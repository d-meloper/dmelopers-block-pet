import type { Menu } from '@tauri-apps/api/menu'
import type { TrayIconEvent } from '@tauri-apps/api/tray'

import { getVersion } from '@tauri-apps/api/app'
import { emitTo } from '@tauri-apps/api/event'
import { resolveResource } from '@tauri-apps/api/path'
import { TrayIcon } from '@tauri-apps/api/tray'
import { computed, onBeforeUnmount, readonly, ref, watch } from 'vue'

import { APP_DISPLAY_NAME, WINDOW_LABEL } from '@/constants'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'
import { editorsLocked } from '@/features/stateSafety'
import { showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'
import { createLatestAsyncTaskQueue } from '@/utils/latestAsyncTask'

import { useAppMenu } from './useAppMenu'

const TRAY_ID = 'DMELOPERS_BLOCK_PET_TRAY'

export function useTray(canEdit: () => boolean = () => true) {
  const catStore = useCatStore()
  const generalStore = useGeneralStore()
  const { getAppMenu } = useAppMenu()
  let generation = 0
  let disposed = false
  let ownsTray = false
  let attachedMenu: Menu | undefined
  const broadcastPromptOpen = ref(false)
  // Retain priority through the modal's closing animation.
  const broadcastPromptActive = ref(false)
  const broadcastRestoreDisabled = computed(() => editorsLocked.value || !canEdit())

  function cancelBroadcastRestore() {
    broadcastPromptOpen.value = false
  }

  function finishBroadcastPrompt() {
    if (!broadcastPromptOpen.value) broadcastPromptActive.value = false
  }

  function confirmBroadcastRestore() {
    if (disposed || !broadcastPromptOpen.value || broadcastRestoreDisabled.value) return
    // Preferences owns these stores, as in the broadcast settings control.
    // Its existing persistence and main-window watchers restore the renderer.
    generalStore.broadcast.showOnDesktop = true
    catStore.window.visible = true
    cancelBroadcastRestore()
  }

  function handleTrayEvent(event: TrayIconEvent) {
    if (disposed || event.type !== 'Click' || event.button !== 'Left' || event.buttonState !== 'Up') return
    if (broadcastRestoreDisabled.value) return

    if (broadcastPromptActive.value || (generalStore.broadcast.enabled
      && (!catStore.window.visible || !generalStore.broadcast.showOnDesktop))) {
      if (!broadcastPromptActive.value) {
        broadcastPromptActive.value = true
        broadcastPromptOpen.value = true
      }
      // Untargeted native show preserves the current preference tab.
      void showWindow().catch(error => console.error('Failed to show the broadcast visibility prompt.', error))
      return
    }

    // Hidden pets must restore their renderer through the visibility owner first.
    const request = catStore.window.visible
      ? showWindow(WINDOW_LABEL.MAIN)
      : emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { visible: true })
    void request.catch(error => console.error('Failed to focus the pet from the tray.', error))
  }

  const updates = createLatestAsyncTaskQueue(async (request: number) => {
    let tray = await TrayIcon.getById(TRAY_ID)
    if (disposed || request !== generation) return
    const menu = await getAppMenu()
    let attached = false
    try {
      if (disposed || request !== generation) return
      if (tray && ownsTray) {
        await tray.setMenu(menu)
      } else {
        const [appVersion, icon] = await Promise.all([
          getVersion(),
          resolveResource('assets/tray.png'),
        ])
        if (disposed || request !== generation) return
        // Native trays survive webview reloads, but their IPC callback belongs to
        // the previous page. setMenu cannot rebind it; replace it once per owner.
        if (tray) await TrayIcon.removeById(TRAY_ID)
        if (disposed || request !== generation) return
        tray = await TrayIcon.new({
          menu,
          icon,
          id: TRAY_ID,
          tooltip: `${APP_DISPLAY_NAME} v${appVersion}`,
          iconAsTemplate: true,
          showMenuOnLeftClick: false,
          action: handleTrayEvent,
        })
        ownsTray = true
      }
      attached = true
      const previous = attachedMenu
      attachedMenu = menu
      await previous?.close()
      // Read the latest visibility even if it changed during native creation.
      await tray.setVisible(generalStore.app.trayVisible)
    } finally {
      if (!attached) await menu.close()
    }
  }, { onError: error => console.error('Failed to update the tray menu.', error) })

  watch([
    () => catStore.window.visible,
    () => generalStore.broadcast.enabled,
    () => generalStore.broadcast.showOnDesktop,
    () => catStore.activePet3dPreset.cameraZoomPercent,
    () => catStore.activePet3dPreset.sceneRotationOffsetDegrees,
    () => catStore.window.opacity,
    () => catStore.window.keepInScreen,
    () => generalStore.appearance.language,
    () => generalStore.app.trayVisible,
    () => editorsLocked.value,
  ], () => updates.enqueue(++generation), { immediate: true })

  onBeforeUnmount(() => {
    disposed = true
    generation += 1
    updates.clear()
    broadcastPromptOpen.value = false
    broadcastPromptActive.value = false
  })

  return {
    broadcastPromptOpen: readonly(broadcastPromptOpen),
    broadcastPromptActive: readonly(broadcastPromptActive),
    broadcastRestoreDisabled,
    confirmBroadcastRestore,
    cancelBroadcastRestore,
    finishBroadcastPrompt,
  }
}
