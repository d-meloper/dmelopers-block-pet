import { ref } from 'vue'

// Pure owner registry: stores and preset owners must not import native startup.
export const editorsLocked = ref(false)
export const shortcutWarnings = new Set<string>()
export const stateOwners: {
  flushPresets?: () => Promise<boolean>
  presetsReady?: () => boolean
  drainShortcuts?: () => Promise<void>
} = {}

export function initializePetForStartup(store: { window: { visible: boolean }, init: () => void }): void {
  const restoredVisibility = store.window.visible
  store.init()
  if (editorsLocked.value) store.window.visible = restoredVisibility
}

export function registerPresetFlush(flush: () => Promise<boolean>, ready: () => boolean = () => true): () => void {
  stateOwners.flushPresets = flush
  stateOwners.presetsReady = ready
  return () => {
    if (stateOwners.flushPresets !== flush) return
    stateOwners.flushPresets = undefined
    stateOwners.presetsReady = undefined
  }
}
export function reportShortcutConflict(value: string): void {
  shortcutWarnings.add(value)
}
