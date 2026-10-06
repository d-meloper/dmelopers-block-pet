import type { SliderSnapRange } from './snapValue'

export type SliderDisplayMode = 'centered' | 'unit' | 'raw'

export function sliderDisplayRange(range: SliderSnapRange & { step?: number }, mode: SliderDisplayMode = 'centered') {
  const { min, max, defaultValue } = range
  if (mode === 'raw') return { min, max, defaultValue, step: range.step ?? 1 }
  return {
    min: mode === 'unit' ? 0 : -1,
    max: 1,
    defaultValue: toSliderDisplayValue(range.defaultValue, range, mode),
    step: 0.01,
  }
}

/** Conversion is display-only: reading an authored value never quantizes or saves it. */
export function toSliderDisplayValue(value: number, range: SliderSnapRange, mode: SliderDisplayMode = 'centered'): number {
  const { min, max, defaultValue } = range
  if (mode === 'raw') return value
  const bounded = Math.min(max, Math.max(min, value))
  if (mode === 'unit') return (bounded - min) / (max - min)
  if (bounded === defaultValue) return 0
  return bounded < defaultValue
    ? (bounded - defaultValue) / (defaultValue - min)
    : (bounded - defaultValue) / (max - defaultValue)
}

export function fromSliderDisplayValue(value: number, range: SliderSnapRange, mode: SliderDisplayMode = 'centered'): number {
  const { min, max, defaultValue } = range
  if (mode === 'raw') return Math.min(max, Math.max(min, value))
  if (mode === 'unit') {
    if (value <= 0) return min
    if (value >= 1) return max
    return min + value * (max - min)
  }
  if (value <= -1) return min
  if (value >= 1) return max
  if (value === 0) return defaultValue
  return defaultValue + value * (value < 0 ? defaultValue - min : max - defaultValue)
}

export function formatSliderDisplayValue(value: number): string {
  return Number(value.toFixed(2)).toString()
}
