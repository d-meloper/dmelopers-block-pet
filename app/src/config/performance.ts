import { DEFAULT_MODEL_SETTINGS } from './defaultSettings'

export type ShadowQuality = 'high' | 'medium' | 'low'
export type ShadowQualitySelection = ShadowQuality | 'off'

export const DEFAULT_PERFORMANCE_SETTINGS = {
  maxFPS: DEFAULT_MODEL_SETTINGS.maxFPS,
  shadowsEnabled: DEFAULT_MODEL_SETTINGS.shadowsEnabled,
  renderScalePercent: DEFAULT_MODEL_SETTINGS.renderScalePercent,
  idlePowerSavingEnabled: DEFAULT_MODEL_SETTINGS.idlePowerSavingEnabled,
  shadowQuality: DEFAULT_MODEL_SETTINGS.shadowQuality,
  antialiasEnabled: DEFAULT_MODEL_SETTINGS.antialiasEnabled,
  pixelFilterEnabled: DEFAULT_MODEL_SETTINGS.pixelFilterEnabled,
} as const

export const MAX_FPS = 80

export const ANTIALIAS_CHANGE_FAILED = 'antialias-change-failed'

export const IDLE_DELAY_MS = 5000
export const IDLE_FPS = 15

export function normalizeShadowQuality(value: unknown): ShadowQuality {
  // Legacy "auto" and unknown settings use the default tier.
  return value === 'high' || value === 'medium' || value === 'low' ? value : DEFAULT_PERFORMANCE_SETTINGS.shadowQuality
}
