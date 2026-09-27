import type { Theme } from '@tauri-apps/api/window'

import { defineStore } from 'pinia'
import { getLocale } from 'tauri-plugin-locale-api'
import { reactive, ref } from 'vue'

import { DEFAULT_GENERAL_SETTINGS } from '@/config/defaultSettings'
import { LANGUAGE } from '@/constants'

export type Language = typeof LANGUAGE[keyof typeof LANGUAGE]

export interface GeneralStore {
  broadcast: {
    enabled: boolean
    showOnDesktop: boolean
  }
  app: {
    autostart: boolean
    taskbarVisible: boolean
    trayVisible: boolean
    autoUpdateCheck: boolean
    updateReminderHiddenUntil: number
  }
  appearance: {
    theme: 'auto' | Theme
    isDark: boolean
    language?: Language
  }
}

export const useGeneralStore = defineStore('general', () => {
  /* ------------ 废弃字段（后续删除） ------------ */

  /** @deprecated 请使用 `app.autostart` */
  const autostart = ref(DEFAULT_GENERAL_SETTINGS.app.autostart)

  /** @deprecated 请使用 `app.taskbarVisible` */
  const taskbarVisibility = ref(DEFAULT_GENERAL_SETTINGS.app.taskbarVisible)

  /** @deprecated 请使用 `appearance.theme` */
  const theme = ref<'auto' | Theme>(DEFAULT_GENERAL_SETTINGS.appearance.theme)

  /** @deprecated 请使用 `appearance.isDark` */
  const isDark = ref(DEFAULT_GENERAL_SETTINGS.appearance.isDark)

  /** @deprecated 用于标识数据是否已迁移，后续版本将删除 */
  const migrated = ref(false)

  const app = reactive<GeneralStore['app']>({ ...DEFAULT_GENERAL_SETTINGS.app })

  const broadcast = reactive<GeneralStore['broadcast']>({ ...DEFAULT_GENERAL_SETTINGS.broadcast })

  const appearance = reactive<GeneralStore['appearance']>({ ...DEFAULT_GENERAL_SETTINGS.appearance })

  const getLanguage = async () => {
    const locale = await getLocale<Language>()

    if (Object.values(LANGUAGE).includes(locale)) {
      return locale
    }

    return LANGUAGE.EN_US
  }

  const init = async () => {
    if (!Number.isFinite(app.updateReminderHiddenUntil) || app.updateReminderHiddenUntil < 0) {
      app.updateReminderHiddenUntil = DEFAULT_GENERAL_SETTINGS.app.updateReminderHiddenUntil
    }
    broadcast.enabled = broadcast.enabled === true
    broadcast.showOnDesktop = typeof broadcast.showOnDesktop === 'boolean' ? broadcast.showOnDesktop : DEFAULT_GENERAL_SETTINGS.broadcast.showOnDesktop
    if (!appearance.language || !Object.values(LANGUAGE).includes(appearance.language)) {
      appearance.language = await getLanguage()
    }

    if (migrated.value) return

    app.autostart = autostart.value
    app.taskbarVisible = taskbarVisibility.value

    appearance.theme = theme.value
    appearance.isDark = isDark.value

    migrated.value = true
  }

  const reset = () => {
    // Keep the system observation until the existing theme watcher resolves auto.
    const observedDark = appearance.isDark
    Object.assign(broadcast, DEFAULT_GENERAL_SETTINGS.broadcast)
    autostart.value = DEFAULT_GENERAL_SETTINGS.app.autostart
    taskbarVisibility.value = DEFAULT_GENERAL_SETTINGS.app.taskbarVisible
    theme.value = DEFAULT_GENERAL_SETTINGS.appearance.theme
    isDark.value = DEFAULT_GENERAL_SETTINGS.appearance.isDark
    Object.assign(app, DEFAULT_GENERAL_SETTINGS.app)
    Object.assign(appearance, DEFAULT_GENERAL_SETTINGS.appearance, { isDark: observedDark })
    migrated.value = true
  }

  return {
    broadcast,
    migrated,
    app,
    appearance,
    init,
    reset,
  }
})
