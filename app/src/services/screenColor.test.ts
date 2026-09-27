/* eslint-disable test/no-import-node-test */
import { theme } from 'ant-design-vue'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { appDarkAlgorithm, appLightAlgorithm } from '../config/theme'
import { createScreenColorAppearance } from './screenColor'

describe('screen eyedropper appearance', () => {
  it('converts actual light and dark app tokens to opaque Win32 colors', () => {
    const light = createScreenColorAppearance(appLightAlgorithm(theme.defaultSeed))
    const dark = createScreenColorAppearance(appDarkAlgorithm(theme.defaultSeed))
    assert.deepEqual(light, { background: 0xFFFFFF, border: 0xDAE6D6, muted: 0x595959 })
    assert.deepEqual(dark, { background: 0x202020, border: 0x3B3B3B, muted: 0xB1B1B1 })
  })

  it('flattens transparent token colors against the elevated background', () => {
    assert.deepEqual(createScreenColorAppearance({
      colorBgElevated: '#123',
      colorBorder: 'rgb(10, 20, 30)',
      colorTextSecondary: 'rgba(255, 0, 0, 0.5)',
    }), { background: 0x332211, border: 0x1E140A, muted: 0x1A1188 })
  })

  it('falls back to native defaults for unsupported or invalid tokens', () => {
    const tokens = appLightAlgorithm(theme.defaultSeed)
    for (const colorTextSecondary of ['red', '#12', 'rgba(0, 0, 0, 2)', 'rgb(300, 0, 0)', 'rgba(0, 0, 0)', 'rgb(, 0, 0)', 'rgba(0, 0, 0, NaN)', 'rgb(-1, 0, 0)']) {
      assert.equal(createScreenColorAppearance({ ...tokens, colorTextSecondary }), undefined)
    }
    assert.equal(createScreenColorAppearance({ ...tokens, colorBgElevated: 'rgba(255, 255, 255, 0.5)' }), undefined)
  })
})
