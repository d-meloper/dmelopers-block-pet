export interface MenuViewportSettingRequest {
  key: 'cameraZoomPercent' | 'sceneRotationOffsetDegrees'
  value: number
}

export const MENU_VIEWPORT_OPTIONS = {
  cameraZoomPercent: [
    { value: 25, label: 'verySmall' },
    { value: 50, label: 'small' },
    { value: 75, label: 'slightlySmall' },
    { value: 100, label: 'normal' },
    { value: 125, label: 'large' },
    { value: 150, label: 'veryLarge' },
    { value: 200, label: 'maximum' },
  ],
  sceneRotationOffsetDegrees: [
    { value: 0, label: 'default' },
    { value: 45, label: 'rightDiagonal' },
    { value: 90, label: 'rightSide' },
    { value: 135, label: 'rearRight' },
    { value: 180, label: 'back' },
    { value: 225, label: 'rearLeft' },
    { value: 290, label: 'leftSide' },
  ],
} as const

export interface CycleViewportSettingRequest {
  cycle: MenuViewportSettingRequest['key']
}

export function isCycleViewportSettingRequest(value: unknown): value is CycleViewportSettingRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<CycleViewportSettingRequest>
  return request.cycle === 'cameraZoomPercent' || request.cycle === 'sceneRotationOffsetDegrees'
}

export function nextViewportOption(key: MenuViewportSettingRequest['key'], current: number): number {
  const options = MENU_VIEWPORT_OPTIONS[key]
  return (options.find(option => option.value > current) ?? options[0]).value
}

export function isMenuViewportSettingRequest(value: unknown): value is MenuViewportSettingRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<MenuViewportSettingRequest>
  return (request.key === 'cameraZoomPercent' || request.key === 'sceneRotationOffsetDegrees')
    && typeof request.value === 'number'
    && MENU_VIEWPORT_OPTIONS[request.key].some(option => option.value === request.value)
}

export function createMenuViewportSettingHandler(options: {
  ready: () => Promise<unknown>
  apply: (request: MenuViewportSettingRequest) => void
}) {
  let queue = Promise.resolve()
  return (payload: unknown) => {
    if (!isMenuViewportSettingRequest(payload)) return Promise.resolve()
    const request = { key: payload.key, value: payload.value }
    queue = queue.catch(() => {}).then(async () => {
      await options.ready()
      options.apply(request)
    })
    return queue
  }
}
