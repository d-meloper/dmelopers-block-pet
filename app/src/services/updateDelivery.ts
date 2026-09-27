import type { EventCallback } from '@tauri-apps/api/event'

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { computed, shallowRef } from 'vue'

import { quiesceUpdateEditors, releaseUpdateEditors } from '@/features/updateRecovery'

export interface UpdateStatus {
  revision: number
  phase: 'idle' | 'checking' | 'available' | 'upToDate' | 'downloading' | 'verifying' | 'preparing' | 'installing' | 'cancelled' | 'failed'
  requestId: string | null
  currentVersion: string
  targetVersion: string | null
  downloadedBytes: number
  totalBytes: number
  canCancel: boolean
  errorCode: string | null
  releaseUrl: string | null
}

export const updateStatus = shallowRef<UpdateStatus>({
  revision: -1,
  phase: 'idle',
  requestId: null,
  currentVersion: '',
  targetVersion: null,
  downloadedBytes: 0,
  totalBytes: 0,
  canCancel: false,
  errorCode: null,
  releaseUrl: null,
})
export const updateBusy = computed(() => ['checking', 'downloading', 'verifying', 'preparing', 'installing'].includes(updateStatus.value.phase))
export const updateProgress = computed(() => updateStatus.value.totalBytes > 0
  ? Math.min(100, Math.floor(updateStatus.value.downloadedBytes / updateStatus.value.totalBytes * 100))
  : 0)

let initialization: Promise<void> | undefined
let preparationRequest: string | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined

function bounded<T>(work: Promise<T>, onLate?: (value: T) => void): Promise<T> {
  let expired = false
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(new Error('UPDATE_STATUS_TIMEOUT'))
    }, 5000)
  })
  return Promise.race([work.then((value) => {
    if (expired) onLate?.(value)
    return value
  }), timeout])
    .finally(() => clearTimeout(timer))
}

async function subscribe<T>(name: string, callback: EventCallback<T>) {
  let active = true
  try {
    const unlisten = await bounded(listen<T>(name, event => active && callback(event)), late => late())
    return () => {
      active = false
      unlisten()
    }
  } catch (error) {
    active = false
    throw error
  }
}

export function acceptUpdateStatus(status: UpdateStatus) {
  if (Number.isSafeInteger(status.revision) && status.revision > updateStatus.value.revision) updateStatus.value = status
}

async function releasePreparation(request: string) {
  try {
    await releaseUpdateEditors(request)
  } catch {
    console.error('Update preparation editor release is still pending.')
  } finally {
    if (preparationRequest === request) preparationRequest = undefined
  }
}

export function initializeUpdateDelivery(): Promise<void> {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
  return initialization ??= (async () => {
    const unlisteners: Array<() => void> = []
    try {
      unlisteners.push(await subscribe<UpdateStatus>('update-status', ({ payload }) => {
        const previous = updateStatus.value.revision
        acceptUpdateStatus(payload)
        if (payload.revision > previous && ['failed', 'cancelled'].includes(payload.phase) && preparationRequest) {
          const request = preparationRequest
          preparationRequest = undefined
          void releasePreparation(request)
        }
      }))
      unlisteners.push(await subscribe<{ requestId: string }>('update-prepare-data', async ({ payload }) => {
        const request = payload.requestId
        preparationRequest = request
        try {
          await quiesceUpdateEditors(request)
          if (preparationRequest !== request) {
            await releasePreparation(request)
            return
          }
          await invoke('update_data_ready', { requestId: request, ready: true })
        } catch {
          try {
            await invoke('update_data_ready', { requestId: request, ready: false })
          } catch { /* Expired preparation has no authority over a later request. */ }
          await releasePreparation(request)
        }
      }))
      acceptUpdateStatus(await bounded(invoke<UpdateStatus>('update_get_status')))
    } catch (error) {
      unlisteners.forEach(unlisten => unlisten())
      initialization = undefined
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void initializeUpdateDelivery().catch(() => {})
      }, 1000)
      throw error
    }
  })()
}

export async function checkForUpdates() {
  await initializeUpdateDelivery()
  acceptUpdateStatus(await invoke<UpdateStatus>('update_check'))
}
export async function startUpdate() {
  await initializeUpdateDelivery()
  acceptUpdateStatus(await invoke<UpdateStatus>('update_start'))
}
export function cancelUpdate() {
  return invoke<void>('update_cancel')
}
export function configureAutomaticUpdates(enabled: boolean) {
  return invoke<void>('update_configure_automatic', { enabled })
}

export function updateErrorKey(error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
  if (code === 'UPDATE_SOURCE_INVALID') return 'sourceInvalid'
  if (code === 'TRUST_NOT_CONFIGURED') return 'unavailable'
  if (['NETWORK_UNAVAILABLE', 'RATE_LIMITED'].includes(code)) return 'network'
  if (['OTHER_ACCOUNT_RUNNING', 'PROCESS_STATE_UNKNOWN'].includes(code)) return 'running'
  if (['PACKAGED_APP_REQUIRED', 'INSTALL_IDENTITY_INVALID'].includes(code)) return 'installedApp'
  if (['BUSY', 'RECOVERY_REQUIRED', 'RECOVERY_PREPARE_FAILED'].includes(code)) return 'busy'
  if (['WITHDRAWN', 'RELEASE_UNAVAILABLE', 'CHECK_REQUIRED'].includes(code)) return 'unavailable'
  if (['SIGNATURE_INVALID', 'METADATA_INVALID', 'INTEGRITY_FAILED', 'REPOSITORY_MISMATCH', 'RELEASE_INVALID', 'ASSET_MISSING'].includes(code)) return 'verification'
  return 'failed'
}
