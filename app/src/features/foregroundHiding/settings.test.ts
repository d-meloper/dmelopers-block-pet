/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createForegroundHidingSettings, isForegroundApplicationPath, isForegroundHidingSettings, MAX_FOREGROUND_HIDING_RULES } from './settings'

describe('foreground hiding settings', () => {
  it('requires absolute Windows executable paths and bounded canonical rule arrays', () => {
    for (const valid of ['C:\\Program Files\\Browser\\chrome.exe', 'D:\\도구\\APP.EXE', '\\\\server\\share\\app.exe']) assert.equal(isForegroundApplicationPath(valid), true, valid)
    for (const invalid of ['app.exe', 'C:app.exe', '/usr/bin/app.exe', 'C:\\app.dll', 'C:\\..\\app.exe', 'C:\\folder.\\app.exe', 'C:\\folder\\app.exe:stream', '\\\\server\\app.exe', 'C:\\bad?\\app.exe']) assert.equal(isForegroundApplicationPath(invalid), false, invalid)
    const config = { enabled: true, applications: ['C:\\app.exe'], sites: ['example.com'], future: { keep: true } }
    assert.equal(isForegroundHidingSettings(config), true)
    for (const invalid of [undefined, null, [], true, {}, { enabled: true }, { ...config, enabled: 1 }, { ...config, applications: 'C:\\app.exe' }, { ...config, applications: Array.from({ length: MAX_FOREGROUND_HIDING_RULES + 1 }, () => 'C:\\app.exe') }]) assert.equal(isForegroundHidingSettings(invalid), false)
    assert.equal(isForegroundHidingSettings({ ...config, applications: Array.from({ length: MAX_FOREGROUND_HIDING_RULES }, () => 'C:\\app.exe'), sites: Array.from({ length: MAX_FOREGROUND_HIDING_RULES }, () => 'example.com') }), true)
  })

  it('resets known fields with independent arrays and preserves unknown extensions', () => {
    const first = createForegroundHidingSettings({ enabled: true, applications: ['C:\\app.exe'], sites: null, future: { keep: 'source' } })
    const other = createForegroundHidingSettings()
    first.applications.push('C:\\different.exe')
    assert.deepEqual(other, { enabled: false, applications: [] })
    assert.equal((first as unknown as { sites: unknown }).sites, null)
    assert.deepEqual((first as unknown as { future: unknown }).future, { keep: 'source' })
  })
})
