export type SemanticInputSource = 'keyboard' | 'pointer' | 'mouse' | 'gamepad'
export type ReservedSemanticInputSource = Extract<SemanticInputSource, 'gamepad'>

export interface KeyboardContact {
  row: number
  column: number
  pressed: boolean
}

export interface DeviceInputState {
  mouseEnabled: boolean
  mouseGeneration: number
}

/** Omitting enabled queries the main window's confirmed setting. */
export interface MouseSettingRequest {
  requestId: string
  enabled?: boolean
}

export interface MouseSettingResponse {
  requestId: string
  success: boolean
  state?: DeviceInputState
  error?: 'unsupported' | 'unavailable'
}

export function isDeviceInputState(value: unknown): value is DeviceInputState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return typeof state.mouseEnabled === 'boolean'
    && Number.isSafeInteger(state.mouseGeneration)
    && (state.mouseGeneration as number) >= 0
}

export function isMouseSettingRequest(value: unknown): value is MouseSettingRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  return typeof request.requestId === 'string'
    && request.requestId.length > 0 && request.requestId.length <= 128
    && (request.enabled === undefined || typeof request.enabled === 'boolean')
}

export function isMouseSettingResponse(value: unknown): value is MouseSettingResponse {
  if (!isMouseSettingRequest(value)) return false
  const response = value as unknown as Record<string, unknown>
  return typeof response.success === 'boolean'
    && (response.state === undefined || isDeviceInputState(response.state))
    && (!response.success || isDeviceInputState(response.state))
    && (response.error === undefined || response.error === 'unsupported' || response.error === 'unavailable')
}

export type SemanticInputEvent = SemanticInputPayload & {
  /** Native mouse collection epoch; reject old epochs after a toggle/restart. */
  mouseGeneration?: number
}

type SemanticInputPayload
  = {
    kind: 'typing'
    active: boolean
    intensity: number
    contact?: KeyboardContact
  }
  | {
    kind: 'pointer_activity'
    x: number
    y: number
  }
  | {
    kind: 'mouse_primary' | 'mouse_secondary' | 'mouse_middle' | 'drag'
    active: boolean
  }
  | {
    kind: 'scroll'
    deltaX: number
    deltaY: number
  }

/** Apply this again after asynchronous pointer normalization, using the event's original epoch. */
export function isCurrentSemanticInput(event: SemanticInputEvent, state: DeviceInputState): boolean {
  if (event.kind === 'typing') return true
  return state.mouseEnabled
    && (event.mouseGeneration ?? 0) === state.mouseGeneration
}

export function isSemanticInputEvent(value: unknown): value is SemanticInputEvent {
  if (!value || typeof value !== 'object') return false

  const event = value as Record<string, unknown>
  if (event.mouseGeneration !== undefined && (
    !Number.isSafeInteger(event.mouseGeneration)
    || (event.mouseGeneration as number) < 0
  )) {
    return false
  }
  if (event.kind === 'typing') {
    const contact = event.contact as Record<string, unknown> | undefined
    const validContact = event.contact === undefined
      || (
        Boolean(contact)
        && typeof contact === 'object'
        && Object.keys(contact).every(key => (
          key === 'row' || key === 'column' || key === 'pressed'
        ))
        && Number.isSafeInteger(contact?.row)
        && Number.isSafeInteger(contact?.column)
        && (contact?.row as number) >= 0
        && (contact?.row as number) < 5
        && (contact?.column as number) >= 0
        && (contact?.column as number) < 16
        && typeof contact?.pressed === 'boolean'
      )
    return validContact
      && typeof event.active === 'boolean'
      && typeof event.intensity === 'number'
      && Number.isFinite(event.intensity)
  }
  if (event.kind === 'pointer_activity') {
    return typeof event.x === 'number'
      && Number.isFinite(event.x)
      && typeof event.y === 'number'
      && Number.isFinite(event.y)
  }
  if (
    event.kind === 'mouse_primary'
    || event.kind === 'mouse_secondary'
    || event.kind === 'mouse_middle'
    || event.kind === 'drag'
  ) {
    return typeof event.active === 'boolean'
  }
  if (event.kind === 'scroll') {
    return typeof event.deltaX === 'number'
      && Number.isFinite(event.deltaX)
      && typeof event.deltaY === 'number'
      && Number.isFinite(event.deltaY)
  }
  return false
}
