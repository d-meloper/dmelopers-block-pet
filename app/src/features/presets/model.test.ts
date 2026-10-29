/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { DESK_SETTING_KEYS, LEGACY_DESK_SETTINGS } from '@/config/desk'
import { DEFAULT_DEVICE_COLORS, DEVICE_COLOR_KEYS } from '@/config/deviceColors'
import { preparePetStateForSync, useBlockStore } from '@/stores/block'
import { LEGACY_SKIN_APPEARANCE_KEYS } from '@/stores/petSettingsMigration'

import type { PresetCollection, PresetSnapshot } from './types'

import { inspectPresetCompatibility, isPresetSourceSettings, presetSettings, presetSource, projectPresetSettings } from './compatibility'
import {
  applyPresetSnapshot,
  capturePresetSnapshot,
  clonePreset,
  createDefaultPresetSnapshot,
  createPresetCollection,
  isExecutablePresetSnapshot,
  isPresetSnapshot,
  migratePresetCollection,
  movePreset,
  orderedPresets,
  uniquePresetName,
  validatePresetCollection,
  validatePresetName,
} from './model'

const DEFAULT_PRESET_ID = 'default'

function savedCatalog(snapshot: PresetSnapshot = createDefaultPresetSnapshot(), name = 'Preset 1'): PresetCollection {
  return {
    ...createPresetCollection(),
    activeId: 'initial',
    entries: [
      { id: DEFAULT_PRESET_ID, name: 'Default', favorite: false, snapshot: createDefaultPresetSnapshot() },
      { id: 'initial', name, favorite: false, snapshot: clonePreset(snapshot) },
    ],
  }
}

function store() {
  setActivePinia(createPinia())
  const value = useBlockStore()
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
    source.activePet3dPreset.petAnimationMode = 'headbutt'
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
    assert.equal(snapshot.preset.petAnimationMode, 'headbutt')
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
    assert.equal(target.activePet3dPreset.petAnimationMode, 'headbutt')
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
    const saved = savedCatalog(capturePresetSnapshot(source), '프리셋 1')
    source.activePet3dPreset.cameraZoomPercent = 82
    assert.equal(saved.entries[1].snapshot.preset.cameraZoomPercent, 153)
    const restored = clonePreset(saved)
    validatePresetCollection(restored)
    assert.equal(restored.activeId, 'initial')
    assert.equal(restored.entries[0].id, DEFAULT_PRESET_ID)
    assert.equal(restored.entries[0].snapshot.preset.cameraZoomPercent, 100)
  })

  it('copies stored snapshots into current settings without linking either value', () => {
    const target = store()
    const saved = savedCatalog()
    const before = clonePreset(saved)
    target.presetCollection = saved
    applyPresetSnapshot(target, saved.entries[1].snapshot)
    target.activePet3dPreset.cameraZoomPercent = 170
    target.updateDmeloperPalmColor('#123456')
    assert.deepEqual(target.presetCollection, before)
    applyPresetSnapshot(target, saved.entries[1].snapshot)
    assert.equal(target.activePet3dPreset.cameraZoomPercent, 100)
    assert.deepEqual(target.presetCollection, before)
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
    source.presetCollection = savedCatalog(capturePresetSnapshot(source))
    const saved = clonePreset(source.presetCollection.entries[1].snapshot)
    source.handleSkinLibraryEntriesDeleted([id])
    assert.equal(source.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(source.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.deepEqual(source.presetCollection.entries[1].snapshot, saved)
    applyPresetSnapshot(source, source.presetCollection.entries[1].snapshot)
    assert.equal(source.customization3d.dmeloperSkinDataUrl, 'data:image/png;base64,aGVsbG8=')
    assert.equal(source.customization3d.activeSkinLibraryEntryId, id)
  })

  it('whole-program reset clears the list; tab reset changes only current settings', () => {
    const source = store()
    source.presetCollection = savedCatalog(capturePresetSnapshot(source))
    const before = clonePreset(source.presetCollection)
    source.activePet3dPreset.mouseEnabled = false
    source.resetEnvironment3d()
    assert.deepEqual(source.presetCollection, before)
    assert.equal(source.presetCollection.entries.length, 2)
    source.resetAllSettings({ deleteSkins: false, resetPresets: true })
    assert.equal(source.presetCollection.entries.length, 0)
    assert.equal(source.presetCollection.activeId, null)
  })

  it('rejects unsupported or corrupt catalogs without mutating the evidence', () => {
    const future = { ...savedCatalog(), schemaVersion: 999 }
    const before = clonePreset(future)
    assert.throws(() => validatePresetCollection(future))
    assert.deepEqual(future, before)
    const missing = savedCatalog()
    missing.activeId = 'missing'
    assert.throws(() => validatePresetCollection(missing))
  })
})

