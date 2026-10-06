import type { BufferGeometry, Material, Object3D, Texture } from 'three'

import {
  DataTexture,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three'

import { DMELOPER_EYEBROW_FALLBACK_COLOR } from '@/config/dmeloperEyebrows'
import { DMELOPER_PALM_FALLBACK_COLOR } from '@/config/dmeloperPalms'

import { createSkinFaceBounds, installPixelFilter } from './pixelFilter'

export type VoxelSkinModel = 'wide' | 'slim'
export type VoxelSkinModelPreference = VoxelSkinModel | 'auto'

export interface VoxelSkinPixelSource {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

export interface NormalizedVoxelSkin {
  width: 64
  height: 64
  data: Uint8Array
  model: VoxelSkinModel
  inferredModel: VoxelSkinModel
  wideArmLayoutCompatible: boolean
  convertedFromLegacy: boolean
  suggestedEyebrowColor: string
  suggestedPalmColor: string
}

export interface ApplyVoxelSkinOptions {
  materialNames?: readonly string[]
}

export interface VoxelSkinModelControllerOptions {
  wideNodeNames?: readonly string[]
  slimNodeNames?: readonly string[]
}

export interface AppliedVoxelSkin {
  texture: DataTexture
  materialCount: number
  setPixelFilterEnabled: (enabled: boolean) => void
  dispose: () => void
}

export interface VoxelSkinModelController {
  readonly model: VoxelSkinModel
  setModel: (model: VoxelSkinModel) => void
  dispose: () => void
}

export interface VoxelSkinTopology {
  version: 1
  current: number[]
  neighbor: number[]
  palm: number[]
}

export interface VoxelSkinPalmTexel {
  x: number
  y: number
}

export interface VoxelSkinGeometryController {
  setSkin: (skin?: NormalizedVoxelSkin) => void
  setPalmColor: (color: string) => void
  dispose: () => void
}

export function disposeAppliedVoxelSkinBeforeModelResources(
  skin: AppliedVoxelSkin | undefined,
  disposeModelResources: () => void,
): void {
  try {
    skin?.dispose()
  } finally {
    disposeModelResources()
  }
}

const PIXEL_COUNT_64 = 64 * 64 * 4
const PIXEL_COUNT_LEGACY = 64 * 32 * 4
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] as const
const BASE_SLIM_UNUSED_AREAS = [
  [50, 16, 2, 4],
  [54, 20, 2, 12],
  [42, 48, 2, 4],
  [46, 52, 2, 12],
] as const
const OUTER_SLIM_UNUSED_AREAS = [
  [50, 32, 2, 4],
  [54, 36, 2, 12],
  [58, 48, 2, 4],
  [62, 52, 2, 12],
] as const
const BASE_ARM_NET_AREAS = [
  [40, 16, 16, 16],
  [32, 48, 16, 16],
] as const
const OUTER_ARM_NET_AREAS = [
  [40, 32, 16, 16],
  [48, 48, 16, 16],
] as const
const BASE_LAYER_AREAS = [
  [0, 0, 32, 16],
  [0, 16, 64, 16],
  [16, 48, 32, 16],
] as const
const LEGACY_HAT_AREA = [32, 0, 32, 16] as const
const EMPTY_PIXEL = -3
const PALM_PIXEL = -2
const OUTWARD_QUAD = -1
const PALM_RIGHT = 0
const PALM_LEFT = 1

function pixelOffset(x: number, y: number, width = 64): number {
  return (y * width + x) * 4
}

function isSkinPixel(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < 64 * 64
}

function validateTopology(topology: VoxelSkinTopology): void {
  if (
    topology.version !== 1
    || topology.current.length !== topology.neighbor.length
    || topology.current.length !== topology.palm.length
  ) {
    throw new Error('Voxel skin topology metadata is incomplete or unsupported.')
  }
  topology.current.forEach((current, quadIndex) => {
    const neighbor = topology.neighbor[quadIndex]
    const palm = topology.palm[quadIndex]
    if (
      current !== EMPTY_PIXEL
      && current !== PALM_PIXEL
      && !isSkinPixel(current)
    ) {
      throw new Error(`Voxel skin topology quad ${quadIndex} has an invalid current pixel.`)
    }
    if (
      neighbor !== EMPTY_PIXEL
      && neighbor !== PALM_PIXEL
      && neighbor !== OUTWARD_QUAD
      && !isSkinPixel(neighbor)
    ) {
      throw new Error(`Voxel skin topology quad ${quadIndex} has an invalid neighbor pixel.`)
    }
    if (palm !== -1 && palm !== PALM_RIGHT && palm !== PALM_LEFT) {
      throw new Error(`Voxel skin topology quad ${quadIndex} has an invalid palm code.`)
    }
    if (
      (current === PALM_PIXEL && palm === -1)
      || (current === EMPTY_PIXEL && palm !== -1)
    ) {
      throw new Error(`Voxel skin topology quad ${quadIndex} has inconsistent palm metadata.`)
    }
  })
}

/** Return the candidate-geometry quad indices that are visible for one skin. */
export function selectVoxelSkinTopology(
  topology: VoxelSkinTopology,
  skin?: Pick<NormalizedVoxelSkin, 'data'>,
): number[] {
  validateTopology(topology)
  if (skin && skin.data.length !== PIXEL_COUNT_64) {
    throw new Error('Voxel skin topology requires exactly 64x64 RGBA pixels.')
  }
  const occupied = (pixel: number): boolean => (
    pixel === PALM_PIXEL
    || (
      pixel !== EMPTY_PIXEL
      && isSkinPixel(pixel)
      && (!skin || skin.data[pixel * 4 + 3] > 0)
    )
  )
  const selected: number[] = []
  topology.current.forEach((current, quadIndex) => {
    const neighbor = topology.neighbor[quadIndex]
    if (
      neighbor === OUTWARD_QUAD
        ? occupied(current)
        : occupied(current) && !occupied(neighbor)
    ) {
      selected.push(quadIndex)
    }
  })
  return selected
}

function centerFirstColumns(width: number): number[] {
  const center = (width - 1) / 2
  return Array.from({ length: width }, (_value, column) => column)
    .sort((left, right) => (
      Math.abs(left - center) - Math.abs(right - center)
      || left - right
    ))
}

interface PalmSample extends VoxelSkinPalmTexel {
  red: number
  green: number
  blue: number
  priority: number
}

function colorDistance(left: PalmSample, right: PalmSample): number {
  return (
    Math.abs(left.red - right.red)
    + Math.abs(left.green - right.green)
    + Math.abs(left.blue - right.blue)
  )
}

function collectVoxelSkinPalmSamples(
  skin: Pick<NormalizedVoxelSkin, 'data'>,
  model: VoxelSkinModel,
  side: 'right' | 'left',
  initialPriority = 0,
): PalmSample[] {
  const baseU = side === 'right' ? 40 : 32
  const baseV = side === 'right' ? 16 : 48
  const outerU = side === 'right' ? 40 : 48
  const outerV = side === 'right' ? 32 : 48
  const width = model === 'wide' ? 4 : 3
  const depth = 4
  const baseLastRow = baseV + depth + 12 - 1
  const outerLastRow = outerV + depth + 12 - 1
  const faces = [
    [baseU + depth, outerU + depth, width],
    [baseU, outerU, depth],
    [baseU + depth + width, outerU + depth + width, depth],
    [baseU + 2 * depth + width, outerU + 2 * depth + width, width],
  ] as const
  const samples: PalmSample[] = []
  let priority = initialPriority
  faces.forEach(([baseStartX, outerStartX, faceWidth]) => {
    for (let rowOffset = 0; rowOffset < 4; rowOffset += 1) {
      centerFirstColumns(faceWidth).forEach((column) => {
        const baseX = baseStartX + column
        const baseY = baseLastRow - rowOffset
        const outerX = outerStartX + column
        const outerY = outerLastRow - rowOffset
        const outerOffset = pixelOffset(outerX, outerY)
        const useOuter = skin.data[outerOffset + 3] > 0
        const x = useOuter ? outerX : baseX
        const y = useOuter ? outerY : baseY
        const valueOffset = pixelOffset(x, y)
        if (skin.data[valueOffset + 3] > 0) {
          samples.push({
            x,
            y,
            red: skin.data[valueOffset],
            green: skin.data[valueOffset + 1],
            blue: skin.data[valueOffset + 2],
            priority,
          })
        }
        priority += 1
      })
    }
  })
  return samples
}

function selectPalmMedoid(samples: PalmSample[]): PalmSample | undefined {
  return samples.reduce<PalmSample | undefined>((best, candidate) => {
    if (!best) return candidate
    const score = samples.reduce(
      (total, sample) => total + colorDistance(candidate, sample),
      0,
    )
    const bestScore = samples.reduce(
      (total, sample) => total + colorDistance(best, sample),
      0,
    )
    return score < bestScore || (score === bestScore && candidate.priority < best.priority)
      ? candidate
      : best
  }, undefined)
}

/** Pick the RGB medoid of the visible four-row hand-end band of a Java arm net. */
export function selectVoxelSkinPalmTexel(
  skin: Pick<NormalizedVoxelSkin, 'data'>,
  model: VoxelSkinModel,
  side: 'right' | 'left',
): VoxelSkinPalmTexel {
  if (skin.data.length !== PIXEL_COUNT_64) {
    throw new Error('Voxel palm selection requires exactly 64x64 RGBA pixels.')
  }
  const winner = selectPalmMedoid(collectVoxelSkinPalmSamples(skin, model, side))
  if (winner) return { x: winner.x, y: winner.y }
  return side === 'right'
    ? { x: model === 'wide' ? 45 : 44, y: 31 }
    : { x: model === 'wide' ? 37 : 36, y: 63 }
}

/** Suggest one solid palm color from both visible hand-end bands. */
export function suggestVoxelSkinPalmColor(
  data: Uint8Array,
  model: VoxelSkinModel,
): string {
  if (data.length !== PIXEL_COUNT_64) {
    throw new Error('Palm color detection requires exactly 64x64 RGBA pixels.')
  }
  const skin = { data }
  const right = collectVoxelSkinPalmSamples(skin, model, 'right')
  const left = collectVoxelSkinPalmSamples(skin, model, 'left', right.length)
  const medoid = selectPalmMedoid([...right, ...left])
  return medoid
    ? rgbHex(medoid.red, medoid.green, medoid.blue)
    : DMELOPER_PALM_FALLBACK_COLOR
}

function copyFlippedRegion(
  source: Uint8Array | Uint8ClampedArray,
  target: Uint8Array,
  sourceX: number,
  sourceY: number,
  width: number,
  height: number,
  destinationX: number,
  destinationY: number,
): void {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = pixelOffset(sourceX + width - 1 - x, sourceY + y)
      const targetOffset = pixelOffset(destinationX + x, destinationY + y)
      target.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset)
    }
  }
}

