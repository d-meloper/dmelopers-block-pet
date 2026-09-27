/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createSkinFaceThumbnailPixels } from './skinThumbnail'

function setPixel(
  data: Uint8Array,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
) {
  data.set(color, (y * 64 + x) * 4)
}

function readPixel(data: Uint8ClampedArray, size: number, x: number, y: number) {
  return [...data.slice((y * size + x) * 4, (y * size + x) * 4 + 4)]
}

describe('skin face thumbnail composition', () => {
  it('composites the hat front over the face and scales with hard pixel edges', () => {
    const data = new Uint8Array(64 * 64 * 4)
    setPixel(data, 8, 8, [200, 100, 0, 255])
    setPixel(data, 40, 8, [0, 100, 200, 128])
    setPixel(data, 9, 8, [10, 20, 30, 255])

    const thumbnail = createSkinFaceThumbnailPixels({ data }, 16)
    assert.deepEqual(readPixel(thumbnail, 16, 0, 0), [100, 100, 100, 255])
    assert.deepEqual(readPixel(thumbnail, 16, 1, 1), [100, 100, 100, 255])
    assert.deepEqual(readPixel(thumbnail, 16, 2, 0), [10, 20, 30, 255])
  })

  it('preserves transparency and rejects malformed normalized input', () => {
    const transparent = createSkinFaceThumbnailPixels({
      data: new Uint8Array(64 * 64 * 4),
    }, 8)
    assert.deepEqual(readPixel(transparent, 8, 0, 0), [0, 0, 0, 0])

    assert.throws(
      () => createSkinFaceThumbnailPixels({ data: new Uint8Array(4) }),
      /normalized 64x64/,
    )
    assert.throws(
      () => createSkinFaceThumbnailPixels({ data: new Uint8Array(64 * 64 * 4) }, 10),
      /multiple of 8/,
    )
  })
})
