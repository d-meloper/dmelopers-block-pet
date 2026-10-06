import { DataArrayTexture } from 'three'

export interface LegendPixels {
  width: number
  height: number
  channels: 2 | 4
  data: Uint8Array
}

export function packLegendCanvas(canvas: HTMLCanvasElement): LegendPixels {
  const { width, height } = canvas
  const pixels = canvas.getContext('2d')!.getImageData(0, 0, width, height).data
  let channels: 2 | 4 = 2
  for (let index = 0; index < pixels.length; index += 4) {
    // Hidden RGB also participates in filtering; never discard it based on alpha.
    if (pixels[index] !== pixels[index + 1] || pixels[index] !== pixels[index + 2]) {
      channels = 4
      break
    }
  }
  const data = new Uint8Array(width * height * channels)
  for (let row = 0; row < height; row++) {
    const sourceOffset = row * width * 4
    const targetOffset = (height - 1 - row) * width * channels
    if (channels === 4) {
      data.set(pixels.subarray(sourceOffset, sourceOffset + width * 4), targetOffset)
    } else {
      for (let column = 0; column < width; column++) {
        data[targetOffset + column * 2] = pixels[sourceOffset + column * 4]
        data[targetOffset + column * 2 + 1] = pixels[sourceOffset + column * 4 + 3]
      }
    }
  }
  return { width, height, channels, data }
}

// Compression is CPU-only. GPU format, filtering and mip generation stay RGBA/sRGB.
// Accessing .image.data outside uploads can retain a temporary expanded buffer;
// production never serializes or clones these private generated textures.
export function createPackedLegendTexture(glyphs: readonly LegendPixels[]): DataArrayTexture {
  const first = glyphs[0]
  if (!first || glyphs.some(glyph => glyph.width !== first.width || glyph.height !== first.height)) {
    throw new Error('Keyboard legend array dimensions do not match.')
  }
  const texture = new DataArrayTexture(null, first.width, first.height, glyphs.length)
  // Later language-cache growth must not mutate an existing texture's source.
  const sourceGlyphs = glyphs.slice()
  let expanded: Uint8Array | undefined
  const getUploadPixels = () => {
    if (expanded) return expanded
    const layerByteLength = first.width * first.height * 4
    const restored = new Uint8Array(layerByteLength * sourceGlyphs.length)
    sourceGlyphs.forEach((glyph, layer) => {
      const offset = layer * layerByteLength
      if (glyph.channels === 4) {
        restored.set(glyph.data, offset)
      } else {
        for (let index = 0; index < glyph.data.length; index += 2) {
          const target = offset + index * 2
          const brightness = glyph.data[index]
          restored[target] = brightness
          restored[target + 1] = brightness
          restored[target + 2] = brightness
          restored[target + 3] = glyph.data[index + 1]
        }
      }
    })
    // Publish only a complete expansion; failure leaves the source retryable.
    expanded = restored
    return restored
  }
  Object.defineProperty(texture.image, 'data', { enumerable: true, get: getUploadPixels })
  // Three invokes this only after reading pixels and generating mips.
  texture.onUpdate = () => {
    expanded = undefined
  }
  texture.addEventListener('dispose', () => {
    expanded = undefined
  })
  return texture
}
