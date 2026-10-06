/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { DEFAULT_DESK_SETTINGS, DESK_SETTING_KEYS, LEGACY_DESK_SETTINGS } from '@/config/desk'
import { DEFAULT_DEVICE_COLORS, DEVICE_COLOR_KEYS } from '@/config/deviceColors'
import { DEFAULT_PET_MODEL_ID } from '@/config/model3d'
import { applyPresetSnapshot, capturePresetSnapshot, clonePreset, createPresetCollection } from '@/features/presets/model'

import { createDefaultPet3dPreset, preparePetArmPoseStateForSync, preparePetStateForSync, useBlockStore } from './block'

function createStore() {
  setActivePinia(createPinia())
  return useBlockStore()
}

describe('selective whole-program catalog reset', () => {
  for (const deleteSkins of [false, true]) {
    for (const resetPresets of [false, true]) {
      it(`resets the live scene while ${resetPresets ? 'clearing' : 'preserving'} presets with skin deletion ${deleteSkins}`, () => {
        const store = createStore()
        store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,c2tpbg=='
        store.customization3d.activeSkinLibraryEntryId = 'a'.repeat(64)
        store.activePet3dPreset.petHeadScalePercent = 180
        store.presetCollection = createPresetCollection()
        store.presetCollection.entries.push(
          { id: 'second', name: 'Second', favorite: true, snapshot: capturePresetSnapshot(store) },
          { id: 'first', name: 'First', favorite: false, snapshot: capturePresetSnapshot(store) },
        )
        const before = store.presetCollection
        const saved = clonePreset(before)
        const revision = store.activePet3dPreset.viewportModeRevision

        store.resetAllSettings({ deleteSkins, resetPresets })

        assert.notEqual(store.presetCollection, before, 'the reset owner must observe a completed catalog replacement')
        assert.deepEqual(store.presetCollection, resetPresets ? createPresetCollection() : saved)
        assert.deepEqual(before, saved, 'retained snapshots and embedded PNGs remain unchanged')
        assert.equal(store.customization3d.dmeloperSkinDataUrl, undefined)
        assert.equal(store.activePet3dPreset.petHeadScalePercent, createDefaultPet3dPreset().petHeadScalePercent)
        assert.equal(store.activePet3dPreset.viewportModeRevision, revision + 1)
      })
    }
  }

  it('preserves user presets by default and clones nested snapshots', () => {
    const store = createStore()
    store.presetCollection = createPresetCollection()
    store.presetCollection.entries.push({ id: 'kept', name: 'Kept', favorite: true, snapshot: capturePresetSnapshot(store) })
    const before = store.presetCollection
    store.resetAllSettings()
    assert.deepEqual(store.presetCollection, before)
    assert.notEqual(store.presetCollection.entries[0].snapshot, before.entries[0].snapshot)
    store.presetCollection.entries[0].snapshot.preset.petHeadScalePercent = 170
    assert.notEqual(before.entries[0].snapshot.preset.petHeadScalePercent, 170)
  })
})

describe('performance setting persistence and reset', () => {
  const defaults = {
    maxFPS: 30,
    shadowsEnabled: true,
    renderScalePercent: 100,
    idlePowerSavingEnabled: true,
    shadowQuality: 'medium',
    antialiasEnabled: true,
    pixelFilterEnabled: true,
  }
  const readPerformance = (store: ReturnType<typeof createStore>) => ({
    maxFPS: store.model.maxFPS,
    shadowsEnabled: store.model.shadowsEnabled,
    renderScalePercent: store.model.renderScalePercent,
    idlePowerSavingEnabled: store.model.idlePowerSavingEnabled,
    shadowQuality: store.model.shadowQuality,
    antialiasEnabled: store.model.antialiasEnabled,
    pixelFilterEnabled: store.model.pixelFilterEnabled,
  })

  it('migrates the retired face filter only when the new key is absent, and removes experimental settings', () => {
    for (const model of [
      { facePixelFilterEnabled: true, supersampling: 2 },
      { facePixelFilterEnabled: true, pixelFilterEnabled: false, supersampling: 1.5 },
      { facePixelFilterEnabled: false, pixelFilterEnabled: true },
    ]) {
      const incoming = { model }
      const original = JSON.stringify(incoming)
      const store = createStore()
      store.$patch(preparePetStateForSync(incoming))
      store.init()
      const expected = 'pixelFilterEnabled' in model ? model.pixelFilterEnabled : model.facePixelFilterEnabled
      assert.equal(store.model.pixelFilterEnabled, expected)
      assert.equal('supersampling' in store.model, false)
      assert.equal('facePixelFilterEnabled' in store.model, false)
      assert.equal(JSON.stringify(incoming), original)
      const restored = createStore()
      restored.$patch(preparePetStateForSync(JSON.parse(JSON.stringify(store.$state))))
      restored.init()
      assert.equal(restored.model.pixelFilterEnabled, expected)
      restored.resetPerformanceSettings()
      assert.deepEqual(readPerformance(restored), defaults)
    }
  })

  it('uses the supported rendering defaults on a new install', () => {
    assert.deepEqual(readPerformance(createStore()), defaults)
  })

  it('adds missing options to legacy state without changing saved rendering settings', () => {
    const store = createStore()
    const legacyModel = {
      ...store.model,
      maxFPS: 45,
      shadowsEnabled: false,
      renderScalePercent: 75,
    } as Record<string, unknown>
    delete legacyModel.idlePowerSavingEnabled
    delete legacyModel.shadowQuality
    delete legacyModel.antialiasEnabled
    store.$patch(JSON.parse(JSON.stringify({ model: legacyModel })))
    store.init()
    store.init()
    assert.deepEqual(readPerformance(store), {
      ...defaults,
      maxFPS: 45,
      shadowsEnabled: false,
      renderScalePercent: 75,
    })
  })

  it('normalizes malformed values even after initial migration has completed', () => {
    const store = createStore()
    store.init()
    for (const value of [undefined, null, 0, 1, '', 'false', 'true', {}, []]) {
      Object.assign(store.model, {
        idlePowerSavingEnabled: value,
        antialiasEnabled: value,
        shadowQuality: value,
      })
      store.init()
      assert.deepEqual(readPerformance(store), defaults)
    }
    Object.assign(store.model, { shadowQuality: 'ultra' })
    store.init()
    assert.equal(store.model.shadowQuality, 'medium')
  })

  it('preserves valid choices and explicit OFF through persisted reload and repeated init', () => {
    for (const shadowQuality of ['high', 'medium', 'low'] as const) {
      for (const idlePowerSavingEnabled of [true, false]) {
        const source = createStore()
        source.init()
        Object.assign(source.model, {
          idlePowerSavingEnabled,
          shadowQuality,
          antialiasEnabled: false,
          shadowsEnabled: false,
        })
        const restored = createStore()
        restored.$patch(JSON.parse(JSON.stringify(source.$state)))
        restored.init()
        restored.init()
        assert.deepEqual(readPerformance(restored), {
          ...defaults,
          idlePowerSavingEnabled,
          shadowQuality,
          antialiasEnabled: false,
          shadowsEnabled: false,
        })
      }
    }
  })

  it('preserves explicit quality and uses the authored default for missing or automatic quality, including shadows OFF', () => {
    for (const quality of ['high', 'auto', undefined, 'medium', 'low']) {
      for (const enabled of [true, false]) {
        const source = createStore()
        Object.assign(source.model, { shadowQuality: quality, shadowsEnabled: enabled })
        const store = createStore()
        store.$patch(JSON.parse(JSON.stringify(source.$state)))
        store.init()
        store.init()
        const normalized = quality === 'high' || quality === 'low' || quality === 'medium' ? quality : 'medium'
        assert.equal(store.model.shadowQuality, normalized)
        assert.equal(store.shadowQualitySelection, enabled ? normalized : 'off')
        const restored = createStore()
        restored.$patch(JSON.parse(JSON.stringify(store.$state)))
        restored.init()
        assert.equal(restored.model.shadowQuality, normalized)
        assert.equal(restored.shadowQualitySelection, enabled ? normalized : 'off')
      }
    }
  })

  it('persists all four dropdown choices and re-enables shadows from off', () => {
    const store = createStore()
    for (const selection of ['high', 'off', 'low', 'off', 'medium', 'off'] as const) {
      store.shadowQualitySelection = selection
      assert.equal(store.shadowQualitySelection, selection)
      assert.equal(store.model.shadowsEnabled, selection !== 'off')
      const restored = createStore()
      restored.$patch(JSON.parse(JSON.stringify(store.$state)))
      restored.init()
      assert.equal(restored.shadowQualitySelection, selection)
    }
    store.resetPerformanceSettings()
    assert.equal(store.shadowQualitySelection, 'medium')
    assert.equal(store.model.shadowsEnabled, true)
  })

  it('preserves performance choices through general and preset resets', () => {
    const store = createStore()
    Object.assign(store.model, {
      idlePowerSavingEnabled: true,
      shadowQuality: 'low',
      antialiasEnabled: false,
    })
    const before = readPerformance(store)
    for (const reset of [
      store.resetGeneralSettings,
      store.resetActivePet3dPreset,
      store.resetEnvironment3d,
      store.resetPetBehavior,
      store.resetDmeloperSkinToDefault,
    ]) {
      reset()
      assert.deepEqual(readPerformance(store), before)
    }
  })

  it('resets only performance fields while retaining other model and preset settings', () => {
    const store = createStore()
    Object.assign(store.model, {
      maxFPS: 30,
      shadowsEnabled: false,
      renderScalePercent: 50,
      idlePowerSavingEnabled: true,
      shadowQuality: 'low',
      antialiasEnabled: false,
      mirror: true,
      behavior: false,
    })
    store.window.opacity = 44
    store.activePet3dPreset.cameraZoomPercent = 137
    const expected = JSON.parse(JSON.stringify(store.$state))
    Object.assign(expected.model, defaults)
    store.resetPerformanceSettings()
    assert.deepEqual(JSON.parse(JSON.stringify(store.$state)), expected)
  })

  it('restores every performance default on whole-program reset', () => {
    const store = createStore()
    Object.assign(store.model, {
      maxFPS: 30,
      shadowsEnabled: false,
      renderScalePercent: 50,
      idlePowerSavingEnabled: true,
      shadowQuality: 'low',
      antialiasEnabled: false,
    })
    store.resetAllSettings()
    assert.deepEqual(readPerformance(store), defaults)
  })
})

