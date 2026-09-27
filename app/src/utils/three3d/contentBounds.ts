export interface VisibleContentRect {
  x: number
  y: number
  width: number
  height: number
}

export type VisibleContentMeasurementFailureReason
  = | 'context-lost'
    | 'empty-alpha'
    | 'readback-failed'
    | 'render-failed'
    | 'renderer-unavailable'

export type VisibleContentMeasurementResult
  = | {
    status: 'success'
    rect: VisibleContentRect
  }
  | { status: 'failure', reason: VisibleContentMeasurementFailureReason }
  | { status: 'stale' }

interface RectEdges {
  left: number
  top: number
  right: number
  bottom: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum))
}

export function createFullContentRect(
  width: number,
  height: number,
): VisibleContentRect {
  return {
    x: 0,
    y: 0,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  }
}

export function normalizeVisibleContentRect(
  rect: VisibleContentRect,
  compositionWidth: number,
  compositionHeight: number,
): VisibleContentRect {
  const full = createFullContentRect(compositionWidth, compositionHeight)
  if (
    !Number.isFinite(rect.x)
    || !Number.isFinite(rect.y)
    || !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || rect.width <= 0
    || rect.height <= 0
  ) {
    return full
  }

  const left = Math.floor(rect.x)
  const top = Math.floor(rect.y)
  const right = Math.max(left + 1, Math.ceil(rect.x + rect.width))
  const bottom = Math.max(top + 1, Math.ceil(rect.y + rect.height))

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }
}

export function normalizeRealizedViewRect(
  rect: VisibleContentRect,
  fallback: VisibleContentRect,
): VisibleContentRect {
  if (
    !Number.isFinite(rect.x)
    || !Number.isFinite(rect.y)
    || !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || rect.width <= 0
    || rect.height <= 0
  ) {
    return { ...fallback }
  }
  return { ...rect }
}

function contentRectFromEdges(
  edges: RectEdges,
  compositionWidth: number,
  compositionHeight: number,
  paddingPixels = 0,
): VisibleContentRect | undefined {
  if (
    !Number.isFinite(edges.left)
    || !Number.isFinite(edges.top)
    || !Number.isFinite(edges.right)
    || !Number.isFinite(edges.bottom)
    || edges.right <= edges.left
    || edges.bottom <= edges.top
  ) {
    return undefined
  }

  const padding = Number.isFinite(paddingPixels)
    ? Math.max(0, Math.ceil(paddingPixels))
    : 0

  return normalizeVisibleContentRect({
    x: Math.floor(edges.left) - padding,
    y: Math.floor(edges.top) - padding,
    width: Math.ceil(edges.right) - Math.floor(edges.left) + padding * 2,
    height: Math.ceil(edges.bottom) - Math.floor(edges.top) + padding * 2,
  }, compositionWidth, compositionHeight)
}

/**
 * Finds non-transparent pixels in a bottom-left-origin WebGL RGBA readback and
 * returns a top-left-origin rectangle in composition logical pixels.
 */
export function scanAlphaContentRect(
  pixels: Uint8Array,
  width: number,
  height: number,
  paddingPixels = 2,
  alphaThreshold = 0,
): VisibleContentRect | undefined {
  const compositionWidth = Math.max(1, Math.round(width))
  const compositionHeight = Math.max(1, Math.round(height))
  if (pixels.length < compositionWidth * compositionHeight * 4) return undefined

  const threshold = clamp(Math.round(alphaThreshold), 0, 254)
  let minX = compositionWidth
  let minY = compositionHeight
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < compositionHeight; y += 1) {
    for (let x = 0; x < compositionWidth; x += 1) {
      const alphaIndex = (y * compositionWidth + x) * 4 + 3
      if (pixels[alphaIndex]! <= threshold) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) return undefined

  return contentRectFromEdges({
    left: minX,
    top: compositionHeight - 1 - maxY,
    right: maxX + 1,
    bottom: compositionHeight - minY,
  }, compositionWidth, compositionHeight, paddingPixels)
}

export function scanAlphaContentMeasurement(
  pixels: Uint8Array,
  width: number,
  height: number,
  paddingPixels = 2,
  alphaThreshold = 0,
): VisibleContentMeasurementResult {
  const rect = scanAlphaContentRect(
    pixels,
    width,
    height,
    paddingPixels,
    alphaThreshold,
  )
  return rect
    ? { status: 'success', rect }
    : { status: 'failure', reason: 'empty-alpha' }
}
