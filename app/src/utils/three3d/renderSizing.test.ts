/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PerspectiveCamera, Vector3 } from 'three'

import {
  applyVisibleContentViewOffset,
  normalizeOutputDimension,
  selectAdaptiveShadowMapSize,
} from './renderSizing'

describe('adaptive shadow-map sizing', () => {
  it('caps medium and default maps at 512 without enlarging small windows', () => {
    for (const [edge, medium, low] of [
      [128, 256, 256],
      [256, 256, 256],
      [257, 512, 256],
      [512, 512, 256],
      [513, 512, 256],
      [2000, 512, 256],
    ] as const) {
      assert.equal(selectAdaptiveShadowMapSize(edge, edge), medium)
      assert.equal(selectAdaptiveShadowMapSize(edge, edge, 'medium'), medium)
      assert.equal(selectAdaptiveShadowMapSize(edge, edge, 'low'), low)
    }
  })

  it('supersamples high quality at the 512px boundary', () => {
    assert.equal(selectAdaptiveShadowMapSize(512, 200, 'high'), 1024)
    assert.equal(selectAdaptiveShadowMapSize(200, 513, 'high'), 2048)
    assert.equal(selectAdaptiveShadowMapSize(4000, 4000, 'high'), 2048)
  })

  it('adapts to the longest edge within the supported cap', () => {
    assert.equal(selectAdaptiveShadowMapSize(100, 200), 256)
    assert.equal(selectAdaptiveShadowMapSize(500, 300), 512)
    assert.equal(selectAdaptiveShadowMapSize(513, 100), 512)
    assert.equal(selectAdaptiveShadowMapSize(2000, 2000), 512)
  })

  it('uses the minimum tier for invalid dimensions', () => {
    assert.equal(selectAdaptiveShadowMapSize(Number.NaN, -1), 256)
  })
})

describe('renderer output sizing', () => {
  it('preserves positive fractional logical dimensions', () => {
    assert.equal(normalizeOutputDimension(321.375), 321.375)
  })

  it('falls back to one logical pixel for invalid dimensions', () => {
    assert.equal(normalizeOutputDimension(0), 1)
    assert.equal(normalizeOutputDimension(Number.NaN), 1)
  })
})

describe('visible content camera view offset', () => {
  it('preserves a crop with fixed padding outside the composition', () => {
    const camera = new PerspectiveCamera(28, 1, 0.01, 100)
    camera.position.set(0, 0, 5)
    camera.lookAt(0, 0, 0)
    camera.aspect = 500 / 422
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    const point = new Vector3(0.5, 0.25, 0)
    const fullProjection = point.clone().project(camera)
    const fullPixelX = (fullProjection.x + 1) * 500 / 2
    const fullPixelY = (1 - fullProjection.y) * 422 / 2

    applyVisibleContentViewOffset(camera, 500, 422, {
      x: -12,
      y: -8,
      width: 540,
      height: 450,
    })
    const croppedProjection = point.clone().project(camera)
    const croppedPixelX = (croppedProjection.x + 1) * 540 / 2
    const croppedPixelY = (1 - croppedProjection.y) * 450 / 2

    assert.deepEqual(camera.view, {
      enabled: true,
      fullWidth: 500,
      fullHeight: 422,
      offsetX: -12,
      offsetY: -8,
      width: 540,
      height: 450,
    })
    assert.ok(Math.abs(croppedPixelX - (fullPixelX + 12)) < 1e-9)
    assert.ok(Math.abs(croppedPixelY - (fullPixelY + 8)) < 1e-9)
  })

  it('clears the view offset for the full composition', () => {
    const camera = new PerspectiveCamera(28, 1, 0.01, 100)
    camera.setViewOffset(500, 422, 10, 10, 100, 100)
    applyVisibleContentViewOffset(camera, 500, 422, {
      x: 0,
      y: 0,
      width: 500,
      height: 422,
    })

    assert.equal(camera.view?.enabled, false)
    assert.equal(camera.aspect, 500 / 422)
  })

  it('preserves a fractional realized view offset', () => {
    const camera = new PerspectiveCamera(28, 1, 0.01, 100)
    applyVisibleContentViewOffset(camera, 500, 422, {
      x: -0.4,
      y: 12.25,
      width: 401.6,
      height: 299.2,
    })

    assert.equal(camera.view?.offsetX, -0.4)
    assert.equal(camera.view?.offsetY, 12.25)
    assert.equal(camera.view?.width, 401.6)
    assert.equal(camera.view?.height, 299.2)
  })
})
