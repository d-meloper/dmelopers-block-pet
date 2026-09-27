/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MODEL_3D_CONFIG } from '@/config/model3d'

import {
  createFullContentRect,
  normalizeRealizedViewRect,
  normalizeVisibleContentRect,
  scanAlphaContentMeasurement,
  scanAlphaContentRect,
} from './contentBounds'

function pixels(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height * 4)
}

function setAlpha(
  data: Uint8Array,
  width: number,
  x: number,
  webglY: number,
  alpha = 255,
) {
  data[(webglY * width + x) * 4 + 3] = alpha
}

describe('visible content bounds', () => {
  it('returns a padded top-left rectangle from bottom-left WebGL pixels', () => {
    const data = pixels(8, 6)
    setAlpha(data, 8, 2, 1)
    setAlpha(data, 8, 5, 3)

    assert.deepEqual(scanAlphaContentRect(data, 8, 6, 1), {
      x: 1,
      y: 1,
      width: 6,
      height: 5,
    })
  })

  it('preserves fixed padding beyond composition edges', () => {
    const data = pixels(5, 4)
    setAlpha(data, 5, 0, 3)
    setAlpha(data, 5, 4, 0)

    assert.deepEqual(scanAlphaContentRect(data, 5, 4, 2), {
      x: -2,
      y: -2,
      width: 9,
      height: 8,
    })
  })

  it('adds the configured one-shot safety margin to a measured pixel', () => {
    const data = pixels(40, 40)
    setAlpha(data, 40, 20, 20)

    assert.deepEqual(scanAlphaContentRect(
      data,
      40,
      40,
      MODEL_3D_CONFIG.renderer.contentBoundsPaddingPixels,
    ), {
      x: 4,
      y: 3,
      width: 33,
      height: 33,
    })
  })

  it('returns undefined for an empty or undersized readback', () => {
    assert.equal(scanAlphaContentRect(pixels(4, 3), 4, 3), undefined)
    assert.equal(scanAlphaContentRect(new Uint8Array(4), 4, 3), undefined)
  })

  it('distinguishes an empty alpha readback from a successful rectangle', () => {
    const empty = scanAlphaContentMeasurement(pixels(4, 3), 4, 3)
    const visible = pixels(4, 3)
    setAlpha(visible, 4, 2, 1)

    assert.deepEqual(empty, {
      status: 'failure',
      reason: 'empty-alpha',
    })
    assert.deepEqual(scanAlphaContentMeasurement(visible, 4, 3, 0), {
      status: 'success',
      rect: { x: 2, y: 1, width: 1, height: 1 },
    })
  })

  it('honors an alpha threshold', () => {
    const data = pixels(3, 2)
    setAlpha(data, 3, 0, 0, 1)
    setAlpha(data, 3, 2, 1, 2)

    assert.deepEqual(scanAlphaContentRect(data, 3, 2, 0, 1), {
      x: 2,
      y: 0,
      width: 1,
      height: 1,
    })
  })

  it('normalizes invalid rectangles to the full composition', () => {
    assert.deepEqual(normalizeVisibleContentRect({
      x: Number.NaN,
      y: 0,
      width: 10,
      height: 10,
    }, 500, 422), createFullContentRect(500, 422))
  })

  it('preserves a fractional realized view outside the composition', () => {
    assert.deepEqual(normalizeRealizedViewRect({
      x: -7.25,
      y: 3.125,
      width: 420.75,
      height: 300.5,
    }, createFullContentRect(500, 422)), {
      x: -7.25,
      y: 3.125,
      width: 420.75,
      height: 300.5,
    })
  })

  it('falls back from an invalid realized view', () => {
    const fallback = { x: -2, y: 4, width: 100, height: 80 }
    assert.deepEqual(normalizeRealizedViewRect({
      x: 0,
      y: 0,
      width: Number.NaN,
      height: 10,
    }, fallback), fallback)
  })
})
