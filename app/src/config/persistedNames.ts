// These names belong to existing files and native IPC, not the frontend domain.
// Changing them would require a separate, versioned user-data migration.
export const BLOCK_STORE_ID = 'cat'
export const BLOCK_VISIBILITY_STORAGE_KEY = 'visibleCat'

export function restoreShortcutState(state: Record<string, unknown>): Record<string, unknown> {
  const restored = { ...state }
  if (Object.prototype.hasOwnProperty.call(restored, BLOCK_VISIBILITY_STORAGE_KEY)) {
    if (!Object.prototype.hasOwnProperty.call(restored, 'visibleBlock')) {
      restored.visibleBlock = restored[BLOCK_VISIBILITY_STORAGE_KEY]
    }
    delete restored[BLOCK_VISIBILITY_STORAGE_KEY]
  }
  return restored
}

export function serializeShortcutState(state: Record<string, unknown>): Record<string, unknown> {
  const serialized = { ...state }
  if (Object.prototype.hasOwnProperty.call(serialized, 'visibleBlock')) {
    serialized[BLOCK_VISIBILITY_STORAGE_KEY] = serialized.visibleBlock
    delete serialized.visibleBlock
  }
  return serialized
}

export function serializeSettingsState(id: string, state: Record<string, unknown>): Record<string, unknown> {
  return id === 'shortcut' ? serializeShortcutState(state) : state
}
