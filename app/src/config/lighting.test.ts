/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { captureBroadcastScene } from '@/features/broadcast/scene'
import { applyPresetSnapshot, capturePresetSnapshot, createPresetCollection, migratePresetCollection, validatePresetCollection } from '@/features/presets/model'
import { parsePortablePreset, serializePortablePreset } from '@/features/presets/transfer'
import { preparePetStateForSync, useCatStore } from '@/stores/cat'

import { createDefaultLightingSettings, isLightingSettings, migratePresetLighting, normalizeLightingSettings } from './lighting'

it('discards retired controls, fills missing angles and rejects invalid supported values', () => {
  const legacy = { lighting: { brightnessPercent: 0, exposurePercent: 400, toneMapping: 'none', referenceFrame: 'scene', fill: { enabled: true }, rim: { enabled: true }, ambient: { enabled: true }, hemisphere: { enabled: false }, shadow: { enabled: false }, key: { enabled: false, intensityPercent: 0, color: '#123456', azimuthDegrees: 0 } } }
  const original = structuredClone(legacy)
  const result = migratePresetLighting(legacy)
  assert.equal(result.lighting.key.color, '#123456')
  assert.equal(result.lighting.key.azimuthDegrees, 0)
  assert.ok(isLightingSettings(result.lighting))
  assert.deepEqual(Object.keys(result.lighting), ['key'])
  assert.deepEqual(Object.keys(result.lighting.key).sort(), ['azimuthDegrees', 'color', 'elevationDegrees', 'strengthPercent'])
  assert.equal(result.lighting.key.strengthPercent, 100)
  assert.deepEqual(legacy, original)
  assert.equal(migratePresetLighting(result), result)
  for (const lighting of [null, [], { key: null }, { key: { color: 'red' } }, { key: { elevationDegrees: 91 } }, { key: { azimuthDegrees: Number.NaN } }, { key: { strengthPercent: 24 } }, { key: { strengthPercent: 201 } }, { key: { strengthPercent: null } }, { key: { extra: true } }, { extra: true }]) {
    assert.equal(isLightingSettings(migratePresetLighting({ lighting }).lighting), false)
  }
  assert.ok(isLightingSettings(normalizeLightingSettings(legacy.lighting)))
  assert.equal(normalizeLightingSettings({ key: { azimuthDegrees: 5000 } }).key.azimuthDegrees, 180)
  assert.equal(normalizeLightingSettings({ key: { strengthPercent: 5000 } }).key.strengthPercent, 200)
  assert.equal(normalizeLightingSettings({ key: { strengthPercent: 0 } }).key.strengthPercent, 25)
})

it('upgrades old authored pastel defaults while retaining customized lighting', () => {
  const legacy = { lighting: { key: { color: '#FFF4E8', azimuthDegrees: -38.99099404250548, elevationDegrees: 43.89945474962074 } } }
  const defaults = createDefaultLightingSettings()
  assert.deepEqual(defaults.key, { color: '#ffffff', azimuthDegrees: -39, elevationDegrees: 44, strengthPercent: 100 })
  assert.deepEqual(migratePresetLighting(legacy).lighting, defaults)
  assert.deepEqual(normalizeLightingSettings(legacy.lighting), defaults)
  setActivePinia(createPinia())
  const store = useCatStore()
  store.$patch(preparePetStateForSync({ customization3d: { preset: legacy } }))
  store.init()
  assert.deepEqual(store.activePet3dPreset.lighting, defaults)
  store.activePet3dPreset.lighting.key.color = '#123456'
  store.$patch(preparePetStateForSync({ customization3d: { preset: { cameraZoomPercent: 125 } } }))
  assert.equal(store.activePet3dPreset.lighting.key.color, '#123456')
  const custom = { lighting: { key: { color: '#123456', azimuthDegrees: 25, elevationDegrees: 30 } } }
  assert.deepEqual(migratePresetLighting(custom).lighting, { key: { ...custom.lighting.key, strengthPercent: 100 } })
  const current = { lighting: { key: { ...legacy.lighting.key, strengthPercent: 90 } } }
  assert.equal(migratePresetLighting(current), current)
  assert.deepEqual(normalizeLightingSettings(current.lighting), current.lighting)
})