describe('display area visibility persistence and reset', () => {
  it('defaults missing and malformed saved values to OFF without changing the scene or skin', () => {
    assert.equal(createDefaultPet3dPreset().showDisplayArea, false)
    const store = createStore()
    store.customization3d.dmeloperSkinModel = 'slim'
    for (const value of [undefined, null, 0, 1, '', 'false', 'true', {}, []]) {
      Object.assign(store.activePet3dPreset, { showDisplayArea: value, cameraZoomPercent: 137 })
      store.init()
      assert.equal(store.activePet3dPreset.showDisplayArea, false)
      assert.equal(store.activePet3dPreset.cameraZoomPercent, 137)
      assert.equal(store.customization3d.dmeloperSkinModel, 'slim')
    }
  })

  it('preserves either choice through persisted reload and repeated initialization', () => {
    for (const showDisplayArea of [true, false]) {
      const source = createStore()
      source.activePet3dPreset.showDisplayArea = showDisplayArea
      const restored = createStore()
      restored.$patch(JSON.parse(JSON.stringify(source.$state)))
      restored.init()
      restored.init()
      assert.equal(restored.activePet3dPreset.showDisplayArea, showDisplayArea)
    }
  })

  it('belongs to the scene and resets with the scene, preset, and whole program', () => {
    const store = createStore()
    store.activePet3dPreset.showDisplayArea = true
    for (const reset of [
      store.resetEnvironment3d,
      store.resetPetBehavior,
      store.resetPerformanceSettings,
      store.resetGeneralSettings,
      store.resetDmeloperSkinToDefault,
    ]) {
      reset()
      assert.equal(store.activePet3dPreset.showDisplayArea, true)
    }
    for (const reset of [store.resetScene3d, store.resetActivePet3dPreset, store.resetAllSettings]) {
      store.activePet3dPreset.showDisplayArea = true
      reset()
      assert.equal(store.activePet3dPreset.showDisplayArea, false)
    }
  })
})

describe('automatic display area padding persistence', () => {
  it('defaults missing/invalid values to 2 and clamps legacy saved integers', () => {
    assert.equal(createDefaultPet3dPreset().autoViewportPaddingPixels, 2)
    for (const [value, expected] of [
      [undefined, 2],
      [null, 2],
      ['128', 2],
      [Number.NaN, 2],
      [Number.POSITIVE_INFINITY, 2],
      [0, 0],
      [8.6, 9],
      [16, 16],
      [17, 16],
      [64, 16],
      [96.6, 16],
      [128, 16],
      [256, 16],
      [-20, 0],
      [900, 16],
    ]) {
      const store = createStore()
      Object.assign(store.activePet3dPreset, { autoViewportPaddingPixels: value, cameraZoomPercent: 137 })
      store.init()
      assert.equal(store.activePet3dPreset.autoViewportPaddingPixels, expected)
      assert.equal(store.activePet3dPreset.cameraZoomPercent, 137)
    }
  })

  it('reloads either endpoint and resets only with scene, preset, or program settings', () => {
    for (const autoViewportPaddingPixels of [0, 8, 16]) {
      const source = createStore()
      source.activePet3dPreset.autoViewportPaddingPixels = autoViewportPaddingPixels
      const restored = createStore()
      restored.$patch(JSON.parse(JSON.stringify(source.$state)))
      restored.init()
      restored.init()
      restored.resetEnvironment3d()
      assert.equal(restored.activePet3dPreset.autoViewportPaddingPixels, autoViewportPaddingPixels)
      for (const reset of [restored.resetScene3d, restored.resetActivePet3dPreset, restored.resetAllSettings]) {
        restored.activePet3dPreset.autoViewportPaddingPixels = autoViewportPaddingPixels
        reset()
        assert.equal(restored.activePet3dPreset.autoViewportPaddingPixels, 2)
      }
    }
  })
})

describe('confirmed mouse setting persistence', () => {
  it('defaults missing and invalid legacy values to ON without replaying v11 migrations', () => {
    for (const value of [undefined, null, 0, 'false', {}, true]) {
      const store = createStore()
      Object.assign(store.customization3d.preset, { mouseEnabled: value, cameraZoomPercent: 137 })
      store.customization3d.dmeloperSkinModel = 'slim'
      store.init()
      assert.equal(store.activePet3dPreset.mouseEnabled, true)
      assert.equal(store.activePet3dPreset.cameraZoomPercent, 137)
      assert.equal(store.customization3d.dmeloperSkinModel, 'slim')
    }
  })

  it('preserves confirmed OFF across serialization, arm model changes and sanitization', () => {
    const store = createStore()
    store.activePet3dPreset.mouseEnabled = false
    store.customization3d.dmeloperSkinModel = 'slim'
    const restored = createStore()
    Object.assign(restored.customization3d, JSON.parse(JSON.stringify(store.customization3d)))
    restored.init()
    assert.equal(restored.activePet3dPreset.mouseEnabled, false)
    restored.customization3d.dmeloperSkinModel = 'wide'
    restored.resetDmeloperSkinToDefault()
    assert.equal(restored.activePet3dPreset.mouseEnabled, false)
  })

  it('restores ON on environment reset and retains appearance settings', () => {
    const store = createStore()
    store.activePet3dPreset.mouseEnabled = false
    store.activePet3dPreset.dmeloperEyebrows.color = '#123456'
    store.activePet3dPreset.dmeloperPalmColor = '#abcdef'
    store.resetEnvironment3d()
    assert.equal(store.activePet3dPreset.mouseEnabled, true)
    assert.equal(store.activePet3dPreset.dmeloperEyebrows.color, '#123456')
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#abcdef')
  })
})

