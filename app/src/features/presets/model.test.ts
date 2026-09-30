/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import type { Three3DRenderer } from '@/utils/three3d'

import { DEFAULT_DESK_SETTINGS, DESK_SETTING_KEYS } from '@/config/desk'
import { DEFAULT_DEVICE_COLORS, DEVICE_COLOR_KEYS } from '@/config/deviceColors'
import presetRanges from '@/config/presetRanges.json'
import { createDefaultPet3dPreset, preparePetStateForSync, useCatStore } from '@/stores/cat'
import { LEGACY_SKIN_APPEARANCE_KEYS } from '@/stores/petSettingsMigration'

import {
  applyPresetSnapshot,
  capturePresetSnapshot,
  clonePreset,
  createDefaultPresetSnapshot,
  createPresetCollection,
  isPresetSnapshot,
  migratePresetCollection,
  movePreset,
  nextPresetAfterDelete,
  orderedPresets,
  sanitizeStoredPresetCollection,
  uniquePresetName,
  updateActivePreset,
  validatePresetCollection,
  validatePresetName,
} from './model'
import { exportPortablePreset, parsePortablePreset, serializePortablePreset, validatePortablePreset } from './transfer'
import { BUILTIN_PRESET_ID } from './types'
import { applyPresetVisualSettings } from './visualSettings'

function store() {
  setActivePinia(createPinia())
  const value = useCatStore()
  value.init()
  return value
}

