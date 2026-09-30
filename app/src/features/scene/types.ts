import type { ViewportRect, ViewportSize } from '@/utils/viewportGeometry'

export const SCENE_VIEWPORT_REQUEST = 'scene-viewport-request'
export const SCENE_VIEWPORT_RESPONSE = 'scene-viewport-response'
export const SCENE_VIEWPORT_STATE = 'scene-viewport-state'

export interface SceneViewportState {
  automatic: boolean
  revision: number
  rect: ViewportRect
  monitorSize: ViewportSize
  manualCorrection?: { requested: ViewportRect, applied: ViewportRect }
}

export interface SceneViewportRequest {
  requestId: string
  automatic?: boolean
}

export interface SceneViewportResponse {
  requestId: string
  success: boolean
  state?: SceneViewportState
}

export function isSceneViewportRequest(value: unknown): value is SceneViewportRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<SceneViewportRequest>
  return typeof request.requestId === 'string' && request.requestId.length > 0
    && (request.automatic === undefined || typeof request.automatic === 'boolean')
}

export function isSceneViewportState(value: unknown): value is SceneViewportState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<SceneViewportState>
  return typeof state.automatic === 'boolean'
    && Number.isSafeInteger(state.revision) && state.revision! >= 0
    && !!state.rect && !!state.monitorSize
    && [state.rect.x, state.rect.y, state.rect.width, state.rect.height, state.monitorSize.width, state.monitorSize.height].every(Number.isFinite)
    && state.rect.width > 0 && state.rect.height > 0
    && state.monitorSize.width >= 100 && state.monitorSize.height >= 100
    && (state.manualCorrection === undefined || (
      !!state.manualCorrection && typeof state.manualCorrection === 'object'
      && isViewportRect(state.manualCorrection.requested) && isViewportRect(state.manualCorrection.applied)
    ))
}

function isViewportRect(value: unknown): value is ViewportRect {
  if (!value || typeof value !== 'object') return false
  const rect = value as Partial<ViewportRect>
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width! > 0 && rect.height! > 0
}
