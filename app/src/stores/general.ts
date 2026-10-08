import type { Theme } from '@tauri-apps/api/window'

import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'

import type { LanguagePreference } from '@/locales/languageBranch'

import { DEFAULT_GENERAL_SETTINGS } from '@/config/defaultSettings'
import { isLanguagePreference, resolveLanguage } from '@/locales/languageBranch'
import { getSystemLanguage } from '@/services/systemLanguage'

export type { Language, LanguagePreference } from '@/locales/languageBranch'

export interface GeneralStore {
  broadcast: {
    enabled: boolean
    showOnDesktop: boolean
  }
  app: {
    autostart: boolean
    taskbarVisible: boolean
    autoUpdateCheck: boolean
    updateReminderHiddenUntil: number
    broadcastRestorePromptDismissed: boolean
    applyPresetSkin: boolean
  }
  appearance: {
    theme: 'auto' | Theme
    isDark: boolean
    language?: LanguagePreference
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

  const resolvedLanguage = computed(() => resolveLanguage(appearance.language, getSystemLanguage()))

  const init = async () => {
    if (!Number.isFinite(app.updateReminderHiddenUntil) || app.updateReminderHiddenUntil < 0) {
      app.updateReminderHiddenUntil = DEFAULT_GENERAL_SETTINGS.app.updateReminderHiddenUntil
    }
    for (const key of ['broadcastRestorePromptDismissed', 'applyPresetSkin'] as const) {
      if (typeof app[key] !== 'boolean') app[key] = DEFAULT_GENERAL_SETTINGS.app[key]
    }
    broadcast.enabled = broadcast.enabled === true
    broadcast.showOnDesktop = typeof broadcast.showOnDesktop === 'boolean' ? broadcast.showOnDesktop : DEFAULT_GENERAL_SETTINGS.broadcast.showOnDesktop
    if (!isLanguagePreference(appearance.language)) {
      appearance.language = DEFAULT_GENERAL_SETTINGS.appearance.language
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
    resolvedLanguage,
    init,
    reset,
  }
})
