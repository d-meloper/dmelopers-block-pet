import { invoke } from '@tauri-apps/api/core'

import { INVOKE_KEY } from '@/constants'

export const MINECRAFT_USERNAME_PATTERN = /^\w{3,16}$/

export const MINECRAFT_SKIN_ERROR_CODES = [
  'INVALID_USERNAME',
  'PROFILE_NOT_FOUND',
  'NO_SKIN',
  'RATE_LIMITED',
  'TIMEOUT',
  'NETWORK',
  'UPSTREAM',
  'SERVICE_BLOCKED',
  'INVALID_RESPONSE',
  'UNTRUSTED_TEXTURE_URL',
  'TOO_LARGE',
  'INVALID_PNG',
  'INVALID_DIMENSIONS',
  'HASH_MISMATCH',
] as const

export type MinecraftSkinErrorCode = typeof MINECRAFT_SKIN_ERROR_CODES[number]
export type MinecraftSkinModel = 'wide' | 'slim'

export interface MinecraftSkinResponse {
  canonicalName: string
  uuid: string
  model: MinecraftSkinModel
  textureKey: string
  pngBase64: string
  sha256: string
  width: 64
  height: 32 | 64
  cacheHit: boolean
}

export interface MinecraftSkinErrorPayload {
  code: MinecraftSkinErrorCode
  retryable: boolean
  retryAfterSeconds?: number
}

type InvokeMinecraftSkin = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>

const ERROR_CODE_SET = new Set<string>(MINECRAFT_SKIN_ERROR_CODES)
const UUID_PATTERN = /^[0-9a-f]{32}$/i
const TEXTURE_KEY_PATTERN = /^[0-9a-f]{32,128}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/i
const BASE64_PATTERN = /^(?:[A-Z\d+/]{4})*(?:[A-Z\d+/]{2}==|[A-Z\d+/]{3}=)?$/i
const MAX_PNG_BASE64_LENGTH = 4 * Math.ceil((2 * 1024 * 1024) / 3)

export class LatestRequestGate {
  private generation = 0

  begin(): number {
    this.generation += 1
    return this.generation
  }

  invalidate(): void {
    this.generation += 1
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }
}

export class MinecraftSkinError extends Error implements MinecraftSkinErrorPayload {
  readonly code: MinecraftSkinErrorCode
  readonly retryable: boolean
  readonly retryAfterSeconds?: number

  constructor(payload: MinecraftSkinErrorPayload) {
    super(payload.code)
    this.name = 'MinecraftSkinError'
    this.code = payload.code
    this.retryable = payload.retryable
    this.retryAfterSeconds = payload.retryAfterSeconds
  }
}

function parseErrorPayload(error: unknown): Record<string, unknown> | undefined {
  if (error && typeof error === 'object') return error as Record<string, unknown>
  if (typeof error !== 'string') return undefined

  try {
    const parsed = JSON.parse(error) as unknown
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

export function normalizeMinecraftSkinError(error: unknown): MinecraftSkinError {
  if (error instanceof MinecraftSkinError) return error

  const payload = parseErrorPayload(error)
  const code = typeof payload?.code === 'string' && ERROR_CODE_SET.has(payload.code)
    ? payload.code as MinecraftSkinErrorCode
    : 'INVALID_RESPONSE'
  const retryAfterSeconds = typeof payload?.retryAfterSeconds === 'number'
    && Number.isFinite(payload.retryAfterSeconds)
    && payload.retryAfterSeconds >= 0
    ? Math.ceil(payload.retryAfterSeconds)
    : undefined

  return new MinecraftSkinError({
    code,
    retryable: payload?.retryable === true,
    retryAfterSeconds,
  })
}

export function isMinecraftUsername(value: string): boolean {
  return MINECRAFT_USERNAME_PATTERN.test(value)
}

export function createMinecraftSkinDataUrl(pngBase64: string): string {
  return `data:image/png;base64,${pngBase64}`
}

export function createMinecraftSkinBlob(pngBase64: string): Blob {
  const binary = atob(pngBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: 'image/png' })
}

function validateResponse(value: unknown): MinecraftSkinResponse {
  if (!value || typeof value !== 'object') {
    throw new MinecraftSkinError({ code: 'INVALID_RESPONSE', retryable: false })
  }

  const response = value as Record<string, unknown>
  const valid = typeof response.canonicalName === 'string'
    && isMinecraftUsername(response.canonicalName)
    && typeof response.uuid === 'string'
    && UUID_PATTERN.test(response.uuid)
    && (response.model === 'wide' || response.model === 'slim')
    && typeof response.textureKey === 'string'
    && TEXTURE_KEY_PATTERN.test(response.textureKey)
    && typeof response.pngBase64 === 'string'
    && response.pngBase64.length > 0
    && response.pngBase64.length <= MAX_PNG_BASE64_LENGTH
    && BASE64_PATTERN.test(response.pngBase64)
    && typeof response.sha256 === 'string'
    && SHA256_PATTERN.test(response.sha256)
    && response.width === 64
    && (response.height === 32 || response.height === 64)
    && typeof response.cacheHit === 'boolean'

  if (!valid) {
    throw new MinecraftSkinError({ code: 'INVALID_RESPONSE', retryable: false })
  }

  return response as unknown as MinecraftSkinResponse
}

export async function fetchMinecraftSkin(
  username: string,
  invokeCommand: InvokeMinecraftSkin = invoke,
): Promise<MinecraftSkinResponse> {
  const requestedName = username.trim()
  if (!isMinecraftUsername(requestedName)) {
    throw new MinecraftSkinError({ code: 'INVALID_USERNAME', retryable: false })
  }

  try {
    const response = await invokeCommand<unknown>(
      INVOKE_KEY.FETCH_MINECRAFT_SKIN,
      { username: requestedName },
    )
    return validateResponse(response)
  } catch (error) {
    throw normalizeMinecraftSkinError(error)
  }
}
