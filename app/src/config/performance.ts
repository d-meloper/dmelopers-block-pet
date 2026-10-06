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

export const MIN_FPS = 15
export const MAX_FPS = 80

export const ANTIALIAS_SETTING_REQUEST = 'antialias-setting-request'
export const ANTIALIAS_SETTING_RESPONSE = 'antialias-setting-response'
export const ANTIALIAS_SETTING_CANCEL = 'antialias-setting-cancel'

export interface AntialiasSettingRequest {
  requestId: string
  requested: boolean
}

export interface AntialiasSettingResponse extends AntialiasSettingRequest {
  actual: boolean
  success: boolean
}

export function isAntialiasSettingRequest(value: unknown): value is AntialiasSettingRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<AntialiasSettingRequest>
  return typeof request.requestId === 'string' && request.requestId.length > 0
    && request.requestId.length <= 128 && typeof request.requested === 'boolean'
}

export function isAntialiasSettingResponse(value: unknown): value is AntialiasSettingResponse {
  if (!isAntialiasSettingRequest(value)) return false
  const response = value as Partial<AntialiasSettingResponse>
  return typeof response.actual === 'boolean' && typeof response.success === 'boolean'
    && (!response.success || response.actual === response.requested)
}

export const IDLE_DELAY_MS = 5000
export const IDLE_FPS = 15

export function normalizeShadowQuality(value: unknown): ShadowQuality {
  // Legacy "auto" and unknown settings use the default tier.
  return value === 'high' || value === 'medium' || value === 'low' ? value : DEFAULT_PERFORMANCE_SETTINGS.shadowQuality
}
