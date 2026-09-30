import type { CheckMenuItemOptions } from '@tauri-apps/api/menu'

import { emitTo } from '@tauri-apps/api/event'
import { Menu } from '@tauri-apps/api/menu'
import { useI18n } from 'vue-i18n'

import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { isDesktopPetVisible } from '@/features/broadcast/visibility'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'
import { editorsLocked } from '@/features/stateSafety'
import { APP_PROCESS_FAILED, quitApp, restartApp } from '@/plugins/process'
import { showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'

import type { MenuViewportSettingRequest } from './menuViewportSetting'

import { MENU_VIEWPORT_OPTIONS } from './menuViewportSetting'

function numericMenuItems(
  options: readonly { value: number, label?: string }[],
  current: number,
  unit: '%' | '°',
  update: (value: number) => void | Promise<unknown>,
): CheckMenuItemOptions[] {
  const items: CheckMenuItemOptions[] = options.map(({ value, label }) => ({
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
  const catStore = useCatStore()
  const generalStore = useGeneralStore()
  const { t } = useI18n()
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
    const visible = isDesktopPetVisible(catStore.window.visible, generalStore.broadcast)
    return {
      text: t(`composables.useAppMenu.labels.${visible ? 'hideCat' : 'showCat'}`),
      action: () => {
        if (editorsLocked.value) return
        return emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { desktopVisible: !visible })
      },
    }
  }

  const getAppMenu = () => Menu.new({
    items: [
      {
        text: t('composables.useAppMenu.labels.petSettings'),
        action: () => showWindow({ label: WINDOW_LABEL.PREFERENCE, destination: 'pet' }),
      },
      visibilityMenuItem(),
      { item: 'Separator' },
      {
        text: t('composables.useAppMenu.labels.windowSize'),
        items: numericMenuItems(
          MENU_VIEWPORT_OPTIONS.cameraZoomPercent.map(({ value, label }) => ({
            value,
            label: t(`composables.useAppMenu.windowSizeOptions.${label}`),
          })),
          catStore.activePet3dPreset.cameraZoomPercent,
          '%',
          value => requestViewportSetting('cameraZoomPercent', value),
        ),
      },
      {
        text: t('composables.useAppMenu.labels.rotation'),
        items: numericMenuItems(
          MENU_VIEWPORT_OPTIONS.sceneRotationOffsetDegrees.map(({ value, label }) => ({
            value,
            label: t(`composables.useAppMenu.rotationOptions.${label}`),
          })),
          catStore.activePet3dPreset.sceneRotationOffsetDegrees,
          '°',
          value => requestViewportSetting('sceneRotationOffsetDegrees', value),
        ),
      },
      {
        text: t('composables.useAppMenu.labels.opacity'),
        items: numericMenuItems([25, 50, 75, 100].map(value => ({ value })), catStore.window.opacity, '%', (value) => {
          if (editorsLocked.value) return
          return emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { opacity: value })
        }),
      },
      {
        text: t('composables.useAppMenu.labels.keepInScreen'),
        checked: catStore.window.keepInScreen,
        action: () => {
          if (editorsLocked.value) return
          return emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { keepInScreen: !catStore.window.keepInScreen })
        },
      },
      { item: 'Separator' },
      {
        text: t('composables.useAppMenu.labels.preference'),
        accelerator: '',
        action: () => showWindow(WINDOW_LABEL.PREFERENCE),
      },
      {
        text: t('composables.useAppMenu.labels.restartApp'),
        action: () => runProcess('restart'),
      },
      {
        text: t('composables.useAppMenu.labels.quitApp'),
        accelerator: '',
        action: () => runProcess('quit'),
      },
    ],
  })

  return { getAppMenu }
}
