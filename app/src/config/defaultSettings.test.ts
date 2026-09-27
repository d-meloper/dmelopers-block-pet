/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { createDefaultPresetSnapshot, createPresetCollection, isInitialDefaultSnapshot, isPresetSnapshot } from '@/features/presets/model'
import { BUILTIN_PRESET_ID } from '@/features/presets/types'
import { createDefaultPet3dPreset, useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'
import { useShortcutStore } from '@/stores/shortcut'

import { DEFAULT_GENERAL_SETTINGS, DEFAULT_MODEL_SETTINGS, DEFAULT_PET_PRESET, DEFAULT_SHORTCUT_SETTINGS, DEFAULT_WINDOW_SETTINGS } from './defaultSettings'
import { PET_MODEL_OPTIONS } from './model3d'

describe('authored first-release defaults', () => {
  it('survives first initialization and matches the built-in preset without a private catalog', async () => {
    setActivePinia(createPinia())
    const cat = useCatStore()
    const general = useGeneralStore()
    cat.init()
    await general.init()
    assert.deepEqual({ ...cat.model }, DEFAULT_MODEL_SETTINGS)
    assert.equal(cat.model.maxFPS, 60)
    assert.equal(cat.model.shadowQuality, 'high')
    assert.deepEqual({ ...cat.window }, DEFAULT_WINDOW_SETTINGS)
    assert.deepEqual({ ...general.app }, DEFAULT_GENERAL_SETTINGS.app)
    assert.deepEqual({ ...general.broadcast }, DEFAULT_GENERAL_SETTINGS.broadcast)
    assert.equal(general.appearance.language, 'ko-KR')
    assert.equal(general.appearance.theme, 'auto')
    const preset = createDefaultPresetSnapshot()
    assert.equal(isPresetSnapshot(preset), true)
    assert.ok(PET_MODEL_OPTIONS.some(model => model.id === preset.appearance.selectedModelId))
    assert.ok(['auto', 'light', 'dark'].includes(general.appearance.theme))
    assert.equal(preset.preset.autoViewportPaddingPixels, 2)
    assert.equal(preset.preset.dmeloperEyebrows.color, '#523830')
    assert.equal(preset.preset.dmeloperEyebrows.heightOffsetPixels, 0.3)
    assert.equal(preset.preset.dmeloperEyebrows.depthPercent, 50)
    assert.equal(preset.preset.dmeloperPalmColor, '#FFDFCE')
    assert.equal(preset.appearance.dmeloperSkinDataUrl, undefined)
    assert.equal(preset.appearance.minecraftSkinUsername, undefined)
    const catalog = createPresetCollection()
    assert.equal(catalog.activeId, BUILTIN_PRESET_ID)
    assert.equal(catalog.entries.length, 1)
    assert.equal(catalog.entries[0].name, '')
    assert.deepEqual(catalog.entries[0].snapshot, preset)
  })

  it('keeps each factory independent and resets each category to the same authored values', () => {
    setActivePinia(createPinia())
    const cat = useCatStore()
    cat.init()
    const other = createDefaultPet3dPreset()
    Object.assign(cat.activePet3dPreset.dmeloperEyebrows, { color: '#111111', heightOffsetPixels: 2, depthPercent: 180 })
    cat.activePet3dPreset.manualViewportRect.width = 999
    assert.equal(other.dmeloperEyebrows.depthPercent, 50)
    assert.equal(other.manualViewportRect.width, 500)
    cat.resetDmeloperEyebrows()
    assert.deepEqual(cat.activePet3dPreset.dmeloperEyebrows, DEFAULT_PET_PRESET.dmeloperEyebrows)
    cat.activePet3dPreset.dmeloperPalmColor = '#123456'
    cat.resetDmeloperPalmColor()
    assert.equal(cat.activePet3dPreset.dmeloperPalmColor, '#FFDFCE')
    cat.activePet3dPreset.autoViewportPaddingPixels = 16
    cat.resetScene3d()
    assert.equal(cat.activePet3dPreset.autoViewportPaddingPixels, 2)
    assert.deepEqual(cat.activePet3dPreset.manualViewportRect, DEFAULT_PET_PRESET.manualViewportRect)
    Object.assign(cat.model, { maxFPS: 30, idlePowerSavingEnabled: false, pixelFilterEnabled: false })
    cat.resetPerformanceSettings()
    assert.equal(cat.model.maxFPS, 60)
    assert.equal(cat.model.shadowQuality, 'high')
    assert.equal(cat.model.idlePowerSavingEnabled, true)
    assert.equal(cat.model.pixelFilterEnabled, true)
    cat.window.alwaysOnTop = false
    cat.resetGeneralSettings()
    assert.equal(cat.window.alwaysOnTop, true)
    cat.resetAllSettings()
    assert.deepEqual({ ...cat.model }, DEFAULT_MODEL_SETTINGS)
    assert.deepEqual({ ...cat.window }, DEFAULT_WINDOW_SETTINGS)
    assert.deepEqual(cat.activePet3dPreset, DEFAULT_PET_PRESET)
    assert.equal(cat.presetCollection?.activeId, BUILTIN_PRESET_ID)
    assert.equal(cat.presetCollection?.entries.length, 1)
  })

  it('preserves explicit saved choices and an observed system theme until reset is requested', async () => {
    setActivePinia(createPinia())
    const cat = useCatStore()
    const general = useGeneralStore()
    cat.$patch({ migrated: true, model: { maxFPS: 30, idlePowerSavingEnabled: false, pixelFilterEnabled: false }, window: { alwaysOnTop: false }, customization3d: { preset: { autoViewportPaddingPixels: 12, dmeloperEyebrows: { depthPercent: 125 } } } })
    general.$patch({ migrated: true, app: { autostart: true }, broadcast: { enabled: true, showOnDesktop: true }, appearance: { language: 'en-US', theme: 'auto', isDark: true } })
    cat.init()
    await general.init()
    assert.equal(cat.model.maxFPS, 30)
    assert.equal(cat.model.idlePowerSavingEnabled, false)
    assert.equal(cat.model.pixelFilterEnabled, false)
    assert.equal(cat.window.alwaysOnTop, false)
    assert.equal(cat.activePet3dPreset.autoViewportPaddingPixels, 12)
    assert.equal(cat.activePet3dPreset.dmeloperEyebrows.depthPercent, 125)
    assert.equal(general.appearance.language, 'en-US')
    assert.equal(general.app.autostart, true)
    assert.equal(general.broadcast.showOnDesktop, true)
    general.reset()
    await general.init()
    assert.equal(general.appearance.language, 'ko-KR')
    assert.equal(general.appearance.theme, 'auto')
    assert.equal(general.appearance.isDark, true)
    assert.equal(general.app.autostart, false)
    assert.equal(general.broadcast.showOnDesktop, false)
  })

  it('adopts only untouched defaults as the built-in first catalog', () => {
    const pristine = createDefaultPresetSnapshot()
    assert.equal(isInitialDefaultSnapshot(pristine), true)
    pristine.appearance.activeSkinLibraryEntryId = 'builtin:dmeloper'
    assert.equal(isInitialDefaultSnapshot(pristine), true)
    pristine.preset.autoViewportPaddingPixels = 12
    assert.equal(isInitialDefaultSnapshot(pristine), false)
    pristine.preset.autoViewportPaddingPixels = 2
    pristine.appearance.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
    assert.equal(isInitialDefaultSnapshot(pristine), false)
  })

  it('uses the shared shortcut defaults on first launch and explicit reset', () => {
    setActivePinia(createPinia())
    const shortcut = useShortcutStore()
    assert.deepEqual({ ...shortcut.$state }, DEFAULT_SHORTCUT_SETTINGS)
    shortcut.visibleCat = 'F8'
    shortcut.toggleBroadcast = 'Ctrl+F9'
    shortcut.reset()
    assert.deepEqual({ ...shortcut.$state }, DEFAULT_SHORTCUT_SETTINGS)
  })
})
