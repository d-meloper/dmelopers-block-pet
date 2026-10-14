import type { Theme } from '@tauri-apps/api/window'

import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'

import type { ForegroundHidingSettings } from '@/features/foregroundHiding/settings'
import type { LanguagePreference } from '@/locales/languageBranch'

import { DEFAULT_GENERAL_SETTINGS } from '@/config/defaultSettings'
import { createForegroundHidingSettings } from '@/features/foregroundHiding/settings'
import { isLanguagePreference, resolveLanguage } from '@/locales/languageBranch'
import { getSystemLanguage } from '@/services/systemLanguage'

export type { Language, LanguagePreference } from '@/locales/languageBranch'

export interface UpdateReminderSnooze {
  version: string
  hiddenUntil: number
}

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
    updateReminderSnooze: UpdateReminderSnooze
    broadcastRestorePromptDismissed: boolean
    applyPresetSkin: boolean
    foregroundHiding: ForegroundHidingSettings
  }
  appearance: {
    theme: 'auto' | Theme
    isDark: boolean
    language?: LanguagePreference
  }
}

function normalizeReminderSnooze(value: unknown): UpdateReminderSnooze {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const pair = value as Partial<UpdateReminderSnooze>
    if (typeof pair.version === 'string' && pair.version.trim()
      && typeof pair.hiddenUntil === 'number' && Number.isFinite(pair.hiddenUntil) && pair.hiddenUntil >= 0) {
      return { version: pair.version, hiddenUntil: pair.hiddenUntil }
    }
  }
  return { ...DEFAULT_GENERAL_SETTINGS.app.updateReminderSnooze }
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

  const app = reactive<GeneralStore['app']>({
    ...DEFAULT_GENERAL_SETTINGS.app,
    updateReminderSnooze: { ...DEFAULT_GENERAL_SETTINGS.app.updateReminderSnooze },
    foregroundHiding: createForegroundHidingSettings(),
  })

  const broadcast = reactive<GeneralStore['broadcast']>({ ...DEFAULT_GENERAL_SETTINGS.broadcast })

  const appearance = reactive<GeneralStore['appearance']>({ ...DEFAULT_GENERAL_SETTINGS.appearance })

  const resolvedLanguage = computed(() => resolveLanguage(appearance.language, getSystemLanguage()))

  const init = async () => {
    // A legacy global deadline has no recoverable target. Keep it for older readers.
    const snooze = normalizeReminderSnooze(app.updateReminderSnooze)
    if (app.updateReminderSnooze?.version !== snooze.version || app.updateReminderSnooze?.hiddenUntil !== snooze.hiddenUntil) {
      app.updateReminderSnooze = snooze
    }
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
    Object.assign(app, DEFAULT_GENERAL_SETTINGS.app, {
      updateReminderSnooze: { ...DEFAULT_GENERAL_SETTINGS.app.updateReminderSnooze },
      foregroundHiding: createForegroundHidingSettings(app.foregroundHiding),
    })
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
}, {
  tauri: {
    hooks: {
      beforeFrontendSync(state) {
        const app = state.app
        if (!app || typeof app !== 'object' || Array.isArray(app)) return state
        // Normalize the whole incoming pair before Pinia deep-merges it with a
        // previous target/deadline. Partial records must never borrow either half.
        const incoming: Record<string, unknown> = { ...app }
        if ('updateReminderSnooze' in app) incoming.updateReminderSnooze = normalizeReminderSnooze(app.updateReminderSnooze)
        // Pinia replaces a reactive subpatch instead of recursively merging it.
        // Treat this config as one raw record: partial/malformed fields must not
        // borrow defaults or previous rules and become valid by accident.
        if ('foregroundHiding' in app && app.foregroundHiding && typeof app.foregroundHiding === 'object') {
          incoming.foregroundHiding = reactive(app.foregroundHiding)
        }
        return { ...state, app: incoming }
      },
    },
  },
})
