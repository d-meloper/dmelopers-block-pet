import { ref } from 'vue'

import { invalidatePresetSelection } from './editIntent'

export const presetResetInProgress = ref(false)
export const presetOperationInProgress = ref(false)
export const presetNativeEditPending = ref(0)
// Readback still serializes preset/save work, but must not disable live editors.
export const presetNativeMutationPending = ref(0)
let completion: Promise<void> = Promise.resolve()
const nativeQueries = new Set<() => void>()

function beginPresetNativeWork(mutation: boolean): () => void {
  presetNativeEditPending.value++
  if (mutation) presetNativeMutationPending.value++
  let released = false
  return () => {
    if (released) return
    released = true
    presetNativeEditPending.value--
    if (mutation) presetNativeMutationPending.value--
  }
}

/** Hold live editors and preset/save work until an actual mutation settles. */
export function beginPresetNativeEdit(): () => void {
  return beginPresetNativeWork(true)
}

/** Keep queries serialized with presets, but let Quit retire their reply owner. */
export function beginPresetNativeQuery(cancel: () => void): () => void {
  const release = beginPresetNativeWork(false)
  nativeQueries.add(cancel)
  return () => {
    nativeQueries.delete(cancel)
    release()
  }
}

/** Only read-only reply owners; already-issued work and actual edits still drain. */
export function cancelPresetNativeQueries(): void {
  for (const cancel of [...nativeQueries]) cancel()
}

/** Shared by the preference-owned manager and whole-program reset. */
export function beginPresetOperation(): () => void {
  presetOperationInProgress.value = true
  let release!: () => void
  completion = new Promise<void>((resolve) => {
    release = resolve
  })
  let released = false
  return () => {
    if (released) return
    released = true
    presetOperationInProgress.value = false
    release()
  }
}

export async function withPresetReset(operation: () => Promise<void>): Promise<void> {
  if (presetResetInProgress.value) throw new Error('A settings reset is already running.')
  presetResetInProgress.value = true
  invalidatePresetSelection()
  try {
    await completion
    await operation()
  } finally {
    presetResetInProgress.value = false
  }
}
