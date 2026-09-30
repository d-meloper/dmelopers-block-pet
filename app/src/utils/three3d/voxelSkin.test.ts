/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, it } from 'node:test'
import { deflateSync } from 'node:zlib'
import {
  BackSide,
  BufferGeometry,
  Float32BufferAttribute,
  FrontSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
} from 'three'

import { DMELOPER_EYEBROW_FALLBACK_COLOR } from '@/config/dmeloperEyebrows'

import type { NormalizedVoxelSkin, VoxelSkinTopology } from './voxelSkin'

import {
  applyVoxelSkin,
  convertLegacyVoxelSkin,
  createVoxelSkinGeometryController,
  createVoxelSkinModelController,
  decodeVoxelSkin,
  inferVoxelSkinModel,
  normalizeVoxelSkin,
  resolveVoxelSkinModelPreference,
  selectVoxelSkinPalmTexel,
  selectVoxelSkinTopology,
  suggestVoxelSkinEyebrowColor,
  suggestVoxelSkinPalmColor,
} from './voxelSkin'

const SKIN_64_LENGTH = 64 * 64 * 4
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

/** Valid grayscale PNGs, including highly compressed oversized import input. */
function grayscalePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data])
    let crc = 0xFFFFFFFF
    for (const byte of payload) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0)
    }
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    payload.copy(result, 4)
    result.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, data.length + 8)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function offset(x: number, y: number, width = 64): number {
  return (y * width + x) * 4
}

function setPixel(
  data: Uint8Array | Uint8ClampedArray,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
  width = 64,
): void {
  data.set(rgba, offset(x, y, width))
}

function getPixel(
  data: Uint8Array | Uint8ClampedArray,
  x: number,
  y: number,
): number[] {
  return [...data.subarray(offset(x, y), offset(x, y) + 4)]
}

function opaqueSkin64(): Uint8Array {
  const data = new Uint8Array(SKIN_64_LENGTH)
  for (let index = 3; index < data.length; index += 4) data[index] = 0xFF
  return data
}

function basePalmSkin64(): Uint8Array {
  const data = opaqueSkin64()
  for (const [startX, startY] of [[40, 32], [48, 48]]) {
    for (let y = startY; y < startY + 16; y += 1) {
      for (let x = startX; x < startX + 16; x += 1) {
        setPixel(data, x, y, [0, 0, 0, 0])
      }
    }
  }
  return data
}

function normalizedSkin(data = opaqueSkin64()): NormalizedVoxelSkin {
  return {
    width: 64,
    height: 64,
    data,
    model: 'wide',
    inferredModel: 'wide',
    wideArmLayoutCompatible: true,
    convertedFromLegacy: false,
    suggestedEyebrowColor: '#000000',
    suggestedPalmColor: '#CCCCCC',
  }
}

function fillHeadCandidateArea(
  data: Uint8Array,
  rgba: readonly [number, number, number, number],
  outer = false,
): void {
  for (let y = 8; y < 12; y += 1) {
    for (let x = outer ? 40 : 8; x < (outer ? 48 : 16); x += 1) {
      setPixel(data, x, y, rgba)
    }
  }
}

function quadGeometry(quadCount: number): BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (let quad = 0; quad < quadCount; quad += 1) {
    const start = quad * 4
    positions.push(quad, 0, 0)
    positions.push(quad + 1, 0, 0)
    positions.push(quad + 1, 1, 0)
    positions.push(quad, 1, 0)
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1)
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}

