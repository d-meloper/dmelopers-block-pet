import type { Menu } from '@tauri-apps/api/menu'
import type { TrayIconEvent } from '@tauri-apps/api/tray'

import { getVersion } from '@tauri-apps/api/app'
import { emitTo } from '@tauri-apps/api/event'
import { resolveResource } from '@tauri-apps/api/path'
import { TrayIcon } from '@tauri-apps/api/tray'
import { onBeforeUnmount, watch } from 'vue'

import { APP_DISPLAY_NAME, WINDOW_LABEL } from '@/constants'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'
import { editorsLocked } from '@/features/stateSafety'
import { showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'
import { createLatestAsyncTaskQueue } from '@/utils/latestAsyncTask'

import { useAppMenu } from './useAppMenu'

const TRAY_ID = 'DMELOPERS_BLOCK_PET_TRAY'

export function useTray() {
  const catStore = useCatStore()
  const generalStore = useGeneralStore()
  const { getAppMenu } = useAppMenu()
  let generation = 0
  let disposed = false
  let attachedMenu: Menu | undefined

  function handleTrayEvent(event: TrayIconEvent) {
    if (disposed || event.type !== 'Click' || event.button !== 'Left' || event.buttonState !== 'Up') return
    if (editorsLocked.value) return

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
      if (tray) {
        await tray.setMenu(menu)
      } else {
        const [appVersion, icon] = await Promise.all([
          getVersion(),
          resolveResource('assets/tray.png'),
        ])
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
    () => catStore.activePet3dPreset.cameraZoomPercent,
    () => catStore.activePet3dPreset.sceneRotationOffsetDegrees,
    () => catStore.window.opacity,
    () => catStore.window.keepInScreen,
    () => catStore.window.alwaysOnTop,
    () => generalStore.appearance.language,
    () => generalStore.app.trayVisible,
    () => editorsLocked.value,
  ], () => updates.enqueue(++generation), { immediate: true })

  onBeforeUnmount(() => {
    disposed = true
    generation += 1
    updates.clear()
  })
}
