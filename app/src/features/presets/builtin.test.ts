/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import type { Three3DRenderer } from '@/utils/three3d'

import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'

import type { PresetSnapshot } from './types'

import { builtinPresets } from './builtin'
import { presetSettings } from './compatibility'
import { applyPresetSnapshot, capturePresetSnapshot, clonePreset, createPresetCollection, isExecutablePresetSnapshot, validatePresetCollection } from './model'
import { preparePresetSkin } from './skin'
import { installPresetSkinBrowser } from './skin.test.utils'
import { exportPortablePreset, parsePortablePreset, resolvePortablePreset, serializePortablePreset } from './transfer'
import { applyPresetVisualSettings } from './visualSettings'

function translated(language: string) {
  const names = JSON.parse(readFileSync(new URL(`../../locales/${language}.json`, import.meta.url), 'utf8')).pages.preference.presets.builtinNames
  return builtinPresets(key => names[key.split('.').at(-1)!])
}

it('provides the six authored scenes in a stable order without storing assets or personal identities', () => {
  const entries = translated('ko-KR')
  assert.deepEqual(entries.map(entry => entry.name), ['기본', '기본 (저녁 노을)', '기본 (박치기)', '몸통 박치기', '정면', '대두 키보드'])
  assert.deepEqual(translated('en-US').map(entry => entry.name), ['Default', 'Default (Sunset)', 'Default (Headbutt)', 'Torso Headbutt', 'Front', 'Big Head Keyboard'])
  assert.deepEqual(entries.map(entry => entry.id), ['builtin:preset:default', 'builtin:preset:sunset', 'builtin:preset:headbutt', 'builtin:preset:torsoHeadbutt', 'builtin:preset:front', 'builtin:preset:bigHeadKeyboard'])
  assert.deepEqual(entries.map(entry => entry.id), translated('en-US').map(entry => entry.id))
  assert.deepEqual(entries.map(entry => entry.snapshot.preset.petAnimationMode), ['default', 'default', 'headbutt', 'headbutt', 'default', 'default'])
  for (const entry of entries) {
    assert.equal(entry.origin, 'builtin')
    assert.equal(entry.favorite, false)
    assert.equal(isExecutablePresetSnapshot(entry.snapshot), true)
    assert.equal(entry.snapshot.appearance.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.equal(entry.snapshot.appearance.dmeloperSkinDataUrl, undefined)
    assert.equal(entry.snapshot.appearance.minecraftSkinUsername, undefined)
  }
  assert.equal(entries[0].snapshot.preset.deskWidthOffset, -0.28)
  assert.equal(entries[1].snapshot.preset.lighting.key.azimuthDegrees, 90.20999999999998)
  assert.equal(entries[4].snapshot.preset.sceneRotationOffsetDegrees, 21.599999999999998)
  assert.equal(entries[4].snapshot.preset.petLeftArmSpreadDegrees, 14.850000000000001)
  assert.equal(entries[5].snapshot.preset.petHeadScalePercent, 150)
  assert.equal(entries[5].snapshot.preset.keyboardScalePercent, 152)
  assert.equal(entries[5].snapshot.preset.mouseEnabled, false)
})

function snapshotHash(snapshot: PresetSnapshot) {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)]))
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(sorted(snapshot))).digest('hex')
}

