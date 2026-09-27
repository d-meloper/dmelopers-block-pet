/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { createPresetCollection } from '@/features/presets/model'

import { createDefaultPet3dPreset, preparePetStateForSync, useCatStore } from './cat'
import { migrateLegacySkinAppearanceState, migratePetCharacterState, splitLegacySkinAppearance } from './petSettingsMigration'

const ENTRY_ID = 'a'.repeat(64)
const DATA_URL = 'data:image/png;base64,preserved'

function restoredStore(state: Record<string, unknown>) {
  setActivePinia(createPinia())
  const store = useCatStore()
  store.$patch(preparePetStateForSync(state))
  store.init()
  return store
}

describe('character settings compatibility', () => {
  it('restores v11 before new defaults can hide saved skin and appearance values', () => {
    const eyebrows = { ...createDefaultPet3dPreset().dmeloperEyebrows, color: '#123456', widthPixels: 4 }
    const raw = {
      migrated: true,
      customization3d: {
        schemaVersion: 11,
        selectedModelId: 'steve',
        steveSkinDataUrl: DATA_URL,
        // A user nickname is data, not the project's character name.
        minecraftSkinUsername: 'Steve',
        activeSkinLibraryEntryId: ENTRY_ID,
        skinLibraryMigrationCompleted: true,
        steveSkinModel: 'slim',
        useDefaultSteveSkin: false,
        steveEyebrowProfiles: { [ENTRY_ID]: eyebrows, default: eyebrows },
        steveEyebrowAutomaticColors: { [ENTRY_ID]: '#654321' },
        stevePalmManualColors: { [ENTRY_ID]: '#ABCDEF' },
        stevePalmAutomaticColors: { [ENTRY_ID]: '#FEDCBA' },
        preset: {
          windowScalePercent: 67,
          sceneRotationOffsetDegrees: -75,
          petLeftArmBendPercent: 85,
          petRightArmBendPercent: 130,
          steveEyebrows: eyebrows,
          stevePalmColor: '#ABCDEF',
        },
      },
    }
    const original = structuredClone(raw)
    const store = restoredStore(raw)
    const settings = store.customization3d
    assert.equal(settings.schemaVersion, 13)
    assert.equal(settings.selectedModelId, 'dmeloper')
    assert.equal(settings.dmeloperSkinDataUrl, DATA_URL)
    assert.equal(settings.minecraftSkinUsername, 'Steve')
    assert.equal(settings.activeSkinLibraryEntryId, ENTRY_ID)
    assert.equal(settings.skinLibraryMigrationCompleted, true)
    assert.equal(settings.dmeloperSkinModel, 'slim')
    assert.equal(settings.useDefaultDmeloperSkin, false)
    assert.deepEqual(store.legacyAppearanceArchive?.dmeloperEyebrowProfiles, { [ENTRY_ID]: eyebrows, default: eyebrows })
    assert.deepEqual(store.legacyAppearanceArchive?.dmeloperEyebrowAutomaticColors, { [ENTRY_ID]: '#654321' })
    assert.deepEqual(store.legacyAppearanceArchive?.dmeloperPalmManualColors, { [ENTRY_ID]: '#ABCDEF' })
    assert.deepEqual(store.legacyAppearanceArchive?.dmeloperPalmAutomaticColors, { [ENTRY_ID]: '#FEDCBA' })
    assert.deepEqual(settings.preset.dmeloperEyebrows, eyebrows)
    assert.equal(settings.preset.dmeloperPalmColor, '#ABCDEF')
    assert.equal(settings.preset.windowScalePercent, 67)
    assert.equal(settings.preset.sceneRotationOffsetDegrees, -75)
    assert.equal(settings.preset.petLeftArmBendPercent, 85)
    assert.equal(settings.preset.petRightArmBendPercent, 130)
    assert.ok(!('steveSkinDataUrl' in settings))
    assert.ok(!('steveEyebrows' in settings.preset))
    assert.deepEqual(raw, original)

    const saved = JSON.parse(JSON.stringify(store.$state))
    store.init()
    assert.deepEqual(JSON.parse(JSON.stringify(store.$state)), saved)
    const secondWindow = restoredStore(saved)
    assert.deepEqual(JSON.parse(JSON.stringify(secondWindow.$state)), saved)
  })

  it('prefers explicitly supplied new keys, including clearing a value', () => {
    const migrated = migratePetCharacterState({ customization3d: {
      schemaVersion: 12,
      steveSkinDataUrl: DATA_URL,
      dmeloperSkinDataUrl: undefined,
      steveSkinModel: 'wide',
      dmeloperSkinModel: 'slim',
      steveEyebrowProfiles: { default: { color: '#000000' } },
      dmeloperEyebrowProfiles: {},
      preset: { stevePalmColor: '#123456', dmeloperPalmColor: '#ABCDEF' },
    } })
    assert.deepEqual(migrated.customization3d, {
      schemaVersion: 12,
      dmeloperSkinDataUrl: undefined,
      dmeloperSkinModel: 'slim',
      dmeloperEyebrowProfiles: {},
      preset: { dmeloperPalmColor: '#ABCDEF' },
    })
    assert.deepEqual(migratePetCharacterState(migrated), migrated)
  })

  it('preserves pre-v9 scalar appearance after converting the original keys', () => {
    const eyebrows = { ...createDefaultPet3dPreset().dmeloperEyebrows, color: '#123456' }
    const store = restoredStore({ migrated: true, customization3d: {
      schemaVersion: 8,
      steveSkinDataUrl: DATA_URL,
      activeSkinLibraryEntryId: ENTRY_ID,
      preset: { steveEyebrows: eyebrows, windowScalePercent: 72 },
    } })
    assert.equal(store.customization3d.schemaVersion, 13)
    assert.equal(store.customization3d.dmeloperSkinDataUrl, DATA_URL)
    assert.deepEqual(store.activePet3dPreset.dmeloperEyebrows, eyebrows)
    assert.equal('dmeloperEyebrowProfiles' in store.customization3d, false)
    assert.equal(store.activePet3dPreset.windowScalePercent, 72)
  })

  it('retains unversioned per-model presets and does not rewrite their user data', () => {
    const migrated = migratePetCharacterState({ customization3d: {
      selectedPetModelId: 'steve',
      presets: {
        steve: { windowScalePercent: 64, stevePalmColor: '#123456' },
        custom: { displayName: 'Steve', windowScalePercent: 55 },
      },
    } })
    assert.deepEqual(migrated.customization3d, {
      selectedPetModelId: 'dmeloper',
      presets: {
        dmeloper: { windowScalePercent: 64, dmeloperPalmColor: '#123456' },
        custom: { displayName: 'Steve', windowScalePercent: 55 },
      },
      schemaVersion: 0,
    })
    const store = restoredStore(migrated)
    assert.equal(store.activePet3dPreset.windowScalePercent, 64)
  })

  it('folds pending legacy appearance into current preset before defaults merge', () => {
    const eyebrows = createDefaultPet3dPreset().dmeloperEyebrows
    const store = restoredStore({ migrated: true, customization3d: {
      schemaVersion: 11,
      steveSkinDataUrl: DATA_URL,
      pendingSteveEyebrowProfileMigration: eyebrows,
      pendingSteveEyebrowAutomaticColorMigration: '#123456',
      pendingStevePalmManualColorMigration: '#ABCDEF',
      pendingStevePalmAutomaticColorMigration: '#FEDCBA',
    } })
    assert.deepEqual(store.legacyAppearanceArchive?.pendingDmeloperEyebrowProfileMigration, eyebrows)
    assert.equal(store.legacyAppearanceArchive?.pendingDmeloperEyebrowAutomaticColorMigration, '#123456')
    assert.equal(store.legacyAppearanceArchive?.pendingDmeloperPalmManualColorMigration, '#ABCDEF')
    assert.equal(store.legacyAppearanceArchive?.pendingDmeloperPalmAutomaticColorMigration, '#FEDCBA')
    assert.deepEqual(store.activePet3dPreset.dmeloperEyebrows, eyebrows)
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#ABCDEF')
    assert.equal('pendingDmeloperPalmManualColorMigration' in store.customization3d, false)
  })
})

