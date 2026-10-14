import defaults from './defaultSettings.json'
import ranges from './presetRanges.json'
import { getTypingReachRadius, normalizeTypingReachOffset, TYPING_REACH_RADII } from './typingReach'

export interface HeadbuttRadiusSettings {
  petHeadbuttMaxRadiusOffset: number
}

export const DEFAULT_HEADBUTT_MAX_RADIUS_OFFSET = defaults.preset.petHeadbuttMaxRadiusOffset
export const HEADBUTT_MAX_RADIUS_LIMITS = ranges.preset.petHeadbuttMaxRadiusOffset

// One-time calibration from the owner's placement. Device transforms never
// rescale these world-space lengths; only the projected pet-root center moves.
export const HEADBUTT_REACH_RADII = TYPING_REACH_RADII

export function normalizeHeadbuttMaxRadiusOffset(value: unknown, fallback = DEFAULT_HEADBUTT_MAX_RADIUS_OFFSET): number {
  return normalizeTypingReachOffset(value, fallback)
}

export function getHeadbuttReachRadius(value: number): number {
  return getTypingReachRadius(value)
}
