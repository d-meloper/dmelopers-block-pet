import type { NormalizedVoxelSkin } from '@/utils/three3d/voxelSkin'

const SKIN_SIZE = 64
const FACE_SIZE = 8
const BASE_FACE_X = 8
const BASE_FACE_Y = 8
const HAT_FACE_X = 40
const HAT_FACE_Y = 8

function sourceOffset(x: number, y: number): number {
  return (y * SKIN_SIZE + x) * 4
}

function compositeChannel(
  baseChannel: number,
  baseAlpha: number,
  overlayChannel: number,
  overlayAlpha: number,
  outputAlpha: number,
): number {
  if (outputAlpha === 0) return 0
  return Math.round((
    overlayChannel * overlayAlpha
    + baseChannel * baseAlpha * (1 - overlayAlpha)
  ) / outputAlpha)
}

/** Compose the Java face and hat front layers into a nearest-neighbor square. */
export function createSkinFaceThumbnailPixels(
  skin: Pick<NormalizedVoxelSkin, 'data'>,
  size = 64,
): Uint8ClampedArray {
  if (skin.data.length !== SKIN_SIZE * SKIN_SIZE * 4) {
    throw new Error('Skin thumbnails require normalized 64x64 RGBA pixels.')
  }
  if (!Number.isInteger(size) || size < FACE_SIZE || size > 256 || size % FACE_SIZE !== 0) {
    throw new Error('Skin thumbnail size must be a multiple of 8 from 8 to 256.')
  }

  const scale = size / FACE_SIZE
  const output = new Uint8ClampedArray(size * size * 4)
  for (let faceY = 0; faceY < FACE_SIZE; faceY += 1) {
    for (let faceX = 0; faceX < FACE_SIZE; faceX += 1) {
      const base = sourceOffset(BASE_FACE_X + faceX, BASE_FACE_Y + faceY)
      const overlay = sourceOffset(HAT_FACE_X + faceX, HAT_FACE_Y + faceY)
      const baseAlpha = skin.data[base + 3] / 255
      const overlayAlpha = skin.data[overlay + 3] / 255
      const outputAlpha = overlayAlpha + baseAlpha * (1 - overlayAlpha)
      const pixel = [
        compositeChannel(
          skin.data[base],
          baseAlpha,
          skin.data[overlay],
          overlayAlpha,
          outputAlpha,
        ),
        compositeChannel(
          skin.data[base + 1],
          baseAlpha,
          skin.data[overlay + 1],
          overlayAlpha,
          outputAlpha,
        ),
        compositeChannel(
          skin.data[base + 2],
          baseAlpha,
          skin.data[overlay + 2],
          overlayAlpha,
          outputAlpha,
        ),
        Math.round(outputAlpha * 255),
      ] as const

      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const targetX = faceX * scale + x
          const targetY = faceY * scale + y
          output.set(pixel, (targetY * size + targetX) * 4)
        }
      }
    }
  }
  return output
}

function extractPngBase64(dataUrl: string): string {
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix) || dataUrl.length === prefix.length) {
    throw new Error('The browser did not encode a PNG thumbnail.')
  }
  return dataUrl.slice(prefix.length)
}

/** Encode the face thumbnail for the persistent Rust skin library. */
export async function createSkinFaceThumbnailPngBase64(
  skin: Pick<NormalizedVoxelSkin, 'data'>,
  size = 64,
): Promise<string> {
  const pixels = createSkinFaceThumbnailPixels(skin, size)
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(size, size)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('A 2D canvas is required to encode skin thumbnails.')
    const imageData = context.createImageData(size, size)
    imageData.data.set(pixels)
    context.putImageData(imageData, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  if (typeof document === 'undefined') {
    throw new TypeError('Canvas PNG encoding is unavailable in this environment.')
  }
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) throw new Error('A 2D canvas is required to encode skin thumbnails.')
  const imageData = context.createImageData(size, size)
  imageData.data.set(pixels)
  context.putImageData(imageData, 0, 0)
  return extractPngBase64(canvas.toDataURL('image/png'))
}

export function createSkinThumbnailDataUrl(thumbnailPngBase64: string): string {
  return `data:image/png;base64,${thumbnailPngBase64}`
}
