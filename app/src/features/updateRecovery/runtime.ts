import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getStoreState, saveAllNow } from '@tauri-store/pinia'
import { nextTick, ref } from 'vue'

import { setWindowMemoryActive } from '@/plugins/window'
import { listSkinLibraryEntries } from '@/services/skinLibrary'
import { saveSynchronizedSettings } from '@/utils/settingsPersistence'

import { shortcutWarnings, updateEditorsLocked, updateOwners } from './bridge'
import { createQuiescenceOwner } from './quiescence'

export { registerUpdatePresetFlush, reportUpdateShortcutConflict, updateEditorsLocked } from './bridge'

export interface UpdateRecovery {
  requestId: string
  phase: string
  expectedVersion: string
  sourceVersion: string
  presetId: string
  dataDigest: string
  skinHashes: string[]
  rollbackAttempted: boolean
  error?: string
  warnings: string[]
  rendered: boolean
}
export const updateRecovery = ref<UpdateRecovery>()
export const updateEditorReleasePending = ref<string>()
let readSnapshots: (() => Array<{ id: string, state: Record<string, unknown> }>) | undefined
let healthRenderer: (() => Promise<boolean>) | undefined
let healthPending = false
let healthTimer: ReturnType<typeof setTimeout> | undefined
let syncFrozen = false
let storesReady = false
let drainNative: (() => Promise<void>) | undefined
let editingOperationId: string | undefined
let currentLeaseId: string | undefined
let editorReleaseTimer: ReturnType<typeof setTimeout> | undefined
let editorReleaseGeneration = 0
let initialization: Promise<void> | undefined
const runtimeListeners: Array<() => void> = []
let observedOperation = 0
async function subscribe<T>(event: string, handler: (event: { payload: T }) => void | Promise<void>) {
  runtimeListeners.push(await listen<T>(event, handler))
}
export function disposeUpdateRecovery(): void {
  runtimeListeners.splice(0).forEach(stop => stop())
  initialization = undefined
  quiescenceOwner.release()
  syncFrozen = false
  if (healthTimer !== undefined) clearTimeout(healthTimer)
  healthTimer = undefined
  editorReleaseGeneration++
  if (editorReleaseTimer !== undefined) clearTimeout(editorReleaseTimer)
  editorReleaseTimer = undefined
}

const terminal = (state?: UpdateRecovery) => !state || ['verified', 'rolledBack'].includes(state.phase)
const quiescenceOwner = createQuiescenceOwner()

export function registerUpdateSnapshots(read: NonNullable<typeof readSnapshots>): void {
  readSnapshots = read
}
export function markUpdateStoresReady(): void {
  storesReady = true
}
export function registerUpdateNativeDrain(drain: () => Promise<void>): void {
  drainNative = drain
}
export function filterUpdateBackendSync(state: Record<string, unknown>): Record<string, unknown> | undefined {
  return syncFrozen ? undefined : state
}
export function setUpdateHealthRenderer(renderer: () => Promise<boolean>): void {
  healthRenderer = renderer
  void checkUpdateHealth()
}

