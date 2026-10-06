/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { snapSliderValue } from './snapValue'

describe('slider default snapping', () => {
  it('includes both five-percent boundaries in symmetric and lighting ranges', () => {
    for (const [min, max, defaultValue] of [[-100, 100, 0], [0, 200, 100], [25, 200, 100]]) {
      const range = { min, max, defaultValue }
      for (const offset of [-5, -4, 0, 4, 5]) {
        assert.equal(snapSliderValue(defaultValue + offset, range), defaultValue)
      }
      for (const offset of [-6, 6]) {
        assert.equal(snapSliderValue(defaultValue + offset, range), defaultValue + offset)
      }
      assert.equal(snapSliderValue(min, range), min)
      assert.equal(snapSliderValue(max, range), max)
    }
  })

  it('measures the radius from the more distant limit of an asymmetric range', () => {
    const range = { min: -100, max: 100, defaultValue: 20 }
    assert.equal(snapSliderValue(14, range), 20)
    assert.equal(snapSliderValue(26, range), 20)
    assert.equal(snapSliderValue(13, range), 13)
    assert.equal(snapSliderValue(27, range), 27)
  })

  it('supports a default at either endpoint without expanding the slider range', () => {
    assert.equal(snapSliderValue(95.5, { min: 10, max: 100, defaultValue: 100 }), 100)
    assert.equal(snapSliderValue(95, { min: 10, max: 100, defaultValue: 100 }), 95)
    assert.equal(snapSliderValue(14.5, { min: 10, max: 100, defaultValue: 10 }), 10)
    assert.equal(snapSliderValue(15, { min: 10, max: 100, defaultValue: 10 }), 15)
  })

  it('includes decimal boundaries despite floating-point rounding and preserves outside steps', () => {
    const range = { min: 0.75, max: 6, defaultValue: 2 }
    assert.equal(snapSliderValue(1.8, range), 2)
    assert.equal(snapSliderValue(2.2, range), 2)
    assert.equal(snapSliderValue(1.75, range), 1.75)
    assert.equal(snapSliderValue(2.25, range), 2.25)
    assert.equal(snapSliderValue(0.07, { min: -1.5, max: 1.5, defaultValue: 0 }), 0)
    assert.equal(snapSliderValue(0.08, { min: -1.5, max: 1.5, defaultValue: 0 }), 0.08)
  })
})
