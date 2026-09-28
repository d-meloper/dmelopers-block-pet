import { invoke } from '@tauri-apps/api/core'

import { reportDiagnostic } from '@/services/diagnostics'

export interface AutostartStatus {
  enabled: boolean
  state: 'enabled' | 'disabled' | 'disabledByUser' | 'disabledByPolicy' | 'enabledByPolicy'
  canEnable: boolean
  canDisable: boolean
}
// One native writer across tab unmounts and explicit settings resets.
let updates: Promise<unknown> = Promise.resolve()

export async function getAutostartStatus(): Promise<AutostartStatus> {
  await updates
  await invoke('await_native_startup')
  return invoke<AutostartStatus>('autostart_status')
}

export function setAutostartEnabled(enabled: boolean): Promise<void> {
  const update = updates.then(async () => {
    await invoke('await_native_startup')
    await invoke('set_autostart_enabled', { enabled })
  })
  updates = update.catch(error => reportDiagnostic('error', 'autostart.apply', error))
  return update
}