/** Runs before createApp and therefore before Pinia's autoStart watchers. */
export function initializeUpdateRecovery(): Promise<void> {
  return initialization ??= installUpdateRecovery().catch((error) => {
    disposeUpdateRecovery()
    throw error
  })
}
async function installUpdateRecovery(): Promise<void> {
  await subscribe<UpdateRecovery>('update-recovery-status', ({ payload }) => {
    observedOperation++
    updateRecovery.value = payload
    updateEditorsLocked.value = editingOperationId !== undefined || quiescenceOwner.active() || !terminal(payload)
    if (terminal(payload) && currentLeaseId) void checkUpdateHealth()
  })
  await subscribe<{ requestId: string }>('update-quiesce-request', async ({ payload }) => {
    const label = getCurrentWebviewWindow().label
    if (!['main', 'preference'].includes(label)) return
    const isCurrent = quiescenceOwner.begin(payload.requestId)
    const checkCurrent = () => {
      if (!isCurrent()) throw new Error('QUIESCE_CANCELLED')
    }
    let success = false
    try {
      checkCurrent()
      updateEditorsLocked.value = true
      const deadline = performance.now() + 10000
      // Registration happens during setup; the owner may still be applying
      // its restored preset before it can acknowledge a stable snapshot.
      const ready = () => storesReady && readSnapshots && (label !== 'preference'
        || (updateOwners.flushPresets && updateOwners.presetsReady?.() !== false))
      while (!ready()) {
        checkCurrent()
        if (performance.now() >= deadline) throw new Error('SETTINGS_NOT_READY')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (label === 'preference' && updateOwners.flushPresets && !await updateOwners.flushPresets()) throw new Error('PRESETS_NOT_READY')
      checkCurrent()
      await updateOwners.drainShortcuts?.()
      checkCurrent()
      await drainNative?.()
      checkCurrent()
      await saveSynchronizedSettings({ flushFrontend: nextTick, snapshots: readSnapshots!, readBackend: getStoreState, saveNow: async () => undefined, followFrontendChanges: true })
      checkCurrent()
      syncFrozen = true
      await nextTick()
      checkCurrent()
      await invoke('acknowledge_update_quiescence', { requestId: payload.requestId })
      checkCurrent()
      success = true
    } catch {
      // The caller owns the operation outcome; failure here only rejects its
      // preparation barrier and cannot declare update success or failure.
    } finally {
      if (isCurrent()) await emit('update-quiesce-response', { requestId: payload.requestId, label, success, warnings: [...shortcutWarnings] })
    }
  })
  await subscribe<{ requestId: string }>('update-quiesce-release', ({ payload }) => {
    if (!quiescenceOwner.release(payload.requestId)) return
    syncFrozen = false
    updateEditorsLocked.value = editingOperationId !== undefined || !terminal(updateRecovery.value)
    if (terminal(updateRecovery.value)) {
      void getCurrentWebviewWindow().isVisible().then(visible => setWindowMemoryActive(visible))
    }
  })
  await subscribe('update-health-recheck', () => {
    void checkUpdateHealth()
  })
  const observed = observedOperation
  const state = await invoke<UpdateRecovery | null>('update_recovery_status')
  if (observed === observedOperation) updateRecovery.value = state ?? undefined
  updateEditorsLocked.value = editingOperationId !== undefined || quiescenceOwner.active() || !terminal(updateRecovery.value)
  const preventEdit = (event: Event) => {
    if (!updateEditorsLocked.value || (event.target as Element | null)?.closest?.('[data-update-control]')) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  for (const type of ['pointerdown', 'click', 'keydown', 'drop']) {
    document.addEventListener(type, preventEdit, true)
    runtimeListeners.push(() => document.removeEventListener(type, preventEdit, true))
  }
  if (!terminal(updateRecovery.value)) {
    // 120 seconds means uncertainty. The native record and snapshots survive.
    const timer = setTimeout(() => {
      void invoke('recheck_update_recovery')
    }, 120_000)
    runtimeListeners.push(() => clearTimeout(timer))
  }
}

/**
 * Capture only after the preference owner has materialized/saved its latest
 * preset and all four frontend stores have acknowledged backend readback.
 */
export async function quiesceUpdateEditors(requestId: string = crypto.randomUUID()): Promise<void> {
  if (updateEditorsLocked.value) throw new Error('OPERATION_BUSY')
  editingOperationId = requestId
  updateEditorsLocked.value = true
  try {
    await freezeUpdateWindows(requestId)
    await saveAllNow()
  } catch (error) {
    await releaseUpdateEditors(requestId).catch(error => console.error('Failed to release the editor lease.', error))
    throw error
  }
}
export async function releaseUpdateEditors(requestId: string): Promise<void> {
  if (editingOperationId !== requestId) return
  if (!terminal(updateRecovery.value)) return
  const generation = editorReleaseGeneration
  try {
    await releaseWindowLease(requestId)
  } catch (error) {
    if (editingOperationId === requestId && generation === editorReleaseGeneration) {
      updateEditorReleasePending.value = requestId
      updateEditorsLocked.value = true
      scheduleEditorRelease(requestId, generation)
    }
    throw error
  }
  if (editingOperationId !== requestId || generation !== editorReleaseGeneration) return
  editingOperationId = undefined
  if (updateEditorReleasePending.value === requestId) updateEditorReleasePending.value = undefined
  if (editorReleaseTimer !== undefined) clearTimeout(editorReleaseTimer)
  editorReleaseTimer = undefined
  quiescenceOwner.release(requestId)
  updateEditorsLocked.value = quiescenceOwner.active() || !terminal(updateRecovery.value)
  if (!quiescenceOwner.active()) syncFrozen = false
}
function scheduleEditorRelease(requestId: string, generation: number): void {
  if (generation !== editorReleaseGeneration || editorReleaseTimer !== undefined) return
  const timer = setTimeout(() => {
    if (editorReleaseTimer !== timer) return
    editorReleaseTimer = undefined
    if (generation !== editorReleaseGeneration || editingOperationId !== requestId
      || updateEditorReleasePending.value !== requestId) {
      return
    }
    // Cancellation/failure may already have discarded the delivery request.
    // The lease owner keeps retrying until both native and window release finish.
    void releaseUpdateEditors(requestId).catch(() => {}).finally(() => {
      if (editingOperationId === requestId && updateEditorReleasePending.value === requestId) {
        scheduleEditorRelease(requestId, generation)
      }
    })
  }, 2000)
  editorReleaseTimer = timer
}
async function releaseWindowLease(requestId = currentLeaseId): Promise<void> {
  if (!requestId) return
  await invoke('release_update_quiescence', { requestId })
  await emit('update-quiesce-release', { requestId })
  if (currentLeaseId === requestId) currentLeaseId = undefined
}
async function freezeUpdateWindows(requestId: string = crypto.randomUUID()): Promise<void> {
  try {
    await invoke('begin_update_quiescence', { requestId })
  } catch {
    throw new Error('QUIESCE_FAILED')
  }
  currentLeaseId = requestId
  const pending = new Set(['main', 'preference'])
  let finish!: () => void
  let fail!: (error: Error) => void
  const completed = new Promise<void>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  let unlisten: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    unlisten = await listen<{ requestId: string, label: string, success: boolean, warnings: string[] }>('update-quiesce-response', ({ payload }) => {
      if (payload.requestId !== requestId || !pending.has(payload.label)) return
      if (!payload.success) {
        fail(new Error('QUIESCE_FAILED'))
        return
      }
      payload.warnings.forEach(warning => shortcutWarnings.add(warning))
      pending.delete(payload.label)
      if (!pending.size) finish()
    })
    timer = setTimeout(() => fail(new Error('QUIESCE_TIMEOUT')), 15000)
    await emit('update-quiesce-request', { requestId })
    await completed
  } catch (error) {
    await releaseWindowLease(requestId).catch(error => console.error('Failed to release the preparation lease.', error))
    throw new Error(error instanceof Error && error.message === 'QUIESCE_TIMEOUT' ? 'QUIESCE_TIMEOUT' : 'QUIESCE_FAILED')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    unlisten?.()
  }
}
async function assetHashes(): Promise<string[]> {
  const hashes = (await listSkinLibraryEntries()).map(entry => entry.pngSha256)
  const cat = await getStoreState('cat')
  const collection = cat.presetCollection as { entries?: Array<{ snapshot?: { appearance?: { dmeloperSkinDataUrl?: string } } }> }
  for (const entry of collection.entries ?? []) {
    const url = entry.snapshot?.appearance?.dmeloperSkinDataUrl
    if (!url) continue
    const response = await fetch(url)
    if (!response.ok) throw new Error('SKIN_LOAD_FAILED')
    const hash = await crypto.subtle.digest('SHA-256', await response.arrayBuffer())
    hashes.push(Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''))
  }
  return [...new Set(hashes)].sort()
}
export async function checkUpdateHealth(): Promise<void> {
  if (getCurrentWebviewWindow().label !== 'main' || !healthRenderer || healthPending) return
  healthPending = true
  let operation: UpdateRecovery | null = null
  let verified = false
  try {
    operation = await invoke<UpdateRecovery | null>('update_recovery_status')
    if (operation && terminal(operation)) {
      verified = true
      updateRecovery.value = operation
      await releaseWindowLease()
      updateEditorsLocked.value = editingOperationId !== undefined || quiescenceOwner.active()
      if (!quiescenceOwner.active()) syncFrozen = false
      if (updateRecovery.value) updateRecovery.value.warnings = updateRecovery.value.warnings.filter(warning => warning !== 'QUIESCENCE_RELEASE_DEFERRED')
      return
    }
    if (!operation || !['awaitingHealth', 'awaitingRollbackHealth', 'ambiguous'].includes(operation.phase)) return
    await freezeUpdateWindows(operation.requestId)
    await drainNative?.()
    const rendered = await healthRenderer()
    if (!rendered) throw new Error('RENDER_FAILED')
    const cat = await getStoreState('cat')
    const presetId = (cat.presetCollection as { activeId: string }).activeId
    updateRecovery.value = await invoke<UpdateRecovery>('acknowledge_update_health', { proof: {
      requestId: operation.requestId,
      version: await getVersion(),
      presetId,
      rendered,
      skinHashes: await assetHashes(),
      warnings: [...shortcutWarnings],
    } })
    // Rendering is only the data health step. Keep all writers frozen until
    // the helper commits the installation and native status becomes verified.
    if (!terminal(updateRecovery.value)) return
    verified = true
    await releaseWindowLease()
    updateEditorsLocked.value = editingOperationId !== undefined || quiescenceOwner.active()
    if (!quiescenceOwner.active()) syncFrozen = false
  } catch (error) {
    if (!operation) return
    if (verified) {
      // A lost release response cannot revoke the durable success receipt.
      // Keep this owner frozen until native release and cross-window delivery
      // complete, even when one participant already received the release event.
      updateEditorsLocked.value = true
      syncFrozen = true
      if (!updateRecovery.value?.warnings.includes('QUIESCENCE_RELEASE_DEFERRED')) {
        updateRecovery.value?.warnings.push('QUIESCENCE_RELEASE_DEFERRED')
      }
      console.error('Update recovery verified; window lease cleanup was deferred.', error)
      return
    }
    const code = error instanceof Error ? error.message : String(error)
    if (['QUIESCE_TIMEOUT', 'QUIESCE_FAILED', 'SETTINGS_NOT_READY', 'PRESETS_NOT_READY'].includes(code)) {
      await releaseWindowLease().catch(error => console.error('Failed to release the preparation lease.', error))
      return
    }
    // A rejected renderer or readback is confirmed failure. A still-running
    // promise instead reaches the independent 120-second ambiguity state.
    const failedOperation = operation
    updateRecovery.value = await invoke<UpdateRecovery>('confirm_update_failure', {
      requestId: operation.requestId,
      reason: code,
    }).catch(() => failedOperation)
  } finally {
    healthPending = false
    if (healthTimer !== undefined) clearTimeout(healthTimer)
    healthTimer = undefined
    if ((!terminal(updateRecovery.value) || currentLeaseId !== undefined) && initialization) {
      healthTimer = setTimeout(() => {
        healthTimer = undefined
        void checkUpdateHealth()
      }, 2000)
    }
  }
}
