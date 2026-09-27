import { DEFAULT_PET_PRESET } from './defaultSettings'

export interface DeskSettings {
  deskTransparent: boolean
  deskHeightOffset: number
  deskColor: string
}

export const DESK_SETTING_KEYS = ['deskTransparent', 'deskHeightOffset', 'deskColor'] as const satisfies readonly (keyof DeskSettings)[]

export const DEFAULT_DESK_SETTINGS: Readonly<DeskSettings> = {
  deskTransparent: DEFAULT_PET_PRESET.deskTransparent,
  deskHeightOffset: DEFAULT_PET_PRESET.deskHeightOffset,
  deskColor: DEFAULT_PET_PRESET.deskColor,
}

export const DESK_HEIGHT_LIMITS = { min: -1, max: 1, step: 0.01 } as const

/** Fill absent legacy fields only; malformed explicit values must reach validation. */
export function migrateDeskSettings<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || DESK_SETTING_KEYS.every(key => key in value)) {
    return value
  }
  return { ...DEFAULT_DESK_SETTINGS, ...value }
}

export function isDeskSettings(value: unknown): value is DeskSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as DeskSettings
  return typeof source.deskTransparent === 'boolean'
    && typeof source.deskHeightOffset === 'number' && Number.isFinite(source.deskHeightOffset)
    && source.deskHeightOffset >= DESK_HEIGHT_LIMITS.min && source.deskHeightOffset <= DESK_HEIGHT_LIMITS.max
    && typeof source.deskColor === 'string' && /^#[0-9a-f]{6}$/i.test(source.deskColor)
}

export function normalizeDeskSettings(value: Partial<DeskSettings> | undefined): DeskSettings {
  return {
    deskTransparent: typeof value?.deskTransparent === 'boolean' ? value.deskTransparent : DEFAULT_DESK_SETTINGS.deskTransparent,
    deskHeightOffset: typeof value?.deskHeightOffset === 'number' && Number.isFinite(value.deskHeightOffset)
      ? Math.min(DESK_HEIGHT_LIMITS.max, Math.max(DESK_HEIGHT_LIMITS.min, value.deskHeightOffset))
      : DEFAULT_DESK_SETTINGS.deskHeightOffset,
    deskColor: typeof value?.deskColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.deskColor)
      ? value.deskColor
      : DEFAULT_DESK_SETTINGS.deskColor,
  }
}
