import defaults from './defaultSettings.json'
import ranges from './presetRanges.json'

export interface TypingMotionSettings {
  petTypingMaxRadiusOffset: number
  petTypingHandLiftPercent: number
  petTypingBodyMotionPercent: number
  petTypingReturnSpeedPercent: number
}

export const DEFAULT_TYPING_MOTION_SETTINGS: Readonly<TypingMotionSettings> = {
  petTypingMaxRadiusOffset: defaults.preset.petTypingMaxRadiusOffset,
  petTypingHandLiftPercent: defaults.preset.petTypingHandLiftPercent,
  petTypingBodyMotionPercent: defaults.preset.petTypingBodyMotionPercent,
  petTypingReturnSpeedPercent: defaults.preset.petTypingReturnSpeedPercent,
}

export const TYPING_MOTION_LIMITS = {
  petTypingMaxRadiusOffset: ranges.preset.petTypingMaxRadiusOffset,
  petTypingHandLiftPercent: ranges.preset.petTypingHandLiftPercent,
  petTypingBodyMotionPercent: ranges.preset.petTypingBodyMotionPercent,
  petTypingReturnSpeedPercent: ranges.preset.petTypingReturnSpeedPercent,
} as const

export function normalizeTypingMotionSettings(
  settings: Partial<TypingMotionSettings>,
  fallback: Readonly<TypingMotionSettings> = DEFAULT_TYPING_MOTION_SETTINGS,
): TypingMotionSettings {
  const next = { ...fallback }
  for (const key of Object.keys(TYPING_MOTION_LIMITS) as (keyof TypingMotionSettings)[]) {
    const value = settings[key]
    const range = TYPING_MOTION_LIMITS[key]
    if (typeof value === 'number' && Number.isFinite(value)) next[key] = Math.min(range.max, Math.max(range.min, value))
  }
  return next
}
