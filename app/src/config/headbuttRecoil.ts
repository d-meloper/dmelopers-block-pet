import defaults from './defaultSettings.json'
import ranges from './presetRanges.json'

export interface HeadbuttRecoilSettings {
  petHeadbuttRecoilEnabled: boolean
  petHeadbuttRecoilStrengthPercent: number
  petHeadbuttRecoilWobblePercent: number
}

export const DEFAULT_HEADBUTT_RECOIL_SETTINGS: Readonly<HeadbuttRecoilSettings> = {
  petHeadbuttRecoilEnabled: defaults.preset.petHeadbuttRecoilEnabled,
  petHeadbuttRecoilStrengthPercent: defaults.preset.petHeadbuttRecoilStrengthPercent,
  petHeadbuttRecoilWobblePercent: defaults.preset.petHeadbuttRecoilWobblePercent,
}

export const HEADBUTT_RECOIL_LIMITS = {
  petHeadbuttRecoilStrengthPercent: ranges.preset.petHeadbuttRecoilStrengthPercent,
  petHeadbuttRecoilWobblePercent: ranges.preset.petHeadbuttRecoilWobblePercent,
} as const

export function normalizeHeadbuttRecoilSettings(
  settings: Partial<HeadbuttRecoilSettings>,
  fallback: Readonly<HeadbuttRecoilSettings> = DEFAULT_HEADBUTT_RECOIL_SETTINGS,
): HeadbuttRecoilSettings {
  const percent = (value: number | undefined, previous: number, range: { min: number, max: number }) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : previous

  return {
    petHeadbuttRecoilEnabled: typeof settings.petHeadbuttRecoilEnabled === 'boolean'
      ? settings.petHeadbuttRecoilEnabled
      : fallback.petHeadbuttRecoilEnabled,
    petHeadbuttRecoilStrengthPercent: percent(settings.petHeadbuttRecoilStrengthPercent, fallback.petHeadbuttRecoilStrengthPercent, HEADBUTT_RECOIL_LIMITS.petHeadbuttRecoilStrengthPercent),
    petHeadbuttRecoilWobblePercent: percent(settings.petHeadbuttRecoilWobblePercent, fallback.petHeadbuttRecoilWobblePercent, HEADBUTT_RECOIL_LIMITS.petHeadbuttRecoilWobblePercent),
  }
}