export function convertLegacyVoxelSkin(
  source: VoxelSkinPixelSource,
): Uint8Array {
  if (source.width !== 64 || source.height !== 32 || source.data.length !== PIXEL_COUNT_LEGACY) {
    throw new Error('Legacy voxel skins must contain exactly 64x32 RGBA pixels.')
  }

  const target = new Uint8Array(PIXEL_COUNT_64)
  target.set(source.data)

  copyFlippedRegion(source.data, target, 4, 16, 4, 4, 20, 48)
  copyFlippedRegion(source.data, target, 8, 16, 4, 4, 24, 48)
  copyFlippedRegion(source.data, target, 0, 20, 4, 12, 24, 52)
  copyFlippedRegion(source.data, target, 4, 20, 4, 12, 20, 52)
  copyFlippedRegion(source.data, target, 8, 20, 4, 12, 16, 52)
  copyFlippedRegion(source.data, target, 12, 20, 4, 12, 28, 52)

  copyFlippedRegion(source.data, target, 44, 16, 4, 4, 36, 48)
  copyFlippedRegion(source.data, target, 48, 16, 4, 4, 40, 48)
  copyFlippedRegion(source.data, target, 40, 20, 4, 12, 40, 52)
  copyFlippedRegion(source.data, target, 44, 20, 4, 12, 36, 52)
  copyFlippedRegion(source.data, target, 48, 20, 4, 12, 32, 52)
  copyFlippedRegion(source.data, target, 52, 20, 4, 12, 44, 52)
  return target
}

