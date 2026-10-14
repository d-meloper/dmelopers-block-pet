/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import type { PetMotionSettings } from '@/config/petMotion'
import type { Three3DRenderer } from '@/utils/three3d'

import { DEFAULT_PET_PRESET } from '@/config/defaultSettings'
import { migratePetMotionSettings, PET_MOTION_SETTING_KEYS } from '@/config/petMotion'
import { preparePetStateForSync, useBlockStore } from '@/stores/block'

import { defaultPresetSettings, inspectPresetCompatibility, projectPresetSettings } from './compatibility'
import { applyPresetSnapshot, capturePresetSnapshot, clonePreset, createDefaultPresetSnapshot, createPresetCollection, migratePresetCollection } from './model'
import { exportPortablePreset, parsePortablePreset, serializePortablePreset } from './transfer'
import { applyPresetVisualSettings } from './visualSettings'

const motion: PetMotionSettings = {
  petHeadbuttMaxRadiusOffset: 0.6,
  petTypingMaxRadiusOffset: -0.8,
  petHeadbuttRecoilEnabled: false,
  petHeadbuttRecoilStrengthPercent: 185.5,
  petHeadbuttRecoilWobblePercent: 12.5,
  petTypingHandLiftPercent: 300,
  petTypingBodyMotionPercent: 0,
  petTypingReturnSpeedPercent: 400,
}
const pick = (value: object) => Object.fromEntries(PET_MOTION_SETTING_KEYS.map(key => [key, Reflect.get(value, key)]))
const defaults = pick(DEFAULT_PET_PRESET)

it('saves hidden mode controls independently through actual Pinia snapshots, JSON restart and preset restore', () => {
  setActivePinia(createPinia())
  const store = useBlockStore()
  for (const mode of ['default', 'headbutt'] as const) {
    store.updateActivePet3dPreset({ ...motion, petAnimationMode: mode })
    const snapshot = capturePresetSnapshot(store)
    assert.deepEqual(pick(snapshot.preset), motion)
    const restored = useBlockStore(createPinia())
    restored.$patch(preparePetStateForSync(JSON.parse(JSON.stringify(store.$state))))
    assert.deepEqual(pick(restored.activePet3dPreset), motion)
    applyPresetSnapshot(restored, clonePreset(snapshot))
    assert.deepEqual(pick(restored.activePet3dPreset), motion)
    restored.activePet3dPreset.petTypingHandLiftPercent = 100
    assert.equal(snapshot.preset.petTypingHandLiftPercent, 300)
  }
  for (const reset of [store.resetPetBehavior, store.resetDmeloperEyebrows, store.resetEnvironment3d, store.resetSceneView3d]) {
    reset()
    assert.deepEqual(pick(store.activePet3dPreset), motion)
  }
  store.resetActivePet3dPreset()
  assert.deepEqual(pick(store.activePet3dPreset), defaults)
})

it('fills missing live state and all supported old catalog versions without changing explicit values or retained source', () => {
  setActivePinia(createPinia())
  const store = useBlockStore()
  store.updateActivePet3dPreset(motion)
  store.$patch(preparePetStateForSync({ customization3d: { preset: { cameraZoomPercent: 137 } } }))
  assert.deepEqual(pick(store.activePet3dPreset), defaults)
  for (const schemaVersion of [1, 2, 3, 4]) {
    const collection = createPresetCollection()
    collection.schemaVersion = schemaVersion
    const snapshot = createDefaultPresetSnapshot()
    Object.assign(snapshot.preset, motion)
    Reflect.deleteProperty(snapshot.preset, 'petTypingHandLiftPercent')
    Reflect.deleteProperty(snapshot.preset, 'petHeadbuttMaxRadiusOffset')
    Reflect.deleteProperty(snapshot.preset, 'petTypingMaxRadiusOffset')
    const sourceSettings = { preset: { petTypingHandLiftPercent: 'future-value' } }
    collection.entries.push({ id: 'motion', name: 'Motion', favorite: false, snapshot, sourceSettings })
    const before = clonePreset(collection)
    const restored = migratePresetCollection(collection) as typeof collection
    assert.deepEqual(pick(restored.entries[0].snapshot.preset), { ...motion, petTypingHandLiftPercent: 100, petHeadbuttMaxRadiusOffset: 0, petTypingMaxRadiusOffset: 0 })
    assert.deepEqual(restored.entries[0].sourceSettings, sourceSettings)
    assert.deepEqual(collection, before)
    assert.equal(migratePresetCollection(restored), restored)
  }
  const invalid = { petTypingHandLiftPercent: 'invalid', petHeadbuttRecoilEnabled: null }
  const migrated = migratePetMotionSettings(invalid)
  assert.equal(migrated.petTypingHandLiftPercent, 'invalid')
  assert.equal(migrated.petHeadbuttRecoilEnabled, null)
})

