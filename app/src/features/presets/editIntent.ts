// An intent lasts only for the synchronous user event, never for later native
// readback, skin analysis, initialization, or persisted-state synchronization.
let userEdit = false
let generation = 0
const selectionListeners = new Set<() => void>()
const confirmedEditListeners = new Set<() => void>()

export function onPresetSelectionChange(listener: () => void): () => void {
  selectionListeners.add(listener)
  return () => {
    selectionListeners.delete(listener)
  }
}

export function invalidatePresetSelection(): void {
  selectionListeners.forEach(listener => listener())
}

export function onPresetUserEditConfirmed(listener: () => void): () => void {
  confirmedEditListeners.add(listener)
  return () => {
    confirmedEditListeners.delete(listener)
  }
}

/** Capture acknowledged user intent even when store synchronization arrived first. */
export function confirmPresetUserEdit(): void {
  markPresetUserEdit()
  confirmedEditListeners.forEach(listener => listener())
}

export function markPresetUserEdit(): void {
  userEdit = true
  const current = ++generation
  queueMicrotask(() => {
    if (current === generation) userEdit = false
  })
}

export function isPresetUserEdit(): boolean {
  return userEdit
}
