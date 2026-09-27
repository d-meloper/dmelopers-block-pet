import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getStoreState, saveAllNow } from '@tauri-store/pinia'
import { nextTick, ref } from 'vue'

import { setWindowMemoryActive } from '@/plugins/window'
import { reportDiagnostic } from '@/services/diagnostics'
import { saveSynchronizedSettings } from '@/utils/settingsPersistence'

import { editorsLocked, shortcutWarnings, stateOwners } from './bridge'
import { createQuiescenceOwner } from './quiescence'

export { editorsLocked, registerPresetFlush, reportShortcutConflict } from './bridge'

export const editorReleasePending = ref<string>()
let readSnapshots: (() => Array<{ id: string, state: Record<string, unknown> }>) | undefined
let syncFrozen = false
let storesReady = false
let drainNative: (() => Promise<void>) | undefined
let editingOperationId: string | undefined
let currentLeaseId: string | undefined
let editorReleaseTimer: ReturnType<typeof setTimeout> | undefined
let editorReleaseGeneration = 0
let initialization: Promise<void> | undefined
const runtimeListeners: Array<() => void> = []
async function subscribe<T>(event: string, handler: (event: { payload: T }) => void | Promise<void>) {
  runtimeListeners.push(await listen<T>(event, handler))
}
export function disposeStateSafety(): void {
  runtimeListeners.splice(0).forEach(stop => stop())
  initialization = undefined
  quiescenceOwner.release()
  syncFrozen = false
  editorReleaseGeneration++
  if (editorReleaseTimer !== undefined) clearTimeout(editorReleaseTimer)
  editorReleaseTimer = undefined
}

const quiescenceOwner = createQuiescenceOwner()