function areaMatches(
  data: Uint8Array | Uint8ClampedArray,
  area: readonly [number, number, number, number],
  predicate: (red: number, green: number, blue: number, alpha: number) => boolean,
): boolean {
  const [startX, startY, width, height] = area
  for (let y = startY; y < startY + height; y += 1) {
    for (let x = startX; x < startX + width; x += 1) {
      const offset = pixelOffset(x, y)
      if (!predicate(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) {
        return false
      }
    }
  }
  return true
}

interface VoxelSkinModelEvidence {
  inferredModel: VoxelSkinModel
  wideArmLayoutCompatible: boolean
}

function inspectVoxelSkinModel(
  data: Uint8Array | Uint8ClampedArray,
): VoxelSkinModelEvidence {
  if (data.length !== PIXEL_COUNT_64) {
    throw new Error('Voxel model inference requires exactly 64x64 RGBA pixels.')
  }

  const baseArmsAreEmpty = BASE_ARM_NET_AREAS.every(area => (
    areaMatches(data, area, (_red, _green, _blue, alpha) => alpha === 0)
  ))
  const outerArmsHavePixels = OUTER_ARM_NET_AREAS.some(area => (
    !areaMatches(data, area, (_red, _green, _blue, alpha) => alpha === 0)
  ))
  const unusedAreas = baseArmsAreEmpty && outerArmsHavePixels
    ? OUTER_SLIM_UNUSED_AREAS
    : BASE_SLIM_UNUSED_AREAS
  const hasTransparentUnusedArea = unusedAreas.some(area => (
    !areaMatches(data, area, (_red, _green, _blue, alpha) => alpha === 0xFF)
  ))
  const unusedAreasAreBlack = unusedAreas.every(area => (
    areaMatches(data, area, (red, green, blue, alpha) => (
      red === 0 && green === 0 && blue === 0 && alpha === 0xFF
    ))
  ))
  const unusedAreasAreWhite = unusedAreas.every(area => (
    areaMatches(data, area, (red, green, blue, alpha) => (
      red === 0xFF && green === 0xFF && blue === 0xFF && alpha === 0xFF
    ))
  ))
  return {
    inferredModel: hasTransparentUnusedArea || unusedAreasAreBlack || unusedAreasAreWhite
      ? 'slim'
      : 'wide',
    // A Java base layer cannot contain transparent pixels. Rendering a skin
    // with these pixels as Wide would expose the otherwise-unused Slim columns
    // after base-alpha normalization, producing long black/white arm strips.
    wideArmLayoutCompatible: !hasTransparentUnusedArea,
  }
}

export function inferVoxelSkinModel(
  data: Uint8Array | Uint8ClampedArray,
): VoxelSkinModel {
  return inspectVoxelSkinModel(data).inferredModel
}

export function resolveVoxelSkinModelPreference(
  skin: Pick<NormalizedVoxelSkin, 'inferredModel' | 'wideArmLayoutCompatible'>,
  preference: VoxelSkinModelPreference,
): VoxelSkinModel {
  if (preference === 'auto') return skin.inferredModel
  if (preference === 'wide' && !skin.wideArmLayoutCompatible) return 'slim'
  return preference
}

function setAreaAlpha(
  data: Uint8Array,
  area: readonly [number, number, number, number],
  alpha: number,
): void {
  const [startX, startY, width, height] = area
  for (let y = startY; y < startY + height; y += 1) {
    for (let x = startX; x < startX + width; x += 1) {
      data[pixelOffset(x, y) + 3] = alpha
    }
  }
}

function normalizeJavaSkinAlpha(data: Uint8Array, convertedFromLegacy: boolean): void {
  if (
    convertedFromLegacy
    && areaMatches(data, LEGACY_HAT_AREA, (_red, _green, _blue, alpha) => alpha === 0xFF)
  ) {
    setAreaAlpha(data, LEGACY_HAT_AREA, 0)
  }
  BASE_LAYER_AREAS.forEach(area => setAreaAlpha(data, area, 0xFF))
}

interface EyebrowColorCandidate {
  red: number
  green: number
  blue: number
  luminance: number
  priority: number
}

function compositeHeadPixel(
  data: Uint8Array,
  baseX: number,
  baseY: number,
  outerX: number,
  outerY: number,
  priority: number,
): EyebrowColorCandidate | undefined {
  const base = pixelOffset(baseX, baseY)
  const outer = pixelOffset(outerX, outerY)
  const baseAlpha = data[base + 3] / 255
  const outerAlpha = data[outer + 3] / 255
  const alpha = outerAlpha + baseAlpha * (1 - outerAlpha)
  if (alpha <= 0) return undefined

  const composite = (channel: number): number => Math.round((
    data[outer + channel] * outerAlpha
    + data[base + channel] * baseAlpha * (1 - outerAlpha)
  ) / alpha)
  const red = composite(0)
  const green = composite(1)
  const blue = composite(2)
  return {
    red,
    green,
    blue,
    luminance: red * 0.2126 + green * 0.7152 + blue * 0.0722,
    priority,
  }
}

function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase()
}

