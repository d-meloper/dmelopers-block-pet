export interface ViewportPoint {
  x: number
  y: number
}

export interface ViewportSize {
  width: number
  height: number
}

export interface ViewportRect extends ViewportPoint, ViewportSize {}

export interface ViewportMonitor {
  id: string
  workArea: ViewportRect
}

export interface ViewportGeometryInput {
  mirrored: boolean
  scaleFactor: number
  sourceRect: ViewportRect
  virtualOrigin: ViewportPoint
  virtualSize: ViewportSize
  windowScalePercent: number
}

export interface ResolvedViewportGeometry {
  mirrored: boolean
  nativeRect: ViewportRect
  outputLogicalSize: ViewportSize
  physicalOffset: ViewportPoint
  physicalSize: ViewportSize
  placementRect: ViewportRect
  realizedSourceRect: ViewportRect
  scaleFactor: number
  sourceRect: ViewportRect
  virtualOrigin: ViewportPoint
  virtualSize: ViewportSize
  windowScalePercent: number
}

export interface ClampedViewport {
  delta: ViewportPoint
  monitor: ViewportMonitor
  rect: ViewportRect
}

const DEFAULT_WINDOW_SCALE_PERCENT = 100
const MIN_WINDOW_SCALE_PERCENT = 10
const MAX_WINDOW_SCALE_PERCENT = 100

function isFiniteSize(size: ViewportSize): boolean {
  return Number.isFinite(size.width)
    && Number.isFinite(size.height)
    && size.width > 0
    && size.height > 0
}

function isFiniteRect(rect: ViewportRect): boolean {
  return Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && isFiniteSize(rect)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum))
}

export function normalizeWindowScalePercent(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_WINDOW_SCALE_PERCENT
  return clamp(percent, MIN_WINDOW_SCALE_PERCENT, MAX_WINDOW_SCALE_PERCENT)
}

export function normalizeViewportRect(
  rect: ViewportRect,
  virtualSize: ViewportSize,
): ViewportRect {
  if (!isFiniteSize(virtualSize)) {
    throw new RangeError('The virtual viewport size must be finite and positive.')
  }
  if (!isFiniteRect(rect)) {
    return { x: 0, y: 0, ...virtualSize }
  }

  const left = Math.floor(rect.x)
  const top = Math.floor(rect.y)
  const right = Math.ceil(rect.x + rect.width)
  const bottom = Math.ceil(rect.y + rect.height)

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }
}

export function getViewportPlacementRect(
  sourceRect: ViewportRect,
  virtualSize: ViewportSize,
  mirrored: boolean,
): ViewportRect {
  const normalized = normalizeViewportRect(sourceRect, virtualSize)
  if (!mirrored) return normalized

  return {
    ...normalized,
    x: virtualSize.width - normalized.x - normalized.width,
  }
}

function containsViewportRect(
  container: ViewportRect,
  content: ViewportRect,
): boolean {
  const epsilon = 1e-9
  return container.x <= content.x + epsilon
    && container.y <= content.y + epsilon
    && container.x + container.width + epsilon >= content.x + content.width
    && container.y + container.height + epsilon >= content.y + content.height
}

function expandViewportRectToAspect(
  rect: ViewportRect,
  targetAspect: number,
): ViewportRect {
  if (!Number.isFinite(targetAspect) || targetAspect <= 0) return { ...rect }
  const currentAspect = rect.width / rect.height
  if (Math.abs(currentAspect - targetAspect) <= Number.EPSILON) {
    return { ...rect }
  }
  if (currentAspect > targetAspect) {
    const height = rect.width / targetAspect
    return {
      ...rect,
      y: rect.y - (height - rect.height) / 2,
      height,
    }
  }
  const width = rect.height * targetAspect
  return {
    ...rect,
    x: rect.x - (width - rect.width) / 2,
    width,
  }
}

export function getRealizedViewportSourceRect(
  sourceRect: ViewportRect,
  virtualSize: ViewportSize,
  mirrored: boolean,
  physicalOffset: ViewportPoint,
  physicalSize: ViewportSize,
  physicalScale: number,
): ViewportRect {
  if (
    !Number.isFinite(physicalScale)
    || physicalScale <= 0
    || !isFiniteSize(physicalSize)
  ) {
    return { ...sourceRect }
  }
  const realizedPlacementRect = {
    x: physicalOffset.x / physicalScale,
    y: physicalOffset.y / physicalScale,
    width: physicalSize.width / physicalScale,
    height: physicalSize.height / physicalScale,
  }
  const realizedSourceRect = mirrored
    ? {
        ...realizedPlacementRect,
        x: virtualSize.width
          - realizedPlacementRect.x
          - realizedPlacementRect.width,
      }
    : realizedPlacementRect
  if (containsViewportRect(realizedSourceRect, sourceRect)) {
    return realizedSourceRect
  }

  return expandViewportRectToAspect(
    sourceRect,
    physicalSize.width / physicalSize.height,
  )
}