describe('voxel skin normalization', () => {
  it('suggests an eyebrow color from the darkest visible head-front half', () => {
    const data = new Uint8Array(SKIN_64_LENGTH)
    fillHeadCandidateArea(data, [210, 190, 170, 255])
    for (let y = 8; y < 10; y += 1) {
      for (let x = 8; x < 16; x += 1) setPixel(data, x, y, [36, 52, 68, 255])
    }

    assert.equal(suggestVoxelSkinEyebrowColor(data), '#243444')
    assert.equal(
      normalizeVoxelSkin({ width: 64, height: 64, data }).suggestedEyebrowColor,
      '#243444',
    )
  })

  it('composites opaque, partial, and overlay-only head outer pixels before alpha normalization', () => {
    const opaqueOuter = new Uint8Array(SKIN_64_LENGTH)
    fillHeadCandidateArea(opaqueOuter, [200, 180, 160, 255])
    fillHeadCandidateArea(opaqueOuter, [12, 34, 56, 255], true)
    assert.equal(suggestVoxelSkinEyebrowColor(opaqueOuter), '#0C2238')

    const partialOuter = new Uint8Array(SKIN_64_LENGTH)
    fillHeadCandidateArea(partialOuter, [100, 0, 0, 255])
    fillHeadCandidateArea(partialOuter, [0, 0, 100, 128], true)
    assert.equal(suggestVoxelSkinEyebrowColor(partialOuter), '#320032')

    const overlayOnly = new Uint8Array(SKIN_64_LENGTH)
    fillHeadCandidateArea(overlayOnly, [12, 34, 56, 64], true)
    assert.equal(
      normalizeVoxelSkin({ width: 64, height: 64, data: overlayOnly }).suggestedEyebrowColor,
      '#0C2238',
    )
  })

  it('uses the fallback for a transparent head and supports legacy 64x32 head colors', () => {
    assert.equal(suggestVoxelSkinEyebrowColor(new Uint8Array(SKIN_64_LENGTH)), DMELOPER_EYEBROW_FALLBACK_COLOR)

    const legacy = new Uint8Array(64 * 32 * 4)
    fillHeadCandidateArea(legacy, [70, 80, 90, 255])
    assert.equal(
      normalizeVoxelSkin({ width: 64, height: 32, data: legacy }).suggestedEyebrowColor,
      '#46505A',
    )
  })

  it('infers Wide and both transparent and conventional blank Slim layouts', () => {
    const wide = opaqueSkin64()
    setPixel(wide, 50, 16, [12, 34, 56, 255])
    assert.equal(inferVoxelSkinModel(wide), 'wide')

    const transparentSlim = opaqueSkin64()
    setPixel(transparentSlim, 50, 16, [0, 0, 0, 0])
    assert.equal(inferVoxelSkinModel(transparentSlim), 'slim')

    const blackSlim = opaqueSkin64()
    for (const [x, y, width, height] of [
      [50, 16, 2, 4],
      [54, 20, 2, 12],
      [42, 48, 2, 4],
      [46, 52, 2, 12],
    ]) {
      for (let row = y; row < y + height; row += 1) {
        for (let column = x; column < x + width; column += 1) {
          setPixel(blackSlim, column, row, [0, 0, 0, 255])
        }
      }
    }
    assert.equal(inferVoxelSkinModel(blackSlim), 'slim')

    const whiteSlim = opaqueSkin64()
    for (const [x, y, width, height] of [
      [50, 16, 2, 4],
      [54, 20, 2, 12],
      [42, 48, 2, 4],
      [46, 52, 2, 12],
    ]) {
      for (let row = y; row < y + height; row += 1) {
        for (let column = x; column < x + width; column += 1) {
          setPixel(whiteSlim, column, row, [255, 255, 255, 255])
        }
      }
    }
    assert.equal(inferVoxelSkinModel(whiteSlim), 'slim')
  })

  it('rejects an incompatible Wide override before unused Slim pixels can appear', () => {
    const data = opaqueSkin64()
    setPixel(data, 50, 16, [0, 0, 0, 0])
    setPixel(data, 10, 10, [4, 5, 6, 12])
    setPixel(data, 33, 5, [7, 8, 9, 127])
    setPixel(data, 34, 5, [10, 11, 12, 0])

    const normalized = normalizeVoxelSkin({ width: 64, height: 64, data }, 'wide')
    assert.equal(normalized.model, 'wide')
    assert.equal(normalized.inferredModel, 'slim')
    assert.equal(normalized.wideArmLayoutCompatible, false)
    assert.equal(resolveVoxelSkinModelPreference(normalized, 'wide'), 'slim')
    assert.equal(resolveVoxelSkinModelPreference(normalized, 'auto'), 'slim')
    assert.equal(resolveVoxelSkinModelPreference(normalized, 'slim'), 'slim')
    assert.deepEqual(getPixel(normalized.data, 10, 10), [4, 5, 6, 255])
    assert.deepEqual(getPixel(normalized.data, 33, 5), [7, 8, 9, 127])
    assert.deepEqual(getPixel(normalized.data, 34, 5), [10, 11, 12, 0])
  })

  it('keeps a Wide override for a fully opaque compatible arm layout', () => {
    const normalized = normalizeVoxelSkin({
      width: 64,
      height: 64,
      data: opaqueSkin64(),
    })

    assert.equal(normalized.wideArmLayoutCompatible, true)
    assert.equal(resolveVoxelSkinModelPreference(normalized, 'wide'), 'wide')
  })

  it('mirrors legacy right limbs into their left-limb base regions pixel exactly', () => {
    const data = new Uint8Array(64 * 32 * 4)
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        setPixel(data, x, y, [x, y, (x + y) & 0xFF, 255])
      }
    }

    const converted = convertLegacyVoxelSkin({ width: 64, height: 32, data })
    assert.deepEqual(getPixel(converted, 20, 48), [7, 16, 23, 255])
    assert.deepEqual(getPixel(converted, 23, 48), [4, 16, 20, 255])
    assert.deepEqual(getPixel(converted, 36, 48), [47, 16, 63, 255])
    assert.deepEqual(getPixel(converted, 39, 48), [44, 16, 60, 255])
    assert.deepEqual(getPixel(converted, 16, 52), [11, 20, 31, 255])
    assert.deepEqual(getPixel(converted, 44, 52), [55, 20, 75, 255])
    assert.deepEqual(getPixel(converted, 48, 48), [0, 0, 0, 0])
  })

  it('suggests Wide for legacy skins, clears an opaque legacy hat, and keeps feet at base height', () => {
    const data = new Uint8Array(64 * 32 * 4)
    for (let index = 3; index < data.length; index += 4) data[index] = 0xFF
    const normalized = normalizeVoxelSkin({ width: 64, height: 32, data })

    assert.equal(normalized.convertedFromLegacy, true)
    assert.equal(normalized.model, 'wide')
    assert.equal(getPixel(normalized.data, 2, 2)[3], 255)
    assert.equal(getPixel(normalized.data, 40, 8)[3], 0)
    assert.equal(getPixel(normalized.data, 48, 48)[3], 0)
    assert.equal(
      normalizeVoxelSkin({ width: 64, height: 32, data }, 'slim').model,
      'slim',
    )
  })

  it('rejects invalid dimensions and RGBA buffer lengths', () => {
    assert.throws(
      () => normalizeVoxelSkin({ width: 32, height: 64, data: new Uint8Array(32 * 64 * 4) }),
      /64x64 or legacy 64x32/,
    )
    assert.throws(
      () => normalizeVoxelSkin({ width: 64, height: 64, data: new Uint8Array(3) }),
      /Expected 16384 RGBA values/,
    )
  })
})