describe('saved preset range recovery', () => {
  it('keeps in-range fractional inactive snapshots byte-for-byte identical on restore', () => {
    const target = store()
    const saved = savedCatalog(createDefaultPresetSnapshot())
    saved.activeId = DEFAULT_PRESET_ID
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
    target.presetCollection = saved
    target.init()
    assert.equal(JSON.stringify(target.presetCollection), before)
    assert.equal(target.presetCollection.activeId, DEFAULT_PRESET_ID)
  })

  it('retains unsupported saved values as source while applying only the executable catalog projection', () => {
    const target = store()
    const saved = savedCatalog()
    saved.entries[1].snapshot.preset.petRotationDegrees = 90
    saved.entries[1].snapshot.preset.petDeskOffset = -0.044
    const before = clonePreset(saved)
    target.presetCollection = saved
    target.init()
    const migrated = target.presetCollection!
    assert.deepEqual(presetSource(migrated.entries[1]), presetSettings(before.entries[1].snapshot))
    assert.ok(inspectPresetCompatibility(presetSource(migrated.entries[1])).some(issue => issue.path[1] === 'petRotationDegrees'))
    assert.equal(isExecutablePresetSnapshot(migrated.entries[1].snapshot), true)
    const retained = clonePreset(migrated)
    applyPresetSnapshot(target, target.presetCollection.entries[1].snapshot)
    assert.equal(target.activePet3dPreset.petRotationDegrees, createDefaultPresetSnapshot().preset.petRotationDegrees)
    assert.equal(target.activePet3dPreset.petDeskOffset, -0.044)
    assert.deepEqual(target.presetCollection, retained)
    target.init()
    assert.deepEqual(target.presetCollection, retained)
    assert.equal(before.entries[1].snapshot.preset.petRotationDegrees, 90)
  })

  it('preserves unsupported/corrupt catalog evidence for validation instead of repairing it into acceptance', () => {
    const target = store()
    for (const damage of [
      (value: ReturnType<typeof createPresetCollection>) => value.schemaVersion = 999,
      (value: ReturnType<typeof createPresetCollection>) => value.entries[1].snapshot.preset.lighting.key.strengthPercent = Number.NaN,
    ]) {
      const saved = savedCatalog(createDefaultPresetSnapshot())
      saved.entries[1].snapshot.preset.petRotationDegrees = 90
      damage(saved)
      target.presetCollection = saved
      target.init()
      assert.deepEqual(target.presetCollection, saved)
      assert.equal(saved.entries[1].snapshot.preset.petRotationDegrees, 90)
      assert.throws(() => validatePresetCollection(saved))
    }
  })
})