export function createViewportGeometry(
  input: ViewportGeometryInput,
): ResolvedViewportGeometry {
  const sourceRect = normalizeViewportRect(input.sourceRect, input.virtualSize)
  const placementRect = getViewportPlacementRect(
    sourceRect,
    input.virtualSize,
    input.mirrored,
  )
  const windowScalePercent = normalizeWindowScalePercent(input.windowScalePercent)
  const scaleFactor = Number.isFinite(input.scaleFactor) && input.scaleFactor > 0
    ? input.scaleFactor
    : 1
  const physicalScale = windowScalePercent / 100 * scaleFactor
  const left = Math.floor(placementRect.x * physicalScale)
  const top = Math.floor(placementRect.y * physicalScale)
  const right = Math.ceil((placementRect.x + placementRect.width) * physicalScale)
  const bottom = Math.ceil((placementRect.y + placementRect.height) * physicalScale)
  const physicalSize = {
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  }
  const physicalOffset = { x: left, y: top }
  const realizedSourceRect = getRealizedViewportSourceRect(
    sourceRect,
    input.virtualSize,
    input.mirrored,
    physicalOffset,
    physicalSize,
    physicalScale,
  )
  const virtualOrigin = {
    x: Math.round(input.virtualOrigin.x),
    y: Math.round(input.virtualOrigin.y),
  }

  return {
    mirrored: input.mirrored,
    sourceRect,
    realizedSourceRect,
    placementRect,
    physicalOffset,
    physicalSize,
    nativeRect: {
      x: virtualOrigin.x + physicalOffset.x,
      y: virtualOrigin.y + physicalOffset.y,
      ...physicalSize,
    },
    outputLogicalSize: {
      width: physicalSize.width / scaleFactor,
      height: physicalSize.height / scaleFactor,
    },
    scaleFactor,
    virtualOrigin,
    virtualSize: { ...input.virtualSize },
    windowScalePercent,
  }
}

export function getViewportVirtualOrigin(
  nativePosition: ViewportPoint,
  physicalOffset: ViewportPoint,
): ViewportPoint {
  return {
    x: Math.round(nativePosition.x - physicalOffset.x),
    y: Math.round(nativePosition.y - physicalOffset.y),
  }
}

export function getCenteredViewportPosition(
  rect: ViewportRect,
  workArea: ViewportRect,
): ViewportPoint {
  if (!isFiniteRect(rect) || !isFiniteRect(workArea)) {
    return { x: rect.x, y: rect.y }
  }
  return {
    x: Math.round(workArea.x + (workArea.width - rect.width) / 2),
    y: Math.round(workArea.y + (workArea.height - rect.height) / 2),
  }
}

export function getRectIntersectionArea(
  first: ViewportRect,
  second: ViewportRect,
): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width)
    - Math.max(first.x, second.x),
  )
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height)
    - Math.max(first.y, second.y),
  )
  return width * height
}

export function getRectDistanceSquared(
  first: ViewportRect,
  second: ViewportRect,
): number {
  const deltaX = Math.max(
    second.x - (first.x + first.width),
    first.x - (second.x + second.width),
    0,
  )
  const deltaY = Math.max(
    second.y - (first.y + first.height),
    first.y - (second.y + second.height),
    0,
  )
  return deltaX ** 2 + deltaY ** 2
}

export function selectViewportMonitor(
  rect: ViewportRect,
  monitors: readonly ViewportMonitor[],
  preferredMonitorId?: string,
): ViewportMonitor | undefined {
  const candidates = monitors.filter(monitor => isFiniteRect(monitor.workArea))
  if (candidates.length === 0) return undefined

  let maximumIntersection = 0
  for (const monitor of candidates) {
    maximumIntersection = Math.max(
      maximumIntersection,
      getRectIntersectionArea(rect, monitor.workArea),
    )
  }

  if (maximumIntersection > 0) {
    const intersecting = candidates.filter(monitor => (
      getRectIntersectionArea(rect, monitor.workArea) === maximumIntersection
    ))
    return intersecting.find(monitor => monitor.id === preferredMonitorId)
      ?? intersecting[0]
  }

  let minimumDistance = Number.POSITIVE_INFINITY
  for (const monitor of candidates) {
    minimumDistance = Math.min(
      minimumDistance,
      getRectDistanceSquared(rect, monitor.workArea),
    )
  }
  const nearest = candidates.filter(monitor => (
    getRectDistanceSquared(rect, monitor.workArea) === minimumDistance
  ))
  return nearest.find(monitor => monitor.id === preferredMonitorId) ?? nearest[0]
}

export function clampRectToWorkArea(
  rect: ViewportRect,
  workArea: ViewportRect,
): { delta: ViewportPoint, rect: ViewportRect } {
  if (!isFiniteRect(rect) || !isFiniteRect(workArea)) {
    return { delta: { x: 0, y: 0 }, rect: { ...rect } }
  }

  const x = rect.width <= workArea.width
    ? clamp(rect.x, workArea.x, workArea.x + workArea.width - rect.width)
    : workArea.x
  const y = rect.height <= workArea.height
    ? clamp(rect.y, workArea.y, workArea.y + workArea.height - rect.height)
    : workArea.y

  return {
    delta: { x: x - rect.x, y: y - rect.y },
    rect: { ...rect, x, y },
  }
}

export function clampViewportToMonitors(
  rect: ViewportRect,
  monitors: readonly ViewportMonitor[],
  preferredMonitorId?: string,
): ClampedViewport | undefined {
  const monitor = selectViewportMonitor(rect, monitors, preferredMonitorId)
  if (!monitor) return undefined
  const clamped = clampRectToWorkArea(rect, monitor.workArea)
  return { ...clamped, monitor }
}
