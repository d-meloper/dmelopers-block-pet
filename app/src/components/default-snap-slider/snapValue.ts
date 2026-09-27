export interface SliderSnapRange {
  min: number
  max: number
  defaultValue: number
}

export function snapSliderValue(value: number, range: SliderSnapRange): number {
  const { min, max, defaultValue } = range
  const radius = Math.max(Math.abs(min - defaultValue), Math.abs(max - defaultValue)) * 0.05
  // Decimal slider steps can land a few floating-point bits beyond an inclusive edge.
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(defaultValue), radius) * 4
  return Math.abs(value - defaultValue) <= radius + tolerance ? defaultValue : value
}