describe('voxel skin outer topology', () => {
  const topology: VoxelSkinTopology = {
    version: 1,
    current: [0, 1, 0, 1, 2, 3, -2, 0, -2],
    neighbor: [-1, -1, 1, 0, -1, -1, -1, -2, 0],
    palm: [-1, -1, -1, -1, -1, -1, 0, -1, 0],
  }

  it('keeps only outward faces for an opaque or missing skin', () => {
    assert.deepEqual(selectVoxelSkinTopology(topology), [0, 1, 4, 5, 6])
    assert.deepEqual(
      selectVoxelSkinTopology(topology, normalizedSkin()),
      [0, 1, 4, 5, 6],
    )
  })

  it('treats alpha zero as a hole and partial alpha as occupied', () => {
    const data = opaqueSkin64()
    setPixel(data, 1, 0, [1, 2, 3, 0])
    setPixel(data, 2, 0, [4, 5, 6, 1])
    setPixel(data, 3, 0, [7, 8, 9, 0])

    assert.deepEqual(
      selectVoxelSkinTopology(topology, normalizedSkin(data)),
      [0, 2, 4, 6],
    )
  })

  it('emits one boundary wall for adjacent occupied and transparent texels', () => {
    const data = opaqueSkin64()
    setPixel(data, 0, 0, [0, 0, 0, 0])
    assert.deepEqual(
      selectVoxelSkinTopology(topology, normalizedSkin(data)),
      [1, 3, 4, 5, 6, 8],
    )

    data.fill(0)
    assert.deepEqual(
      selectVoxelSkinTopology(topology, normalizedSkin(data)),
      [6, 8],
    )
  })

  it('never renders a permanently empty palm cap and gates its rim by sleeve alpha', () => {
    const terminalTopology: VoxelSkinTopology = {
      version: 1,
      current: [0, -3, 0],
      neighbor: [-1, -1, -3],
      palm: [-1, -1, 0],
    }
    assert.deepEqual(selectVoxelSkinTopology(terminalTopology), [0, 2])

    const transparent = new Uint8Array(SKIN_64_LENGTH)
    assert.deepEqual(
      selectVoxelSkinTopology(terminalTopology, normalizedSkin(transparent)),
      [],
    )
  })
})

