import type { HeadbuttRadiusSettings } from './headbuttRadius'
import type { HeadbuttRecoilSettings } from './headbuttRecoil'
import type { TypingMotionSettings } from './typingMotion'

import { DEFAULT_PET_PRESET } from './defaultSettings'
import { normalizeHeadbuttMaxRadiusOffset } from './headbuttRadius'
import { normalizeHeadbuttRecoilSettings } from './headbuttRecoil'
import { normalizeTypingMotionSettings } from './typingMotion'

export type PetMotionSettings = HeadbuttRadiusSettings & HeadbuttRecoilSettings & TypingMotionSettings

export const PET_TYPING_AND_RECOIL_SETTING_KEYS = [
  'petHeadbuttRecoilEnabled',
  'petHeadbuttRecoilStrengthPercent',
  'petHeadbuttRecoilWobblePercent',
  'petTypingHandLiftPercent',
  'petTypingBodyMotionPercent',
  'petTypingReturnSpeedPercent',
] as const satisfies readonly (keyof PetMotionSettings)[]

export const PET_MOTION_SETTING_KEYS = [
  ...PET_TYPING_AND_RECOIL_SETTING_KEYS,
  'petHeadbuttMaxRadiusOffset',
  'petTypingMaxRadiusOffset',
] as const satisfies readonly (keyof PetMotionSettings)[]

/** Missing-only migration preserves explicit invalid imports for compatibility review. */
export function migratePetMotionSettings<T>(value: T, keys: readonly (keyof PetMotionSettings)[] = PET_MOTION_SETTING_KEYS): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || keys.every(key => key in value)) {
    return value
  }
  return {
    ...Object.fromEntries(keys.map(key => [key, DEFAULT_PET_PRESET[key]])),
    ...value,
  }
}

export function normalizePetMotionSettings(value: Partial<PetMotionSettings>): PetMotionSettings {
  return {
    ...normalizeHeadbuttRecoilSettings(value),
    ...normalizeTypingMotionSettings(value),
    petHeadbuttMaxRadiusOffset: normalizeHeadbuttMaxRadiusOffset(value.petHeadbuttMaxRadiusOffset),
  }
}
