// Fixed world-space lengths calibrated once from the owner's keyboard layout.
// Both typing motions share the same range; moving devices never rescales it.
export const TYPING_REACH_RADII = {
  min: 0.9955904100259901,
  default: 1.2296214928741467,
  max: 1.633463288728702,
} as const

export function normalizeTypingReachOffset(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(-1, value))
    : fallback
}

export function getTypingReachRadius(value: number): number {
  const offset = normalizeTypingReachOffset(value)
  const end = offset < 0 ? TYPING_REACH_RADII.min : TYPING_REACH_RADII.max
  return TYPING_REACH_RADII.default + (end - TYPING_REACH_RADII.default) * Math.abs(offset)
}

/** Tighten ordinary arm extension below zero without changing bone lengths. */
export function getTypingReachContractionScale(value: number): number {
  return Math.min(1, getTypingReachRadius(value) / TYPING_REACH_RADII.default)
}

/** Fade typing-induced waist bend to zero at the compact endpoint. */
export function getTypingReachLeanScale(value: number): number {
  return 1 + Math.min(0, normalizeTypingReachOffset(value))
}

/** How far the allowed target extends beyond the default circle (0..1). */
export function getTypingReachExtension(offset: number, targetDistance: number): number {
  const distance = Math.min(targetDistance, getTypingReachRadius(offset))
  return Math.min(1, Math.max(0, (distance - TYPING_REACH_RADII.default) / (TYPING_REACH_RADII.max - TYPING_REACH_RADII.default)))
}

/** Extra pose support grows along every ray of the character-centered circle. */
export function getTypingReachAssistance(offset: number, targetDistance: number): number {
  const amount = Math.max(0, normalizeTypingReachOffset(offset))
  if (amount === 0) return 0
  const distanceRatio = Math.min(1, Math.max(0, targetDistance / getTypingReachRadius(offset)))
  const progress = Math.min(1, Math.max(0, (distanceRatio - 0.35) / 0.65))
  return amount * progress * progress * (3 - 2 * progress)
}
