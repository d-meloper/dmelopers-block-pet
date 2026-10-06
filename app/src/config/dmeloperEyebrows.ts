import { DEFAULT_PET_PRESET } from './defaultSettings'
import presetRanges from './presetRanges.json'

export interface DmeloperEyebrowPreset {
  enabled: boolean
  color: string
  centerOffsetPixels: number
  heightOffsetPixels: number
  spacingPixels: number
  widthPixels: number
  thicknessPixels: number
  depthPercent: number
}

/** Add only the missing field; preserve explicit invalid values for boundary validation. */
export function migrateDmeloperEyebrowDepth<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'depthPercent' in value) return value
  return { ...value, depthPercent: 100 }
}

export const DMELOPER_EYEBROW_FALLBACK_COLOR = DEFAULT_PET_PRESET.dmeloperEyebrows.color

export const DMELOPER_EYEBROW_LIMITS = {
  centerOffsetPixels: { min: -1.5, max: 1.5 },
  heightOffsetPixels: { min: -3, max: 3 },
  spacingPixels: presetRanges.eyebrows.spacingPixels,
  widthPixels: presetRanges.eyebrows.widthPixels,
  thicknessPixels: presetRanges.eyebrows.thicknessPixels,
  depthPercent: { min: 0, max: 200 },
  step: 0.05,
} as const

export function createDefaultDmeloperEyebrowPreset(): DmeloperEyebrowPreset {
  return { ...DEFAULT_PET_PRESET.dmeloperEyebrows }
}