/** Average the visible 8x8 Java head top, compositing its hat layer first. */
export function suggestVoxelSkinHeadTopColor(data: Uint8Array): string {
  if (data.length !== PIXEL_COUNT_64) {
    throw new Error('Head top color detection requires exactly 64x64 RGBA pixels.')
  }
  let red = 0
  let green = 0
  let blue = 0
  let count = 0
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const pixel = compositeHeadPixel(data, 8 + column, row, 40 + column, row, 0)
      if (!pixel) continue
      red += pixel.red
      green += pixel.green
      blue += pixel.blue
      count += 1
    }
  }
  return count > 0
    ? rgbHex(Math.round(red / count), Math.round(green / count), Math.round(blue / count))
    : DMELOPER_EYEBROW_FALLBACK_COLOR
}

/** Suggest a visible hair/hat color from the upper four rows of the Java head front. */
export function suggestVoxelSkinEyebrowColor(
  data: Uint8Array,
): string {
  if (data.length !== PIXEL_COUNT_64) {
    throw new Error('Eyebrow color detection requires exactly 64x64 RGBA pixels.')
  }

  const candidates: EyebrowColorCandidate[] = []
  const columns = centerFirstColumns(8)
  for (let row = 0; row < 4; row += 1) {
    columns.forEach((column, columnPriority) => {
      const candidate = compositeHeadPixel(
        data,
        8 + column,
        8 + row,
        40 + column,
        8 + row,
        row * 8 + columnPriority,
      )
      if (candidate) candidates.push(candidate)
    })
  }
  if (candidates.length === 0) return DMELOPER_EYEBROW_FALLBACK_COLOR

  const darkest = [...candidates]
    .sort((left, right) => left.luminance - right.luminance || left.priority - right.priority)
    .slice(0, Math.ceil(candidates.length / 2))
  const medoid = darkest.reduce((best, candidate) => {
    const distance = darkest.reduce((total, other) => total
      + Math.abs(candidate.red - other.red)
      + Math.abs(candidate.green - other.green)
      + Math.abs(candidate.blue - other.blue), 0)
    const bestDistance = darkest.reduce((total, other) => total
      + Math.abs(best.red - other.red)
      + Math.abs(best.green - other.green)
      + Math.abs(best.blue - other.blue), 0)
    return distance < bestDistance
      || (distance === bestDistance && candidate.priority < best.priority)
      ? candidate
      : best
  })
  return rgbHex(medoid.red, medoid.green, medoid.blue)
}