describe('retired per-skin appearance migration', () => {
  const OTHER_ID = 'b'.repeat(64)

  it('preserves catalog-era current scalars over stale maps and archives unused values once', () => {
    const current = { ...createDefaultPet3dPreset().dmeloperEyebrows, color: '#123456', widthPixels: 4 }
    const stale = { ...current, color: '#AAAAAA' }
    const raw = { migrated: true, presetCollection: createPresetCollection(), customization3d: {
      schemaVersion: 12,
      dmeloperSkinDataUrl: DATA_URL,
      activeSkinLibraryEntryId: ENTRY_ID,
      dmeloperEyebrowProfiles: { [ENTRY_ID]: stale, [OTHER_ID]: { ...stale, widthPixels: 6 } },
      dmeloperEyebrowAutomaticColors: { [ENTRY_ID]: '#BBBBBB' },
      dmeloperPalmManualColors: { [ENTRY_ID]: '#CCCCCC', [OTHER_ID]: '#DDDDDD' },
      dmeloperPalmAutomaticColors: { [ENTRY_ID]: '#EEEEEE' },
      preset: { dmeloperEyebrows: current, dmeloperPalmColor: '#654321' },
    } }
    const original = structuredClone(raw)
    const store = restoredStore(raw)
    assert.deepEqual(store.activePet3dPreset.dmeloperEyebrows, current)
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#654321')
    assert.deepEqual(store.legacyAppearanceArchive, {
      dmeloperEyebrowProfiles: raw.customization3d.dmeloperEyebrowProfiles,
      dmeloperEyebrowAutomaticColors: raw.customization3d.dmeloperEyebrowAutomaticColors,
      dmeloperPalmManualColors: raw.customization3d.dmeloperPalmManualColors,
      dmeloperPalmAutomaticColors: raw.customization3d.dmeloperPalmAutomaticColors,
    })
    assert.deepEqual(raw, original)
    assert.ok(!Object.keys(store.customization3d).some(key => /Profiles|AutomaticColors|ManualColors|pendingDmeloper/.test(key)))
    const saved = JSON.parse(JSON.stringify(store.$state))
    assert.deepEqual(JSON.parse(JSON.stringify(restoredStore(saved).$state)), saved)
  })

  it('preserves pre-catalog displayed appearance when active maps conflict with stale scalars', () => {
    const scalar = { ...createDefaultPet3dPreset().dmeloperEyebrows, color: '#111111' }
    const displayed = { ...scalar, color: '#222222', widthPixels: 5 }
    const store = restoredStore({ migrated: true, customization3d: {
      schemaVersion: 12,
      dmeloperSkinDataUrl: DATA_URL,
      activeSkinLibraryEntryId: ENTRY_ID,
      dmeloperEyebrowProfiles: { [ENTRY_ID]: displayed },
      dmeloperPalmManualColors: { [ENTRY_ID]: '#444444' },
      preset: { dmeloperEyebrows: scalar, dmeloperPalmColor: '#333333' },
    } })
    assert.deepEqual(store.activePet3dPreset.dmeloperEyebrows, displayed)
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#444444')
    store.updateDmeloperEyebrows({ color: '#555555' })
    store.updateDmeloperPalmColor('#666666')
    store.init()
    assert.equal(store.activePet3dPreset.dmeloperEyebrows.color, '#555555')
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#666666')
  })

  it('uses the legacy default profile for both unresolved and materialized bundled skins', () => {
    for (const dataUrl of [undefined, DATA_URL]) {
      const store = restoredStore({ migrated: true, customization3d: {
        schemaVersion: 12,
        dmeloperSkinDataUrl: dataUrl,
        activeSkinLibraryEntryId: 'builtin:dmeloper',
        dmeloperEyebrowAutomaticColors: { default: '#123456', [ENTRY_ID]: '#999999' },
        dmeloperPalmManualColors: { default: '#ABCDEF', [ENTRY_ID]: '#888888' },
        preset: { dmeloperEyebrows: createDefaultPet3dPreset().dmeloperEyebrows, dmeloperPalmColor: '#111111' },
      } })
      assert.equal(store.activePet3dPreset.dmeloperEyebrows.color, '#123456')
      assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#ABCDEF')
    }
  })

  it('preserves pre-catalog pending appearance before the current skin receives an identity', () => {
    const displayed = { ...createDefaultPet3dPreset().dmeloperEyebrows, color: '#123456', widthPixels: 5 }
    const store = restoredStore({ migrated: true, customization3d: {
      schemaVersion: 12,
      dmeloperSkinDataUrl: DATA_URL,
      pendingDmeloperEyebrowProfileMigration: displayed,
      pendingDmeloperPalmManualColorMigration: '#ABCDEF',
      preset: { dmeloperEyebrows: createDefaultPet3dPreset().dmeloperEyebrows, dmeloperPalmColor: '#111111' },
    } })
    assert.deepEqual(store.activePet3dPreset.dmeloperEyebrows, displayed)
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#ABCDEF')
    store.completeSkinLibraryMigration(ENTRY_ID, DATA_URL)
    assert.deepEqual(store.activePet3dPreset.dmeloperEyebrows, displayed)
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#ABCDEF')
  })

  it('never reapplies retired maps or pending colors to v13 settings', () => {
    for (const preset of [{}, { dmeloperPalmColor: '#654321' }]) {
      const store = restoredStore({ migrated: true, customization3d: {
        schemaVersion: 13,
        dmeloperEyebrowAutomaticColors: { default: '#123456' },
        pendingDmeloperPalmManualColorMigration: '#ABCDEF',
        preset,
      } })
      assert.equal(store.activePet3dPreset.dmeloperEyebrows.color, createDefaultPet3dPreset().dmeloperEyebrows.color)
      assert.equal(store.activePet3dPreset.dmeloperPalmColor, preset.dmeloperPalmColor ?? createDefaultPet3dPreset().dmeloperPalmColor)
    }
  })

  it('recovers missing current scalar fields from the matching active skin only', () => {
    const expected = { ...createDefaultPet3dPreset().dmeloperEyebrows, color: '#123456', widthPixels: 5 }
    const store = restoredStore({ migrated: true, customization3d: {
      schemaVersion: 12,
      dmeloperSkinDataUrl: DATA_URL,
      activeSkinLibraryEntryId: ENTRY_ID,
      dmeloperEyebrowProfiles: { [ENTRY_ID]: expected, [OTHER_ID]: { ...expected, color: '#999999' } },
      dmeloperPalmManualColors: { [ENTRY_ID]: '#654321', [OTHER_ID]: '#888888' },
    } })
    assert.deepEqual(store.activePet3dPreset.dmeloperEyebrows, expected)
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#654321')
    store.setActiveSkinLibraryEntryId(OTHER_ID)
    store.init()
    assert.deepEqual(store.activePet3dPreset.dmeloperEyebrows, expected)
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#654321')
  })

  it('recovers default and automatic fallbacks only when no current scalar was saved', () => {
    const store = restoredStore({ migrated: true, customization3d: {
      schemaVersion: 12,
      activeSkinLibraryEntryId: 'builtin:dmeloper',
      dmeloperSkinDataUrl: DATA_URL,
      dmeloperEyebrowAutomaticColors: { default: '#123456' },
      dmeloperPalmAutomaticColors: { default: '#ABCDEF' },
    } })
    assert.equal(store.activePet3dPreset.dmeloperEyebrows.color, '#123456')
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#ABCDEF')
  })

  it('strips empty compatibility maps without creating recovery metadata', () => {
    const raw = { dmeloperEyebrowProfiles: {}, dmeloperPalmManualColors: {}, pendingDmeloperPalmManualColorMigration: undefined, dmeloperSkinModel: 'wide' }
    assert.deepEqual(splitLegacySkinAppearance(raw), { appearance: { dmeloperSkinModel: 'wide' } })
    const store = restoredStore({ migrated: true, customization3d: { schemaVersion: 12, ...raw } })
    assert.equal(store.legacyAppearanceArchive, undefined)
    assert.ok(!JSON.stringify(store.$state).includes('legacyAppearanceArchive'))
  })

  it('leaves unrelated partial state unchanged and preserves the first recovery archive', () => {
    const unrelated = { window: { visible: false } }
    assert.equal(migrateLegacySkinAppearanceState(unrelated), unrelated)
    const archive = { dmeloperPalmManualColors: { [ENTRY_ID]: '#123456' } }
    const migrated = migrateLegacySkinAppearanceState({
      legacyAppearanceArchive: archive,
      customization3d: { schemaVersion: 13, dmeloperPalmManualColors: { [OTHER_ID]: '#ABCDEF' } },
    })
    assert.deepEqual(migrated.legacyAppearanceArchive, archive)
  })

  it('removes retired nested keys and clears recovery data through the backend JSON patch boundary', () => {
    const archive = { dmeloperPalmManualColors: { [ENTRY_ID]: '#ABCDEF' } }
    let backend: Record<string, unknown> = {
      migrated: true,
      legacyAppearanceArchive: archive,
      customization3d: {
        schemaVersion: 12,
        ...archive,
        dmeloperSkinDataUrl: DATA_URL,
        activeSkinLibraryEntryId: ENTRY_ID,
        preset: { dmeloperPalmColor: '#ABCDEF' },
      },
    }
    const store = restoredStore(backend)
    // tauri-store 0.12 StoreState::patch extends the top-level map with JSON values.
    const patchBackend = () => {
      backend = { ...backend, ...JSON.parse(JSON.stringify(store.$state)) }
    }
    patchBackend()
    assert.equal('dmeloperPalmManualColors' in (backend.customization3d as Record<string, unknown>), false)
    assert.deepEqual(backend.legacyAppearanceArchive, archive)
    store.resetAllSettings()
    patchBackend()
    assert.equal(backend.legacyAppearanceArchive, null)
    const restarted = restoredStore(backend)
    assert.equal(restarted.legacyAppearanceArchive, null)
    assert.equal(restarted.activePet3dPreset.dmeloperPalmColor, createDefaultPet3dPreset().dmeloperPalmColor)
    assert.ok(!JSON.stringify(restarted.$state).includes(ENTRY_ID))
  })
})