describe('voxel skin solid palm selection', () => {
  function fillBand(
    data: Uint8Array,
    startX: number,
    endX: number,
    endY: number,
    color: readonly [number, number, number, number],
  ): void {
    for (let y = endY - 3; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        setPixel(data, x, y, color)
      }
    }
  }

  it('rejects a one-row black outlier in favor of the surrounding hand-end band', () => {
    const data = basePalmSkin64()
    for (let y = 28; y <= 30; y += 1) {
      for (let x = 40; x <= 55; x += 1) {
        const variation = (y - 28) * 16 + x - 40
        setPixel(data, x, y, [190 + variation, 150 + variation, 120 + variation, 255])
      }
    }
    for (let x = 40; x <= 55; x += 1) {
      setPixel(data, x, 31, [0, 0, 0, 255])
    }

    const selected = selectVoxelSkinPalmTexel(normalizedSkin(data), 'wide', 'right')
    assert.notEqual(selected.y, 31)
    assert.notDeepEqual(getPixel(data, selected.x, selected.y).slice(0, 3), [0, 0, 0])
  })

  it('preserves a genuinely dark lower arm and deterministic face priority', () => {
    const data = basePalmSkin64()
    fillBand(data, 40, 55, 31, [8, 9, 10, 255])
    assert.deepEqual(
      selectVoxelSkinPalmTexel(normalizedSkin(data), 'wide', 'right'),
      { x: 45, y: 31 },
    )
  })

  it('computes Wide/Slim and right/left hands independently', () => {
    const data = basePalmSkin64()
    for (let y = 28; y <= 31; y += 1) {
      for (let x = 40; x <= 53; x += 1) {
        setPixel(data, x, y, y >= 30
          ? [90, 91, 92, 255]
          : [30, 31, 32, 255])
      }
    }
    fillBand(data, 54, 55, 31, [30, 31, 32, 255])
    fillBand(data, 32, 47, 63, [70, 71, 72, 255])

    assert.deepEqual(
      selectVoxelSkinPalmTexel(normalizedSkin(data), 'wide', 'right'),
      { x: 45, y: 29 },
    )
    assert.deepEqual(
      selectVoxelSkinPalmTexel(normalizedSkin(data), 'slim', 'right'),
      { x: 45, y: 31 },
    )
    assert.deepEqual(
      selectVoxelSkinPalmTexel(normalizedSkin(data), 'wide', 'left'),
      { x: 37, y: 63 },
    )
    assert.equal(suggestVoxelSkinPalmColor(data, 'wide'), '#464748')
    assert.equal(suggestVoxelSkinPalmColor(data, 'slim'), '#464748')
  })

  it('uses the visible sleeve band for an overlay-only Wide skin', () => {
    const data = new Uint8Array(SKIN_64_LENGTH)
    const skinColor = [239, 205, 174, 255] as const
    const shadeColor = [225, 168, 117, 255] as const

    for (const [startX, startY] of [[40, 32], [48, 48]]) {
      for (let y = startY; y < startY + 16; y += 1) {
        for (let x = startX; x < startX + 16; x += 1) {
          const inTopOrBottom = y < startY + 4 && x >= startX + 4 && x < startX + 12
          const inSides = y >= startY + 4
          if (inTopOrBottom || inSides) setPixel(data, x, y, skinColor)
        }
      }
    }
    fillBand(data, 48, 51, 47, shadeColor)
    fillBand(data, 48, 51, 63, shadeColor)

    const normalized = normalizeVoxelSkin({ width: 64, height: 64, data })
    assert.equal(normalized.model, 'wide')

    const right = selectVoxelSkinPalmTexel(normalized, 'wide', 'right')
    const left = selectVoxelSkinPalmTexel(normalized, 'wide', 'left')
    assert.deepEqual(right, { x: 45, y: 47 })
    assert.deepEqual(left, { x: 53, y: 63 })
    assert.deepEqual(getPixel(normalized.data, right.x, right.y), [...skinColor])
    assert.deepEqual(getPixel(normalized.data, left.x, left.y), [...skinColor])
    assert.equal(normalized.suggestedPalmColor, '#EFCDAE')
  })

  it('selects one deterministic medoid across both hands and falls back when empty', () => {
    const data = basePalmSkin64()
    fillBand(data, 40, 55, 31, [20, 40, 60, 255])
    fillBand(data, 32, 47, 63, [100, 120, 140, 255])

    assert.equal(suggestVoxelSkinPalmColor(data, 'wide'), '#14283C')
    assert.equal(suggestVoxelSkinPalmColor(data, 'wide'), '#14283C')
    assert.equal(
      suggestVoxelSkinPalmColor(new Uint8Array(SKIN_64_LENGTH), 'slim'),
      '#CCCCCC',
    )
  })

  it('includes transparent base hand RGB that becomes visible during normalization', () => {
    const data = new Uint8Array(SKIN_64_LENGTH)
    fillBand(data, 40, 55, 31, [20, 40, 60, 0])
    fillBand(data, 32, 47, 63, [20, 40, 60, 0])

    const normalized = normalizeVoxelSkin({ width: 64, height: 64, data })

    assert.equal(normalized.suggestedPalmColor, '#14283C')
    assert.deepEqual(getPixel(normalized.data, 40, 31), [20, 40, 60, 255])

    fillBand(data, 40, 55, 47, [7, 8, 9, 128])
    fillBand(data, 48, 63, 63, [7, 8, 9, 128])
    assert.equal(
      normalizeVoxelSkin({ width: 64, height: 64, data }).suggestedPalmColor,
      '#070809',
    )
  })
})