it('supports exact numeric boundaries/fractions and retains rejected import leaves while projecting current values', () => {
  const numeric = [
    ['petTypingMaxRadiusOffset', -1, 1],
    ['petHeadbuttMaxRadiusOffset', -1, 1],
    ['petHeadbuttRecoilStrengthPercent', 0, 200],
    ['petHeadbuttRecoilWobblePercent', 0, 100],
    ['petTypingHandLiftPercent', 0, 300],
    ['petTypingBodyMotionPercent', 0, 300],
    ['petTypingReturnSpeedPercent', 50, 400],
  ] as const
  for (const [key, min, max] of numeric) {
    for (const value of [min, min + 0.125, max]) {
      const source = defaultPresetSettings()
      source.preset[key] = value
      assert.deepEqual(inspectPresetCompatibility(source), [])
      assert.equal(projectPresetSettings(source).preset[key], value)
    }
    for (const value of [min - 0.01, max + 0.01, '100', null]) {
      const source = defaultPresetSettings()
      Reflect.set(source.preset, key, value)
      const current = defaultPresetSettings()
      Object.assign(current.preset, motion)
      const before = clonePreset(source)
      assert.equal(inspectPresetCompatibility(source).some(issue => issue.path.join('.') === `preset.${key}`), true)
      assert.equal(projectPresetSettings(source, current).preset[key], motion[key])
      assert.deepEqual(source, before)
    }
  }
  for (const value of [true, false, 'false', 0, null]) {
    const source = defaultPresetSettings()
    Reflect.set(source.preset, 'petHeadbuttRecoilEnabled', value)
    assert.equal(inspectPresetCompatibility(source).length, typeof value === 'boolean' ? 0 : 1)
  }
})

it('round-trips all controls in portable v1 and preserves invalid original values on re-export', async () => {
  const snapshot = createDefaultPresetSnapshot()
  Object.assign(snapshot.preset, motion)
  snapshot.appearance.minecraftSkinUsername = 'Fixture_User'
  const exported = await exportPortablePreset('Motion', snapshot, 'nickname')
  const imported = parsePortablePreset(new TextEncoder().encode(serializePortablePreset(exported)))
  assert.equal(imported.version, 1)
  assert.deepEqual(pick(imported.settings.preset), motion)
  const document = JSON.parse(readFileSync(new URL('./fixtures/portable-v1.json', import.meta.url), 'utf8'))
  Object.assign(document.settings.preset, motion, { petTypingReturnSpeedPercent: 401, petHeadbuttRecoilEnabled: 'false', petHeadbuttMaxRadiusOffset: 2 })
  const rejected = parsePortablePreset(new TextEncoder().encode(JSON.stringify(document)))
  assert.equal(rejected.settings.preset.petTypingReturnSpeedPercent, 100)
  assert.equal(rejected.settings.preset.petHeadbuttRecoilEnabled, true)
  assert.equal(rejected.settings.preset.petHeadbuttMaxRadiusOffset, 0)
  assert.deepEqual(rejected.sourceSettings, document.settings)
  assert.deepEqual(JSON.parse(serializePortablePreset(rejected)).settings, document.settings)
})

it('applies stored controls on the shared renderer path and resets missing legacy controls instead of retaining the prior preset', () => {
  const calls = new Map<string, unknown>()
  const renderer = new Proxy({}, {
    get: (_, key) => (value: unknown) => {
      calls.set(String(key), clonePreset(value))
    },
  }) as Three3DRenderer
  const preset = createDefaultPresetSnapshot().preset
  Object.assign(preset, motion)
  applyPresetVisualSettings(renderer, { ...DEFAULT_PET_PRESET, ...preset })
  assert.deepEqual(calls.get('setTypingMotionSettings'), motion)
  assert.deepEqual(calls.get('setHeadbuttRecoilSettings'), motion)
  assert.equal(calls.get('setHeadbuttMaxRadiusOffset'), 0.6)
  for (const key of PET_MOTION_SETTING_KEYS) Reflect.deleteProperty(preset, key)
  applyPresetVisualSettings(renderer, preset as typeof DEFAULT_PET_PRESET)
  assert.deepEqual(calls.get('setTypingMotionSettings'), defaults)
  assert.deepEqual(calls.get('setHeadbuttRecoilSettings'), defaults)
  assert.equal(calls.get('setHeadbuttMaxRadiusOffset'), 0)
})
