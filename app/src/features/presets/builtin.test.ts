/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { builtinPresets } from './builtin'
import { createPresetCollection, isPresetSnapshot, validatePresetCollection } from './model'

function translated(language: string) {
  const names = JSON.parse(readFileSync(new URL(`../../locales/${language}.json`, import.meta.url), 'utf8')).pages.preference.presets.builtinNames
  return builtinPresets(key => names[key.split('.').at(-1)!])
}

it('provides the four authored scenes in a stable order without storing assets or personal identities', () => {
  const entries = translated('ko-KR')
  assert.deepEqual(entries.map(entry => entry.name), ['기본', '기본 (저녁 노을)', '정면', '대두 키보드'])
  assert.deepEqual(translated('en-US').map(entry => entry.name), ['Default', 'Default (Sunset)', 'Front', 'Big Head Keyboard'])
  assert.deepEqual(entries.map(entry => entry.id), translated('en-US').map(entry => entry.id))
  for (const entry of entries) {
    assert.equal(entry.origin, 'builtin')
    assert.equal(entry.favorite, false)
    assert.equal(isPresetSnapshot(entry.snapshot), true)
    assert.equal(entry.snapshot.appearance.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.equal(entry.snapshot.appearance.dmeloperSkinDataUrl, undefined)
    assert.equal(entry.snapshot.appearance.minecraftSkinUsername, undefined)
  }
  assert.equal(entries[0].snapshot.preset.deskWidthOffset, -0.28)
  assert.equal(entries[1].snapshot.preset.lighting.key.azimuthDegrees, 90.20999999999998)
  assert.equal(entries[2].snapshot.preset.sceneRotationOffsetDegrees, 21.599999999999998)
  assert.equal(entries[2].snapshot.preset.petLeftArmSpreadDegrees, 14.850000000000001)
  assert.equal(entries[3].snapshot.preset.petHeadScalePercent, 150)
  assert.equal(entries[3].snapshot.preset.keyboardScalePercent, 152)
  assert.equal(entries[3].snapshot.preset.mouseEnabled, false)
})

it('keeps each runtime copy independent and rejects bundled entries in the persistent user catalog', () => {
  const entries = translated('ko-KR')
  entries[0].name = 'edited'
  entries[0].snapshot.preset.dmeloperEyebrows.color = '#abcdef'
  assert.equal(entries[1].snapshot.preset.dmeloperEyebrows.color, '#523830')
  assert.equal(translated('ko-KR')[0].name, '기본')
  assert.equal(translated('ko-KR')[0].snapshot.preset.dmeloperEyebrows.color, '#523830')
  const catalog = createPresetCollection()
  assert.doesNotThrow(() => validatePresetCollection(catalog))
  for (const entry of entries) {
    assert.throws(() => validatePresetCollection({ ...catalog, entries: [entry] }), /presets.errors.load/)
    const { origin: _origin, ...withoutOrigin } = entry
    assert.throws(() => validatePresetCollection({ ...catalog, entries: [withoutOrigin] }), /presets.errors.load/)
  }
})