it('retains lighting through local initialization, snapshots, catalog migration, OBS and scoped resets', () => {
  setActivePinia(createPinia())
  let store = useCatStore()
  store.init()
  const lighting = createDefaultLightingSettings()
  lighting.key.color = '#abcdef'
  lighting.key.azimuthDegrees = 45
  lighting.key.elevationDegrees = 0
  lighting.key.strengthPercent = 25
  store.activePet3dPreset.lighting = lighting
  store.shadowQualitySelection = 'low'
  const snapshot = capturePresetSnapshot(store)
  const saved = JSON.parse(JSON.stringify(store.$state))
  setActivePinia(createPinia())
  store = useCatStore()
  store.$patch(saved)
  store.init()
  assert.deepEqual(store.activePet3dPreset.lighting, lighting)
  assert.deepEqual(captureBroadcastScene(store).preset.lighting, lighting)
  store.resetLighting()
  assert.equal(store.shadowQualitySelection, 'low')
  assert.deepEqual(store.activePet3dPreset.lighting, createDefaultLightingSettings())
  applyPresetSnapshot(store, snapshot)
  assert.deepEqual(store.activePet3dPreset.lighting, lighting)
  store.activePet3dPreset.lighting.key.color = '#111111'
  assert.equal(snapshot.preset.lighting.key.color, '#abcdef')
  const collection = createPresetCollection(snapshot)
  Reflect.deleteProperty(collection.entries[0].snapshot.preset, 'lighting')
  const migrated = migratePresetCollection(collection)
  validatePresetCollection(migrated)
  assert.deepEqual(migrated.entries[0].snapshot.preset.lighting, createDefaultLightingSettings())
  assert.deepEqual(migrated.entries[1].snapshot.preset.lighting, lighting)
  assert.equal(migratePresetCollection(migrated), migrated)
  store.resetScene3d()
  assert.deepEqual(store.activePet3dPreset.lighting, createDefaultLightingSettings())
  assert.equal(store.shadowQualitySelection, 'low')
})

it('round trips lighting through portable v1 and rejects invalid nested fields', () => {
  const legacy = readFileSync(new URL('../features/presets/fixtures/portable-v1.json', import.meta.url))
  const document = parsePortablePreset(legacy)
  assert.deepEqual(document.settings.preset.lighting, createDefaultLightingSettings())
  document.settings.preset.lighting.key.azimuthDegrees = 90
  document.settings.preset.lighting.key.color = '#123456'
  const bytes = () => new TextEncoder().encode(JSON.stringify(document))
  for (const strengthPercent of [25, 75, 100, 125, 200]) {
    document.settings.preset.lighting.key.strengthPercent = strengthPercent
    assert.deepEqual(parsePortablePreset(new TextEncoder().encode(serializePortablePreset(document))), document)
  }
  Object.assign(document.settings.preset.lighting, { toneMapping: 'none', brightnessPercent: 0, fill: { enabled: true } })
  Object.assign(document.settings.preset.lighting.key, { enabled: false, intensityPercent: 0 })
  const restored = parsePortablePreset(bytes())
  assert.deepEqual(restored.settings.preset.lighting, { key: { color: '#123456', azimuthDegrees: 90, elevationDegrees: createDefaultLightingSettings().key.elevationDegrees, strengthPercent: 200 } })
  assert.deepEqual(parsePortablePreset(new TextEncoder().encode(serializePortablePreset(document))).settings.preset.lighting, restored.settings.preset.lighting)
  for (const strengthPercent of [24, 201]) {
    document.settings.preset.lighting.key.strengthPercent = strengthPercent
    assert.throws(() => parsePortablePreset(bytes()))
  }
  document.settings.preset.lighting.key.strengthPercent = 100
  document.settings.preset.lighting.key.elevationDegrees = 91
  assert.throws(() => parsePortablePreset(bytes()))
  document.settings.preset.lighting = createDefaultLightingSettings()
  Object.assign(document.settings.preset.lighting.key, { unknown: true })
  assert.throws(() => parsePortablePreset(bytes()))
})
