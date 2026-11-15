import { DEFAULT_GENERAL_SETTINGS, DEFAULT_PET_PRESET } from './defaultSettings'
import keycapKeys from './keyboardKeycapKeys.json'

export type KeyboardKeycapInputMode = 'all' | 'selected'

export interface KeyboardKeycapSelection {
  keyboardKeycapInputMode: KeyboardKeycapInputMode
  keyboardKeycapSelectedKeys: string[]
}

/** Retire prototype preset fields only from executable copies, not archives. */
export function retirePresetKeyboardKeycapSelection<T>(source: T): T {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source
  const next = { ...source } as Record<string, unknown>
  delete next.keyboardKeycapInputMode
  delete next.keyboardKeycapSelectedKeys
  return next as T
}

/** Runtime cleanup is separate from strict validation of imported source data. */
export function normalizeKeyboardKeycapSelectedKeys(value: unknown): string[] {
  const selected = new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [])
  return keycapKeys.filter(key => selected.has(key))
}

export function normalizeKeyboardKeycapSelection(source: Partial<KeyboardKeycapSelection>): KeyboardKeycapSelection {
  return {
    keyboardKeycapInputMode: source.keyboardKeycapInputMode === 'selected' ? 'selected' : DEFAULT_GENERAL_SETTINGS.keyboardKeycap.mode,
    keyboardKeycapSelectedKeys: normalizeKeyboardKeycapSelectedKeys(source.keyboardKeycapSelectedKeys),
  }
}

let legacySelection: KeyboardKeycapSelection | undefined

/** Hand the active prototype choice to General once, before Block normalizes it. */
export function rememberLegacyKeyboardKeycapSelection(source: unknown) {
  if (!legacySelection && isKeyboardKeycapSelection(source)) legacySelection = normalizeKeyboardKeycapSelection(source)
}

export function takeLegacyKeyboardKeycapSelection(): KeyboardKeycapSelection | undefined {
  const selection = legacySelection
  legacySelection = undefined
  return selection
}

export function isKeyboardKeycapSelection(source: unknown): source is KeyboardKeycapSelection {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false
  const { keyboardKeycapInputMode: mode, keyboardKeycapSelectedKeys: keys } = source as KeyboardKeycapSelection
  return (mode === 'all' || mode === 'selected') && Array.isArray(keys)
    && keys.every(key => typeof key === 'string' && keycapKeys.includes(key))
    && new Set(keys).size === keys.length
}

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