export function normalizeVoxelSkin(
  source: VoxelSkinPixelSource,
  model: VoxelSkinModelPreference = 'auto',
): NormalizedVoxelSkin {
  if (source.width !== 64 || (source.height !== 64 && source.height !== 32)) {
    throw new Error('Voxel skins must be 64x64 or legacy 64x32 RGBA images.')
  }
  const expectedLength = source.width * source.height * 4
  if (source.data.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} RGBA values for the voxel skin.`)
  }

  const convertedFromLegacy = source.height === 32
  const modelEvidence: VoxelSkinModelEvidence = convertedFromLegacy
    ? { inferredModel: 'wide', wideArmLayoutCompatible: true }
    : inspectVoxelSkinModel(source.data)
  const data = convertedFromLegacy
    ? convertLegacyVoxelSkin(source)
    : new Uint8Array(source.data)
  const suggestedEyebrowColor = suggestVoxelSkinEyebrowColor(data)
  const resolvedModel = model === 'auto'
    ? modelEvidence.inferredModel
    : model
  normalizeJavaSkinAlpha(data, convertedFromLegacy)
  const suggestedPalmColor = suggestVoxelSkinPalmColor(data, resolvedModel)
  return {
    width: 64,
    height: 64,
    data,
    model: resolvedModel,
    inferredModel: modelEvidence.inferredModel,
    wideArmLayoutCompatible: modelEvidence.wideArmLayoutCompatible,
    convertedFromLegacy,
    suggestedEyebrowColor,
    suggestedPalmColor,
  }
}

interface DecodedCanvasImage {
  image: CanvasImageSource
  width: number
  height: number
  dispose: () => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadHtmlCanvasImage(source: Blob): Promise<DecodedCanvasImage> {
  if (typeof document === 'undefined') {
    throw new TypeError('HTML image decoding is unavailable in this environment.')
  }
  const objectUrl = URL.createObjectURL(source)
  const image = document.createElement('img')
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('The browser could not decode the skin image.'))
      image.src = objectUrl
    })
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => {
        image.removeAttribute('src')
        URL.revokeObjectURL(objectUrl)
      },
    }
  } catch (error) {
    image.removeAttribute('src')
    URL.revokeObjectURL(objectUrl)
    throw error
  }
}

async function decodeCanvasImage(source: Blob): Promise<DecodedCanvasImage> {
  let bitmapFailure: unknown
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(source)
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      }
    } catch (error) {
      bitmapFailure = error
    }
  }

  try {
    return await loadHtmlCanvasImage(source)
  } catch (htmlImageFailure) {
    const bitmapDetail = bitmapFailure === undefined
      ? 'createImageBitmap is unavailable'
      : `createImageBitmap failed: ${errorText(bitmapFailure)}`
    throw new Error(
      `Voxel skin image decoding failed (${bitmapDetail}; HTML image fallback failed: ${errorText(htmlImageFailure)}).`,
    )
  }
}

export async function decodeVoxelSkin(
  source: Blob,
  model: VoxelSkinModelPreference = 'auto',
): Promise<NormalizedVoxelSkin> {
  if (source.type && source.type !== 'image/png') {
    throw new Error('Voxel skins must be PNG images.')
  }
  // Reject oversized image dimensions before either browser decoder can allocate
  // pixels. A small compressed PNG can still describe a very large bitmap.
  const header = await source.slice(0, 33).arrayBuffer()
  const signature = new Uint8Array(header, 0, Math.min(header.byteLength, PNG_SIGNATURE.length))
  if (
    signature.length !== PNG_SIGNATURE.length
    || PNG_SIGNATURE.some((value, index) => signature[index] !== value)
  ) {
    throw new Error('Voxel skins must contain a valid PNG signature.')
  }
  const fields = new DataView(header)
  if (header.byteLength < 33 || fields.getUint32(8) !== 13 || fields.getUint32(12) !== 0x49484452) {
    throw new Error('Voxel skins must contain a valid PNG IHDR header.')
  }
  const width = fields.getUint32(16)
  const height = fields.getUint32(20)
  if (width !== 64 || (height !== 64 && height !== 32)) {
    throw new Error('Voxel skins must be 64x64 or legacy 64x32 images.')
  }
  const decoded = await decodeCanvasImage(source)
  try {
    if (decoded.width !== 64 || (decoded.height !== 64 && decoded.height !== 32)) {
      throw new Error('Voxel skins must be 64x64 or legacy 64x32 images.')
    }
    const canvas = typeof OffscreenCanvas === 'undefined'
      ? document.createElement('canvas')
      : new OffscreenCanvas(decoded.width, decoded.height)
    canvas.width = decoded.width
    canvas.height = decoded.height
    const context = canvas.getContext('2d', { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null
    if (!context) throw new Error('A 2D canvas is required to decode the voxel skin.')
    context.clearRect(0, 0, decoded.width, decoded.height)
    context.drawImage(decoded.image, 0, 0)
    const imageData = context.getImageData(0, 0, decoded.width, decoded.height)
    return normalizeVoxelSkin(imageData, model)
  } finally {
    decoded.dispose()
  }
}

export function createVoxelSkinTexture(skin: NormalizedVoxelSkin): DataTexture {
  const texture = new DataTexture(
    new Uint8Array(skin.data),
    64,
    64,
    RGBAFormat,
    UnsignedByteType,
  )
  texture.name = `voxel-skin-${skin.model}`
  texture.colorSpace = SRGBColorSpace
  texture.flipY = false
  texture.generateMipmaps = false
  texture.magFilter = NearestFilter
  texture.minFilter = NearestFilter
  texture.needsUpdate = true
  return texture
}

interface TexturedMaterial extends Material {
  map: Texture | null
  alphaTest: number
  transparent: boolean
}

function supportsTextureMap(material: Material): material is TexturedMaterial {
  return 'map' in material
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function createVoxelSkinModelController(
  root: Object3D,
  initialModel: VoxelSkinModel,
  options: VoxelSkinModelControllerOptions = {},
): VoxelSkinModelController {
  const wideNames = new Set(
    (options.wideNodeNames ?? ['WideArms', 'ClassicArms'])
      .map(normalizedName),
  )
  const slimNames = new Set(
    (options.slimNodeNames ?? ['SlimArms'])
      .map(normalizedName),
  )
  const changed: Array<{ object: Object3D, visible: boolean }> = []
  let hasWideNodes = false
  let hasSlimNodes = false
  root.traverse((object) => {
    const declaredModel = object.userData.voxelSkinModel
    const declaredVariant = declaredModel === 'classic' ? 'wide' : declaredModel
    if (declaredVariant === 'wide' || declaredVariant === 'slim') {
      changed.push({ object, visible: object.visible })
      hasWideNodes ||= declaredVariant === 'wide'
      hasSlimNodes ||= declaredVariant === 'slim'
      return
    }
    const name = normalizedName(object.name)
    if (wideNames.has(name) || slimNames.has(name)) {
      changed.push({ object, visible: object.visible })
      hasWideNodes ||= wideNames.has(name)
      hasSlimNodes ||= slimNames.has(name)
    }
  })
  if (!hasWideNodes || !hasSlimNodes) {
    throw new Error('The voxel model must contain both Wide and Slim arm groups.')
  }

  let model = initialModel
  let disposed = false
  const setModel = (nextModel: VoxelSkinModel) => {
    if (disposed) return
    model = nextModel
    changed.forEach(({ object }) => {
      const declaredModel = object.userData.voxelSkinModel
      const declaredVariant = declaredModel === 'classic' ? 'wide' : declaredModel
      if (declaredVariant === 'wide' || declaredVariant === 'slim') {
        object.visible = declaredVariant === model
        return
      }
      const name = normalizedName(object.name)
      if (wideNames.has(name)) object.visible = model === 'wide'
      if (slimNames.has(name)) object.visible = model === 'slim'
    })
  }
  setModel(initialModel)

  return {
    get model() {
      return model
    },
    setModel,
    dispose: () => {
      if (disposed) return
      changed.forEach(({ object, visible }) => {
        object.visible = visible
      })
      disposed = true
    },
  }
}

type PalmQuad = readonly [quadIndex: number, palm: number]

interface VoxelSkinGeometryBinding {
  mesh: Mesh
  original: BufferGeometry
  geometry: BufferGeometry
  originalIndex: number[]
  originalMaterial: Material | Material[]
  originalMaterialCount: number
  topology?: VoxelSkinTopology
  palmQuads: PalmQuad[]
  palmQuadIndices: Set<number>
  model?: VoxelSkinModel
}

function parseJsonUserData(value: unknown, label: string): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${label} must be valid JSON.`)
  }
}