describe('voxel skin geometry controller', () => {
  it('routes palm triangles to an immediate solid material, then restores resources', () => {
    const root = new Object3D()
    const wideGroup = new Object3D()
    wideGroup.userData.voxelSkinModel = 'wide'
    root.add(wideGroup)

    const outerOriginal = quadGeometry(4)
    const outerOriginalMaterial = new MeshBasicMaterial()
    const outer = new Mesh(outerOriginal, outerOriginalMaterial)
    outer.userData.voxelSkinTopology = JSON.stringify({
      version: 1,
      current: [0, 0, 0, -3],
      neighbor: [-1, 1, -3, -1],
      palm: [-1, -1, 0, -1],
    })
    wideGroup.add(outer)

    const baseOriginal = quadGeometry(1)
    const baseOriginalMaterial = new MeshBasicMaterial()
    const base = new Mesh(baseOriginal, baseOriginalMaterial)
    base.userData.voxelSkinPalmQuads = JSON.stringify([[0, 0]])
    wideGroup.add(base)

    const controller = createVoxelSkinGeometryController(root)
    assert.notEqual(outer.geometry, outerOriginal)
    assert.equal(outer.geometry.getIndex()?.count, 12)
    assert.deepEqual(outer.geometry.groups, [
      { start: 0, count: 6, materialIndex: 0 },
      { start: 6, count: 6, materialIndex: 1 },
    ])
    assert.equal(Array.isArray(outer.material), true)
    assert.equal(Array.isArray(base.material), true)
    const outerMaterials = outer.material as unknown as MeshBasicMaterial[]
    const baseMaterials = base.material as unknown as MeshBasicMaterial[]
    assert.equal(outerMaterials[0], outerOriginalMaterial)
    assert.equal(baseMaterials[0], baseOriginalMaterial)
    assert.equal(outerMaterials[1], baseMaterials[1])

    const data = basePalmSkin64()
    setPixel(data, 1, 0, [0, 0, 0, 0])
    for (let y = 28; y <= 31; y += 1) {
      for (let x = 40; x <= 55; x += 1) {
        setPixel(data, x, y, [45, 31, 0, 255])
      }
    }
    controller.setSkin(normalizedSkin(data))
    assert.equal(outer.geometry.getIndex()?.count, 18)
    assert.deepEqual(outer.geometry.groups, [
      { start: 0, count: 12, materialIndex: 0 },
      { start: 12, count: 6, materialIndex: 1 },
    ])
    assert.deepEqual(base.geometry.groups, [
      { start: 0, count: 6, materialIndex: 1 },
    ])

    controller.setPalmColor('#123456')
    assert.equal(outerMaterials[1].color.getHexString().toUpperCase(), '123456')

    controller.setSkin(undefined)
    assert.equal(outer.geometry.getIndex()?.count, 12)

    let geometryDisposed = false
    let materialDisposed = false
    outer.geometry.addEventListener('dispose', () => geometryDisposed = true)
    outerMaterials[1].addEventListener('dispose', () => materialDisposed = true)

    controller.dispose()
    assert.equal(outer.geometry, outerOriginal)
    assert.equal(base.geometry, baseOriginal)
    assert.equal(outer.material, outerOriginalMaterial)
    assert.equal(base.material, baseOriginalMaterial)
    assert.equal(geometryDisposed, true)
    assert.equal(materialDisposed, true)
  })
})

