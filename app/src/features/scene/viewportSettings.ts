import type { ViewportRect, ViewportSize } from '@/utils/viewportGeometry'

import { DEFAULT_PET_PRESET } from '@/config/defaultSettings'

export const DEFAULT_MANUAL_VIEWPORT: Readonly<ViewportRect> = { x: 0, y: 0, width: 500, height: 422 }
export const AUTO_VIEWPORT_PADDING_LIMITS = { min: 0, max: 16 } as const

export function equalViewportRect(first: ViewportRect, second: ViewportRect): boolean {
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height
}

/** Logical pixels per side at 100% zoom. */
export function normalizeAutoViewportPadding(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(AUTO_VIEWPORT_PADDING_LIMITS.max, Math.max(AUTO_VIEWPORT_PADDING_LIMITS.min, Math.round(value)))
    : DEFAULT_PET_PRESET.autoViewportPaddingPixels
}

export function getScaledAutoViewportPadding(pixels: number, zoomPercent: number): number {
  // Ignore division noise at integer pixel edges when deriving zoom from the camera.
  return Math.max(0, Math.ceil(normalizeAutoViewportPadding(pixels) * zoomPercent / 100 - 1e-9))
}

export function resizeAutoViewportPadding(
  rect: ViewportRect,
  previousPixels: number,
  nextPixels: number,
  zoomPercent: number,
): ViewportRect {
  const delta = getScaledAutoViewportPadding(nextPixels, zoomPercent) - getScaledAutoViewportPadding(previousPixels, zoomPercent)
  return { x: rect.x - delta, y: rect.y - delta, width: rect.width + delta * 2, height: rect.height + delta * 2 }
}

export function normalizeManualViewport(
  value: Partial<ViewportRect> | undefined,
  maximum: ViewportSize = { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER },
): ViewportRect {
  const finite = (input: unknown, fallback: number): number => typeof input === 'number' && Number.isFinite(input) ? input : fallback
  const sourceWidth = Math.max(100, Math.round(finite(value?.width, DEFAULT_MANUAL_VIEWPORT.width)))
  const sourceHeight = Math.max(100, Math.round(finite(value?.height, DEFAULT_MANUAL_VIEWPORT.height)))
  const width = Math.min(sourceWidth, Math.max(100, Math.floor(maximum.width)))
  const height = Math.min(sourceHeight, Math.max(100, Math.floor(maximum.height)))
  return {
    x: finite(value?.x, DEFAULT_MANUAL_VIEWPORT.x) + (sourceWidth - width) / 2,
    y: finite(value?.y, DEFAULT_MANUAL_VIEWPORT.y) + (sourceHeight - height) / 2,
    width,
    height,
  }
}

export function viewportSizeChanged(before: ViewportSize | undefined, after: ViewportSize): boolean {
  return !!before && (Math.round(before.width) !== Math.round(after.width)
    || Math.round(before.height) !== Math.round(after.height))
}
