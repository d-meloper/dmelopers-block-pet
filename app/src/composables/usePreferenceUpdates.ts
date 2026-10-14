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

export function providePreferenceUpdates() {
  const general = useGeneralStore()
  const { t } = useI18n()
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
    listen: accept => listen<boolean>('preference-visibility-changed', ({ payload }) => accept(payload === true)),
    read: () => getCurrentWebviewWindow().isVisible(),
    accept: updates.setVisible,
    report: (error) => {
      reportDiagnostic('warn', 'updates.window_visibility', error)
      updates.recordVisibilityFailure(error)
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
