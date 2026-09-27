import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'

import { reportDiagnostic } from '@/services/diagnostics'

// General settings and whole-program reset share one native writer, including
// operations already in flight when the General tab unmounts.
let updates: Promise<void> = Promise.resolve()

export function setAutostartEnabled(enabled: boolean): Promise<void> {
  const update = updates.then(async () => {
    if (await isEnabled() === enabled) return
    if (enabled) await enable()
    else await disable()
  })
  updates = update.catch(error => reportDiagnostic('error', 'autostart.apply', error))
  return update
}