describe('preset list operations', () => {
  it('keeps favorites first and preserves order within each group', () => {
    const collection = savedCatalog(createDefaultPresetSnapshot())
    collection.entries.push({ ...clonePreset(collection.entries[1]), id: 'second', name: 'Second', favorite: true })
    collection.entries.push({ ...clonePreset(collection.entries[1]), id: 'third', name: 'Third' })
    assert.deepEqual(orderedPresets(collection).map(entry => entry.id), ['second', DEFAULT_PRESET_ID, 'initial', 'third'])
    movePreset(collection, 'third', 'initial')
    movePreset(collection, 'initial', 'second')
    assert.deepEqual(orderedPresets(collection).map(entry => entry.id), ['second', DEFAULT_PRESET_ID, 'third', 'initial'])
  })

  it('supports Unicode names, prevents accidental overwrite, and numbers automatic names', () => {
    const collection = savedCatalog(createDefaultPresetSnapshot(), '작업 😶 安')
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
    const collection = savedCatalog(createDefaultPresetSnapshot(), '작업 2')
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
  const source = savedCatalog(capturePresetSnapshot(current), 'Saved')
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
  assert.equal(migrated.schemaVersion, 4)
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
  const archived = migratePresetCollection(corrupt)
  validatePresetCollection(archived)
  assert.deepEqual(presetSource(archived.entries[1]), presetSettings(corrupt.entries[1].snapshot))
  assert.equal(isExecutablePresetSnapshot(archived.entries[1].snapshot), true)
  assert.ok(inspectPresetCompatibility(presetSource(archived.entries[1])).some(issue => issue.path[1] === 'keyboardColor' && issue.reason === 'color'))
})

it('migrates v2 skin memory into inert evidence while preserving each explicit preset appearance', () => {
  const current = store()
  const id = 'a'.repeat(64)
  const inactiveId = 'b'.repeat(64)
  current.customization3d.activeSkinLibraryEntryId = id
  current.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,aGVsbG8='
  current.updateDmeloperEyebrows({ color: '#123456', widthPixels: 4 })
  current.updateDmeloperPalmColor('#ABCDEF')
  const source = savedCatalog(capturePresetSnapshot(current), 'Saved A')
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
    Object.assign(entry.snapshot.appearance, clonePreset(oldMaps))
  }
  const before = clonePreset(source)
  const migrated = migratePresetCollection(source)
  validatePresetCollection(migrated)
  assert.equal(migrated.activeId, source.activeId)
  assert.equal(migrated.entries.length, source.entries.length)
  assert.deepEqual(migrated.legacyAppearanceArchive?.initial, oldMaps)
  assert.deepEqual(migrated.legacyAppearanceArchive?.second, oldMaps)
  assert.deepEqual(migrated.legacyAppearanceArchive?.[DEFAULT_PRESET_ID], oldMaps)
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
  assert.equal(savedCatalog().legacyAppearanceArchive, undefined)
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
  const legacy = savedCatalog()
  Reflect.deleteProperty(legacy.entries[0].snapshot.preset, 'petHeadScalePercent')
  legacy.entries[0].snapshot.preset.petRotationDegrees = 37
  const migrated = migratePresetCollection(legacy)
  validatePresetCollection(migrated)
  assert.equal(migrated.entries[0].snapshot.preset.petHeadScalePercent, 100)
  assert.equal(migrated.entries[0].snapshot.preset.petRotationDegrees, createDefaultPresetSnapshot().preset.petRotationDegrees)
  assert.equal((presetSource(migrated.entries[0]).preset as Record<string, unknown>).petRotationDegrees, 37)
  assert.ok(inspectPresetCompatibility(presetSource(migrated.entries[0])).some(issue => issue.path[1] === 'petRotationDegrees' && issue.reason === 'range'))
  assert.equal(migratePresetCollection(migrated), migrated)
})

it('migrates missing eyebrow depth in every saved preset without changing explicit zero or input data', () => {
  const legacy = savedCatalog(createDefaultPresetSnapshot())
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
  const collection = savedCatalog(createDefaultPresetSnapshot())
  const legacy = JSON.parse(JSON.stringify(collection))
  for (const entry of legacy.entries) {
    for (const key of DESK_SETTING_KEYS) delete entry.snapshot.preset[key]
  }
  legacy.entries[1].snapshot.preset.deskTransparent = false
  legacy.entries[1].snapshot.preset.deskColor = '#123aBC'
  legacy.entries[1].snapshot.preset.deskWidthOffset = 0.6
  legacy.entries[1].snapshot.preset.deskDepthOffset = -0.3
  const before = clonePreset(legacy)
  const migrated = migratePresetCollection(legacy)
  validatePresetCollection(migrated)
  assert.deepEqual(legacy, before)
  assert.equal(migrated.schemaVersion, collection.schemaVersion)
  for (const key of DESK_SETTING_KEYS) assert.equal(migrated.entries[0].snapshot.preset[key], LEGACY_DESK_SETTINGS[key])
  assert.equal(migrated.entries[1].snapshot.preset.deskTransparent, false)
  assert.equal(migrated.entries[1].snapshot.preset.deskColor, '#123aBC')
  assert.equal(migrated.entries[1].snapshot.preset.deskHeightOffset, 0)
  assert.equal(migrated.entries[1].snapshot.preset.deskWidthOffset, 0.6)
  assert.equal(migrated.entries[1].snapshot.preset.deskDepthOffset, -0.3)
  assert.equal(migratePresetCollection(migrated), migrated)
  const target = store()
  applyPresetSnapshot(target, migrated.entries[1].snapshot)
  assert.deepEqual(capturePresetSnapshot(target).preset, migrated.entries[1].snapshot.preset)
  applyPresetSnapshot(target, legacy.entries[0].snapshot)
  for (const key of DESK_SETTING_KEYS) assert.equal(target.activePet3dPreset[key], LEGACY_DESK_SETTINGS[key])
})

it('archives bounded invalid desk values and unknown fields without executing them; non-JSON evidence remains rejected', () => {
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
    { deskWidthOffset: -1.01 },
    { deskWidthOffset: 1.01 },
    { deskWidthOffset: Number.NaN },
    { deskWidthOffset: '0' },
    { deskWidthOffset: undefined },
    { deskDepthOffset: -1.01 },
    { deskDepthOffset: 1.01 },
    { deskDepthOffset: null },
    { deskDepthOffset: Infinity },
    { deskDepthOffset: false },
    { deskEnabled: true },
  ]) {
    const collection = savedCatalog()
    Object.assign(collection.entries[0].snapshot.preset, changes)
    assert.equal(isPresetSnapshot(collection.entries[0].snapshot), false)
    const original = presetSettings(collection.entries[0].snapshot)
    const migrated = migratePresetCollection(collection)
    if (!isPresetSourceSettings(original)) {
      assert.throws(() => validatePresetCollection(migrated))
      assert.deepEqual(migrated, collection)
      continue
    }
    validatePresetCollection(migrated)
    assert.deepEqual(presetSource(migrated.entries[0]), original)
    assert.ok(inspectPresetCompatibility(presetSource(migrated.entries[0])).length)
    assert.equal(isExecutablePresetSnapshot(migrated.entries[0].snapshot), true)
    assert.deepEqual(presetSettings(collection.entries[0].snapshot), original)
    const restored = JSON.parse(JSON.stringify(migrated))
    assert.deepEqual(migratePresetCollection(restored), migrated)
  }
})