describe('preset ownership and persistence', () => {
  it('includes every tab-owned field and excludes common settings and runtime epochs', () => {
    const source = store()
    source.window.visible = false
    source.window.opacity = 45
    source.window.alwaysOnTop = true
    source.window.passThrough = true
    source.model.mirror = true
    source.model.eyebrowAnimationEnabled = false
    source.model.maxFPS = 30
    source.activePet3dPreset.viewportModeRevision = 87
    source.activePet3dPreset.mouseEnabled = false
    source.activePet3dPreset.keyboardLegendLanguage = 'en'
    source.activePet3dPreset.cameraZoomPercent = 140
    const snapshot = capturePresetSnapshot(source)
    assert.equal('visible' in snapshot, false)
    assert.equal(snapshot.opacity, 45)
    assert.equal(snapshot.mirror, true)
    assert.equal(snapshot.eyebrowAnimationEnabled, false)
    assert.equal(snapshot.preset.mouseEnabled, false)
    assert.equal(snapshot.preset.keyboardLegendLanguage, 'en')
    assert.equal('viewportModeRevision' in snapshot.preset, false)
    assert.equal('windowScalePercent' in snapshot.preset, false)
    assert.equal('maxFPS' in snapshot, false)
    const target = store()
    target.model.maxFPS = 99
    target.window.alwaysOnTop = false
    target.window.passThrough = false
    target.activePet3dPreset.viewportModeRevision = 120
    target.window.visible = false
    applyPresetSnapshot(target, snapshot)
    assert.equal(target.window.visible, true)
    assert.equal(target.model.maxFPS, 99)
    assert.equal(target.window.alwaysOnTop, false)
    assert.equal(target.window.passThrough, false)
    assert.equal(target.activePet3dPreset.viewportModeRevision, 121)
    assert.equal(target.activePet3dPreset.cameraZoomPercent, 140)
    snapshot.preset.manualViewportRect.width = 150
    assert.notEqual(target.activePet3dPreset.manualViewportRect.width, 150)
  })

  it('never restores fields outside the explicit scope even if an old or damaged snapshot carries them', () => {
    const target = store()
    const snapshot = createDefaultPresetSnapshot()
    const contaminated = {
      ...snapshot,
      preset: { ...snapshot.preset, windowScalePercent: 37, viewportModeRevision: 999 },
      appearance: { ...snapshot.appearance, schemaVersion: 0 },
    }
    const version = target.customization3d.schemaVersion
    applyPresetSnapshot(target, contaminated, 7)
    assert.equal(target.activePet3dPreset.windowScalePercent, 100)
    assert.equal(target.activePet3dPreset.viewportModeRevision, 7)
    assert.equal(target.customization3d.schemaVersion, version)
  })

  it('retains existing settings as an independent initial entry and survives JSON restore', () => {
    const source = store()
    source.activePet3dPreset.cameraZoomPercent = 153
    const saved = createPresetCollection(capturePresetSnapshot(source), '프리셋 1')
    source.activePet3dPreset.cameraZoomPercent = 82
    assert.equal(saved.entries[1].snapshot.preset.cameraZoomPercent, 153)
    const restored = clonePreset(saved)
    validatePresetCollection(restored)
    assert.equal(restored.activeId, 'initial')
    assert.equal(restored.entries[0].id, BUILTIN_PRESET_ID)
    assert.equal(restored.entries[0].snapshot.preset.cameraZoomPercent, 100)
  })

  it('copies factory settings only on an actual user edit, never normalization', () => {
    const collection = createPresetCollection()
    const snapshot = createDefaultPresetSnapshot()
    snapshot.preset.cameraZoomPercent = 126
    assert.equal(updateActivePreset(collection, snapshot, false, '기본값 사본'), false)
    assert.equal(collection.entries.length, 1)
    assert.equal(updateActivePreset(collection, snapshot, true, '기본값 사본'), true)
    assert.equal(collection.entries.length, 2)
    assert.equal(collection.entries[0].snapshot.preset.cameraZoomPercent, 100)
    snapshot.preset.cameraZoomPercent = 143
    updateActivePreset(collection, snapshot, true, '기본값 사본')
    assert.equal(collection.entries.length, 2)
    assert.equal(collection.entries[1].snapshot.preset.cameraZoomPercent, 143)
  })

  it('keeps same-skin presets independent through switching and settings initialization', () => {
    const source = store()
    const id = 'a'.repeat(64)
    source.customization3d.activeSkinLibraryEntryId = id
    source.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,aGVsbG8='
    source.updateDmeloperEyebrows({ color: '#123456', widthPixels: 4 })
    source.updateDmeloperPalmColor('#ABCDEF')
    const a = capturePresetSnapshot(source)
    source.updateDmeloperEyebrows({ color: '#654321', widthPixels: 1 })
    source.updateDmeloperPalmColor('#FEDCBA')
    const b = capturePresetSnapshot(source)
    for (const expected of [a, b, a]) {
      applyPresetSnapshot(source, expected)
      source.init()
      assert.deepEqual(source.activePet3dPreset.dmeloperEyebrows, expected.preset.dmeloperEyebrows)
      assert.equal(source.activePet3dPreset.dmeloperPalmColor, expected.preset.dmeloperPalmColor)
    }
  })

  it('preserves independent skin bytes when the shared library item is deleted', () => {
    const source = store()
    const id = 'a'.repeat(64)
    source.customization3d.activeSkinLibraryEntryId = id
    source.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,aGVsbG8='
    source.presetCollection = createPresetCollection(capturePresetSnapshot(source))
    const saved = clonePreset(source.presetCollection.entries[1].snapshot)
    source.handleSkinLibraryEntriesDeleted([id])
    assert.equal(source.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(source.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.deepEqual(source.presetCollection.entries[1].snapshot, saved)
    applyPresetSnapshot(source, source.presetCollection.entries[1].snapshot)
    assert.equal(source.customization3d.dmeloperSkinDataUrl, 'data:image/png;base64,aGVsbG8=')
    assert.equal(source.customization3d.activeSkinLibraryEntryId, id)
  })

  it('whole-program reset leaves only factory settings; tab reset changes the current entry', () => {
    const source = store()
    source.presetCollection = createPresetCollection(capturePresetSnapshot(source))
    source.activePet3dPreset.mouseEnabled = false
    source.resetEnvironment3d()
    updateActivePreset(source.presetCollection, capturePresetSnapshot(source), true, 'Copy')
    assert.equal(source.presetCollection.entries.length, 2)
    source.resetAllSettings()
    assert.equal(source.presetCollection.entries.length, 1)
    assert.equal(source.presetCollection.activeId, BUILTIN_PRESET_ID)
  })

  it('rejects unsupported or corrupt catalogs without mutating the evidence', () => {
    const future = { ...createPresetCollection(), schemaVersion: 999 }
    const before = clonePreset(future)
    assert.throws(() => validatePresetCollection(future))
    assert.deepEqual(future, before)
    const missing = createPresetCollection()
    missing.activeId = 'missing'
    assert.throws(() => validatePresetCollection(missing))
  })
})

describe('saved preset range recovery', () => {
  it('keeps in-range fractional inactive snapshots byte-for-byte identical on restore', () => {
    const target = store()
    const saved = createPresetCollection(createDefaultPresetSnapshot())
    saved.activeId = BUILTIN_PRESET_ID
    Object.assign(saved.entries[1].snapshot.preset, {
      petRotationDegrees: 3.3,
      petDeskOffset: -0.044,
      keyboardBaseXOffset: 0.088,
      keyboardBaseZOffset: -0.0495,
      mouseBaseXOffset: 0.066,
      mouseBaseZOffset: -0.0495,
    })
    Object.assign(saved.entries[1].snapshot.preset.dmeloperEyebrows, {
      spacingPixels: 1.665,
      widthPixels: 2.22,
      thicknessPixels: 0.599,
    })
    const before = JSON.stringify(saved)
    assert.equal(sanitizeStoredPresetCollection(saved, target.sanitizePet3dPreset), saved)
    target.presetCollection = saved
    target.init()
    assert.equal(JSON.stringify(target.presetCollection), before)
    assert.equal(target.presetCollection.activeId, BUILTIN_PRESET_ID)
  })

  it('clamps inactive cards before preview/export while retaining catalog identity and actual fractions', async () => {
    for (const edge of ['min', 'max'] as const) {
      const saved = createPresetCollection(createDefaultPresetSnapshot(), 'Saved 😶')
      saved.activeId = BUILTIN_PRESET_ID
      saved.entries[1].favorite = true
      const preset = saved.entries[1].snapshot.preset
      for (const [key, range] of Object.entries(presetRanges.preset)) {
        Reflect.set(preset, key, range[edge] + (edge === 'min' ? -10 : 10))
      }
      for (const [key, range] of Object.entries(presetRanges.eyebrows)) {
        Reflect.set(preset.dmeloperEyebrows, key, range[edge] + (edge === 'min' ? -10 : 10))
      }
      preset.cameraZoomPercent = 113.75
      preset.petRightArmBendPercent = 103.25
      preset.lighting.key.azimuthDegrees = -14.91
      preset.manualViewportRect.x = 12.5
      saved.entries[1].snapshot.appearance.minecraftSkinUsername = 'Fixture_User'
      const before = clonePreset(saved)
      const target = store()
      const schemaVersion = target.customization3d.schemaVersion
      target.presetCollection = saved
      target.init()
      const restored = target.presetCollection!
      assert.equal(restored.schemaVersion, saved.schemaVersion)
      assert.equal(restored.activeId, BUILTIN_PRESET_ID)
      assert.equal(target.customization3d.schemaVersion, schemaVersion)
      assert.deepEqual(restored.entries.map(({ id, name, favorite, builtin }) => ({ id, name, favorite, builtin })), before.entries.map(({ id, name, favorite, builtin }) => ({ id, name, favorite, builtin })))
      assert.deepEqual(restored.entries[0], before.entries[0])
      assert.deepEqual(saved, before, 'restoration must leave the source catalog untouched')
      const entry = restored.entries[1]
      for (const [key, range] of Object.entries(presetRanges.preset)) {
        assert.equal(Reflect.get(entry.snapshot.preset, key), range[edge], key)
      }
      for (const [key, range] of Object.entries(presetRanges.eyebrows)) {
        assert.equal(Reflect.get(entry.snapshot.preset.dmeloperEyebrows, key), range[edge], key)
      }
      assert.equal(entry.snapshot.preset.cameraZoomPercent, 113.75)
      assert.equal(entry.snapshot.preset.petRightArmBendPercent, 103.25)
      assert.equal(entry.snapshot.preset.lighting.key.azimuthDegrees, -14.91)
      assert.equal(entry.snapshot.preset.manualViewportRect.x, 12.5)
      assert.equal(target.activePet3dPreset.petRotationDegrees, 0, 'recovery must not activate the inactive card')

      const document = await exportPortablePreset(entry.name, entry.snapshot, 'nickname')
      const imported = parsePortablePreset(new TextEncoder().encode(serializePortablePreset(document)))
      assert.deepEqual(imported.settings.preset, entry.snapshot.preset)
      imported.settings.preset.petRotationDegrees = 90
      assert.throws(() => validatePortablePreset(imported), { code: 'invalidSettings' }, 'external files remain strictly validated')

      // Thumbnail and desktop rendering share this actual visual-settings path.
      const preview = new Map<string, unknown[]>()
      const renderer = new Proxy({} as Three3DRenderer, {
        get: (_target, key) => (...values: unknown[]) => preview.set(String(key), values),
      })
      applyPresetVisualSettings(renderer, { ...createDefaultPet3dPreset(), ...entry.snapshot.preset })
      assert.deepEqual(preview.get('setPetTransform'), [presetRanges.preset.petRotationDegrees[edge], presetRanges.preset.petDeskOffset[edge]])
      assert.deepEqual(preview.get('setKeyboardBasePosition'), [presetRanges.preset.keyboardBaseXOffset[edge], presetRanges.preset.keyboardBaseZOffset[edge]])
      assert.deepEqual(preview.get('setMouseBasePosition'), [presetRanges.preset.mouseBaseXOffset[edge], presetRanges.preset.mouseBaseZOffset[edge]])
      assert.deepEqual(preview.get('setDmeloperEyebrows'), [entry.snapshot.preset.dmeloperEyebrows])
      applyPresetSnapshot(target, entry.snapshot)
      assert.deepEqual(capturePresetSnapshot(target), entry.snapshot)
      const normalized = clonePreset(restored)
      target.init()
      assert.deepEqual(target.presetCollection, normalized)
    }
  })

  it('preserves unsupported/corrupt catalog evidence for validation instead of repairing it into acceptance', () => {
    const target = store()
    for (const damage of [
      (value: ReturnType<typeof createPresetCollection>) => value.schemaVersion = 999,
      (value: ReturnType<typeof createPresetCollection>) => value.entries[1].snapshot.preset.lighting.key.strengthPercent = Number.NaN,
      (value: ReturnType<typeof createPresetCollection>) => Reflect.set(value.entries[1].snapshot.preset, 'unknownField', 1),
    ]) {
      const saved = createPresetCollection(createDefaultPresetSnapshot())
      saved.entries[1].snapshot.preset.petRotationDegrees = 90
      damage(saved)
      assert.equal(sanitizeStoredPresetCollection(saved, target.sanitizePet3dPreset), saved)
      assert.equal(saved.entries[1].snapshot.preset.petRotationDegrees, 90)
      assert.throws(() => validatePresetCollection(saved))
    }
  })
})

describe('preset list operations', () => {
  it('keeps favorites first, preserves group order, and chooses a deterministic delete successor', () => {
    const collection = createPresetCollection(createDefaultPresetSnapshot())
    collection.entries.push({ ...clonePreset(collection.entries[1]), id: 'second', name: 'Second', favorite: true })
    collection.entries.push({ ...clonePreset(collection.entries[1]), id: 'third', name: 'Third' })
    assert.deepEqual(orderedPresets(collection).map(entry => entry.id), ['second', BUILTIN_PRESET_ID, 'initial', 'third'])
    movePreset(collection, 'third', 'initial')
    assert.equal(nextPresetAfterDelete(collection, 'third')?.id, 'initial')
    movePreset(collection, 'initial', 'second')
    assert.deepEqual(orderedPresets(collection).map(entry => entry.id), ['second', BUILTIN_PRESET_ID, 'third', 'initial'])
    assert.equal(nextPresetAfterDelete(collection, 'initial')?.id, 'third')
  })

  it('supports Unicode names, prevents accidental overwrite, and numbers automatic names', () => {
    const collection = createPresetCollection(createDefaultPresetSnapshot(), '작업 😶 安')
    assert.equal(validatePresetName(collection, '  새 작업 😶 安  '), '새 작업 😶 安')
    assert.throws(() => validatePresetName(collection, '작업 😶 安'))
    assert.throws(() => validatePresetName(collection, '   '))
    assert.throws(() => validatePresetName(collection, 'name\nline'))
    assert.equal(uniquePresetName(collection, '작업 😶 安'), '작업 😶 安 2')
    const longName = '😶'.repeat(255)
    collection.entries[1].name = longName
    const numbered = uniquePresetName(collection, longName)
    assert.equal([...numbered].length, 255)
    assert.equal(validatePresetName(collection, numbered), numbered)
    assert.equal(numbered.endsWith(' 2'), true)
  })

  it('always appends only a number for duplicate names, including localized defaults and long Unicode names', () => {
    const collection = createPresetCollection(createDefaultPresetSnapshot(), '작업 2')
    assert.equal(uniquePresetName(collection, 'App Defaults', true), 'App Defaults 2')
    assert.equal(uniquePresetName(collection, '작업 2', true), '작업 2 2')
    collection.entries.push({ ...clonePreset(collection.entries[1]), id: 'duplicate', name: '작업 2 2' })
    assert.equal(uniquePresetName(collection, '작업 2', true), '작업 2 3')
    const longName = '😶'.repeat(255)
    const numbered = uniquePresetName(collection, longName, true)
    collection.entries[1].name = numbered
    const next = uniquePresetName(collection, longName, true)
    assert.equal([...next].length, 255)
    assert.equal(next, `${'😶'.repeat(253)} 3`)
    assert.equal(validatePresetName(collection, next), next)
  })
})

it('upgrades every v1 preset palette before strict validation and keeps existing catalog choices', () => {
  const current = store()
  const source = createPresetCollection(capturePresetSnapshot(current), 'Saved')
  source.schemaVersion = 1
  source.entries[1].favorite = true
  source.entries[1].snapshot.preset.keyboardColor = '#123456'
  source.entries[1].snapshot.preset.cameraZoomPercent = 145
  for (const entry of source.entries) {
    for (const key of DEVICE_COLOR_KEYS) {
      if (entry.id !== 'initial' || key !== 'keyboardColor') delete (entry.snapshot.preset as Partial<typeof entry.snapshot.preset>)[key]
    }
  }
  const before = clonePreset(source)
  const incoming = preparePetStateForSync({ presetCollection: source })
  current.$patch(incoming)
  current.init()
  const migrated = current.presetCollection!
  validatePresetCollection(migrated)
  assert.equal(migrated.schemaVersion, 3)
  assert.equal(migrated.activeId, source.activeId)
  assert.equal(migrated.entries[1].favorite, true)
  assert.equal(migrated.entries[1].name, 'Saved')
  assert.equal(migrated.entries[1].snapshot.preset.cameraZoomPercent, 145)
  assert.equal(migrated.entries[1].snapshot.preset.keyboardColor, '#123456')
  for (const key of DEVICE_COLOR_KEYS) assert.equal(migrated.entries[0].snapshot.preset[key], DEFAULT_DEVICE_COLORS[key])
  assert.deepEqual(source, before)
  assert.equal(migratePresetCollection(migrated), migrated)
  const corrupt = clonePreset(before)
  corrupt.entries[1].snapshot.preset.keyboardColor = 'invalid'
  assert.throws(() => validatePresetCollection(migratePresetCollection(corrupt)))
})

it('migrates v2 skin memory into inert evidence while preserving each explicit preset appearance', () => {
  const current = store()
  const id = 'a'.repeat(64)
  const inactiveId = 'b'.repeat(64)
  current.customization3d.activeSkinLibraryEntryId = id
  current.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,aGVsbG8='
  current.updateDmeloperEyebrows({ color: '#123456', widthPixels: 4 })
  current.updateDmeloperPalmColor('#ABCDEF')
  const source = createPresetCollection(capturePresetSnapshot(current), 'Saved A')
  source.schemaVersion = 2
  const first = source.entries[1]
  const second = { ...clonePreset(first), id: 'second', name: 'Saved B' }
  second.snapshot.preset.dmeloperEyebrows.color = '#654321'
  second.snapshot.preset.dmeloperPalmColor = '#FEDCBA'
  source.entries.push(second)
  const oldMaps = {
    dmeloperEyebrowProfiles: {
      [id]: { ...first.snapshot.preset.dmeloperEyebrows, color: '#112233' },
      [inactiveId]: { ...first.snapshot.preset.dmeloperEyebrows, color: '#445566' },
    },
    dmeloperPalmManualColors: { [id]: '#778899', [inactiveId]: '#aabbcc' },
    dmeloperPalmAutomaticColors: { [inactiveId]: '#ddeeff' },
    pendingDmeloperEyebrowProfileMigration: { ...first.snapshot.preset.dmeloperEyebrows, color: '#000000' },
  }
  for (const entry of source.entries) {
    Object.assign(entry.snapshot, { visible: false })
    Object.assign(entry.snapshot.appearance, entry.builtin ? { dmeloperEyebrowProfiles: {} } : clonePreset(oldMaps))
  }
  const before = clonePreset(source)
  const migrated = migratePresetCollection(source)
  validatePresetCollection(migrated)
  assert.equal(migrated.activeId, source.activeId)
  assert.equal(migrated.entries.length, source.entries.length)
  assert.deepEqual(migrated.legacyAppearanceArchive?.initial, oldMaps)
  assert.deepEqual(migrated.legacyAppearanceArchive?.second, oldMaps)
  assert.equal(migrated.legacyAppearanceArchive?.[BUILTIN_PRESET_ID], undefined)
  for (const entry of migrated.entries) {
    assert.equal('visible' in entry.snapshot, false)
    assert.ok(LEGACY_SKIN_APPEARANCE_KEYS.every(key => !(key in entry.snapshot.appearance)))
    const original = source.entries.find(candidate => candidate.id === entry.id)!
    assert.deepEqual(entry.snapshot.preset, original.snapshot.preset)
  }
  for (const entry of [migrated.entries[1], migrated.entries[2], migrated.entries[1]]) {
    current.window.visible = false
    applyPresetSnapshot(current, entry.snapshot)
    current.init()
    assert.equal(current.window.visible, true)
    assert.deepEqual(capturePresetSnapshot(current), entry.snapshot)
  }
  assert.deepEqual(source, before)
  const restored = clonePreset(migrated)
  validatePresetCollection(restored)
  assert.equal(migratePresetCollection(restored), restored)
  Object.assign(restored.entries[1].snapshot.appearance, { dmeloperPalmManualColors: oldMaps.dmeloperPalmManualColors })
  assert.equal(isPresetSnapshot(restored.entries[1].snapshot), false, 'current snapshots cannot resurrect removed maps')
})

it('keeps live visibility outside snapshot equality and restores it separately for rollback', () => {
  const current = store()
  const shown = capturePresetSnapshot(current)
  current.window.visible = false
  assert.deepEqual(capturePresetSnapshot(current), shown)
  applyPresetSnapshot(current, shown, 42, false)
  assert.equal(current.window.visible, false)
  assert.equal(current.activePet3dPreset.viewportModeRevision, 42)
  applyPresetSnapshot(current, { ...shown, ...{ visible: false } })
  assert.equal(current.window.visible, true, 'retired visibility cannot override the load default')
  assert.equal(isPresetSnapshot({ ...shown, visible: false }), false)
  assert.equal(createPresetCollection().legacyAppearanceArchive, undefined)
})

it('captures and applies all six colors independently without changing common performance', () => {
  const current = store()
  const colors = { keyboardColor: '#112233', keyboardKeycapColor: '#445566', keyboardLegendColor: '#778899', keyboardPressedColor: '#aabbcc', mouseColor: '#ddeeff', mousePressedColor: '#123456' }
  Object.assign(current.activePet3dPreset, colors)
  const saved = capturePresetSnapshot(current)
  current.resetEnvironment3d()
  current.model.maxFPS = 47
  applyPresetSnapshot(current, saved)
  current.init()
  for (const key of DEVICE_COLOR_KEYS) assert.equal(current.activePet3dPreset[key], colors[key])
  assert.equal(current.model.maxFPS, 47)
})

it('adds default head size to existing version 3 catalogs without losing saved settings', () => {
  const legacy = createPresetCollection()
  Reflect.deleteProperty(legacy.entries[0].snapshot.preset, 'petHeadScalePercent')
  legacy.entries[0].snapshot.preset.petRotationDegrees = 37
  const migrated = migratePresetCollection(legacy)
  validatePresetCollection(migrated)
  assert.equal(migrated.entries[0].snapshot.preset.petHeadScalePercent, 100)
  assert.equal(migrated.entries[0].snapshot.preset.petRotationDegrees, 37)
  assert.equal(migratePresetCollection(migrated), migrated)
})

it('migrates missing eyebrow depth in every saved preset without changing explicit zero or input data', () => {
  const legacy = createPresetCollection(createDefaultPresetSnapshot())
  Reflect.deleteProperty(legacy.entries[0].snapshot.preset.dmeloperEyebrows, 'depthPercent')
  legacy.entries[1].snapshot.preset.dmeloperEyebrows.depthPercent = 0
  const before = JSON.stringify(legacy)
  const migrated = migratePresetCollection(legacy)
  validatePresetCollection(migrated)
  assert.equal(migrated.entries[0].snapshot.preset.dmeloperEyebrows.depthPercent, 100)
  assert.equal(migrated.entries[1].snapshot.preset.dmeloperEyebrows.depthPercent, 0)
  assert.equal(JSON.stringify(legacy), before)
  assert.equal(migratePresetCollection(migrated), migrated)
  const target = store()
  for (const entry of migrated.entries) {
    applyPresetSnapshot(target, entry.snapshot)
    assert.equal(capturePresetSnapshot(target).preset.dmeloperEyebrows.depthPercent, entry.snapshot.preset.dmeloperEyebrows.depthPercent)
  }
  applyPresetSnapshot(target, legacy.entries[0].snapshot)
  assert.equal(target.activePet3dPreset.dmeloperEyebrows.depthPercent, 100)
})

it('additively migrates desk settings in existing catalogs and retains each explicit desk choice', () => {
  const collection = createPresetCollection(createDefaultPresetSnapshot())
  const legacy = JSON.parse(JSON.stringify(collection))
  for (const entry of legacy.entries) {
    for (const key of DESK_SETTING_KEYS) delete entry.snapshot.preset[key]
  }
  legacy.entries[1].snapshot.preset.deskTransparent = false
  legacy.entries[1].snapshot.preset.deskColor = '#123aBC'
  const before = clonePreset(legacy)
  const migrated = migratePresetCollection(legacy)
  validatePresetCollection(migrated)
  assert.deepEqual(legacy, before)
  assert.equal(migrated.schemaVersion, collection.schemaVersion)
  for (const key of DESK_SETTING_KEYS) assert.equal(migrated.entries[0].snapshot.preset[key], DEFAULT_DESK_SETTINGS[key])
  assert.equal(migrated.entries[1].snapshot.preset.deskTransparent, false)
  assert.equal(migrated.entries[1].snapshot.preset.deskColor, '#123aBC')
  assert.equal(migrated.entries[1].snapshot.preset.deskHeightOffset, 0)
  assert.equal(migratePresetCollection(migrated), migrated)
  const target = store()
  applyPresetSnapshot(target, migrated.entries[1].snapshot)
  assert.deepEqual(capturePresetSnapshot(target).preset, migrated.entries[1].snapshot.preset)
  applyPresetSnapshot(target, legacy.entries[0].snapshot)
  for (const key of DESK_SETTING_KEYS) assert.equal(target.activePet3dPreset[key], DEFAULT_DESK_SETTINGS[key])
})

it('rejects explicit invalid desk values and unknown preset fields without masking them during migration', () => {
  for (const changes of [
    { deskTransparent: null },
    { deskTransparent: 'true' },
    { deskColor: '#12345' },
    { deskColor: null },
    { deskHeightOffset: -1.01 },
    { deskHeightOffset: 1.01 },
    { deskHeightOffset: Number.NaN },
    { deskHeightOffset: '0' },
    { deskHeightOffset: undefined },
    { deskEnabled: true },
  ]) {
    const collection = createPresetCollection()
    Object.assign(collection.entries[0].snapshot.preset, changes)
    assert.equal(isPresetSnapshot(collection.entries[0].snapshot), false)
    assert.throws(() => validatePresetCollection(migratePresetCollection(collection)))
  }
})
