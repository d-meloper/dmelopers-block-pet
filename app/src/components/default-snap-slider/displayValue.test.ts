/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatSliderDisplayValue, fromSliderDisplayValue, sliderDisplayRange, toSliderDisplayValue } from './displayValue'

describe('slider display conversion', () => {
  it('places asymmetric authored defaults at zero and maps both halves independently', () => {
    for (const range of [
      { min: 0, max: 400, defaultValue: 100 },
      { min: -180, max: 180, defaultValue: -39 },
      { min: -3, max: 3, defaultValue: 0.3 },
      { min: 0.2, max: 1.4, defaultValue: 0.5 },
    ]) {
      assert.deepEqual(sliderDisplayRange(range), { min: -1, max: 1, defaultValue: 0, step: 0.01 })
      for (const [actual, displayed] of [[range.min, -1], [range.defaultValue, 0], [range.max, 1]]) {
        assert.equal(toSliderDisplayValue(actual, range), displayed)
        assert.equal(fromSliderDisplayValue(displayed, range), actual)
      }
      for (const displayed of [-0.77, -0.01, 0.01, 0.34]) {
        assert.ok(Math.abs(toSliderDisplayValue(fromSliderDisplayValue(displayed, range), range) - displayed) < 1e-12)
      }
    }
    const arm = { min: 0, max: 400, defaultValue: 100 }
    assert.equal(fromSliderDisplayValue(-0.5, arm), 50)
    assert.equal(fromSliderDisplayValue(0.5, arm), 250)
    assert.equal(fromSliderDisplayValue(0.01, arm), 103)
  })

  it('maps opacity 10..100 to 0..1 with its default on the right', () => {
    const range = { min: 10, max: 100, defaultValue: 100 }
    assert.deepEqual(sliderDisplayRange(range, 'unit'), { min: 0, max: 1, defaultValue: 1, step: 0.01 })
    for (const [actual, displayed] of [[10, 0], [55, 0.5], [100, 1]]) {
      assert.equal(toSliderDisplayValue(actual, range, 'unit'), displayed)
      assert.equal(fromSliderDisplayValue(displayed, range, 'unit'), actual)
    }
  })

  it('retains actual units and step for raw controls and does not quantize restored values', () => {
    const range = { min: 25, max: 200, defaultValue: 100, step: 1 }
    assert.deepEqual(sliderDisplayRange(range, 'raw'), range)
    assert.equal(toSliderDisplayValue(87.321, range, 'raw'), 87.321)
    const normalized = toSliderDisplayValue(87.321, range)
    assert.notEqual(normalized, Number(normalized.toFixed(2)))
    assert.ok(Math.abs(fromSliderDisplayValue(normalized, range) - 87.321) < 1e-12)
  })

  it('formats at most two decimals without negative zero or trailing zeroes', () => {
    for (const [value, expected] of [[0, '0'], [-0, '0'], [-0.004, '0'], [0.1, '0.1'], [0.127, '0.13'], [-1, '-1'], [1, '1']] as const) {
      assert.equal(formatSliderDisplayValue(value), expected)
    }
  })
})
