import { ref } from 'vue'

// Pure owner registry: stores and preset owners must not import native startup.
export const updateEditorsLocked = ref(false)
export const shortcutWarnings = new Set<string>()
export const updateOwners: {
  flushPresets?: () => Promise<boolean>
  presetsReady?: () => boolean
  drainShortcuts?: () => Promise<void>
} = {}

export function initializePetForStartup(store: { window: { visible: boolean }, init: () => void }): void {
  const restoredVisibility = store.window.visible
  store.init()
  if (updateEditorsLocked.value) store.window.visible = restoredVisibility
}

export function registerUpdatePresetFlush(flush: () => Promise<boolean>, ready: () => boolean = () => true): () => void {
  updateOwners.flushPresets = flush
  updateOwners.presetsReady = ready
  return () => {
    if (updateOwners.flushPresets !== flush) return
    updateOwners.flushPresets = undefined
    updateOwners.presetsReady = undefined
  }
}
export function reportUpdateShortcutConflict(value: string): void {
  shortcutWarnings.add(value)
}
