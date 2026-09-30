import { DEFAULT_PET_PRESET } from './defaultSettings'

export interface LightingSettings {
  key: {
    color: string
    azimuthDegrees: number
    elevationDegrees: number
    strengthPercent: number
  }
}

export const LIGHTING_LIMITS = {
  azimuthDegrees: { min: -180, max: 180, step: 1 },
  elevationDegrees: { min: -90, max: 90, step: 1 },
  strengthPercent: { min: 25, max: 200, step: 1 },
} as const

export function createDefaultLightingSettings(): LightingSettings {
  return { key: { ...DEFAULT_PET_PRESET.lighting.key } }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function without(value: Record<string, unknown>, keys: readonly string[]) {
  if (!keys.some(key => key in value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

/** Retired controls never affect rendering. Preserve unknown/invalid supported values for rejection. */
export function migratePresetLighting<T>(preset: T): T {
  if (!record(preset)) return preset
  if (!('lighting' in preset)) return { ...preset, lighting: createDefaultLightingSettings() }
  if (!record(preset.lighting)) return preset
  let lighting = without(preset.lighting, ['brightnessPercent', 'exposurePercent', 'toneMapping', 'referenceFrame', 'fill', 'rim', 'ambient', 'hemisphere', 'shadow'])
  if (!('key' in lighting)) lighting = { ...lighting, key: createDefaultLightingSettings().key }
  if (record(lighting.key)) {
    let key = without(lighting.key, ['enabled', 'intensityPercent'])
    // Upgrade the previous authored defaults once, preserving customized colors/angles.
    if (!('strengthPercent' in key)) {
      if (typeof key.color === 'string' && key.color.toLowerCase() === '#fff4e8') key = { ...key, color: DEFAULT_PET_PRESET.lighting.key.color }
      for (const [name, previous] of [['azimuthDegrees', -38.99099404250548], ['elevationDegrees', 43.89945474962074]] as const) {
        if (key[name] === previous) key = { ...key, [name]: DEFAULT_PET_PRESET.lighting.key[name] }
      }
    }
    for (const [name, fallback] of Object.entries(DEFAULT_PET_PRESET.lighting.key)) {
      if (!(name in key)) key = { ...key, [name]: fallback }
    }
    if (key !== lighting.key) lighting = { ...lighting, key }
  }
  return lighting === preset.lighting ? preset : { ...preset, lighting }
}

function validColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

export function isLightingSettings(value: unknown): value is LightingSettings {
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.key)) return false
  const key = value.key
  return Object.keys(key).length === 4 && validColor(key.color)
    && Object.entries(LIGHTING_LIMITS).every(([name, { min, max }]) =>
      typeof key[name] === 'number' && Number.isFinite(key[name]) && key[name] >= min && key[name] <= max)
}

/** Local recovery clamps supported values; imports validate before use. */
export function normalizeLightingSettings(value: unknown): LightingSettings {
  const result = createDefaultLightingSettings()
  const migrated = migratePresetLighting({ lighting: value }).lighting
  const key = record(migrated) && record(migrated.key) ? migrated.key : {}
  if (validColor(key.color)) result.key.color = key.color
  for (const name of ['azimuthDegrees', 'elevationDegrees', 'strengthPercent'] as const) {
    const number = key[name]
    if (typeof number === 'number' && Number.isFinite(number)) {
      const { min, max } = LIGHTING_LIMITS[name]
      result.key[name] = Math.min(max, Math.max(min, number))
    }
  }
  return result
}