function parseVoxelSkinTopology(value: unknown): VoxelSkinTopology | undefined {
  if (value === undefined) return undefined
  const parsed = parseJsonUserData(value, 'voxelSkinTopology')
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('voxelSkinTopology must be an object.')
  }
  const candidate = parsed as Partial<VoxelSkinTopology>
  if (
    candidate.version !== 1
    || !Array.isArray(candidate.current)
    || !Array.isArray(candidate.neighbor)
    || !Array.isArray(candidate.palm)
    || !candidate.current.every(Number.isInteger)
    || !candidate.neighbor.every(Number.isInteger)
    || !candidate.palm.every(Number.isInteger)
  ) {
    throw new Error('voxelSkinTopology contains invalid arrays.')
  }
  const topology: VoxelSkinTopology = {
    version: 1,
    current: [...candidate.current],
    neighbor: [...candidate.neighbor],
    palm: [...candidate.palm],
  }
  validateTopology(topology)
  return topology
}

function parsePalmQuads(value: unknown): PalmQuad[] {
  if (value === undefined) return []
  const parsed = parseJsonUserData(value, 'voxelSkinPalmQuads')
  if (
    !Array.isArray(parsed)
    || !parsed.every(entry => (
      Array.isArray(entry)
      && entry.length === 2
      && Number.isInteger(entry[0])
      && (entry[1] === PALM_RIGHT || entry[1] === PALM_LEFT)
    ))
  ) {
    throw new Error('voxelSkinPalmQuads contains invalid entries.')
  }
  return parsed.map(entry => [entry[0], entry[1]] as const)
}

