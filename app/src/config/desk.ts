import { DEFAULT_PET_PRESET } from './defaultSettings'

export interface DeskSettings {
  deskTransparent: boolean
  deskHeightOffset: number
  deskWidthOffset: number
  deskDepthOffset: number
  deskColor: string
}

export const DESK_SETTING_KEYS = ['deskTransparent', 'deskHeightOffset', 'deskWidthOffset', 'deskDepthOffset', 'deskColor'] as const satisfies readonly (keyof DeskSettings)[]

export const DEFAULT_DESK_SETTINGS: Readonly<DeskSettings> = {
  deskTransparent: DEFAULT_PET_PRESET.deskTransparent,
  deskHeightOffset: DEFAULT_PET_PRESET.deskHeightOffset,
  deskWidthOffset: DEFAULT_PET_PRESET.deskWidthOffset,
  deskDepthOffset: DEFAULT_PET_PRESET.deskDepthOffset,
  deskColor: DEFAULT_PET_PRESET.deskColor,
}

// Absent width in older settings retains the original normalized minimum.
export const LEGACY_DESK_SETTINGS: Readonly<DeskSettings> = {
  ...DEFAULT_DESK_SETTINGS,
  deskWidthOffset: -1,
}

export const DESK_DIMENSION_LIMITS = { min: -1, max: 1, step: 0.01 } as const
export const DESK_HEIGHT_LIMITS = DESK_DIMENSION_LIMITS

function isDeskOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= DESK_DIMENSION_LIMITS.min && value <= DESK_DIMENSION_LIMITS.max
}

function normalizeDeskOffset(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(DESK_DIMENSION_LIMITS.max, Math.max(DESK_DIMENSION_LIMITS.min, value))
    : fallback
}

/** Fill absent legacy fields only; malformed explicit values must reach validation. */
export function migrateDeskSettings<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || DESK_SETTING_KEYS.every(key => key in value)) {
    return value
  }
  return { ...LEGACY_DESK_SETTINGS, ...value }
}

export function isDeskSettings(value: unknown): value is DeskSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as DeskSettings
  return typeof source.deskTransparent === 'boolean'
    && isDeskOffset(source.deskHeightOffset)
    && isDeskOffset(source.deskWidthOffset)
    && isDeskOffset(source.deskDepthOffset)
    && typeof source.deskColor === 'string' && /^#[0-9a-f]{6}$/i.test(source.deskColor)
}

export function normalizeDeskSettings(value: Partial<DeskSettings> | undefined): DeskSettings {
  return {
    deskTransparent: typeof value?.deskTransparent === 'boolean' ? value.deskTransparent : DEFAULT_DESK_SETTINGS.deskTransparent,
    deskHeightOffset: normalizeDeskOffset(value?.deskHeightOffset, DEFAULT_DESK_SETTINGS.deskHeightOffset),
    deskWidthOffset: normalizeDeskOffset(
      value?.deskWidthOffset,
      value && !('deskWidthOffset' in value) ? LEGACY_DESK_SETTINGS.deskWidthOffset : DEFAULT_DESK_SETTINGS.deskWidthOffset,
    ),
    deskDepthOffset: normalizeDeskOffset(value?.deskDepthOffset, DEFAULT_DESK_SETTINGS.deskDepthOffset),
    deskColor: typeof value?.deskColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.deskColor)
      ? value.deskColor
      : DEFAULT_DESK_SETTINGS.deskColor,
  }
}
