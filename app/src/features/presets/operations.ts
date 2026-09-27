import { ref } from 'vue'

import { invalidatePresetSelection } from './editIntent'

export const presetResetInProgress = ref(false)
export const presetOperationInProgress = ref(false)
export const presetNativeEditPending = ref(0)
let completion: Promise<void> = Promise.resolve()

/** Count both native queries and edits; each request owns exactly one release. */
export function beginPresetNativeEdit(): () => void {
  presetNativeEditPending.value++
  let released = false
  return () => {
    if (released) return
    released = true
    presetNativeEditPending.value--
  }
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
