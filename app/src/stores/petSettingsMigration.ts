import { createDefaultDmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'
import { BUILTIN_DMELOPER_SKIN, DEFAULT_DMELOPER_SKIN_PROFILE_ID } from '@/config/skinIdentity'

// These old names are read-only compatibility keys for settings saved before v12.
const LEGACY_CHARACTER_KEYS = {
  steveSkinDataUrl: 'dmeloperSkinDataUrl',
  steveSkinModel: 'dmeloperSkinModel',
  useDefaultSteveSkin: 'useDefaultDmeloperSkin',
  steveEyebrows: 'dmeloperEyebrows',
  stevePalmColor: 'dmeloperPalmColor',
  steveEyebrowProfiles: 'dmeloperEyebrowProfiles',
  steveEyebrowAutomaticColors: 'dmeloperEyebrowAutomaticColors',
  pendingSteveEyebrowProfileMigration: 'pendingDmeloperEyebrowProfileMigration',
  pendingSteveEyebrowAutomaticColorMigration: 'pendingDmeloperEyebrowAutomaticColorMigration',
  stevePalmManualColors: 'dmeloperPalmManualColors',
  stevePalmAutomaticColors: 'dmeloperPalmAutomaticColors',
  pendingStevePalmManualColorMigration: 'pendingDmeloperPalmManualColorMigration',
  pendingStevePalmAutomaticColorMigration: 'pendingDmeloperPalmAutomaticColorMigration',
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function renameCharacterKeys(source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...source }
  for (const [oldKey, newKey] of Object.entries(LEGACY_CHARACTER_KEYS)) {
    if (!(oldKey in source)) continue
    // Presence, including an explicit undefined, takes precedence over legacy data.
    if (!(newKey in source)) result[newKey] = source[oldKey]
    delete result[oldKey]
  }
  return result
}

/** Convert raw persisted/synchronized state before Pinia merges in new defaults. */
export function migratePetCharacterState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(state.customization3d)) return state
  const source = state.customization3d
  const customization = renameCharacterKeys(source)
  for (const key of ['selectedModelId', 'selectedPetModelId']) {
    if (customization[key] === 'steve') customization[key] = 'dmeloper'
  }
  if (isRecord(source.preset)) customization.preset = renameCharacterKeys(source.preset)
  // v3 and earlier stored presets under the selected model's ID.
  if (isRecord(source.presets)) {
    const presets: Record<string, unknown> = {}
    for (const [id, preset] of Object.entries(source.presets)) {
      if (id === 'steve' && 'dmeloper' in source.presets) continue
      presets[id === 'steve' ? 'dmeloper' : id] = isRecord(preset)
        ? renameCharacterKeys(preset)
        : preset
    }
    customization.presets = presets
  }
  // A legacy unversioned object must not inherit the new store's schema version.
  if (!('schemaVersion' in source)) customization.schemaVersion = 0
  return { ...state, customization3d: customization }
}

export const LEGACY_SKIN_APPEARANCE_KEYS = [
  'dmeloperEyebrowProfiles',
  'dmeloperEyebrowAutomaticColors',
  'pendingDmeloperEyebrowProfileMigration',
  'pendingDmeloperEyebrowAutomaticColorMigration',
  'dmeloperPalmManualColors',
  'dmeloperPalmAutomaticColors',
  'pendingDmeloperPalmManualColorMigration',
  'pendingDmeloperPalmAutomaticColorMigration',
] as const

/** Keep retired data only as inert recovery metadata, outside live snapshots. */
export function splitLegacySkinAppearance(source: Record<string, unknown>): {
  appearance: Record<string, unknown>
  archive?: Record<string, unknown>
} {
  const appearance = { ...source }
  const archive: Record<string, unknown> = {}
  for (const key of LEGACY_SKIN_APPEARANCE_KEYS) {
    if (!(key in source)) continue
    const value = source[key]
    if (value !== undefined && value !== null
      && (!isRecord(value) || Object.keys(value).length > 0)) {
      archive[key] = value
    }
    delete appearance[key]
  }
  return { appearance, ...(Object.keys(archive).length > 0 ? { archive } : {}) }
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

/** Preserve pre-preset displayed appearance before Pinia can fill absent values. */
export function migrateLegacySkinAppearanceState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(state.customization3d)) return state
  const source = state.customization3d
  const { appearance, archive } = splitLegacySkinAppearance(source)
  if (!LEGACY_SKIN_APPEARANCE_KEYS.some(key => key in source)) return state

  const preset = isRecord(source.preset) ? { ...source.preset } : {}
  const legacySchema = typeof source.schemaVersion !== 'number' || source.schemaVersion < 13
  const hasPresetCatalog = state.presetCollection !== undefined && state.presetCollection !== null
  // Before catalogs existed, initialization selected the active skin's memory.
  // A saved catalog's scalar snapshot and all v13 values are already authoritative.
  const preserveLegacyDisplay = legacySchema && !hasPresetCatalog
  const profileId = source.activeSkinLibraryEntryId === BUILTIN_DMELOPER_SKIN.id
    || !source.dmeloperSkinDataUrl
    ? DEFAULT_DMELOPER_SKIN_PROFILE_ID
    : typeof source.activeSkinLibraryEntryId === 'string' && /^[0-9a-f]{64}$/.test(source.activeSkinLibraryEntryId)
      ? source.activeSkinLibraryEntryId
      : undefined
  const valueForActiveSkin = (mapKey: string, pendingKey: string): unknown => {
    const values = source[mapKey]
    if (!profileId) return source[pendingKey]
    const stored = isRecord(values) ? values[profileId] : undefined
    return stored ?? (!source.dmeloperSkinDataUrl ? source[pendingKey] : undefined)
  }
  const eyebrows = valueForActiveSkin('dmeloperEyebrowProfiles', 'pendingDmeloperEyebrowProfileMigration')
  const eyebrowColor = valueForActiveSkin('dmeloperEyebrowAutomaticColors', 'pendingDmeloperEyebrowAutomaticColorMigration')
  if (legacySchema && (preserveLegacyDisplay || !('dmeloperEyebrows' in preset))) {
    if (isRecord(eyebrows)) {
      preset.dmeloperEyebrows = { ...eyebrows }
    } else if (isHexColor(eyebrowColor)) {
      preset.dmeloperEyebrows = { ...createDefaultDmeloperEyebrowPreset(), color: eyebrowColor }
    }
  }
  if (legacySchema && (preserveLegacyDisplay || !('dmeloperPalmColor' in preset))) {
    const manualColor = valueForActiveSkin('dmeloperPalmManualColors', 'pendingDmeloperPalmManualColorMigration')
    const automaticColor = valueForActiveSkin('dmeloperPalmAutomaticColors', 'pendingDmeloperPalmAutomaticColorMigration')
    if (isHexColor(manualColor)) preset.dmeloperPalmColor = manualColor
    else if (isHexColor(automaticColor)) preset.dmeloperPalmColor = automaticColor
  }
  return {
    ...state,
    customization3d: { ...appearance, preset },
    ...(archive
      ? {
          // The first migration owns recovery data; later live updates never rewrite it.
          legacyAppearanceArchive: isRecord(state.legacyAppearanceArchive)
            ? state.legacyAppearanceArchive
            : archive,
        }
      : {}),
  }
}