describe('per-arm behavior persistence and reset', () => {
  const armPose = (store: ReturnType<typeof createStore>) => ({
    petRightArmBendPercent: store.activePet3dPreset.petRightArmBendPercent,
    petRightArmSpreadDegrees: store.activePet3dPreset.petRightArmSpreadDegrees,
    petLeftArmBendPercent: store.activePet3dPreset.petLeftArmBendPercent,
    petLeftArmSpreadDegrees: store.activePet3dPreset.petLeftArmSpreadDegrees,
  })
  const defaultArmPose = {
    petRightArmBendPercent: 100,
    petRightArmSpreadDegrees: 0,
    petLeftArmBendPercent: 100,
    petLeftArmSpreadDegrees: 0,
  }
  const deleteNewArmSettings = (preset: Record<string, unknown>) => {
    for (const key of Object.keys(defaultArmPose)) delete preset[key]
  }

  it('creates independent per-arm defaults without the retired shared setting', () => {
    const store = createStore()
    assert.deepEqual(armPose(store), defaultArmPose)
    assert.equal('petArmSpacingPercent' in createDefaultPet3dPreset(), false)
  })

  it('inherits legacy bend independently, clamps it, and removes the retired field idempotently', () => {
    for (const [value, expected] of [
      [175, 175],
      [0, 0],
      [-10, 0],
      [250, 200],
      [undefined, 100],
      [null, 100],
      ['150', 100],
      [Number.NaN, 100],
    ]) {
      const store = createStore()
      const preset = { ...store.activePet3dPreset, petArmSpacingPercent: value }
      deleteNewArmSettings(preset)
      Object.assign(store.customization3d, { preset })
      store.init()
      assert.deepEqual(armPose(store), {
        ...defaultArmPose,
        petRightArmBendPercent: expected,
        petLeftArmBendPercent: expected,
      })
      assert.equal('petArmSpacingPercent' in store.activePet3dPreset, false)
      const before = JSON.stringify(store.$state)
      store.init()
      assert.equal(JSON.stringify(store.$state), before)
    }
  })

  it('gives each explicit new value priority and only inherits when that side is undefined', () => {
    const cases = [
      { right: 100, left: undefined, expectedRight: 100, expectedLeft: 175 },
      { right: undefined, left: 30, expectedRight: 175, expectedLeft: 30 },
      { right: null, left: undefined, expectedRight: 100, expectedLeft: 175 },
      { right: undefined, left: '80', expectedRight: 175, expectedLeft: 100 },
      { right: Number.NaN, left: Infinity, expectedRight: 100, expectedLeft: 100 },
      { right: -10, left: 430, expectedRight: 0, expectedLeft: 400 },
      { right: 250, left: 400, expectedRight: 250, expectedLeft: 400 },
      { right: 0, left: 100, expectedRight: 0, expectedLeft: 100 },
    ]
    for (const sample of cases) {
      const store = createStore()
      Object.assign(store.activePet3dPreset, {
        petArmSpacingPercent: 175,
        petRightArmBendPercent: sample.right,
        petLeftArmBendPercent: sample.left,
      })
      store.init()
      assert.equal(store.activePet3dPreset.petRightArmBendPercent, sample.expectedRight)
      assert.equal(store.activePet3dPreset.petLeftArmBendPercent, sample.expectedLeft)
      assert.equal('petArmSpacingPercent' in store.activePet3dPreset, false)
    }
  })

  it('sanitizes independent spread limits and invalid new settings without replaying current migrations', () => {
    for (const value of [undefined, null, '150', {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const store = createStore()
      const entryId = 'd'.repeat(64)
      store.applySkinLibraryEntry({
        entryId,
        source: 'local',
        dataUrl: 'data:image/png;base64,preserved-skin',
        skinModel: 'slim',
      })
      store.updateDmeloperEyebrows({ color: '#654321', widthPixels: 4 })
      store.updateDmeloperPalmColor('#FEDCBA')
      store.activePet3dPreset.cameraZoomPercent = 137
      store.init()
      const before = JSON.parse(JSON.stringify(store.customization3d))
      Object.assign(store.activePet3dPreset, {
        petRightArmBendPercent: value,
        petRightArmSpreadDegrees: value,
        petLeftArmBendPercent: value,
        petLeftArmSpreadDegrees: value,
      })
      store.init()
      assert.deepEqual(armPose(store), defaultArmPose)
      assert.deepEqual(JSON.parse(JSON.stringify(store.customization3d)), before)
    }
    for (const [value, expected] of [[-50, -45], [-45, -45], [-12, -12], [0, 0], [25, 25], [45, 45], [50, 45]]) {
      const store = createStore()
      store.activePet3dPreset.petRightArmSpreadDegrees = value
      store.activePet3dPreset.petLeftArmSpreadDegrees = -value
      store.init()
      assert.equal(store.activePet3dPreset.petRightArmSpreadDegrees, expected)
      assert.equal(store.activePet3dPreset.petLeftArmSpreadDegrees, -expected)
    }
  })

  it('migrates incoming legacy state before Pinia deep merge can mask missing values', () => {
    const store = createStore()
    const preset = { ...store.activePet3dPreset, petArmSpacingPercent: 173 }
    deleteNewArmSettings(preset)
    Object.assign(preset, { petRightArmBendPercent: 80 })
    const incoming = { customization3d: { schemaVersion: 11, preset } }
    const original = JSON.stringify(incoming)
    const prepared = preparePetArmPoseStateForSync(incoming)
    store.$patch(prepared)
    store.init()
    assert.deepEqual(armPose(store), {
      ...defaultArmPose,
      petRightArmBendPercent: 80,
      petLeftArmBendPercent: 173,
    })
    assert.equal(JSON.stringify(incoming), original)
    assert.equal('petArmSpacingPercent' in store.activePet3dPreset, false)
    assert.deepEqual(preparePetArmPoseStateForSync(prepared), prepared)
    const unrelated = { customization3d: { preset: { cameraZoomPercent: 155 } } }
    assert.equal(preparePetArmPoseStateForSync(unrelated), unrelated)
    store.$patch(preparePetArmPoseStateForSync(unrelated))
    assert.equal(store.activePet3dPreset.petLeftArmBendPercent, 173)
  })

  it('restores independent values after serialization and retains them through skin and model changes', () => {
    const store = createStore()
    const expected = {
      petRightArmBendPercent: 363,
      petRightArmSpreadDegrees: 24,
      petLeftArmBendPercent: 47,
      petLeftArmSpreadDegrees: -18,
    }
    store.updateActivePet3dPreset(expected)
    const restored = createStore()
    Object.assign(restored.customization3d, JSON.parse(JSON.stringify(store.customization3d)))
    restored.init()
    assert.deepEqual(armPose(restored), expected)
    restored.setDmeloperSkinDataUrl('data:image/png;base64,new-skin')
    restored.setDmeloperSkinModel('slim')
    assert.deepEqual(armPose(restored), expected)
    restored.setDmeloperSkinModel('wide')
    restored.resetDmeloperSkinToDefault()
    assert.deepEqual(armPose(restored), expected)
    assert.equal('petArmSpacingPercent' in restored.activePet3dPreset, false)
  })

  it('resets only the four arm fields, body rotation, and desk distance', () => {
    const store = createStore()
    store.setDmeloperSkinDataUrl('data:image/png;base64,preserved-skin')
    store.setDmeloperSkinModel('slim')
    store.updateActivePet3dPreset({
      petRightArmBendPercent: 180,
      petRightArmSpreadDegrees: 36,
      petLeftArmBendPercent: 65,
      petLeftArmSpreadDegrees: -22,
      petRotationDegrees: 43,
      petDeskOffset: -0.75,
      cameraZoomPercent: 150,
      keyboardScalePercent: 125,
      mouseEnabled: false,
    })
    store.updateDmeloperEyebrows({ color: '#123456', widthPixels: 4 })
    store.updateDmeloperPalmColor('#ABCDEF')
    store.model.mirror = true
    store.window.opacity = 40
    const before = JSON.parse(JSON.stringify(store.$state))
    store.resetPetBehavior()
    Object.assign(before.customization3d.preset, {
      ...defaultArmPose,
      petRotationDegrees: 0,
      petDeskOffset: 0,
    })
    assert.deepEqual(JSON.parse(JSON.stringify(store.$state)), before)
  })
})

describe('unsupported persisted model identities', () => {
  it('normalizes invalid current identities without losing the skin, appearance or other settings', () => {
    for (const modelId of ['unsupported-model', '', null, undefined, 17, {}]) {
      const store = createStore()
      store.setDmeloperSkinDataUrl('data:image/png;base64,preserved-skin')
      store.setDmeloperSkinModel('slim')
      store.activePet3dPreset.mouseEnabled = false
      store.activePet3dPreset.cameraZoomPercent = 137
      store.activePet3dPreset.keyboardScalePercent = 122
      store.updateDmeloperPalmColor('#234567')
      store.activePet3dPreset.dmeloperEyebrows.color = '#654321'
      store.init()
      const before = JSON.parse(JSON.stringify(store.customization3d))
      Object.assign(store.customization3d, { selectedModelId: modelId })
      store.init()
      assert.deepEqual(JSON.parse(JSON.stringify(store.customization3d)), before)
      store.selectPetModel(modelId as Parameters<typeof store.selectPetModel>[0])
      assert.equal(store.customization3d.selectedModelId, DEFAULT_PET_MODEL_ID)
    }
  })

  it('retains the selected legacy preset and PNG while normalizing an old unsupported identity', () => {
    const store = createStore()
    Object.assign(store.customization3d, {
      schemaVersion: 2,
      selectedPetModelId: 'unsupported-model',
      selectedInstallId: 'legacy-install',
      selectedVariantId: 'legacy-variant',
      dmeloperSkinDataUrl: 'data:image/png;base64,legacy-skin',
      useDefaultDmeloperSkin: false,
      presets: {
        'unsupported-model': {
          ...createDefaultPet3dPreset(),
          mouseEnabled: false,
          cameraZoomPercent: 143,
          keyboardScalePercent: 123,
          petRotationDegrees: 27,
        },
      },
    })
    store.init()
    assert.equal(store.customization3d.selectedModelId, DEFAULT_PET_MODEL_ID)
    assert.equal(store.customization3d.dmeloperSkinDataUrl, 'data:image/png;base64,legacy-skin')
    assert.equal(store.customization3d.dmeloperSkinModel, 'auto')
    assert.equal(store.customization3d.useDefaultDmeloperSkin, false)
    assert.equal(store.activePet3dPreset.mouseEnabled, false)
    assert.equal(store.activePet3dPreset.cameraZoomPercent, 143)
    assert.equal(store.activePet3dPreset.keyboardScalePercent, 123)
    assert.equal(store.activePet3dPreset.petRotationDegrees, 27)
    assert.equal('selectedPetModelId' in store.customization3d, false)
    assert.equal('presets' in store.customization3d, false)
  })
})

describe('Dmeloper skin-model persistence', () => {
  it('defaults new settings to Wide', () => {
    const store = createStore()
    store.init()
    assert.equal(store.customization3d.schemaVersion, 13)
    assert.equal(store.customization3d.dmeloperSkinModel, 'wide')
    assert.deepEqual(
      store.customization3d.preset.dmeloperEyebrows,
      createDefaultPet3dPreset().dmeloperEyebrows,
    )
  })

  it('migrates existing persisted settings through one-time auto detection', () => {
    const store = createStore()
    Object.assign(store.customization3d, {
      schemaVersion: 3,
      selectedModelId: 'dmeloper',
      dmeloperSkinDataUrl: 'data:image/png;base64,legacy-skin',
      useDefaultDmeloperSkin: false,
      preset: createDefaultPet3dPreset(),
    })

    store.init()
    assert.equal(store.customization3d.schemaVersion, 13)
    assert.equal(store.customization3d.dmeloperSkinModel, 'auto')
    assert.equal(
      store.customization3d.dmeloperSkinDataUrl,
      'data:image/png;base64,legacy-skin',
    )
  })

  it('preserves the v4 arm selection and restores a valid legacy eyebrow color only', () => {
    const store = createStore()
    const preset = createDefaultPet3dPreset() as unknown as Record<string, unknown>
    delete preset.dmeloperEyebrows
    preset.eyebrowColor = '#123aBC'
    preset.eyebrowCenterX = 0.19
    Object.assign(store.customization3d, {
      schemaVersion: 4,
      selectedModelId: 'unsupported-model',
      dmeloperSkinModel: 'slim',
      preset,
    })

    store.init()
    assert.equal(store.customization3d.schemaVersion, 13)
    assert.equal(store.customization3d.selectedModelId, DEFAULT_PET_MODEL_ID)
    assert.equal(store.customization3d.dmeloperSkinModel, 'slim')
    assert.equal(store.customization3d.preset.dmeloperEyebrows.color, '#123aBC')
    assert.equal(store.customization3d.preset.dmeloperEyebrows.centerOffsetPixels, 0)
  })

  it('keeps the selected arm model when a skin is cleared', () => {
    const store = createStore()
    store.setDmeloperSkinModel('slim')
    store.setDmeloperSkinDataUrl('data:image/png;base64,new-skin')
    store.setDmeloperSkinDataUrl()

    assert.equal(store.customization3d.dmeloperSkinModel, 'slim')
    assert.equal(store.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(store.customization3d.useDefaultDmeloperSkin, false)
    assert.equal(store.customization3d.minecraftSkinUsername, undefined)
  })

  it('migrates v6 without changing the existing skin or preset and normalizes unsupported identities', () => {
    const store = createStore()
    const preservedPreset = {
      ...createDefaultPet3dPreset(),
      petRotationDegrees: 27,
    } as Partial<ReturnType<typeof createDefaultPet3dPreset>>
    delete preservedPreset.cameraHorizontalOffset
    delete preservedPreset.cameraVerticalOffset
    delete preservedPreset.cameraZoomPercent
    delete preservedPreset.keyboardScalePercent
    delete preservedPreset.mouseScalePercent
    Object.assign(store.customization3d, {
      schemaVersion: 6,
      selectedModelId: 'unsupported-model',
      dmeloperSkinDataUrl: 'data:image/png;base64,preserved-skin',
      dmeloperSkinModel: 'slim',
      useDefaultDmeloperSkin: false,
      preset: preservedPreset,
    })

    store.init()

    assert.equal(store.customization3d.schemaVersion, 13)
    assert.equal(store.customization3d.selectedModelId, DEFAULT_PET_MODEL_ID)
    assert.equal(
      store.customization3d.dmeloperSkinDataUrl,
      'data:image/png;base64,preserved-skin',
    )
    assert.equal(store.customization3d.dmeloperSkinModel, 'slim')
    assert.equal(store.customization3d.useDefaultDmeloperSkin, false)
    assert.equal(store.customization3d.preset.petRotationDegrees, 27)
    assert.equal(store.customization3d.preset.cameraHorizontalOffset, 0)
    assert.equal(store.customization3d.preset.cameraVerticalOffset, 0)
    assert.equal(store.customization3d.preset.cameraZoomPercent, 100)
    assert.equal(store.customization3d.preset.keyboardScalePercent, 100)
    assert.equal(store.customization3d.preset.mouseScalePercent, 100)
    assert.equal(store.customization3d.minecraftSkinUsername, undefined)
  })

  it('switches atomically between Minecraft, local, and default skin sources', () => {
    const store = createStore()

    assert.equal(store.applyMinecraftSkin({
      dataUrl: 'data:image/png;base64,remote-skin',
      canonicalName: 'jeb_',
      skinModel: 'slim',
    }), true)
    assert.equal(store.customization3d.minecraftSkinUsername, 'jeb_')
    assert.equal(store.customization3d.dmeloperSkinModel, 'slim')
    assert.equal(store.customization3d.preset.dmeloperEyebrows.color, createDefaultPet3dPreset().dmeloperEyebrows.color)

    store.setDmeloperSkinDataUrl('data:image/png;base64,local-skin')
    assert.equal(store.customization3d.minecraftSkinUsername, undefined)
    assert.equal(
      store.customization3d.dmeloperSkinDataUrl,
      'data:image/png;base64,local-skin',
    )

    store.resetDmeloperSkinToDefault()
    assert.equal(store.customization3d.minecraftSkinUsername, undefined)
    assert.equal(store.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(store.customization3d.dmeloperSkinModel, 'wide')
    assert.equal(store.customization3d.useDefaultDmeloperSkin, true)
    assert.equal(
      store.customization3d.preset.dmeloperEyebrows.color,
      createDefaultPet3dPreset().dmeloperEyebrows.color,
    )

    const previousState = JSON.stringify(store.customization3d)
    assert.equal(store.applyMinecraftSkin({
      dataUrl: 'not-a-data-url',
      canonicalName: 'invalid-name',
      skinModel: 'wide',
    }), false)
    assert.equal(JSON.stringify(store.customization3d), previousState)
  })
})

describe('validated skin selection colors', () => {
  for (const source of ['java', 'local', 'default'] as const) {
    it(`applies both ${source} colors atomically while preserving other appearance and rejects an invalid eyebrow color`, () => {
      const store = createStore()
      store.updateDmeloperEyebrows({ enabled: false, color: '#112233', widthPixels: 3 })
      store.updateDmeloperPalmColor('#334455')
      const before = JSON.parse(JSON.stringify(store.$state))
      const select = (eyebrowColor: string) => {
        const colors = { palmColor: '#445566', eyebrowColor }
        if (source === 'java') {
          return store.applyMinecraftSkin({
            dataUrl: 'data:image/png;base64,java',
            canonicalName: 'jeb_',
            skinModel: 'slim',
            ...colors,
          })
        }
        if (source === 'local') {
          return store.applySkinLibraryEntry({
            entryId: 'a'.repeat(64),
            source: 'local',
            dataUrl: 'data:image/png;base64,local',
            skinModel: 'wide',
            ...colors,
          })
        }
        store.resetDmeloperSkinToDefault(colors.palmColor, colors.eyebrowColor)
      }
      select('invalid')
      assert.deepEqual(JSON.parse(JSON.stringify(store.$state)), before)
      select('#778899')
      assert.deepEqual(store.activePet3dPreset, {
        ...before.customization3d.preset,
        dmeloperPalmColor: '#445566',
        dmeloperEyebrows: { ...before.customization3d.preset.dmeloperEyebrows, color: '#778899' },
      })
      assert.deepEqual(store.model, before.model)
      assert.deepEqual(store.presetCollection, before.presetCollection)
    })
  }
})

describe('preset-owned Dmeloper appearance', () => {
  const ENTRY_A = 'a'.repeat(64)
  const ENTRY_B = 'b'.repeat(64)

  function applyLocalSkin(store: ReturnType<typeof createStore>, entryId: string) {
    assert.equal(store.applySkinLibraryEntry({
      entryId,
      source: 'local',
      dataUrl: `data:image/png;base64,${entryId.slice(0, 1)}`,
      skinModel: 'wide',
    }), true)
  }

  function readAppearance(store: ReturnType<typeof createStore>) {
    return JSON.parse(JSON.stringify({
      eyebrows: store.activePet3dPreset.dmeloperEyebrows,
      palm: store.activePet3dPreset.dmeloperPalmColor,
    }))
  }

  function assertNoSkinMemory(store: ReturnType<typeof createStore>) {
    assert.ok(!Object.keys(store.customization3d).some(key => /Profiles|AutomaticColors|ManualColors|pendingDmeloper/.test(key)))
    assert.equal(store.legacyAppearanceArchive ?? undefined, undefined)
  }

  it('retains one current appearance through skin A → B → A, including later edits', () => {
    const store = createStore()
    const defaults = readAppearance(store)
    applyLocalSkin(store, ENTRY_A)
    assert.deepEqual(readAppearance(store), defaults)
    store.updateDmeloperEyebrows({ color: '#AABBCC', widthPixels: 4.25 })
    store.updateDmeloperPalmColor('#123456')
    const firstEdit = readAppearance(store)
    applyLocalSkin(store, ENTRY_B)
    assert.deepEqual(readAppearance(store), firstEdit)
    store.updateDmeloperEyebrows({ enabled: false, spacingPixels: 3.5 })
    store.updateDmeloperPalmColor('#FEDCBA')
    const latestEdit = readAppearance(store)
    applyLocalSkin(store, ENTRY_A)
    assert.deepEqual(readAppearance(store), latestEdit)
    assertNoSkinMemory(store)
  })

  it('preserves appearance through repeated init, reload, skin linking and default selection', () => {
    const source = createStore()
    source.init()
    source.setDmeloperSkinDataUrl('data:image/png;base64,unlinked')
    source.updateDmeloperEyebrows({ color: '#ABCDEF', centerOffsetPixels: 1.25, thicknessPixels: 1.5 })
    source.updateDmeloperPalmColor('#445566')
    source.window.visible = false
    const expected = readAppearance(source)
    const restored = createStore()
    restored.$patch(preparePetStateForSync(JSON.parse(JSON.stringify(source.$state))))
    restored.init()
    restored.init()
    assert.deepEqual(readAppearance(restored), expected)
    assert.equal(restored.window.visible, false)
    assert.equal(restored.completeSkinLibraryMigration(ENTRY_A, 'data:image/png;base64,unlinked'), true)
    assert.deepEqual(readAppearance(restored), expected)
    restored.setActiveSkinLibraryEntryId(ENTRY_B)
    restored.setDmeloperSkinModel('slim')
    restored.resetDmeloperSkinToDefault()
    assert.deepEqual(readAppearance(restored), expected)
    applyLocalSkin(restored, ENTRY_A)
    assert.deepEqual(readAppearance(restored), expected)
    assertNoSkinMemory(restored)
  })

  it('resets appearance to application defaults without consulting skin color history', () => {
    const store = createStore()
    applyLocalSkin(store, ENTRY_A)
    store.updateDmeloperEyebrows({ color: '#AAAAAA', widthPixels: 4 })
    store.updateDmeloperPalmColor('#BBBBBB')
    store.model.eyebrowAnimationEnabled = false
    store.activePet3dPreset.petDeskOffset = 0.75
    store.resetDmeloperEyebrows()
    assert.deepEqual(store.activePet3dPreset.dmeloperEyebrows, createDefaultPet3dPreset().dmeloperEyebrows)
    assert.equal(store.model.eyebrowAnimationEnabled, true)
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#BBBBBB')
    store.resetDmeloperPalmColor()
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, createDefaultPet3dPreset().dmeloperPalmColor)
    assert.equal(store.customization3d.activeSkinLibraryEntryId, ENTRY_A)
    assert.equal(store.activePet3dPreset.petDeskOffset, 0.75)
    assertNoSkinMemory(store)
  })

  it('restores independent appearance only when a different preset is applied', () => {
    const store = createStore()
    store.init()
    applyLocalSkin(store, ENTRY_A)
    store.updateDmeloperEyebrows({ color: '#AAAAAA', widthPixels: 4 })
    store.updateDmeloperPalmColor('#111111')
    const first = capturePresetSnapshot(store)
    const firstAppearance = readAppearance(store)
    store.updateDmeloperEyebrows({ color: '#BBBBBB', widthPixels: 5 })
    store.updateDmeloperPalmColor('#222222')
    const second = capturePresetSnapshot(store)
    const secondAppearance = readAppearance(store)

    applyPresetSnapshot(store, first)
    store.init()
    applyLocalSkin(store, ENTRY_B)
    assert.deepEqual(readAppearance(store), firstAppearance)
    applyPresetSnapshot(store, second)
    store.init()
    assert.deepEqual(readAppearance(store), secondAppearance)
    assert.deepEqual(first.preset.dmeloperEyebrows, firstAppearance.eyebrows)
    assertNoSkinMemory(store)
  })

  it('keeps pre-profile v8 scalar appearance without creating profile memory', () => {
    const store = createStore()
    const eyebrows = { ...createDefaultPet3dPreset().dmeloperEyebrows, color: '#876543', heightOffsetPixels: 2.25 }
    store.$patch(preparePetStateForSync({ customization3d: {
      schemaVersion: 8,
      dmeloperSkinDataUrl: 'data:image/png;base64,a',
      activeSkinLibraryEntryId: ENTRY_A,
      preset: { dmeloperEyebrows: eyebrows, dmeloperPalmColor: '#ABCDEF' },
    } }))
    store.init()
    applyLocalSkin(store, ENTRY_B)
    assert.deepEqual(store.activePet3dPreset.dmeloperEyebrows, eyebrows)
    assert.equal(store.activePet3dPreset.dmeloperPalmColor, '#ABCDEF')
    assertNoSkinMemory(store)
  })

  it('keeps recovery metadata inert during skin edits and clears it on whole reset', () => {
    const store = createStore()
    const archive = { dmeloperPalmManualColors: { [ENTRY_A]: '#AAAAAA', [ENTRY_B]: '#BBBBBB' } }
    store.$patch(preparePetStateForSync({ customization3d: {
      schemaVersion: 12,
      ...archive,
      dmeloperSkinDataUrl: 'data:image/png;base64,a',
      activeSkinLibraryEntryId: ENTRY_A,
      preset: { dmeloperPalmColor: '#ABCDEF' },
    } }))
    store.init()
    const expected = readAppearance(store)
    applyLocalSkin(store, ENTRY_B)
    assert.deepEqual(readAppearance(store), expected)
    store.updateDmeloperPalmColor('#123456')
    assert.deepEqual(store.legacyAppearanceArchive, archive)
    store.resetAllSettings()
    assertNoSkinMemory(store)
  })
})

describe('3D preset sanitization', () => {
  it('defaults and sanitizes camera and object scale settings', () => {
    const defaults = createDefaultPet3dPreset()
    assert.deepEqual({
      cameraHorizontalOffset: defaults.cameraHorizontalOffset,
      cameraVerticalOffset: defaults.cameraVerticalOffset,
      cameraZoomPercent: defaults.cameraZoomPercent,
      keyboardScalePercent: defaults.keyboardScalePercent,
      mouseScalePercent: defaults.mouseScalePercent,
    }, {
      cameraHorizontalOffset: 0,
      cameraVerticalOffset: 0,
      cameraZoomPercent: 100,
      keyboardScalePercent: 100,
      mouseScalePercent: 100,
    })

    const store = createStore()
    Object.assign(store.customization3d.preset, {
      cameraHorizontalOffset: -10,
      cameraVerticalOffset: 10,
      cameraZoomPercent: 250,
      keyboardScalePercent: 10,
      mouseScalePercent: 250,
    })
    store.init()
    assert.deepEqual({
      cameraHorizontalOffset: store.customization3d.preset.cameraHorizontalOffset,
      cameraVerticalOffset: store.customization3d.preset.cameraVerticalOffset,
      cameraZoomPercent: store.customization3d.preset.cameraZoomPercent,
      keyboardScalePercent: store.customization3d.preset.keyboardScalePercent,
      mouseScalePercent: store.customization3d.preset.mouseScalePercent,
    }, {
      cameraHorizontalOffset: -1.5,
      cameraVerticalOffset: 1.5,
      cameraZoomPercent: 200,
      keyboardScalePercent: 50,
      mouseScalePercent: 200,
    })

    Object.assign(store.customization3d.preset, {
      cameraHorizontalOffset: Number.NaN,
      cameraVerticalOffset: Number.POSITIVE_INFINITY,
      cameraZoomPercent: Number.NaN,
      keyboardScalePercent: Number.NEGATIVE_INFINITY,
      mouseScalePercent: Number.NaN,
    })
    store.init()
    assert.deepEqual({
      cameraHorizontalOffset: store.customization3d.preset.cameraHorizontalOffset,
      cameraVerticalOffset: store.customization3d.preset.cameraVerticalOffset,
      cameraZoomPercent: store.customization3d.preset.cameraZoomPercent,
      keyboardScalePercent: store.customization3d.preset.keyboardScalePercent,
      mouseScalePercent: store.customization3d.preset.mouseScalePercent,
    }, {
      cameraHorizontalOffset: 0,
      cameraVerticalOffset: 0,
      cameraZoomPercent: 100,
      keyboardScalePercent: 100,
      mouseScalePercent: 100,
    })
  })

  it('migrates v10 additively without clearing appearance or preset data', () => {
    const store = createStore()
    const entryId = 'c'.repeat(64)
    const eyebrows = {
      ...createDefaultPet3dPreset().dmeloperEyebrows,
      color: '#123456',
      widthPixels: 4,
    }
    const legacyPreset = {
      ...createDefaultPet3dPreset(),
      windowScalePercent: 82,
      sceneRotationOffsetDegrees: 47,
      petRotationDegrees: -21,
      petDeskOffset: 0.35,
      mouseBaseXOffset: -0.25,
      mouseBaseZOffset: 0.3,
      keyboardBaseXOffset: 0.35,
      keyboardBaseZOffset: -0.45,
      keyboardLegendLanguage: 'en' as const,
      dmeloperEyebrows: eyebrows,
      dmeloperPalmColor: '#ABCDEF',
    } as Partial<ReturnType<typeof createDefaultPet3dPreset>>
    delete legacyPreset.petRightArmBendPercent
    delete legacyPreset.petRightArmSpreadDegrees
    delete legacyPreset.petLeftArmBendPercent
    delete legacyPreset.petLeftArmSpreadDegrees
    delete legacyPreset.cameraHorizontalOffset
    delete legacyPreset.cameraVerticalOffset
    delete legacyPreset.cameraZoomPercent
    delete legacyPreset.keyboardScalePercent
    delete legacyPreset.mouseScalePercent
    Object.assign(store.customization3d, {
      schemaVersion: 10,
      selectedModelId: 'dmeloper',
      dmeloperSkinDataUrl: 'data:image/png;base64,preserved',
      minecraftSkinUsername: 'jeb_',
      activeSkinLibraryEntryId: entryId,
      skinLibraryMigrationCompleted: true,
      dmeloperSkinModel: 'slim',
      useDefaultDmeloperSkin: false,
      dmeloperEyebrowProfiles: { [entryId]: eyebrows },
      dmeloperEyebrowAutomaticColors: { [entryId]: '#654321' },
      dmeloperPalmManualColors: { [entryId]: '#ABCDEF' },
      dmeloperPalmAutomaticColors: { [entryId]: '#FEDCBA' },
      preset: legacyPreset,
    })

    store.init()

    assert.equal(store.customization3d.schemaVersion, 13)
    assert.equal(store.customization3d.selectedModelId, 'dmeloper')
    assert.equal(store.customization3d.dmeloperSkinDataUrl, 'data:image/png;base64,preserved')
    assert.equal(store.customization3d.minecraftSkinUsername, 'jeb_')
    assert.equal(store.customization3d.activeSkinLibraryEntryId, entryId)
    assert.equal(store.customization3d.skinLibraryMigrationCompleted, true)
    assert.equal(store.customization3d.dmeloperSkinModel, 'slim')
    assert.equal(store.customization3d.useDefaultDmeloperSkin, false)
    assert.deepEqual(store.legacyAppearanceArchive?.dmeloperEyebrowProfiles, { [entryId]: eyebrows })
    assert.deepEqual(store.legacyAppearanceArchive?.dmeloperEyebrowAutomaticColors, { [entryId]: '#654321' })
    assert.deepEqual(store.legacyAppearanceArchive?.dmeloperPalmManualColors, { [entryId]: '#ABCDEF' })
    assert.deepEqual(store.legacyAppearanceArchive?.dmeloperPalmAutomaticColors, { [entryId]: '#FEDCBA' })
    assert.deepEqual(store.customization3d.preset, {
      ...legacyPreset,
      petRightArmBendPercent: 100,
      petRightArmSpreadDegrees: 0,
      petLeftArmBendPercent: 100,
      petLeftArmSpreadDegrees: 0,
      cameraHorizontalOffset: 0,
      cameraVerticalOffset: 0,
      cameraZoomPercent: 100,
      keyboardScalePercent: 100,
      mouseScalePercent: 100,
    })
  })

  it('keeps scene rotation centered on zero within -360° and 360°', () => {
    const store = createStore()

    assert.equal(createDefaultPet3dPreset().sceneRotationOffsetDegrees, 0)

    store.customization3d.preset.sceneRotationOffsetDegrees = -360
    store.init()
    assert.equal(store.customization3d.preset.sceneRotationOffsetDegrees, -360)

    store.customization3d.preset.sceneRotationOffsetDegrees = 540
    store.init()
    assert.equal(store.customization3d.preset.sceneRotationOffsetDegrees, 360)
  })

  it('clamps eyebrow settings, validates color, and supports eyebrow-only reset', () => {
    const store = createStore()
    Object.assign(store.customization3d.preset.dmeloperEyebrows, {
      enabled: true,
      color: 'not-a-color',
      centerOffsetPixels: 99,
      heightOffsetPixels: -99,
      spacingPixels: 0,
      widthPixels: 99,
      thicknessPixels: 0,
    })
    store.init()

    assert.deepEqual(store.customization3d.preset.dmeloperEyebrows, {
      enabled: true,
      color: '#523830',
      centerOffsetPixels: 1.5,
      heightOffsetPixels: -3,
      spacingPixels: 0.5,
      widthPixels: 4,
      thicknessPixels: 0.2,
      depthPercent: 50,
    })

    Object.assign(store.customization3d.preset.dmeloperEyebrows, {
      centerOffsetPixels: -99,
      heightOffsetPixels: 99,
      spacingPixels: 99,
      widthPixels: -99,
      thicknessPixels: 99,
    })
    store.init()

    assert.deepEqual(store.customization3d.preset.dmeloperEyebrows, {
      enabled: true,
      color: '#523830',
      centerOffsetPixels: -1.5,
      heightOffsetPixels: 3,
      spacingPixels: 3,
      widthPixels: 0.8,
      thicknessPixels: 1.4,
      depthPercent: 50,
    })

    store.customization3d.preset.dmeloperEyebrows.enabled = false
    store.resetDmeloperEyebrows()
    assert.deepEqual(
      store.customization3d.preset.dmeloperEyebrows,
      createDefaultPet3dPreset().dmeloperEyebrows,
    )
  })

  it('restores saved frame limits within the supported 15–80 FPS range', () => {
    for (const [saved, expected] of [[144, 80], [81, 80], [80, 80], [60, 60], [20, 20], [16, 16], [15, 15], [14, 15], [10, 15], [0, 80], [Number.NaN, 30]]) {
      const store = createStore()
      store.model.maxFPS = saved
      store.init()
      assert.equal(store.model.maxFPS, expected)
    }
  })

  it('migrates v5 eyebrow color modes and rendering limits', () => {
    const store = createStore()
    const legacyEyebrows = {
      ...createDefaultPet3dPreset().dmeloperEyebrows,
      colorMode: 'custom',
      customColor: '#123456',
    } as Record<string, unknown>
    delete legacyEyebrows.color
    Object.assign(store.customization3d, {
      schemaVersion: 5,
      preset: {
        ...createDefaultPet3dPreset(),
        dmeloperEyebrows: legacyEyebrows,
      },
    })
    store.model.maxFPS = 0
    store.model.renderScalePercent = 20

    store.init()

    assert.equal(store.customization3d.schemaVersion, 13)
    assert.equal(store.customization3d.preset.dmeloperEyebrows.color, '#123456')
    assert.equal(store.model.maxFPS, 80)
    assert.equal(store.model.renderScalePercent, 50)
    assert.equal(store.model.shadowsEnabled, true)
  })

  it('removes retired model and window settings without changing retained window data', () => {
    const legacyStore = createStore()
    ;(legacyStore.model as typeof legacyStore.model & { memorySavingMode?: boolean }).memorySavingMode = true
    ;(legacyStore.window as typeof legacyStore.window & { radius?: number }).radius = 33
    legacyStore.window.opacity = 44
    legacyStore.window.keepInScreen = false
    legacyStore.migrated = true

    legacyStore.init()

    assert.equal('memorySavingMode' in legacyStore.model, false)
    assert.equal('radius' in legacyStore.window, false)
    assert.equal(legacyStore.window.opacity, 44)
    assert.equal(legacyStore.window.keepInScreen, false)
  })

  it('separates environment, pet behavior, appearance, and whole-program reset scopes', () => {
    const store = createStore()
    store.customization3d.dmeloperSkinModel = 'slim'
    store.customization3d.preset.dmeloperEyebrows.color = '#112233'
    store.updateDmeloperPalmColor('#445566')
    store.customization3d.preset.petRightArmBendPercent = 175
    store.customization3d.preset.petRightArmSpreadDegrees = 25
    store.customization3d.preset.petLeftArmBendPercent = 80
    store.customization3d.preset.petLeftArmSpreadDegrees = -15
    store.customization3d.preset.petRotationDegrees = -31
    store.customization3d.preset.petDeskOffset = 1
    store.customization3d.preset.cameraHorizontalOffset = 1
    store.customization3d.preset.cameraVerticalOffset = -1
    store.customization3d.preset.cameraZoomPercent = 150
    store.customization3d.preset.keyboardScalePercent = 125
    store.customization3d.preset.mouseScalePercent = 175
    store.model.mirror = true
    store.window.opacity = 40
    ;(store.model as typeof store.model & { memorySavingMode?: boolean }).memorySavingMode = true

    store.resetEnvironment3d()

    assert.equal(store.customization3d.selectedModelId, DEFAULT_PET_MODEL_ID)
    assert.equal(store.customization3d.dmeloperSkinModel, 'slim')
    assert.equal(store.customization3d.preset.dmeloperEyebrows.color, '#112233')
    assert.equal(store.customization3d.preset.dmeloperPalmColor, '#445566')
    assert.equal(store.customization3d.preset.petRightArmBendPercent, 175)
    assert.equal(store.customization3d.preset.petRightArmSpreadDegrees, 25)
    assert.equal(store.customization3d.preset.petLeftArmBendPercent, 80)
    assert.equal(store.customization3d.preset.petLeftArmSpreadDegrees, -15)
    assert.equal(store.customization3d.preset.petRotationDegrees, -31)
    assert.equal(store.customization3d.preset.petDeskOffset, 1)
    assert.equal(store.customization3d.preset.cameraHorizontalOffset, 1)
    assert.equal(store.customization3d.preset.cameraVerticalOffset, -1)
    assert.equal(store.customization3d.preset.cameraZoomPercent, 150)
    assert.equal(store.customization3d.preset.keyboardScalePercent, 100)
    assert.equal(store.customization3d.preset.mouseScalePercent, 100)
    assert.equal(store.model.mirror, true)
    assert.equal(store.window.opacity, 40)

    store.resetScene3d()
    assert.equal(store.customization3d.preset.cameraHorizontalOffset, 0)
    assert.equal(store.customization3d.preset.cameraVerticalOffset, 0)
    assert.equal(store.customization3d.preset.cameraZoomPercent, 100)
    assert.equal(store.customization3d.preset.autoViewportEnabled, true)
    assert.equal(store.customization3d.preset.petRightArmBendPercent, 175)
    assert.equal(store.model.mirror, false)
    assert.equal(store.window.opacity, 100)

    store.resetAllSettings()
    assert.equal(store.customization3d.selectedModelId, 'dmeloper')
    assert.equal(store.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(store.customization3d.preset.dmeloperPalmColor, '#FFDFCE')
    assert.equal(store.customization3d.preset.petRightArmBendPercent, 100)
    assert.equal(store.customization3d.preset.petRightArmSpreadDegrees, 0)
    assert.equal(store.customization3d.preset.petLeftArmBendPercent, 100)
    assert.equal(store.customization3d.preset.petLeftArmSpreadDegrees, 0)
    assert.equal(store.customization3d.preset.petRotationDegrees, 0)
    assert.equal(store.customization3d.preset.petDeskOffset, 0)
    assert.equal('dmeloperPalmManualColors' in store.customization3d, false)
    assert.equal(store.model.maxFPS, 30)
    assert.equal('memorySavingMode' in store.model, false)
  })
})

describe('persistent skin-library state', () => {
  const ENTRY_ID = 'a'.repeat(64)
  const OTHER_ENTRY_ID = 'b'.repeat(64)

  it('additively migrates v7 settings and exposes a retryable current-skin migration', () => {
    const store = createStore()
    Object.assign(store.customization3d, {
      schemaVersion: 7,
      dmeloperSkinDataUrl: 'data:image/png;base64,legacy-java',
      minecraftSkinUsername: 'jeb_',
      dmeloperSkinModel: 'slim',
      useDefaultDmeloperSkin: true,
    })

    store.init()

    assert.equal(store.customization3d.schemaVersion, 13)
    assert.equal(store.customization3d.skinLibraryMigrationCompleted, false)
    assert.deepEqual(store.getPendingSkinLibraryMigration(), {
      source: 'java',
      displayName: 'jeb_',
      canonicalNickname: 'jeb_',
      modelPreference: 'slim',
      dataUrl: 'data:image/png;base64,legacy-java',
    })

    // A failed store attempt does not call complete and therefore remains retryable.
    assert.notEqual(store.getPendingSkinLibraryMigration(), undefined)
    assert.equal(store.completeSkinLibraryMigration('unsafe/id'), false)
    assert.equal(store.customization3d.skinLibraryMigrationCompleted, false)
    assert.equal(store.completeSkinLibraryMigration(ENTRY_ID), true)
    assert.equal(store.customization3d.skinLibraryMigrationCompleted, true)
    assert.equal(store.customization3d.activeSkinLibraryEntryId, ENTRY_ID)
    assert.equal(store.getPendingSkinLibraryMigration(), undefined)
  })

  it('uses a stable legacy name when migrating a current local skin', () => {
    const store = createStore()
    store.setDmeloperSkinDataUrl('data:image/png;base64,local')

    assert.deepEqual(store.getPendingSkinLibraryMigration(), {
      source: 'local',
      displayName: '기존 스킨',
      originalFilename: '기존 스킨.png',
      modelPreference: 'wide',
      dataUrl: 'data:image/png;base64,local',
    })
  })

  it('completes a fresh-install migration before newly stored local skins apply', () => {
    const store = createStore()
    store.init()
    assert.equal(store.customization3d.skinLibraryMigrationCompleted, false)
    assert.equal(store.getPendingSkinLibraryMigration(), undefined)

    assert.equal(store.completeSkinLibraryMigration(), true)
    store.setDmeloperSkinDataUrl('data:image/png;base64,new-local', ENTRY_ID)

    assert.equal(store.customization3d.skinLibraryMigrationCompleted, true)
    assert.equal(store.customization3d.activeSkinLibraryEntryId, ENTRY_ID)
    assert.equal(store.getPendingSkinLibraryMigration(), undefined)
  })

  it('does not let a stale one-time migration replace a newly active card', () => {
    const store = createStore()
    store.setDmeloperSkinDataUrl('data:image/png;base64,legacy')
    const migration = store.getPendingSkinLibraryMigration()
    assert.ok(migration)

    assert.equal(store.applySkinLibraryEntry({
      entryId: OTHER_ENTRY_ID,
      source: 'local',
      dataUrl: 'data:image/png;base64,new',
      skinModel: 'wide',
    }), true)
    assert.equal(
      store.completeSkinLibraryMigration(ENTRY_ID, migration.dataUrl),
      false,
    )
    assert.equal(
      store.customization3d.activeSkinLibraryEntryId,
      OTHER_ENTRY_ID,
    )
  })

  it('applies a validated entry atomically and resets default when active is deleted', () => {
    const store = createStore()
    const previous = JSON.stringify(store.customization3d)
    assert.equal(store.applySkinLibraryEntry({
      entryId: 'unsafe',
      source: 'local',
      dataUrl: 'data:image/png;base64,local',
      skinModel: 'wide',
    }), false)
    assert.equal(JSON.stringify(store.customization3d), previous)

    assert.equal(store.applySkinLibraryEntry({
      entryId: ENTRY_ID,
      source: 'java',
      canonicalNickname: 'jeb_',
      dataUrl: 'data:image/png;base64,remote',
      skinModel: 'slim',
    }), true)
    assert.equal(store.customization3d.activeSkinLibraryEntryId, ENTRY_ID)
    assert.equal(store.customization3d.minecraftSkinUsername, 'jeb_')

    store.handleSkinLibraryEntriesDeleted([OTHER_ENTRY_ID])
    assert.equal(store.customization3d.activeSkinLibraryEntryId, ENTRY_ID)
    store.updateDmeloperPalmColor('#334455')
    store.updateDmeloperEyebrows({ color: '#123456' })
    store.handleSkinLibraryEntriesDeleted([OTHER_ENTRY_ID, ENTRY_ID], '#445566')
    assert.equal(store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.equal(store.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(store.customization3d.useDefaultDmeloperSkin, true)
    assert.equal(store.customization3d.preset.dmeloperPalmColor, '#445566')
    assert.equal(store.customization3d.preset.dmeloperEyebrows.color, '#123456')
  })

  it('separates general and performance reset scopes', () => {
    const store = createStore()
    Object.assign(store.window, {
      visible: false,
      passThrough: true,
      alwaysOnTop: true,
      scale: 55,
      opacity: 44,
      hideOnHover: true,
      hideOnHoverDelay: 7,
      keepInScreen: false,
    })
    Object.assign(store.model, {
      maxFPS: 30,
      shadowsEnabled: false,
      renderScalePercent: 50,
      mirror: true,
    })

    store.resetGeneralSettings()
    assert.deepEqual({
      visible: store.window.visible,
      passThrough: store.window.passThrough,
      alwaysOnTop: store.window.alwaysOnTop,
      hideOnHover: store.window.hideOnHover,
      hideOnHoverDelay: store.window.hideOnHoverDelay,
      keepInScreen: store.window.keepInScreen,
    }, {
      visible: true,
      passThrough: false,
      alwaysOnTop: true,
      hideOnHover: false,
      hideOnHoverDelay: 0,
      keepInScreen: true,
    })
    assert.equal(store.window.scale, 55)
    assert.equal(store.window.opacity, 44)
    assert.equal(store.model.maxFPS, 30)

    store.resetPerformanceSettings()
    assert.equal(store.model.maxFPS, 30)
    assert.equal(store.model.shadowsEnabled, true)
    assert.equal(store.model.renderScalePercent, 100)
    assert.equal(store.model.mirror, true)
  })
})

describe('device palette persistence', () => {
  it('preserves independent colors across initialization, restart and object-only reset', () => {
    const source = createStore()
    source.init()
    const colors = { keyboardColor: '#112233', keyboardKeycapColor: '#445566', keyboardLegendColor: '#778899', keyboardPressedColor: '#aabbcc', mouseColor: '#ddeeff', mousePressedColor: '#123456' }
    Object.assign(source.activePet3dPreset, colors)
    source.activePet3dPreset.petDeskOffset = 0.32
    const restored = createStore()
    restored.$patch(JSON.parse(JSON.stringify(source.$state)))
    restored.init()
    for (const key of DEVICE_COLOR_KEYS) assert.equal(restored.activePet3dPreset[key], colors[key])
    restored.resetEnvironment3d()
    for (const key of DEVICE_COLOR_KEYS) assert.equal(restored.activePet3dPreset[key], DEFAULT_DEVICE_COLORS[key])
    assert.equal(restored.activePet3dPreset.petDeskOffset, 0.32)
  })

  it('supplies absent colors and sanitizes malformed values without changing other settings', () => {
    const source = createStore()
    source.init()
    for (const value of [undefined, null, {}, '#123', '#gggggg', 12]) {
      Object.assign(source.activePet3dPreset, Object.fromEntries(DEVICE_COLOR_KEYS.map(key => [key, value])))
      source.activePet3dPreset.keyboardBaseXOffset = 0.33
      source.init()
      for (const key of DEVICE_COLOR_KEYS) assert.equal(source.activePet3dPreset[key], DEFAULT_DEVICE_COLORS[key])
      assert.equal(source.activePet3dPreset.keyboardBaseXOffset, 0.33)
    }
  })
})

it('does not merge the built-in identity into legacy user PNGs lacking a library ID', () => {
  for (const schemaVersion of [8, 9, 10, 11, 12, 13]) {
    const source = createStore()
    const incoming = { customization3d: { schemaVersion, dmeloperSkinDataUrl: 'data:image/png;base64,iVBORw0KGgo=', dmeloperSkinModel: 'slim' } }
    const before = JSON.stringify(incoming)
    source.$patch(preparePetStateForSync(incoming))
    source.init()
    assert.equal(source.customization3d.activeSkinLibraryEntryId, undefined)
    assert.equal(source.getPendingSkinLibraryMigration()?.dataUrl, incoming.customization3d.dmeloperSkinDataUrl)
    assert.equal(JSON.stringify(incoming), before)
  }
})

it('restores, clamps, and resets head size while preserving other settings', () => {
  for (const [value, expected] of [[undefined, 100], [10, 25], [250, 200], [175, 175]]) {
    const store = createStore()
    Object.assign(store.activePet3dPreset, { petHeadScalePercent: value, cameraZoomPercent: 150 })
    store.init()
    assert.equal(store.activePet3dPreset.petHeadScalePercent, expected)
    const snapshot = capturePresetSnapshot(store)
    const restored = createStore()
    applyPresetSnapshot(restored, snapshot)
    restored.init()
    assert.equal(restored.activePet3dPreset.petHeadScalePercent, expected)
    restored.resetPetBehavior()
    assert.equal(restored.activePet3dPreset.petHeadScalePercent, 100)
    assert.equal(restored.activePet3dPreset.cameraZoomPercent, 150)
  }
})

describe('eyebrow depth persistence', () => {
  it('fills legacy depth before deep merge, preserves zero across restart and resets to the authored depth', () => {
    const source = createStore()
    source.init()
    source.updateDmeloperEyebrows({ depthPercent: 0, widthPixels: 3 })
    const saved = JSON.parse(JSON.stringify(source.$state))
    const restored = createStore()
    restored.$patch(preparePetStateForSync(saved))
    restored.init()
    assert.equal(restored.activePet3dPreset.dmeloperEyebrows.depthPercent, 0)
    const legacy = JSON.parse(JSON.stringify(saved))
    delete legacy.customization3d.preset.dmeloperEyebrows.depthPercent
    restored.$patch(preparePetStateForSync(legacy))
    restored.init()
    assert.equal(restored.activePet3dPreset.dmeloperEyebrows.depthPercent, 100)
    assert.equal(restored.activePet3dPreset.dmeloperEyebrows.widthPixels, 3)
    assert.equal('depthPercent' in legacy.customization3d.preset.dmeloperEyebrows, false)
    restored.updateDmeloperEyebrows({ depthPercent: 0 })
    restored.resetDmeloperEyebrows()
    assert.equal(restored.activePet3dPreset.dmeloperEyebrows.depthPercent, 50)
  })

  it('clamps stored depth while defaulting non-finite and malformed values', () => {
    const source = createStore()
    for (const [input, expected] of [[-1, 0], [201, 200], [100, 100], [200, 200], [50, 50], [Number.NaN, 50], [Infinity, 50], ['0', 50], [null, 50]] as const) {
      source.updateDmeloperEyebrows({ depthPercent: input as number })
      assert.equal(source.activePet3dPreset.dmeloperEyebrows.depthPercent, expected)
    }
  })
})

describe('desk setting persistence and reset ownership', () => {
  const readDesk = (source: ReturnType<typeof createStore>) => Object.fromEntries(DESK_SETTING_KEYS.map(key => [key, source.activePet3dPreset[key]]))

  it('fills legacy desk fields before deep merge without replacing explicit choices or unrelated settings', () => {
    const source = createStore()
    Object.assign(source.activePet3dPreset, { deskTransparent: false, deskHeightOffset: 0.7, deskColor: '#123456' })
    const legacy = JSON.parse(JSON.stringify(source.$state))
    delete legacy.customization3d.preset.deskHeightOffset
    delete legacy.customization3d.preset.deskColor
    delete legacy.customization3d.preset.deskWidthOffset
    delete legacy.customization3d.preset.deskDepthOffset
    legacy.customization3d.preset.cameraZoomPercent = 137
    source.$patch(preparePetStateForSync(legacy))
    source.init()
    assert.deepEqual(readDesk(source), { ...LEGACY_DESK_SETTINGS, deskTransparent: false })
    assert.equal(source.activePet3dPreset.cameraZoomPercent, 137)
    assert.equal('deskColor' in legacy.customization3d.preset, false)
  })

  it('retains both transparent and opaque desk choices through restart and pet reset, with object and whole resets restoring defaults', () => {
    for (const deskTransparent of [true, false]) {
      const source = createStore()
      const settings = { deskTransparent, deskHeightOffset: -0.73, deskWidthOffset: 0.42, deskDepthOffset: -0.7, deskColor: '#A1b2C3' }
      Object.assign(source.activePet3dPreset, settings)
      const restored = createStore()
      restored.$patch(preparePetStateForSync(JSON.parse(JSON.stringify(source.$state))))
      restored.init()
      assert.deepEqual(readDesk(restored), settings)
      for (const reset of [restored.resetPetBehavior, restored.resetDmeloperSkinToDefault, restored.resetScene3d]) {
        reset()
        assert.deepEqual(readDesk(restored), settings)
      }
      for (const reset of [restored.resetEnvironment3d, restored.resetActivePet3dPreset, restored.resetAllSettings]) {
        Object.assign(restored.activePet3dPreset, settings)
        reset()
        assert.deepEqual(readDesk(restored), DEFAULT_DESK_SETTINGS)
      }
    }
  })

  it('sanitizes malformed local desk values and clamps dimensions without changing the current schema or scene', () => {
    for (const [value, expected] of [[-2, -1], [2, 1], [0, 0], [Number.NaN, 0], [Infinity, 0], [null, 0], ['0.2', 0]] as const) {
      const source = createStore()
      const version = source.customization3d.schemaVersion
      Object.assign(source.activePet3dPreset, { deskTransparent: 'false', deskHeightOffset: value, deskWidthOffset: value, deskDepthOffset: value, deskColor: 'red', cameraZoomPercent: 137 })
      source.init()
      assert.deepEqual(readDesk(source), {
        ...DEFAULT_DESK_SETTINGS,
        deskHeightOffset: expected,
        deskDepthOffset: typeof value === 'number' && Number.isFinite(value) ? expected : DEFAULT_DESK_SETTINGS.deskDepthOffset,
        deskWidthOffset: typeof value === 'number' && Number.isFinite(value) ? expected : DEFAULT_DESK_SETTINGS.deskWidthOffset,
      })
      assert.equal(source.customization3d.schemaVersion, version)
      assert.equal(source.activePet3dPreset.cameraZoomPercent, 137)
    }
  })
})

it('resets desk, keyboard and mouse independently while preserving other state and the aggregate reset', () => {
  const source = createStore()
  const changed = {
    deskTransparent: false,
    deskHeightOffset: 0.73,
    deskWidthOffset: 0.4,
    deskDepthOffset: -0.8,
    deskColor: '#123456',
    keyboardColor: '#112233',
    keyboardKeycapColor: '#223344',
    keyboardLegendColor: '#334455',
    keyboardPressedColor: '#445566',
    keyboardBaseXOffset: 0.25,
    keyboardBaseZOffset: -0.5,
    keyboardScalePercent: 175,
    keyboardLegendLanguage: 'en' as const,
    mouseEnabled: false,
    mouseColor: '#556677',
    mousePressedColor: '#667788',
    mouseBaseXOffset: -0.4,
    mouseBaseZOffset: 0.5,
    mouseScalePercent: 150,
  }
  source.activePet3dPreset.petRotationDegrees = 31
  source.activePet3dPreset.cameraZoomPercent = 150
  source.model.maxFPS = 30
  source.window.opacity = 60
  const defaults = createDefaultPet3dPreset()
  const keyboardKeys = ['keyboardColor', 'keyboardKeycapColor', 'keyboardLegendColor', 'keyboardPressedColor', 'keyboardBaseXOffset', 'keyboardBaseZOffset', 'keyboardScalePercent', 'keyboardLegendLanguage'] as const
  const mouseKeys = ['mouseEnabled', 'mouseColor', 'mousePressedColor', 'mouseBaseXOffset', 'mouseBaseZOffset', 'mouseScalePercent'] as const
  const cases = [
    { reset: source.resetDesk3d, keys: DESK_SETTING_KEYS },
    { reset: source.resetKeyboard3d, keys: keyboardKeys },
    { reset: source.resetMouse3d, keys: mouseKeys },
    { reset: source.resetEnvironment3d, keys: [...DESK_SETTING_KEYS, ...keyboardKeys, ...mouseKeys] },
  ]
  for (const { reset, keys } of cases) {
    Object.assign(source.activePet3dPreset, changed)
    const expected = JSON.parse(JSON.stringify(source.$state))
    for (const key of keys) expected.customization3d.preset[key] = defaults[key]
    reset()
    assert.deepEqual(JSON.parse(JSON.stringify(source.$state)), expected)
  }
})
