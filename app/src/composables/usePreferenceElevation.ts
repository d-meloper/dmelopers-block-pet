import { onBeforeUnmount } from 'vue'

import { createPreferenceElevation } from '@/features/elevation/preferenceElevation'
import { restartAppAsAdministrator, saveAppSettings } from '@/plugins/process'
import { reportDiagnostic } from '@/services/diagnostics'
import { cancelElevatedRestart, getElevationStatus, prepareElevatedRestart } from '@/services/elevation'
import { useGeneralStore } from '@/stores/general'

export function usePreferenceElevation() {
  const general = useGeneralStore()
  const elevation = createPreferenceElevation({
    status: getElevationStatus,
    prepare: prepareElevatedRestart,
    cancel: cancelElevatedRestart,
    restart: restartAppAsAdministrator,
    reminderDismissed: () => general.app.administratorReminderDismissed,
    persist: async (key, enabled, isCurrent) => {
      if (!isCurrent()) throw new Error('APP_PROCESS_CANCELLED')
      const before = general.app[key]
      general.app[key] = enabled
      try {
        await saveAppSettings(isCurrent)
        if (isCurrent()) {
          const saved = await getElevationStatus()
          if (saved[key] !== enabled) throw new Error('ELEVATION_PREFERENCE_UNCONFIRMED')
        }
      } catch (error) {
        // A failed save can have reached disk. Reconcile this field only; never
        // restore an old whole-store snapshot over newer user edits.
        try {
          const saved = await getElevationStatus()
          general.app[key] = typeof saved[key] === 'boolean' ? saved[key] : before
        } catch {
          general.app[key] = before
        }
        throw error
      }
    },
    report: (operation, error) => reportDiagnostic('warn', `elevation.${operation}`, error),
  })
  onBeforeUnmount(elevation.dispose)
  return elevation
}
