import { DEFAULT_PET_PRESET } from './defaultSettings'

/** Convert the retired negative flag before defaults can conceal its absence. */
export function migrateKeyboardKeycapInput(source: Record<string, unknown>, fillMissing = true): Record<string, unknown> {
  const preset = { ...source }
  if (!('keyboardKeycapInputEnabled' in source) && (fillMissing || 'keyboardKeycapInputDisabled' in source)) {
    const legacy = source.keyboardKeycapInputDisabled
    preset.keyboardKeycapInputEnabled = 'keyboardKeycapInputDisabled' in source
      ? typeof legacy === 'boolean' ? !legacy : legacy
      : DEFAULT_PET_PRESET.keyboardKeycapInputEnabled
  }
  // This is the executable copy. Preset archives retain their original source.
  delete preset.keyboardKeycapInputDisabled
  return preset
}

export function normalizeKeyboardKeycapInput(source: Record<string, unknown>): boolean {
  const value = migrateKeyboardKeycapInput(source).keyboardKeycapInputEnabled
  return typeof value === 'boolean' ? value : DEFAULT_PET_PRESET.keyboardKeycapInputEnabled
}
