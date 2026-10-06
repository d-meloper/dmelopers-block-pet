import type { ShadowQuality } from '@/config/performance'
import type { Pet3dPreset } from '@/stores/block'

export interface BroadcastScene {
  schemaVersion: 1
  modelId: 'dmeloper'
  skinPngBase64?: string
  skinModel: 'wide' | 'slim'
  preset: Pet3dPreset
  mirror: boolean
  opacity: number
  eyebrowAnimationEnabled: boolean
  performance: {
    maxFPS: number
    shadowsEnabled: boolean
    shadowQuality: ShadowQuality
    renderScalePercent: number
    idlePowerSavingEnabled: boolean
    antialiasEnabled: boolean
    pixelFilterEnabled?: boolean
  }
}

export interface BroadcastStatus {
  enabled: boolean
  url?: string
  clients: number
  error?: string
  warning?: string
}

export interface BroadcastConfiguration {
  enabled: boolean
  scene?: BroadcastScene
}

export const BROADCAST_STATUS_EVENT = 'broadcast-status'

export function isBroadcastStatus(value: unknown): value is BroadcastStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as BroadcastStatus
  return typeof status.enabled === 'boolean'
    && Number.isSafeInteger(status.clients) && status.clients >= 0
    && (status.url === undefined || /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/$/.test(status.url))
    && (status.error === undefined || typeof status.error === 'string')
    && (status.warning === undefined || status.warning === 'endpoint_backup_unavailable')
}
