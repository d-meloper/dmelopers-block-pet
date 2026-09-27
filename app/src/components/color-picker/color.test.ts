/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { hexToHsv, hexToRgb, hsvToHex, normalizeHex, pointToSv, rgbToHex } from './color'

describe('opaque RGB color picker', () => {
  it('validates complete RGB hex input without accepting partial, alpha or CSS values', () => {
    assert.equal(normalizeHex(' abcdef '), '#ABCDEF')
    for (const invalid of ['#fff', '#11223344', 'red', 'rgb(1,2,3)', '#GG1122', '']) assert.equal(normalizeHex(invalid), undefined)
  })

  it('round trips color sectors, greys and intermediate screen colors without channel changes', () => {
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const hex = rgbToHex([r, g, b])
          assert.deepEqual(hexToRgb(hex), [r, g, b])
          assert.equal(hsvToHex(hexToHsv(hex)), hex)
        }
      }
    }
    assert.equal(hsvToHex({ h: 360, s: 100, v: 100 }), '#FF0000')
    assert.equal(hexToHsv('#808080', 240).h, 240)
    assert.equal(hsvToHex({ h: 240, s: 100, v: 100 }), '#0000FF')
  })

  it('clamps captured pointer drags beyond the square and maps its corners exactly', () => {
    assert.deepEqual(pointToSv(0, 0, 240, 150), { s: 0, v: 100 })
    assert.deepEqual(pointToSv(240, 150, 240, 150), { s: 100, v: 0 })
    assert.deepEqual(pointToSv(120, 75, 240, 150), { s: 50, v: 50 })
    assert.deepEqual(pointToSv(-100, 250, 240, 150), { s: 0, v: 0 })
    assert.deepEqual(pointToSv(900, -100, 240, 150), { s: 100, v: 100 })
  })
})