it('retains both captured snapshots exactly after resolving their verified bundled PNG', async () => {
  const bytes = readFileSync(new URL('../../../src-tauri/assets/models/dmeloper/default.png', import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'c79c163fcde7edd727499d449421dae7a1f5e5d1004152512c84b68656099b88')
  // Canonical hashes of the owner's two captured snapshots, including their PNG.
  const hashes = ['2f0e5eaeb340f2ebfb065ab14340060aca0d850fae20c02935e8b08b0c28ba5f', '8401c3fc9dd9b91403e9506b0b6f49310b34783624e41c83ebda394809e6f41f']
  const browser = installPresetSkinBrowser()
  try {
    for (const [index, entry] of translated('ko-KR').slice(2, 4).entries()) {
      const before = clonePreset(entry.snapshot)
      const prepared = await preparePresetSkin(entry.snapshot)
      assert.equal(snapshotHash(prepared), hashes[index])
      assert.deepEqual(entry.snapshot, before, 'asset resolution must keep the authored template immutable')
      setActivePinia(createPinia())
      const store = useBlockStore()
      applyPresetSnapshot(store, prepared)
      assert.deepEqual(capturePresetSnapshot(store), prepared)

      const exported = await exportPortablePreset(entry.name, prepared, 'image')
      const imported = parsePortablePreset(new TextEncoder().encode(serializePortablePreset(exported)))
      assert.deepEqual(imported.settings, presetSettings(prepared))
      assert.equal(imported.skin.mode, 'image')
      const resolved = await resolvePortablePreset(imported)
      assert.deepEqual(presetSettings(resolved.snapshot), presetSettings(prepared))
      assert.equal(resolved.snapshot.appearance.dmeloperSkinDataUrl, browser.dataUrl)
      assert.equal(resolved.snapshot.appearance.dmeloperSkinModel, 'wide')
      assert.equal(resolved.snapshot.appearance.minecraftSkinUsername, undefined)
      assert.deepEqual(entry.snapshot, before)
    }
  } finally {
    browser.restore()
  }
})

it('keeps each runtime copy independent and rejects bundled entries in the persistent user catalog', () => {
  const entries = translated('ko-KR')
  entries[0].name = 'edited'
  entries[0].snapshot.preset.dmeloperEyebrows.color = '#abcdef'
  assert.equal(entries[1].snapshot.preset.dmeloperEyebrows.color, '#523830')
  assert.equal(translated('ko-KR')[0].name, '기본')
  assert.equal(translated('ko-KR')[0].snapshot.preset.dmeloperEyebrows.color, '#523830')
  entries[2].snapshot.preset.dmeloperEyebrows.color = '#abcdef'
  assert.equal(entries[3].snapshot.preset.dmeloperEyebrows.color, '#5E3E33')
  assert.equal(translated('ko-KR')[2].snapshot.preset.dmeloperEyebrows.color, '#5E3E33')
  const catalog = createPresetCollection()
  assert.doesNotThrow(() => validatePresetCollection(catalog))
  for (const entry of entries) {
    assert.throws(() => validatePresetCollection({ ...catalog, entries: [entry] }), /presets.errors.load/)
    const { origin: _origin, ...withoutOrigin } = entry
    assert.throws(() => validatePresetCollection({ ...catalog, entries: [withoutOrigin] }), /presets.errors.load/)
  }
})

it('forwards each authored headbutt pose and appearance through the shared visual application path', () => {
  for (const [index, entry] of translated('ko-KR').slice(2, 4).entries()) {
    const calls = new Map<string, unknown[]>()
    const renderer = new Proxy({}, {
      get: (_, key) => (...values: unknown[]) => calls.set(String(key), clonePreset(values)),
    }) as Three3DRenderer
    applyPresetVisualSettings(renderer, { ...createDefaultPet3dPreset(), ...entry.snapshot.preset })
    assert.deepEqual(calls.get('setAnimationMode'), ['headbutt'])
    assert.deepEqual(calls.get('setPetHeadScalePercent'), [index === 0 ? 100 : 115])
    assert.deepEqual(calls.get('setPetArmsDisabled'), [index === 1, index === 1])
    assert.deepEqual(calls.get('setShoulderTorsoConnected'), [false])
    assert.deepEqual(calls.get('setHeadbuttMaxRadiusOffset'), [0])
    assert.deepEqual(calls.get('setHeadbuttRecoilSettings'), [{
      petHeadbuttRecoilEnabled: true,
      petHeadbuttRecoilStrengthPercent: 50,
      petHeadbuttRecoilWobblePercent: 50,
      petTypingHandLiftPercent: 100,
      petTypingBodyMotionPercent: 100,
      petTypingReturnSpeedPercent: 100,
      petHeadbuttMaxRadiusOffset: 0,
      petTypingMaxRadiusOffset: 0,
    }])
    assert.deepEqual(calls.get('setDmeloperEyebrows'), [entry.snapshot.preset.dmeloperEyebrows])
    assert.deepEqual(calls.get('setDmeloperPalmColor'), ['#FFDFCE'])
  }
})
