import { isEqual } from 'es-toolkit'

import { DEFAULT_GENERAL_SETTINGS } from './defaultSettings'
import { normalizeKeyboardKeycapSelectedKeys } from './keyboardKeycapInput'

export interface KeyboardKeycapPreset {
  id: string
  name: string
  keys: string[]
}

export interface KeyboardKeycapSettings {
  mode: 'all' | 'selected'
  selectedKeys: string[]
  presets: KeyboardKeycapPreset[]
  seededPresetIds: string[]
  starterRevision: number
}

// Historical starters from before the library recorded seed identities.
const LEGACY_STARTER_IDS = ['builtin:lol', 'builtin:fps']
const RETIRED_STARTERS: KeyboardKeycapPreset[] = [
  { id: 'builtin:rhythm-4k', name: 'Rhythm 4K', keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'] },
  { id: 'builtin:rhythm-7k', name: 'Rhythm 7K', keys: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Space'] },
  { id: 'builtin:arrow-keys', name: 'Arrow keys', keys: ['Return', 'ShiftLeft', 'KeyZ', 'KeyX', 'KeyC', 'UpArrow', 'ControlLeft', 'Alt', 'Space', 'LeftArrow', 'DownArrow', 'RightArrow'] },
]

export function prepareKeyboardKeycapSettingsForSync(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return {
    seededPresetIds: [...LEGACY_STARTER_IDS],
    starterRevision: 1,
    ...value,
  }
}

export function createDefaultKeyboardKeycapSettings(): KeyboardKeycapSettings {
  return JSON.parse(JSON.stringify(DEFAULT_GENERAL_SETTINGS.keyboardKeycap)) as KeyboardKeycapSettings
}

export function reconcileKeyboardKeycapSettings(target: KeyboardKeycapSettings): void {
  const normalized = normalizeKeyboardKeycapSettings(target)
  // Backend JSON key ordering is not a settings change. Keep untouched arrays
  // resident so a library update cannot look like an active-selection edit.
  const patch = Object.fromEntries(Object.entries(normalized)
    .filter(([key, value]) => !isEqual(value, target[key as keyof KeyboardKeycapSettings])))
  if (Object.keys(patch).length) Object.assign(target, patch)
}

export function resetKeyboardKeycapSettings(target: KeyboardKeycapSettings): void {
  Object.assign(target, createDefaultKeyboardKeycapSettings())
}

/** Offer each new starter once; never restore an already offered, deleted entry. */
export function normalizeKeyboardKeycapSettings(value: unknown): KeyboardKeycapSettings {
  const defaults = createDefaultKeyboardKeycapSettings()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const source = value as Partial<KeyboardKeycapSettings>
  const sourceRevision = typeof source.starterRevision === 'number' && Number.isSafeInteger(source.starterRevision)
    ? source.starterRevision
    : 1
  const ids = new Set<string>()
  const seeded = new Set(Array.isArray(source.seededPresetIds)
    ? source.seededPresetIds.filter((id): id is string => typeof id === 'string')
    : LEGACY_STARTER_IDS)
  const presets = Array.isArray(source.presets)
    ? source.presets.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id
          || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || !Array.isArray(entry.keys)) {
          return []
        }
        if (sourceRevision < 2 && RETIRED_STARTERS.some(retired => retired.id === entry.id && retired.name === entry.name
          && retired.keys.length === entry.keys.length && retired.keys.every(key => entry.keys.includes(key)))) {
          return []
        }
        ids.add(entry.id)
        return [{ id: entry.id, name: entry.name, keys: normalizeKeyboardKeycapSelectedKeys(entry.keys) }]
      })
    : defaults.presets
  for (const entry of presets) ids.add(entry.id)
  let insertionIndex = 0
  for (const entry of defaults.presets) {
    if (!seeded.has(entry.id) && !ids.has(entry.id)) {
      // Position new starters relative to the authored sequence without
      // reordering existing user entries or reviving previously deleted ones.
      presets.splice(insertionIndex, 0, { ...entry, keys: normalizeKeyboardKeycapSelectedKeys(entry.keys) })
      ids.add(entry.id)
    }
    const existingIndex = presets.findIndex(preset => preset.id === entry.id)
    if (existingIndex >= insertionIndex) insertionIndex = existingIndex + 1
    seeded.add(entry.id)
  }
  return {
    mode: source.mode === 'selected' ? 'selected' : 'all',
    selectedKeys: normalizeKeyboardKeycapSelectedKeys(source.selectedKeys),
    presets,
    seededPresetIds: [...seeded],
    starterRevision: Math.max(sourceRevision, defaults.starterRevision),
  }
}
