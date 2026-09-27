<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { emitTo } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEventListener } from '@vueuse/core'
import isURL from 'is-url'
import { onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView, useRouter } from 'vue-router'

import { createMenuViewportSettingHandler } from './composables/menuViewportSetting'
import { useTauriListen } from './composables/useTauriListen'
import { useWindowState } from './composables/useWindowState'
import { APP_DISPLAY_NAME, LANGUAGE, LISTEN_KEY, WINDOW_LABEL } from './constants'
import { isDesktopPetVisible } from './features/broadcast/visibility'
import { PET_RUNTIME_SHOW } from './features/petRuntime/types'
import { requestPresetEdit } from './features/presets/editRequests'
import { PRESET_EDIT_REQUEST } from './features/presets/types'
import { initializePetForStartup } from './features/stateSafety/bridge'
import { markStoresReady, registerStateSnapshots } from './features/stateSafety/runtime'
import { hideWindow, showWindow } from './plugins/window'
import { createShowWindowRequestHandler } from './plugins/windowNavigation'
import { useAppStore } from './stores/app'
import { useCatStore } from './stores/cat'
import { useGeneralStore } from './stores/general'
import { useShortcutStore } from './stores/shortcut.ts'

const appStore = useAppStore()
const catStore = useCatStore()
const generalStore = useGeneralStore()
const shortcutStore = useShortcutStore()
registerStateSnapshots(() => [appStore, catStore, generalStore, shortcutStore].map(store => ({
  id: store.$id,
  state: JSON.parse(JSON.stringify(store.$state)) as Record<string, unknown>,
})))
const appWindow = getCurrentWebviewWindow()
const { isRestored, restoreState } = useWindowState()
const { locale } = useI18n()
const router = useRouter()
let settingsReady: Promise<void>
let disposed = false
onUnmounted(() => {
  disposed = true
})

async function restoreSettings() {
  await appStore.$tauri.start()
  await appStore.init()
  if (appWindow.label === WINDOW_LABEL.MAIN) await appWindow.setTitle(APP_DISPLAY_NAME)
  await catStore.$tauri.start()
  initializePetForStartup(catStore)
  await generalStore.$tauri.start()
  await generalStore.init()
  await shortcutStore.$tauri.start()
  if (appWindow.label === WINDOW_LABEL.MAIN || appWindow.label === WINDOW_LABEL.PREFERENCE) {
    await invoke('initialize_shortcut_defaults')
  }
  markStoresReady()
}

onMounted(async () => {
  settingsReady = restoreSettings()
  await settingsReady
  if (disposed) return
  await restoreState()
})

watch(() => generalStore.appearance.language, (value) => {
  locale.value = value ?? LANGUAGE.EN_US
}, { immediate: true })

const handleShowWindowRequest = createShowWindowRequestHandler({
  label: appWindow.label,
  router,
  show: async () => {
    if (appWindow.label === WINDOW_LABEL.MAIN) {
      await settingsReady
      if (disposed || !isDesktopPetVisible(catStore.window.visible, generalStore.broadcast)) return
      await emitTo(WINDOW_LABEL.MAIN, PET_RUNTIME_SHOW)
      return
    }
    await showWindow()
  },
})
useTauriListen(LISTEN_KEY.SHOW_WINDOW, ({ payload }) => {
  void handleShowWindowRequest(payload).catch(error => console.error('Failed to show the requested window.', error))
})

useTauriListen(PRESET_EDIT_REQUEST, ({ payload }) => {
  if (appWindow.label === WINDOW_LABEL.PREFERENCE) requestPresetEdit(payload)
})

const handleMenuViewportSetting = createMenuViewportSettingHandler({
  ready: () => settingsReady,
  apply: ({ key, value }) => {
    void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { key, value })
  },
})
useTauriListen(LISTEN_KEY.MENU_VIEWPORT_SETTING_REQUEST, ({ payload }) => {
  if (appWindow.label !== WINDOW_LABEL.PREFERENCE) return
  void handleMenuViewportSetting(payload).catch(error => console.error('Failed to apply a menu viewport setting.', error))
})

useTauriListen(LISTEN_KEY.HIDE_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return

  if (appWindow.label === WINDOW_LABEL.MAIN) {
    void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { visible: false })
    return
  }

  hideWindow()
})

useEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest('a')

  if (!link) return

  const { href, target } = link

  if (target === '_blank') return

  event.preventDefault()

  if (!isURL(href)) return

  openUrl(href)
})
</script>

<template>
  <RouterView v-if="isRestored" />
</template>
