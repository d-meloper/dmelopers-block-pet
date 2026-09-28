import type { InjectionKey } from 'vue'

import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { message } from 'ant-design-vue'
import { inject, onBeforeUnmount, onMounted, provide } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PreferenceUpdates } from '@/features/updates/preferenceUpdates'

import { createPreferenceUpdates } from '@/features/updates/preferenceUpdates'
import { reportDiagnostic } from '@/services/diagnostics'
import { getDistributionInfo } from '@/services/distribution'
import { cancelAppUpdate, checkAppUpdate, installAppUpdate } from '@/services/inAppUpdates'
import { useGeneralStore } from '@/stores/general'

const PREFERENCE_UPDATES: InjectionKey<PreferenceUpdates> = Symbol('preference-updates')

export function providePreferenceUpdates() {
  const general = useGeneralStore()
  const { t } = useI18n()
  const updates = createPreferenceUpdates({
    channel: async () => (await getDistributionInfo()).channel,
    checkApp: checkAppUpdate,
    install: installAppUpdate,
    cancel: cancelAppUpdate,
    hiddenUntil: () => general.app.updateReminderHiddenUntil,
    hideUntil: (deadline) => {
      general.app.updateReminderHiddenUntil = deadline
    },
    report: (operation, error) => {
      reportDiagnostic('warn', `updates.${operation}`, error)
      if (operation === 'install') message.error(t('inAppUpdates.failed'))
    },
  })
  provide(PREFERENCE_UPDATES, updates)
  let disposed = false
  let eventCount = 0
  let stop: (() => void) | undefined
  onMounted(async () => {
    try {
      const release = await listen<boolean>('preference-visibility-changed', ({ payload }) => {
        eventCount += 1
        if (!disposed) void updates.setVisible(payload === true)
      })
      if (disposed) {
        release()
        return
      }
      stop = release
      const before = eventCount
      const visible = await getCurrentWebviewWindow().isVisible()
      // Covers a show before listener registration without overwriting a newer event.
      if (!disposed && before === eventCount) await updates.setVisible(visible)
    } catch (error) {
      if (!disposed) reportDiagnostic('warn', 'updates.window_visibility', error)
    }
  })
  onBeforeUnmount(() => {
    disposed = true
    stop?.()
    updates.dispose()
  })
  return updates
}

export function usePreferenceUpdates() {
  const updates = inject(PREFERENCE_UPDATES)
  if (!updates) throw new Error('Preference update owner is unavailable')
  return updates
}
