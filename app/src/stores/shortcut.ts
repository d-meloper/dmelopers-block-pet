import { defineStore } from 'pinia'
import { ref } from 'vue'

import { DEFAULT_SHORTCUT_SETTINGS } from '@/config/defaultSettings'
import { restoreShortcutState, serializeShortcutState } from '@/config/persistedNames'

export type HotKey = 'visibleBlock' | 'mirrorMode' | 'cycleZoom' | 'cycleRotation' | 'penetrable' | 'alwaysOnTop' | 'visiblePreference' | 'toggleBroadcast' | 'showDisplayArea' | 'mouseEnabled' | 'keepInScreen' | 'hideOnHover' | 'keyboardKeycapInputEnabled'

export const useShortcutStore = defineStore('shortcut', () => {
  const visibleBlock = ref(DEFAULT_SHORTCUT_SETTINGS.visibleBlock)
  const visiblePreference = ref(DEFAULT_SHORTCUT_SETTINGS.visiblePreference)
  const mirrorMode = ref(DEFAULT_SHORTCUT_SETTINGS.mirrorMode)
  const cycleZoom = ref(DEFAULT_SHORTCUT_SETTINGS.cycleZoom)
  const cycleRotation = ref(DEFAULT_SHORTCUT_SETTINGS.cycleRotation)
  const penetrable = ref(DEFAULT_SHORTCUT_SETTINGS.penetrable)
  const alwaysOnTop = ref(DEFAULT_SHORTCUT_SETTINGS.alwaysOnTop)

  const toggleBroadcast = ref(DEFAULT_SHORTCUT_SETTINGS.toggleBroadcast)
  const showDisplayArea = ref(DEFAULT_SHORTCUT_SETTINGS.showDisplayArea)
  const mouseEnabled = ref(DEFAULT_SHORTCUT_SETTINGS.mouseEnabled)
  const keepInScreen = ref(DEFAULT_SHORTCUT_SETTINGS.keepInScreen)
  const hideOnHover = ref(DEFAULT_SHORTCUT_SETTINGS.hideOnHover)
  const keyboardKeycapInputEnabled = ref(DEFAULT_SHORTCUT_SETTINGS.keyboardKeycapInputEnabled)

  const reset = () => {
    toggleBroadcast.value = DEFAULT_SHORTCUT_SETTINGS.toggleBroadcast
    showDisplayArea.value = DEFAULT_SHORTCUT_SETTINGS.showDisplayArea
    mouseEnabled.value = DEFAULT_SHORTCUT_SETTINGS.mouseEnabled
    keepInScreen.value = DEFAULT_SHORTCUT_SETTINGS.keepInScreen
    hideOnHover.value = DEFAULT_SHORTCUT_SETTINGS.hideOnHover
    visibleBlock.value = DEFAULT_SHORTCUT_SETTINGS.visibleBlock
    visiblePreference.value = DEFAULT_SHORTCUT_SETTINGS.visiblePreference
    mirrorMode.value = DEFAULT_SHORTCUT_SETTINGS.mirrorMode
    cycleZoom.value = DEFAULT_SHORTCUT_SETTINGS.cycleZoom
    cycleRotation.value = DEFAULT_SHORTCUT_SETTINGS.cycleRotation
    penetrable.value = DEFAULT_SHORTCUT_SETTINGS.penetrable
    alwaysOnTop.value = DEFAULT_SHORTCUT_SETTINGS.alwaysOnTop
    keyboardKeycapInputEnabled.value = DEFAULT_SHORTCUT_SETTINGS.keyboardKeycapInputEnabled
  }

  return {
    toggleBroadcast,
    showDisplayArea,
    mouseEnabled,
    keepInScreen,
    hideOnHover,
    visibleBlock,
    visiblePreference,
    mirrorMode,
    cycleZoom,
    cycleRotation,
    penetrable,
    alwaysOnTop,
    keyboardKeycapInputEnabled,
    reset,
  }
}, {
  tauri: {
    hooks: {
      beforeFrontendSync: restoreShortcutState,
      beforeBackendSync: serializeShortcutState,
    },
  },
})