describe('voxel skin material application', () => {
  it('uses inverse-side shadow casting for single-sided skin materials and restores originals', () => {
    const root = new Object3D()
    const original = new MeshBasicMaterial({ side: BackSide })
    original.shadowSide = BackSide
    const mesh = new Mesh(quadGeometry(1), original)
    root.add(mesh)

    const applied = applyVoxelSkin(root, normalizedSkin())
    assert.notEqual(mesh.material, original)
    assert.equal(mesh.material.side, FrontSide)
    assert.equal(mesh.material.shadowSide, null)
    assert.equal(mesh.material.transparent, true)
    assert.equal(mesh.material.alphaTest, 1 / 255)

    applied.dispose()
    assert.equal(mesh.material, original)
  })

  it('leaves the dedicated eyebrow material untouched when material names are filtered', () => {
    const root = new Object3D()
    const skinMaterial = new MeshBasicMaterial()
    skinMaterial.name = 'Voxel External Skin'
    const eyebrowMaterial = new MeshBasicMaterial({ color: '#4A2818' })
    eyebrowMaterial.name = 'Dmeloper Eyebrow'
    const skinMesh = new Mesh(quadGeometry(1), skinMaterial)
    const eyebrowMesh = new Mesh(quadGeometry(1), eyebrowMaterial)
    root.add(skinMesh, eyebrowMesh)

    const applied = applyVoxelSkin(root, normalizedSkin(), {
      materialNames: ['Voxel External Skin', 'Voxel External Skin Overlay'],
    })
    assert.notEqual(skinMesh.material, skinMaterial)
    assert.equal(eyebrowMesh.material, eyebrowMaterial)
    assert.equal(applied.materialCount, 1)

    applied.dispose()
    assert.equal(skinMesh.material, skinMaterial)
    assert.equal(eyebrowMesh.material, eyebrowMaterial)
  })
})

describe('voxel skin arm-model controller', () => {
  it('switches Wide/Slim groups without reloading a texture and restores visibility', () => {
    const root = new Object3D()
    const wide = new Object3D()
    const slim = new Object3D()
    wide.name = 'WideArms'
    slim.userData.voxelSkinModel = 'slim'
    wide.visible = false
    slim.visible = true
    root.add(wide, slim)

    const controller = createVoxelSkinModelController(root, 'wide')
    assert.equal(controller.model, 'wide')
    assert.equal(wide.visible, true)
    assert.equal(slim.visible, false)

    controller.setModel('slim')
    assert.equal(controller.model, 'slim')
    assert.equal(wide.visible, false)
    assert.equal(slim.visible, true)

    controller.dispose()
    assert.equal(wide.visible, false)
    assert.equal(slim.visible, true)
  })
})

