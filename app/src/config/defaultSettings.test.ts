/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { createDefaultPresetSnapshot, createPresetCollection, isPresetSnapshot } from '@/features/presets/model'
import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'
import { useShortcutStore } from '@/stores/shortcut'

import { DEFAULT_GENERAL_SETTINGS, DEFAULT_MODEL_SETTINGS, DEFAULT_PET_PRESET, DEFAULT_SHORTCUT_SETTINGS, DEFAULT_WINDOW_SETTINGS } from './defaultSettings'
import { PET_MODEL_OPTIONS } from './model3d'

describe('authored first-release defaults', () => {
  it('survives first initialization with authored settings and an empty catalog', async () => {
    setActivePinia(createPinia())
    const block = useBlockStore()
    const general = useGeneralStore()
    block.init()
    await general.init()
    assert.deepEqual({ ...block.model }, DEFAULT_MODEL_SETTINGS)
    assert.equal(block.model.maxFPS, 30)
    assert.equal(block.model.shadowQuality, 'medium')
    assert.deepEqual({ ...block.window }, DEFAULT_WINDOW_SETTINGS)
    assert.deepEqual({ ...general.app }, DEFAULT_GENERAL_SETTINGS.app)
    assert.deepEqual({ ...general.broadcast }, DEFAULT_GENERAL_SETTINGS.broadcast)
    assert.equal(general.appearance.language, 'ko-KR')
    assert.equal(general.appearance.theme, 'auto')
    const preset = createDefaultPresetSnapshot()
    assert.equal(isPresetSnapshot(preset), true)
    assert.ok(PET_MODEL_OPTIONS.some(model => model.id === preset.appearance.selectedModelId))
    assert.ok(['auto', 'light', 'dark'].includes(general.appearance.theme))
    assert.equal(preset.preset.autoViewportPaddingPixels, 2)
    assert.equal(preset.preset.deskWidthOffset, -0.28)
    assert.equal(preset.preset.deskDepthOffset, 0.1)
    assert.equal(preset.preset.dmeloperEyebrows.color, '#523830')
    assert.equal(preset.preset.dmeloperEyebrows.heightOffsetPixels, 0.3)
    assert.equal(preset.preset.dmeloperEyebrows.depthPercent, 50)
    assert.equal(preset.preset.dmeloperPalmColor, '#FFDFCE')
    assert.equal(preset.appearance.dmeloperSkinDataUrl, undefined)
    assert.equal(preset.appearance.minecraftSkinUsername, undefined)
    const catalog = createPresetCollection()
    assert.equal(catalog.activeId, null)
    assert.equal(catalog.entries.length, 0)
  })

  it('keeps each factory independent and resets each category to the same authored values', () => {
    setActivePinia(createPinia())
    const block = useBlockStore()
    block.init()
    const other = createDefaultPet3dPreset()
    Object.assign(block.activePet3dPreset.dmeloperEyebrows, { color: '#111111', heightOffsetPixels: 2, depthPercent: 180 })
    block.activePet3dPreset.manualViewportRect.width = 999
    assert.equal(other.dmeloperEyebrows.depthPercent, 50)
    assert.equal(other.manualViewportRect.width, 500)
    block.resetDmeloperEyebrows()
    assert.deepEqual(block.activePet3dPreset.dmeloperEyebrows, DEFAULT_PET_PRESET.dmeloperEyebrows)
    block.activePet3dPreset.dmeloperPalmColor = '#123456'
    block.resetDmeloperPalmColor()
    assert.equal(block.activePet3dPreset.dmeloperPalmColor, '#FFDFCE')
    block.activePet3dPreset.autoViewportPaddingPixels = 16
    block.resetScene3d()
    assert.equal(block.activePet3dPreset.autoViewportPaddingPixels, 2)
    assert.deepEqual(block.activePet3dPreset.manualViewportRect, DEFAULT_PET_PRESET.manualViewportRect)
    Object.assign(block.model, { maxFPS: 60, shadowQuality: 'high', idlePowerSavingEnabled: false, pixelFilterEnabled: false })
    block.resetPerformanceSettings()
    assert.equal(block.model.maxFPS, 30)
    assert.equal(block.model.shadowQuality, 'medium')
    assert.equal(block.model.idlePowerSavingEnabled, true)
    assert.equal(block.model.pixelFilterEnabled, true)
    block.window.alwaysOnTop = false
    block.resetGeneralSettings()
    assert.equal(block.window.alwaysOnTop, true)
    const previousRevision = block.activePet3dPreset.viewportModeRevision
    block.resetAllSettings()
    assert.deepEqual({ ...block.model }, DEFAULT_MODEL_SETTINGS)
    assert.deepEqual({ ...block.window }, DEFAULT_WINDOW_SETTINGS)
    assert.deepEqual(block.activePet3dPreset, { ...DEFAULT_PET_PRESET, viewportModeRevision: previousRevision + 1 })
    assert.equal(block.presetCollection?.activeId, null)
    assert.equal(block.presetCollection?.entries.length, 0)
  })

  it('preserves explicit saved choices and an observed system theme until reset is requested', async () => {
    setActivePinia(createPinia())
    const block = useBlockStore()
    const general = useGeneralStore()
    block.$patch({ migrated: true, model: { maxFPS: 60, shadowQuality: 'high', idlePowerSavingEnabled: false, pixelFilterEnabled: false }, window: { alwaysOnTop: false }, customization3d: { preset: { autoViewportPaddingPixels: 12, dmeloperEyebrows: { depthPercent: 125 } } } })
    general.$patch({ migrated: true, app: { autostart: true, broadcastRestorePromptDismissed: true, applyPresetSkin: false }, broadcast: { enabled: true, showOnDesktop: true }, appearance: { language: 'en-US', theme: 'auto', isDark: true } })
    block.init()
    await general.init()
    assert.equal(block.model.maxFPS, 60)
    assert.equal(block.model.shadowQuality, 'high')
    assert.equal(block.model.idlePowerSavingEnabled, false)
    assert.equal(block.model.pixelFilterEnabled, false)
    assert.equal(block.window.alwaysOnTop, false)
    assert.equal(block.activePet3dPreset.autoViewportPaddingPixels, 12)
    assert.equal(block.activePet3dPreset.dmeloperEyebrows.depthPercent, 125)
    assert.equal(general.appearance.language, 'en-US')
    assert.equal(general.app.autostart, true)
    assert.equal(general.app.broadcastRestorePromptDismissed, true)
    assert.equal(general.app.applyPresetSkin, false)
    assert.equal(general.broadcast.showOnDesktop, true)
    general.reset()
    await general.init()
    assert.equal(general.appearance.language, 'ko-KR')
    assert.equal(general.appearance.theme, 'auto')
    assert.equal(general.appearance.isDark, true)
    assert.equal(general.app.autostart, false)
    assert.equal(general.app.broadcastRestorePromptDismissed, false)
    assert.equal(general.app.applyPresetSkin, true)
    assert.equal(general.broadcast.showOnDesktop, false)
  })

  it('creates an independent empty catalog without capturing live settings', () => {
    const a = createPresetCollection()
    const b = createPresetCollection()
    a.activeId = 'missing'
    assert.equal(b.activeId, null)
    assert.deepEqual(b.entries, [])
  })

  it('uses the shared shortcut defaults on first launch and explicit reset', () => {
    setActivePinia(createPinia())
    const shortcut = useShortcutStore()
    assert.deepEqual({ ...shortcut.$state }, DEFAULT_SHORTCUT_SETTINGS)
    shortcut.visibleBlock = 'F8'
    shortcut.toggleBroadcast = 'Ctrl+F9'
    shortcut.reset()
    assert.deepEqual({ ...shortcut.$state }, DEFAULT_SHORTCUT_SETTINGS)
  })
})