it('removes only the legacy default entry and preserves local user presets and selection', () => {
  for (const activeId of ['builtin:default', 'initial']) {
    const saved = savedCatalog()
    const userEntries = clonePreset(saved.entries)
    const legacy = { ...saved, schemaVersion: 3, activeId, entries: [
      { id: 'builtin:default', name: '', builtin: true, favorite: false, snapshot: createDefaultPresetSnapshot() },
      ...saved.entries.map(entry => ({ ...entry, builtin: false })),
    ] }
    const before = clonePreset(legacy)
    const migrated = migratePresetCollection(legacy)
    validatePresetCollection(migrated)
    assert.deepEqual(migrated.entries, userEntries)
    assert.equal(migrated.activeId, activeId === 'initial' ? 'initial' : null)
    assert.equal(migratePresetCollection(migrated), migrated)
    assert.deepEqual(legacy, before)
  }
  const migrated = migratePresetCollection({ schemaVersion: 3, activeId: 'builtin:default', entries: [
    { id: 'builtin:default', name: '', builtin: true, favorite: false, snapshot: createDefaultPresetSnapshot() },
  ] })
  assert.deepEqual(migrated, createPresetCollection())
})

it('additively migrates old catalogs to default animation and preserves explicit modes and retained sources', () => {
  for (const schemaVersion of [1, 2, 3, 4]) {
    const collection = savedCatalog()
    collection.schemaVersion = schemaVersion
    Reflect.deleteProperty(collection.entries[0].snapshot.preset, 'petAnimationMode')
    collection.entries[1].snapshot.preset.petAnimationMode = 'headbutt'
    const original = { preset: { petAnimationMode: 'future-mode', retained: null } }
    collection.entries[1].sourceSettings = original
    const before = JSON.stringify(collection)
    const migrated = migratePresetCollection(collection)
    validatePresetCollection(migrated)
    assert.equal(migrated.schemaVersion, 4)
    assert.equal(migrated.entries[0].snapshot.preset.petAnimationMode, 'default')
    assert.equal(migrated.entries[1].snapshot.preset.petAnimationMode, 'headbutt')
    assert.deepEqual(migrated.entries[1].sourceSettings, original)
    assert.equal(JSON.stringify(collection), before)
    assert.equal(migratePresetCollection(migrated), migrated)
    const target = store()
    for (const entry of migrated.entries) {
      applyPresetSnapshot(target, entry.snapshot)
      assert.equal(capturePresetSnapshot(target).preset.petAnimationMode, entry.snapshot.preset.petAnimationMode)
    }
  }
})

it('keeps Japanese catalog snapshots and restores archived Japanese from an older partial import', () => {
  const current = store()
  current.activePet3dPreset.keyboardLegendLanguage = 'ja'
  const snapshot = capturePresetSnapshot(current)
  const catalog = savedCatalog(snapshot, 'Japanese')
  const restored = migratePresetCollection(JSON.parse(JSON.stringify(catalog))) as PresetCollection
  validatePresetCollection(restored)
  assert.equal(restored.schemaVersion, 4)
  assert.equal(restored.activeId, 'initial')
  assert.equal(restored.entries[1].snapshot.preset.keyboardLegendLanguage, 'ja')
  applyPresetSnapshot(current, restored.entries[1].snapshot)
  assert.equal(current.activePet3dPreset.keyboardLegendLanguage, 'ja')
  const partial = clonePreset(restored.entries[1])
  partial.sourceSettings = presetSettings(snapshot)
  partial.snapshot.preset.keyboardLegendLanguage = 'en'
  assert.equal(presetSource(partial).preset && (presetSource(partial).preset as Record<string, unknown>).keyboardLegendLanguage, 'ja')
  applyPresetSnapshot(current, { ...partial.snapshot, ...projectPresetSettings(presetSource(partial)) })
  assert.equal(current.activePet3dPreset.keyboardLegendLanguage, 'ja')
  assert.equal(partial.snapshot.preset.keyboardLegendLanguage, 'en')
})