describe('voxel skin browser decoding', () => {
  it('rejects unsupported PNG dimensions and malformed headers before either browser decoder', async () => {
    const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
    let decoderCalls = 0
    const attemptedDecode = () => {
      decoderCalls++
      throw new Error('Unsupported input reached a browser decoder.')
    }
    try {
      Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: attemptedDecode })
      Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: attemptedDecode } })
      const oversized = grayscalePng(2048, 2048)
      assert.ok(oversized.length < 2 * 1024 * 1024, 'the PNG passes the file picker byte limit')
      for (const bytes of [oversized, grayscalePng(64, 128), grayscalePng(32, 64)]) {
        await assert.rejects(decodeVoxelSkin(new Blob([new Uint8Array(bytes)], { type: 'image/png' })), /64x64/)
      }
      const invalidLength = grayscalePng(64, 64)
      invalidLength.writeUInt32BE(12, 8)
      const invalidChunk = grayscalePng(64, 64)
      invalidChunk.write('IDAT', 12)
      for (const bytes of [PNG_SIGNATURE, grayscalePng(64, 64).subarray(0, 32), invalidLength, invalidChunk]) {
        await assert.rejects(decodeVoxelSkin(new Blob([new Uint8Array(bytes)], { type: 'image/png' })), /valid PNG IHDR header/)
      }
      assert.equal(decoderCalls, 0)
    } finally {
      restoreProperty(globalThis, 'createImageBitmap', bitmapDescriptor)
      restoreProperty(globalThis, 'document', documentDescriptor)
    }
  })

  it('rejects an explicitly non-PNG MIME type before decoding', async () => {
    await assert.rejects(
      decodeVoxelSkin(new Blob(['not a png'], { type: 'image/jpeg' })),
      /PNG image/,
    )
  })

  it('rejects PNG MIME data without the PNG file signature', async () => {
    await assert.rejects(
      decodeVoxelSkin(new Blob(['not a png'], { type: 'image/png' })),
      /valid PNG signature/,
    )
  })

  it('falls back to an HTML image when createImageBitmap rejects', async () => {
    const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const createUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    let bitmapAttempted = false
    let objectUrlRevoked = false
    const pixels = new Uint8ClampedArray(SKIN_64_LENGTH)
    for (let index = 3; index < pixels.length; index += 4) pixels[index] = 0xFF

    const image = {
      naturalWidth: 64,
      naturalHeight: 64,
      onerror: null as null | (() => void),
      onload: null as null | (() => void),
      removeAttribute() {},
      get src() {
        return ''
      },
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      },
    }
    const canvas = {
      height: 0,
      width: 0,
      getContext: () => ({
        clearRect() {},
        drawImage() {},
        getImageData: () => ({ data: pixels, height: 64, width: 64 }),
      }),
    }

    try {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: async () => {
          bitmapAttempted = true
          throw new Error('WebView2 bitmap decoder rejected the image')
        },
      })
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          createElement: (tag: string) => tag === 'img' ? image : canvas,
        },
      })
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: () => 'blob:voxel-skin-test',
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: () => {
          objectUrlRevoked = true
        },
      })

      const decoded = await decodeVoxelSkin(
        new Blob([new Uint8Array(grayscalePng(64, 64))], { type: 'image/png' }),
        'wide',
      )
      assert.equal(bitmapAttempted, true)
      assert.equal(objectUrlRevoked, true)
      assert.equal(decoded.width, 64)
      assert.equal(decoded.height, 64)
      assert.equal(decoded.model, 'wide')
    } finally {
      restoreProperty(globalThis, 'createImageBitmap', bitmapDescriptor)
      restoreProperty(globalThis, 'document', documentDescriptor)
      restoreProperty(URL, 'createObjectURL', createUrlDescriptor)
      restoreProperty(URL, 'revokeObjectURL', revokeUrlDescriptor)
    }
  })
})

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, property, descriptor)
  else Reflect.deleteProperty(target, property)
}
