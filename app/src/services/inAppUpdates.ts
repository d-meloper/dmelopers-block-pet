import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { quiesceEditors, releaseEditors } from '@/features/stateSafety'
import { reportDiagnostic } from '@/services/diagnostics'

export interface AppUpdateInfo {
  available: boolean
  currentVersion: string
  version: string | null
  bytes: number | null
}
export type UpdatePhase = 'downloading' | 'verifying' | 'saving' | 'installing'
interface ProgressEvent { requestId: string, received: number, size: number, phase: 'downloading' | 'verifying' }
let active: { requestId: string, phase: UpdatePhase } | undefined

export async function checkAppUpdate(force = false): Promise<AppUpdateInfo> {
  await invoke('await_native_startup')
  return invoke<AppUpdateInfo>('check_app_update', { force })
}

export async function cancelAppUpdate(): Promise<void> {
  if (!active) return
  if (active.phase === 'saving' || active.phase === 'installing') throw new Error('UPDATE_TOO_LATE')
  await invoke('cancel_app_update', { requestId: active.requestId })
}

/** Cached UI data never supplies a URL, signature or installer to native code. */
export async function installAppUpdate(onPhase: (phase: UpdatePhase) => void, onProgress: (percent: number) => void): Promise<void> {
  if (active) throw new Error('UPDATE_BUSY')
  const operation = { requestId: crypto.randomUUID(), phase: 'downloading' as UpdatePhase }
  active = operation
  let lease = false
  let stop: (() => void) | undefined
  const phase = (value: UpdatePhase) => {
    if (active !== operation) return
    operation.phase = value
    onPhase(value)
  }
  try {
    stop = await listen<ProgressEvent>('app-update-progress', ({ payload }) => {
      if (active !== operation || payload.requestId !== operation.requestId
        || !['downloading', 'verifying'].includes(operation.phase)) {
        return
      }
      if (payload.phase === 'verifying') phase('verifying')
      if (Number.isFinite(payload.received) && Number.isFinite(payload.size) && payload.size > 0) {
        onProgress(Math.max(0, Math.min(100, Math.floor(payload.received * 100 / payload.size))))
      }
    })
    phase('downloading')
    await invoke('download_app_update', { requestId: operation.requestId })
    // Native arbitrates cancellation before the editor save barrier begins.
    await invoke('begin_app_update_save', { requestId: operation.requestId })
    phase('saving')
    lease = true
    await quiesceEditors(operation.requestId)
    phase('installing')
    await invoke('install_app_update', { requestId: operation.requestId })
    // Successful Windows handoff exits. No IPC response proves installation.
  } catch (error) {
    await invoke('abort_app_update', { requestId: operation.requestId }).catch((abortError: unknown) => {
      if (abortError !== 'UPDATE_REQUEST_INVALID' && abortError !== 'UPDATE_TOO_LATE') {
        reportDiagnostic('warn', 'updates.abort', abortError)
      }
    })
    if (lease) await releaseEditors(operation.requestId).catch(() => {})
    throw error
  } finally {
    stop?.()
    if (active === operation) active = undefined
  }
}
