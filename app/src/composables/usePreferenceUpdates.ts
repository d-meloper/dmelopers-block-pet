import type { InjectionKey } from 'vue'

import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { message } from 'ant-design-vue'
import { inject, onBeforeUnmount, onMounted, provide } from 'vue'
import { useI18n } from 'vue-i18n'

import { reportDiagnostic } from '@/services/diagnostics'
import { getDistributionInfo } from '@/services/distribution'
import { cancelAppUpdate, checkAppUpdate, installAppUpdate } from '@/services/inAppUpdates'
import { useGeneralStore } from '@/stores/general'

import type { PreferenceUpdateRecovery } from './preferenceUpdateRecovery'

import { createPreferenceUpdateRecovery } from './preferenceUpdateRecovery'
import { createPreferenceUpdateVisibility } from './preferenceUpdateVisibility'

const PREFERENCE_UPDATES: InjectionKey<PreferenceUpdateRecovery> = Symbol('preference-updates')

export function providePreferenceUpdates(observeVisibility?: (visible: boolean) => void | Promise<void>) {
  const general = useGeneralStore()
  const { t } = useI18n()
  let hasVisibilityListener = false
  const observe = async (visible: boolean) => {
    try {
      await observeVisibility?.(visible)
    } catch (error) {
      reportDiagnostic('warn', 'preference.visibility_observer', error)
    }
  }
  const updates = createPreferenceUpdateRecovery({
    channel: async () => (await getDistributionInfo()).channel,
    checkApp: checkAppUpdate,
    install: installAppUpdate,
    cancel: cancelAppUpdate,
    reminderSnooze: () => general.app.updateReminderSnooze,
    snoozeReminder: (value) => {
      general.app.updateReminderSnooze = value
    },
    report: (operation, error) => {
      reportDiagnostic(operation === 'install' ? 'error' : 'warn', `updates.${operation}`, error)
      if (operation === 'install') message.error(t('inAppUpdates.failed'))
    },
  })
  const visibility = createPreferenceUpdateVisibility({
    listen: async (accept) => {
      const unlisten = await listen<boolean>('preference-visibility-changed', ({ payload }) => accept(payload === true))
      hasVisibilityListener = true
      return () => {
        hasVisibilityListener = false
        unlisten()
      }
    },
    read: () => getCurrentWebviewWindow().isVisible(),
    accept: async (visible) => {
      // Both observers receive the same accepted native show/hide observation.
      // Start updates first so their reminder retains priority over other offers.
      const update = updates.setVisible(visible)
      await observe(visible && hasVisibilityListener)
      await update
    },
    report: (error) => {
      // Unknown visibility cannot authorize a delayed elevated handoff. Update
      // recovery keeps its existing fallback; other offers require a listener.
      void observe(false)
      reportDiagnostic('warn', 'updates.window_visibility', error)
      updates.recordVisibilityFailure()
    },
  })
  const check = updates.check
  updates.check = async (force = true) => {
    await visibility.refresh()
    await check(force)
  }
  provide(PREFERENCE_UPDATES, updates)
  onMounted(visibility.refresh)
  onBeforeUnmount(() => {
    visibility.dispose()
    updates.dispose()
  })
  return updates
}

export function usePreferenceUpdates() {
  const updates = inject(PREFERENCE_UPDATES)
  if (!updates) throw new Error('Preference update owner is unavailable')
  return updates
}
