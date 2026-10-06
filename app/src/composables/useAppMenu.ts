import type { CheckMenuItemOptions } from '@tauri-apps/api/menu'

import { emitTo } from '@tauri-apps/api/event'
import { Menu } from '@tauri-apps/api/menu'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useI18n } from 'vue-i18n'

import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { isDesktopPetVisible } from '@/features/broadcast/visibility'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'
import { editorsLocked } from '@/features/stateSafety'
import { APP_PROCESS_FAILED, quitApp, restartApp } from '@/plugins/process'
import { showWindow } from '@/plugins/window'
import { useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'

import type { MenuViewportSettingRequest } from './menuViewportSetting'

import { MENU_VIEWPORT_OPTIONS } from './menuViewportSetting'

function numericMenuItems(
  idPrefix: string,
  options: readonly { value: number, label?: string }[],
  current: number,
  unit: '%' | '°',
  update: (value: number) => void | Promise<unknown>,
): CheckMenuItemOptions[] {
  const items: CheckMenuItemOptions[] = options.map(({ value, label }) => ({
    id: `${idPrefix}:${value}`,
    text: label ? `${label} (${value}${unit})` : `${value}${unit}`,
    checked: current === value,
    action: () => update(value),
  }))
  if (!options.some(option => option.value === current)) {
    items.unshift({ text: `${current}${unit}`, checked: true, enabled: false })
  }
  return items
}

export function useAppMenu() {
  const blockStore = useBlockStore()
  const generalStore = useGeneralStore()
  const { t } = useI18n()
  // Tauri retains menu action channels by ID independently of Resource.close.
  // Reuse semantic IDs, with separate owners for the pet menu and tray menu.
  const menuId = `block-pet-app-menu:${getCurrentWebviewWindow().label}`
  const runProcess = (action: 'quit' | 'restart') => (action === 'quit' ? quitApp() : restartApp()).catch(async () => {
    await showWindow({ label: WINDOW_LABEL.PREFERENCE, destination: 'presets' })
    await emitTo(WINDOW_LABEL.PREFERENCE, APP_PROCESS_FAILED, { action })
  })

  // Preferences owns preset writes and publishes them in order to the renderer.
  // A narrow request avoids racing its pending full-preset snapshots from Main.
  const requestViewportSetting = (key: MenuViewportSettingRequest['key'], value: number) => {
    if (editorsLocked.value) return Promise.resolve()
    return emitTo(WINDOW_LABEL.PREFERENCE, LISTEN_KEY.MENU_VIEWPORT_SETTING_REQUEST, { key, value })
  }

  const visibilityMenuItem = () => {
    const visible = isDesktopPetVisible(blockStore.window.visible, generalStore.broadcast)
    return {
      id: `${menuId}:visibility:${visible ? 'hide' : 'show'}`,
      text: t(`composables.useAppMenu.labels.${visible ? 'hideBlock' : 'showBlock'}`),
      action: () => {
        if (editorsLocked.value) return
        return emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { desktopVisible: !visible })
      },
    }
  }

  const getAppMenu = () => Menu.new({
    id: menuId,
    items: [
      visibilityMenuItem(),
      {
        id: `${menuId}:pet-settings`,
        text: t('composables.useAppMenu.labels.petSettings'),
        action: () => showWindow({ label: WINDOW_LABEL.PREFERENCE, destination: 'pet' }),
      },
      { item: 'Separator' },
      {
        id: `${menuId}:zoom`,
        text: t('composables.useAppMenu.labels.windowSize'),
        items: numericMenuItems(
          `${menuId}:zoom`,
          MENU_VIEWPORT_OPTIONS.cameraZoomPercent.map(({ value, label }) => ({
            value,
            label: t(`composables.useAppMenu.windowSizeOptions.${label}`),
          })),
          blockStore.activePet3dPreset.cameraZoomPercent,
          '%',
          value => requestViewportSetting('cameraZoomPercent', value),
        ),
      },
      {
        id: `${menuId}:rotation`,
        text: t('composables.useAppMenu.labels.rotation'),
        items: numericMenuItems(
          `${menuId}:rotation`,
          MENU_VIEWPORT_OPTIONS.sceneRotationOffsetDegrees.map(({ value, label }) => ({
            value,
            label: t(`composables.useAppMenu.rotationOptions.${label}`),
          })),
          blockStore.activePet3dPreset.sceneRotationOffsetDegrees,
          '°',
          value => requestViewportSetting('sceneRotationOffsetDegrees', value),
        ),
      },
      {
        id: `${menuId}:opacity`,
        text: t('composables.useAppMenu.labels.opacity'),
        items: numericMenuItems(`${menuId}:opacity`, [25, 50, 75, 100].map(value => ({ value })), blockStore.window.opacity, '%', (value) => {
          if (editorsLocked.value) return
          return emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { opacity: value })
        }),
      },
      {
        id: `${menuId}:keep-in-screen`,
        text: t('composables.useAppMenu.labels.keepInScreen'),
        checked: blockStore.window.keepInScreen,
        action: () => {
          if (editorsLocked.value) return
          return emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { keepInScreen: !blockStore.window.keepInScreen })
        },
      },
      { item: 'Separator' },
      {
        id: `${menuId}:preferences`,
        text: t('composables.useAppMenu.labels.preference'),
        accelerator: '',
        action: () => showWindow(WINDOW_LABEL.PREFERENCE),
      },
      {
        id: `${menuId}:restart`,
        text: t('composables.useAppMenu.labels.restartApp'),
        action: () => runProcess('restart'),
      },
      {
        id: `${menuId}:quit`,
        text: t('composables.useAppMenu.labels.quitApp'),
        accelerator: '',
        action: () => runProcess('quit'),
      },
    ],
  })

  return { getAppMenu }
}
