import { invoke } from '@tauri-apps/api/core'

import { quiesceEditors, releaseEditors } from '@/features/stateSafety'

export interface AppUpdateInfo {
  available: boolean
  currentVersion: string
  version: string | null
  bytes: number | null
}
export type UpdatePhase = 'downloading' | 'saving' | 'installing'
let updating = false

export async function inAppUpdaterEnabled(): Promise<boolean> {
  await invoke('await_native_startup')
  return invoke<boolean>('in_app_updater_enabled')
}

export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  await invoke('await_native_startup')
  return invoke<AppUpdateInfo>('check_app_update')
}

/** The native selection owns the version, URL and downloaded bytes. */
export async function installAppUpdate(onPhase: (phase: UpdatePhase) => void): Promise<void> {
  if (updating) throw new Error('UPDATE_BUSY')
  updating = true
  const requestId = crypto.randomUUID()
  let lease = false
  try {
    onPhase('downloading')
    await invoke('download_app_update')
    onPhase('saving')
    lease = true
    await quiesceEditors(requestId)
    onPhase('installing')
    await invoke('install_app_update', { requestId })
    // Windows exits after installer handoff. A reply is never installation proof.
  } catch (error) {
    if (lease) await releaseEditors(requestId).catch(() => {})
    throw error
  } finally {
    updating = false
  }
}
