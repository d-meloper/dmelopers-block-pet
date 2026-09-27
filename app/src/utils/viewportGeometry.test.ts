/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  clampRectToWorkArea,
  clampViewportToMonitors,
  createViewportGeometry,
  getCenteredViewportPosition,
  getRectDistanceSquared,
  getViewportPlacementRect,
  getViewportVirtualOrigin,
  normalizeViewportRect,
  selectViewportMonitor,
} from './viewportGeometry'

const virtualSize = { width: 500, height: 422 }

describe('viewport geometry', () => {
  it('rounds measured bounds outwards without clipping the safety envelope', () => {
    assert.deepEqual(normalizeViewportRect({
      x: -10.2,
      y: 20.4,
      width: 80.4,
      height: 500.2,
    }, virtualSize), {
      x: -11,
      y: 20,
      width: 82,
      height: 501,
    })
    assert.deepEqual(normalizeViewportRect({
      x: Number.NaN,
      y: 0,
      width: 10,
      height: 10,
    }, virtualSize), { x: 0, y: 0, ...virtualSize })
  })

  it('preserves source bounds that extend beyond every virtual edge', () => {
    const rect = { x: -25, y: -10, width: 550, height: 450 }

    assert.deepEqual(normalizeViewportRect(rect, virtualSize), rect)
    assert.deepEqual(getViewportPlacementRect(rect, virtualSize, true), {
      x: -25,
      y: -10,
      width: 550,
      height: 450,
    })
  })

  it('mirrors only the desktop placement while preserving the source crop', () => {
    const sourceRect = { x: 40, y: 30, width: 200, height: 300 }

    assert.deepEqual(getViewportPlacementRect(sourceRect, virtualSize, true), {
      x: 260,
      y: 30,
      width: 200,
      height: 300,
    })
    assert.deepEqual(getViewportPlacementRect(sourceRect, virtualSize, false), sourceRect)
  })

  it('rounds scaled physical crop edges outwards and preserves virtual origin', () => {
    const geometry = createViewportGeometry({
      mirrored: false,
      scaleFactor: 1.25,
      sourceRect: { x: 10, y: 20, width: 101, height: 51 },
      virtualOrigin: { x: -200, y: 300 },
      virtualSize,
      windowScalePercent: 50,
    })

    assert.deepEqual(geometry.physicalOffset, { x: 6, y: 12 })
    assert.deepEqual(geometry.physicalSize, { width: 64, height: 33 })
    assert.deepEqual(geometry.nativeRect, {
      x: -194,
      y: 312,
      width: 64,
      height: 33,
    })
    assert.deepEqual(geometry.outputLogicalSize, { width: 51.2, height: 26.4 })
    assert.deepEqual(geometry.realizedSourceRect, {
      x: 9.6,
      y: 19.2,
      width: 102.4,
      height: 52.8,
    })
    assert.ok(Math.abs(
      geometry.realizedSourceRect.width / geometry.realizedSourceRect.height
      - geometry.outputLogicalSize.width / geometry.outputLogicalSize.height,
    ) < 1e-12)
    assert.deepEqual(
      getViewportVirtualOrigin(geometry.nativeRect, geometry.physicalOffset),
      { x: -200, y: 300 },
    )
  })

  it('maps fractional outward padding back through a mirrored source view', () => {
    const geometry = createViewportGeometry({
      mirrored: true,
      scaleFactor: 1.25,
      sourceRect: { x: 40, y: 20, width: 101, height: 51 },
      virtualOrigin: { x: 0, y: 0 },
      virtualSize,
      windowScalePercent: 50,
    })

    assert.ok(geometry.realizedSourceRect.x <= geometry.sourceRect.x)
    assert.ok(geometry.realizedSourceRect.y <= geometry.sourceRect.y)
    assert.ok(
      geometry.realizedSourceRect.x + geometry.realizedSourceRect.width
      >= geometry.sourceRect.x + geometry.sourceRect.width,
    )
    assert.ok(
      geometry.realizedSourceRect.y + geometry.realizedSourceRect.height
      >= geometry.sourceRect.y + geometry.sourceRect.height,
    )
    assert.ok(Math.abs(
      geometry.realizedSourceRect.width / geometry.realizedSourceRect.height
      - geometry.physicalSize.width / geometry.physicalSize.height,
    ) < 1e-12)
  })

  it('preserves outward coverage and aspect across scale, DPR, and mirror combinations', () => {
    const sourceRect = { x: 37, y: 29, width: 173, height: 211 }
    for (const windowScalePercent of [10, 50, 100]) {
      for (const scaleFactor of [1, 1.25, 1.5, 2]) {
        for (const mirrored of [false, true]) {
          const geometry = createViewportGeometry({
            mirrored,
            scaleFactor,
            sourceRect,
            virtualOrigin: { x: -1200, y: 75 },
            virtualSize,
            windowScalePercent,
          })
          const physicalScale = windowScalePercent / 100 * scaleFactor
          const placement = getViewportPlacementRect(
            sourceRect,
            virtualSize,
            mirrored,
          )

          assert.equal(
            geometry.physicalOffset.x,
            Math.floor(placement.x * physicalScale),
          )
          assert.equal(
            geometry.physicalOffset.y,
            Math.floor(placement.y * physicalScale),
          )
          assert.equal(
            geometry.physicalSize.width,
            Math.ceil((placement.x + placement.width) * physicalScale)
            - Math.floor(placement.x * physicalScale),
          )
          assert.equal(
            geometry.physicalSize.height,
            Math.ceil((placement.y + placement.height) * physicalScale)
            - Math.floor(placement.y * physicalScale),
          )
          assert.ok(geometry.realizedSourceRect.x <= sourceRect.x)
          assert.ok(geometry.realizedSourceRect.y <= sourceRect.y)
          assert.ok(
            geometry.realizedSourceRect.x + geometry.realizedSourceRect.width
            >= sourceRect.x + sourceRect.width,
          )
          assert.ok(
            geometry.realizedSourceRect.y + geometry.realizedSourceRect.height
            >= sourceRect.y + sourceRect.height,
          )
          assert.ok(Math.abs(
            geometry.realizedSourceRect.width / geometry.realizedSourceRect.height
            - geometry.outputLogicalSize.width / geometry.outputLogicalSize.height,
          ) < 1e-12)
        }
      }
    }
  })

  it('does not accumulate virtual-origin drift across crop and mirror restores', () => {
    const origin = { x: -1440, y: 180 }
    const cases = [
      { mirrored: false, sourceRect: { x: 0, y: 0, width: 500, height: 422 } },
      { mirrored: false, sourceRect: { x: 43, y: 17, width: 291, height: 350 } },
      { mirrored: true, sourceRect: { x: -8, y: 4, width: 430, height: 440 } },
    ]

    for (const [index, candidate] of cases.entries()) {
      const geometry = createViewportGeometry({
        ...candidate,
        scaleFactor: [1, 1.25, 1.5][index],
        virtualOrigin: origin,
        virtualSize,
        windowScalePercent: [100, 50, 10][index],
      })
      assert.deepEqual(
        getViewportVirtualOrigin(
          geometry.nativeRect,
          geometry.physicalOffset,
        ),
        origin,
      )
    }
  })

  it('centers a cropped native rect inside a negative work area', () => {
    assert.deepEqual(getCenteredViewportPosition(
      { x: 0, y: 0, width: 301, height: 201 },
      { x: -1920, y: 40, width: 1920, height: 1040 },
    ), { x: -1110, y: 460 })
  })

  it('recomputes the centered top-left when mixed-DPI changes physical size', () => {
    const workArea = { x: 0, y: 40, width: 1920, height: 1040 }
    const sourceRect = { x: 40, y: 30, width: 201, height: 301 }
    const atOne = createViewportGeometry({
      mirrored: false,
      scaleFactor: 1,
      sourceRect,
      virtualOrigin: { x: 0, y: 0 },
      virtualSize,
      windowScalePercent: 100,
    })
    const atOneAndHalf = createViewportGeometry({
      mirrored: false,
      scaleFactor: 1.5,
      sourceRect,
      virtualOrigin: { x: 0, y: 0 },
      virtualSize,
      windowScalePercent: 100,
    })

    const firstPosition = getCenteredViewportPosition(atOne.nativeRect, workArea)
    const secondPosition = getCenteredViewportPosition(
      atOneAndHalf.nativeRect,
      workArea,
    )
    assert.notDeepEqual(firstPosition, secondPosition)
    assert.equal(
      secondPosition.x * 2 + atOneAndHalf.nativeRect.width,
      workArea.x * 2 + workArea.width,
    )
    assert.equal(
      secondPosition.y * 2 + atOneAndHalf.nativeRect.height,
      workArea.y * 2 + workArea.height,
    )
  })
})

