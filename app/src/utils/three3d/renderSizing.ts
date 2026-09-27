import type { PerspectiveCamera } from 'three'

import type { ShadowQuality } from '@/config/performance'

import type { VisibleContentRect } from './contentBounds'

export type AdaptiveShadowMapSize = 256 | 512 | 1024 | 2048

export function normalizeOutputDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

export function selectAdaptiveShadowMapSize(
  drawingBufferWidth: number,
  drawingBufferHeight: number,
  quality: ShadowQuality = 'medium',
): AdaptiveShadowMapSize {
  const longestEdge = Math.max(
    Number.isFinite(drawingBufferWidth) ? drawingBufferWidth : 0,
    Number.isFinite(drawingBufferHeight) ? drawingBufferHeight : 0,
  )
  if (quality === 'high') return longestEdge <= 512 ? 1024 : 2048
  if (longestEdge <= 256 || quality === 'low') return 256
  return 512
}

export function applyVisibleContentViewOffset(
  camera: PerspectiveCamera,
  compositionWidth: number,
  compositionHeight: number,
  rect: VisibleContentRect,
): void {
  camera.aspect = compositionWidth / compositionHeight
  const isFullComposition = rect.x === 0
    && rect.y === 0
    && rect.width === compositionWidth
    && rect.height === compositionHeight
  if (isFullComposition) {
    camera.clearViewOffset()
  } else {
    camera.setViewOffset(
      compositionWidth,
      compositionHeight,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
    )
  }
  camera.updateProjectionMatrix()
}