function declaredVoxelSkinModel(object: Object3D): VoxelSkinModel | undefined {
  let current: Object3D | null = object
  while (current) {
    const declared = current.userData.voxelSkinModel
    if (declared === 'wide' || declared === 'slim') return declared
    if (declared === 'classic') return 'wide'
    current = current.parent
  }
  return undefined
}

function originalQuadMaterialIndex(
  binding: VoxelSkinGeometryBinding,
  quadIndex: number,
): number {
  const indexStart = quadIndex * 6
  return binding.original.groups.find(group => (
    group.start <= indexStart && group.start + group.count >= indexStart + 6
  ))?.materialIndex ?? 0
}

function setBindingQuads(
  binding: VoxelSkinGeometryBinding,
  quadIndices: readonly number[],
): void {
  binding.geometry.setIndex(quadIndices.flatMap(quadIndex => (
    binding.originalIndex.slice(quadIndex * 6, quadIndex * 6 + 6)
  )))
  binding.geometry.clearGroups()
  quadIndices.forEach((quadIndex, outputQuadIndex) => {
    const materialIndex = binding.palmQuadIndices.has(quadIndex)
      ? binding.originalMaterialCount
      : originalQuadMaterialIndex(binding, quadIndex)
    const start = outputQuadIndex * 6
    const previous = binding.geometry.groups.at(-1)
    if (previous && previous.materialIndex === materialIndex && previous.start + previous.count === start) {
      previous.count += 6
    } else {
      binding.geometry.addGroup(start, 6, materialIndex)
    }
  })
}