describe('viewport monitor containment', () => {
  const monitors = [
    {
      id: 'left',
      workArea: { x: -1920, y: 40, width: 1920, height: 1040 },
    },
    {
      id: 'primary',
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    },
  ]

  it('selects the work area with the largest content overlap', () => {
    assert.equal(selectViewportMonitor({
      x: -100,
      y: 100,
      width: 400,
      height: 300,
    }, monitors)?.id, 'primary')
  })

  it('uses the previous monitor as a stable tie-breaker', () => {
    const rect = { x: -100, y: 100, width: 200, height: 200 }

    assert.equal(selectViewportMonitor(rect, monitors, 'left')?.id, 'left')
    assert.equal(selectViewportMonitor(rect, monitors, 'primary')?.id, 'primary')
  })

  it('selects the nearest work area when content is in a monitor gap', () => {
    const distantMonitors = [
      { id: 'left', workArea: { x: 0, y: 0, width: 100, height: 100 } },
      { id: 'right', workArea: { x: 300, y: 0, width: 100, height: 100 } },
    ]
    const rect = { x: 220, y: 20, width: 20, height: 20 }

    assert.equal(selectViewportMonitor(rect, distantMonitors)?.id, 'right')
    assert.equal(
      getRectDistanceSquared(rect, distantMonitors[1].workArea),
      60 ** 2,
    )
  })

  it('clamps against taskbar-adjusted work-area edges', () => {
    const clamped = clampRectToWorkArea(
      { x: -30, y: 10, width: 300, height: 200 },
      { x: 0, y: 40, width: 1920, height: 1040 },
    )

    assert.deepEqual(clamped, {
      delta: { x: 30, y: 30 },
      rect: { x: 0, y: 40, width: 300, height: 200 },
    })
  })

  it('aligns oversized content to the work-area origin', () => {
    assert.deepEqual(clampRectToWorkArea(
      { x: 100, y: 200, width: 700, height: 500 },
      { x: 20, y: 40, width: 600, height: 400 },
    ), {
      delta: { x: -80, y: -160 },
      rect: { x: 20, y: 40, width: 700, height: 500 },
    })
  })

  it('returns both the chosen monitor and clamp delta', () => {
    const result = clampViewportToMonitors(
      { x: 1800, y: 1000, width: 300, height: 200 },
      monitors,
      'primary',
    )

    assert.equal(result?.monitor.id, 'primary')
    assert.deepEqual(result?.delta, { x: -180, y: -160 })
    assert.deepEqual(result?.rect, {
      x: 1620,
      y: 840,
      width: 300,
      height: 200,
    })
  })
})
