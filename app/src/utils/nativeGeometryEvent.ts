import type { ViewportPoint, ViewportSize } from './viewportGeometry'

export type NativeGeometryEventClassification
  = 'external' | 'noop' | 'programmatic' | 'stale'

export interface NativeGeometryEventInput<T> {
  actualValue: T
  committedValue?: T
  eventValue: T
  programmaticGeneration?: number
  tolerance?: number
}

const DEFAULT_TOLERANCE = 1

export function selectCurrentProgrammaticGeneration(
  matchedGeneration: number | undefined,
  activeGeneration: number | undefined,
): number | undefined {
  // An active mutation can supersede an older native command whose event is
  // delivered late. Once no mutation is active, every leftover token must be
  // checked against the actual native geometry instead.
  return matchedGeneration !== undefined
    && activeGeneration !== undefined
    && matchedGeneration <= activeGeneration
    ? matchedGeneration
    : undefined
}

function getTolerance(value: number | undefined): number {
  return Number.isFinite(value) && value! >= 0 ? value! : DEFAULT_TOLERANCE
}

function valuesMatch(
  first: readonly number[],
  second: readonly number[],
  tolerance: number,
): boolean {
  return first.every((value, index) => (
    Number.isFinite(value)
    && Number.isFinite(second[index])
    && Math.abs(value - second[index]) <= tolerance
  ))
}

function classifyNativeGeometryEvent<T>(
  input: NativeGeometryEventInput<T>,
  toValues: (value: T) => readonly number[],
): NativeGeometryEventClassification {
  if (input.programmaticGeneration !== undefined) return 'programmatic'
  const tolerance = getTolerance(input.tolerance)
  const eventMatchesActual = valuesMatch(
    toValues(input.eventValue),
    toValues(input.actualValue),
    tolerance,
  )
  if (input.committedValue !== undefined) {
    const actualMatchesCommitted = valuesMatch(
      toValues(input.actualValue),
      toValues(input.committedValue),
      tolerance,
    )
    if (!actualMatchesCommitted) return 'external'
    return eventMatchesActual ? 'noop' : 'stale'
  }
  return eventMatchesActual ? 'external' : 'stale'
}

/** Classifies a native move event against the window's current position. */
export function classifyNativePositionEvent(
  input: NativeGeometryEventInput<ViewportPoint>,
): NativeGeometryEventClassification {
  return classifyNativeGeometryEvent(input, value => [value.x, value.y])
}

/** Classifies a native resize event against the window's current inner size. */
export function classifyNativeSizeEvent(
  input: NativeGeometryEventInput<ViewportSize>,
): NativeGeometryEventClassification {
  return classifyNativeGeometryEvent(
    input,
    value => [value.width, value.height],
  )
}