/** Control the alpha-dependent outer-shell topology and generated solid palms. */
export function createVoxelSkinGeometryController(
  root: Object3D,
): VoxelSkinGeometryController {
  const bindings: VoxelSkinGeometryBinding[] = []
  const palmMaterial = new MeshStandardMaterial({
    color: DMELOPER_PALM_FALLBACK_COLOR,
    side: FrontSide,
  })
  palmMaterial.name = 'Dmeloper Palm'
  try {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return
      const topology = parseVoxelSkinTopology(object.userData.voxelSkinTopology)
      const basePalmQuads = parsePalmQuads(object.userData.voxelSkinPalmQuads)
      if (!topology && basePalmQuads.length === 0) return

      const original = object.geometry
      const originalIndexAttribute = original.getIndex()
      if (!originalIndexAttribute) {
        throw new Error(`${object.name || 'Voxel skin mesh'} must use indexed quad geometry.`)
      }
      const originalIndex = Array.from(originalIndexAttribute.array as ArrayLike<number>)
      const quadCount = originalIndex.length / 6
      if (!Number.isInteger(quadCount)) {
        throw new TypeError(`${object.name || 'Voxel skin mesh'} has a non-quad index buffer.`)
      }
      if (topology && topology.current.length !== quadCount) {
        throw new Error(`${object.name || 'Voxel skin mesh'} topology does not match its quads.`)
      }
      basePalmQuads.forEach(([quadIndex]) => {
        if (quadIndex < 0 || quadIndex >= quadCount) {
          throw new Error(`${object.name || 'Voxel skin mesh'} has an invalid palm quad.`)
        }
      })

      const geometry = original.clone()
      const topologyPalmQuads = topology
        ? topology.palm.flatMap((palm, quadIndex) => (
            palm === PALM_RIGHT || palm === PALM_LEFT
              ? [[quadIndex, palm] as const]
              : []
          ))
        : []
      const palmQuads = [...basePalmQuads, ...topologyPalmQuads]
      const originalMaterials = Array.isArray(object.material)
        ? object.material
        : [object.material]
      bindings.push({
        mesh: object,
        original,
        geometry,
        originalIndex,
        originalMaterial: object.material,
        originalMaterialCount: originalMaterials.length,
        topology,
        palmQuads,
        palmQuadIndices: new Set(palmQuads.map(([quadIndex]) => quadIndex)),
        model: declaredVoxelSkinModel(object),
      })
    })
  } catch (error) {
    bindings.forEach(binding => binding.geometry.dispose())
    palmMaterial.dispose()
    throw error
  }

  const untaggedPalm = bindings.find(binding => binding.palmQuads.length > 0 && !binding.model)
  if (untaggedPalm) {
    bindings.forEach(({ geometry }) => geometry.dispose())
    palmMaterial.dispose()
    throw new Error(`${untaggedPalm.mesh.name || 'Voxel skin mesh'} palm requires a Wide/Slim model tag.`)
  }
  bindings.forEach((binding) => {
    binding.mesh.geometry = binding.geometry
    if (binding.palmQuads.length > 0) {
      const originalMaterials = Array.isArray(binding.originalMaterial)
        ? binding.originalMaterial
        : [binding.originalMaterial]
      binding.mesh.material = [...originalMaterials, palmMaterial]
    }
  })

  let disposed = false
  const setSkin = (skin?: NormalizedVoxelSkin): void => {
    if (disposed) return
    if (skin && skin.data.length !== PIXEL_COUNT_64) {
      throw new Error('Voxel geometry requires exactly 64x64 RGBA pixels.')
    }
    bindings.forEach((binding) => {
      const quadIndices = binding.topology
        ? selectVoxelSkinTopology(binding.topology, skin)
        : Array.from(
            { length: binding.originalIndex.length / 6 },
            (_value, quadIndex) => quadIndex,
          )
      setBindingQuads(binding, quadIndices)
    })
  }
  setSkin(undefined)

  return {
    setSkin,
    setPalmColor: (color: string) => {
      if (!/^#[0-9a-f]{6}$/i.test(color)) return
      palmMaterial.color.set(color)
    },
    dispose: () => {
      if (disposed) return
      bindings.forEach(({ mesh, original, geometry, originalMaterial, palmQuads }) => {
        mesh.geometry = original
        if (palmQuads.length > 0) mesh.material = originalMaterial
        geometry.dispose()
      })
      palmMaterial.dispose()
      disposed = true
    },
  }
}

export function applyVoxelSkin(
  root: Object3D,
  skin: NormalizedVoxelSkin,
  options: ApplyVoxelSkinOptions = {},
): AppliedVoxelSkin {
  const texture = createVoxelSkinTexture(skin)
  const pixelFilter = { value: false }
  const materialNames = options.materialNames
    ? new Set(options.materialNames.map(normalizedName))
    : undefined
  const replacements: Array<{
    mesh: Mesh
    original: Material | Material[]
    clones: Material[]
    originalGeometry: BufferGeometry
    filteredGeometry?: BufferGeometry
  }> = []
  let materialCount = 0

  root.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const originals = Array.isArray(object.material)
      ? object.material
      : [object.material]
    const clones: Material[] = []
    const replacementsForMesh = originals.map((material) => {
      if (
        !supportsTextureMap(material)
        || (materialNames && !materialNames.has(normalizedName(material.name)))
      ) {
        return material
      }

      const clone = material.clone()
      clone.map = texture
      installPixelFilter(clone, pixelFilter)
      clone.alphaTest = Math.max(clone.alphaTest, 1 / 255)
      clone.transparent = true
      clone.side = FrontSide
      // Preserve Three's inverse-side shadow default to avoid front-face shadow acne.
      clone.shadowSide = null
      clone.needsUpdate = true
      clones.push(clone)
      materialCount += 1
      return clone
    })
    const originalGeometry = object.geometry
    const filteredGeometry = clones.length > 0 ? originalGeometry.clone() : undefined
    if (filteredGeometry) {
      filteredGeometry.setAttribute('skinFaceBounds', createSkinFaceBounds(originalGeometry, declaredVoxelSkinModel(object) ?? skin.model))
      object.geometry = filteredGeometry
    }
    replacements.push({ mesh: object, original: object.material, clones, originalGeometry, filteredGeometry })
    object.material = Array.isArray(object.material)
      ? replacementsForMesh
      : replacementsForMesh[0]
  })

  let disposed = false
  return {
    texture,
    materialCount,
    setPixelFilterEnabled: (enabled: boolean) => {
      pixelFilter.value = enabled
    },
    dispose: () => {
      if (disposed) return
      replacements.forEach(({ mesh, original, clones, originalGeometry, filteredGeometry }) => {
        mesh.geometry = originalGeometry
        filteredGeometry?.dispose()
        mesh.material = original
        clones.forEach(material => material.dispose())
      })
      texture.dispose()
      disposed = true
    },
  }
}
