import { DEFAULT_PET_PRESET } from './defaultSettings'

export interface PetArmPoseSettings {
  petRightArmBendPercent: number
  petRightArmSpreadDegrees: number
  petLeftArmBendPercent: number
  petLeftArmSpreadDegrees: number
}

export const DEFAULT_PET_ARM_POSE_SETTINGS: Readonly<PetArmPoseSettings> = {
  petRightArmBendPercent: DEFAULT_PET_PRESET.petRightArmBendPercent,
  petRightArmSpreadDegrees: DEFAULT_PET_PRESET.petRightArmSpreadDegrees,
  petLeftArmBendPercent: DEFAULT_PET_PRESET.petLeftArmBendPercent,
  petLeftArmSpreadDegrees: DEFAULT_PET_PRESET.petLeftArmSpreadDegrees,
}

export function normalizePetArmPoseSettings(
  settings: Partial<PetArmPoseSettings>,
  fallback: Readonly<PetArmPoseSettings> = DEFAULT_PET_ARM_POSE_SETTINGS,
): PetArmPoseSettings {
  const clamp = (value: number | undefined, previous: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : previous

  return {
    petRightArmBendPercent: clamp(settings.petRightArmBendPercent, fallback.petRightArmBendPercent, 0, 400),
    petRightArmSpreadDegrees: clamp(settings.petRightArmSpreadDegrees, fallback.petRightArmSpreadDegrees, -45, 45),
    petLeftArmBendPercent: clamp(settings.petLeftArmBendPercent, fallback.petLeftArmBendPercent, 0, 400),
    petLeftArmSpreadDegrees: clamp(settings.petLeftArmSpreadDegrees, fallback.petLeftArmSpreadDegrees, -45, 45),
  }
}