export function registerStateSnapshots(read: NonNullable<typeof readSnapshots>): void {
  readSnapshots = read
}
export function markStoresReady(): void {
  storesReady = true
}
export function registerNativeDrain(drain: () => Promise<void>): void {
  drainNative = drain
}
export function filterBackendSync(state: Record<string, unknown>): Record<string, unknown> | undefined {
  return syncFrozen ? undefined : state
}
/** Runs before createApp and therefore before Pinia's autoStart watchers. */
export function initializeStateSafety(): Promise<void> {
  return initialization ??= installStateSafety().catch((error) => {
    reportDiagnostic('error', 'settings.safety_initialize', error)
    disposeStateSafety()
    throw error
  })
}
async function installStateSafety(): Promise<void> {
  await subscribe<{ requestId: string }>('state-quiesce-request', async ({ payload }) => {
    const label = getCurrentWebviewWindow().label
    if (!['main', 'preference'].includes(label)) return
    const isCurrent = quiescenceOwner.begin(payload.requestId)
    const checkCurrent = () => {
      if (!isCurrent()) throw new Error('QUIESCE_CANCELLED')
    }
    let success = false
    try {
      checkCurrent()
      editorsLocked.value = true
      const deadline = performance.now() + 10000
      // Registration happens during setup; the owner may still be applying
      // its restored preset before it can acknowledge a stable snapshot.
      const ready = () => storesReady && readSnapshots && (label !== 'preference'
        || (stateOwners.flushPresets && stateOwners.presetsReady?.() !== false))
      while (!ready()) {
        checkCurrent()
        if (performance.now() >= deadline) throw new Error('SETTINGS_NOT_READY')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (label === 'preference' && stateOwners.flushPresets && !await stateOwners.flushPresets()) throw new Error('PRESETS_NOT_READY')
      checkCurrent()
      await stateOwners.drainShortcuts?.()
      checkCurrent()
      await drainNative?.()
      checkCurrent()
      await saveSynchronizedSettings({ flushFrontend: nextTick, snapshots: readSnapshots!, readBackend: getStoreState, saveNow: async () => undefined, followFrontendChanges: true })
      checkCurrent()
      syncFrozen = true
      await nextTick()
      checkCurrent()
      await invoke('acknowledge_state_quiescence', { requestId: payload.requestId })
      checkCurrent()
      success = true
    } catch (error) {
      if (isCurrent()) reportDiagnostic('error', 'settings.save_barrier', error)
      // The caller owns the operation outcome; failure here only rejects its
      // save barrier and cannot decide whether the app may exit.
    } finally {
      if (isCurrent()) await emit('state-quiesce-response', { requestId: payload.requestId, label, success, warnings: [...shortcutWarnings] })
    }
  })
  await subscribe<{ requestId: string }>('state-quiesce-release', ({ payload }) => {
    if (!quiescenceOwner.release(payload.requestId)) return
    syncFrozen = false
    editorsLocked.value = editingOperationId !== undefined
    void getCurrentWebviewWindow().isVisible().then(visible => setWindowMemoryActive(visible))
  })
  editorsLocked.value = editingOperationId !== undefined || quiescenceOwner.active()
  const preventEdit = (event: Event) => {
    if (!editorsLocked.value) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  for (const type of ['pointerdown', 'click', 'keydown', 'drop']) {
    document.addEventListener(type, preventEdit, true)
    runtimeListeners.push(() => document.removeEventListener(type, preventEdit, true))
  }
}

/**
 * Capture only after the preference owner has materialized/saved its latest
 * preset and all four frontend stores have acknowledged backend readback.
 */
export async function quiesceEditors(requestId: string = crypto.randomUUID()): Promise<void> {
  if (editorsLocked.value) throw new Error('OPERATION_BUSY')
  editingOperationId = requestId
  editorsLocked.value = true
  try {
    await freezeWindows(requestId)
    await saveAllNow()
    await invoke('verify_state_quiescence', { requestId })
  } catch (error) {
    await releaseEditors(requestId).catch(error => console.error('Failed to release the editor lease.', error))
    throw error
  }
}
export async function releaseEditors(requestId: string): Promise<void> {
  if (editingOperationId !== requestId) return
  const generation = editorReleaseGeneration
  try {
    await releaseWindowLease(requestId)
  } catch (error) {
    if (editingOperationId === requestId && generation === editorReleaseGeneration) {
      reportDiagnostic('warn', 'settings.release_editors', error)
      editorReleasePending.value = requestId
      editorsLocked.value = true
      scheduleEditorRelease(requestId, generation)
    }
    throw error
  }
  if (editingOperationId !== requestId || generation !== editorReleaseGeneration) return
  editingOperationId = undefined
  if (editorReleasePending.value === requestId) editorReleasePending.value = undefined
  if (editorReleaseTimer !== undefined) clearTimeout(editorReleaseTimer)
  editorReleaseTimer = undefined
  quiescenceOwner.release(requestId)
  editorsLocked.value = quiescenceOwner.active()
  if (!quiescenceOwner.active()) syncFrozen = false
}
function scheduleEditorRelease(requestId: string, generation: number): void {
  if (generation !== editorReleaseGeneration || editorReleaseTimer !== undefined) return
  const timer = setTimeout(() => {
    if (editorReleaseTimer !== timer) return
    editorReleaseTimer = undefined
    if (generation !== editorReleaseGeneration || editingOperationId !== requestId
      || editorReleasePending.value !== requestId) {
      return
    }
    // A failed Quit/restart may already have returned to its caller.
    // The lease owner keeps retrying until both native and window release finish.
    void releaseEditors(requestId).catch(() => {}).finally(() => {
      if (editingOperationId === requestId && editorReleasePending.value === requestId) {
        scheduleEditorRelease(requestId, generation)
      }
    })
  }, 2000)
  editorReleaseTimer = timer
}
async function releaseWindowLease(requestId = currentLeaseId): Promise<void> {
  if (!requestId) return
  await invoke('release_state_quiescence', { requestId })
  await emit('state-quiesce-release', { requestId })
  if (currentLeaseId === requestId) currentLeaseId = undefined
}
async function freezeWindows(requestId: string = crypto.randomUUID()): Promise<void> {
  try {
    await invoke('begin_state_quiescence', { requestId })
  } catch (error) {
    reportDiagnostic('error', 'settings.begin_save_barrier', error)
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
    unlisten = await listen<{ requestId: string, label: string, success: boolean, warnings: string[] }>('state-quiesce-response', ({ payload }) => {
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
    await emit('state-quiesce-request', { requestId })
    await completed
  } catch (error) {
    await releaseWindowLease(requestId).catch(error => console.error('Failed to release the preparation lease.', error))
    throw new Error(error instanceof Error && error.message === 'QUIESCE_TIMEOUT' ? 'QUIESCE_TIMEOUT' : 'QUIESCE_FAILED')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    unlisten?.()
  }
}
