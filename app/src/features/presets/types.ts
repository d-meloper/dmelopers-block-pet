import type { BlockStore, Pet3dPreset } from '@/stores/block'
import type { VoxelSkinModel, VoxelSkinModelPreference } from '@/utils/three3d/voxelSkin'

import { DESK_SETTING_KEYS } from '@/config/desk'
import { DEVICE_COLOR_KEYS } from '@/config/deviceColors'

export const PRESET_COLLECTION_VERSION = 4
export const PRESET_APPLY_REQUEST = 'preset-apply-request'
export const PRESET_APPLY_RESPONSE = 'preset-apply-response'
export const PRESET_APPLY_CANCEL = 'preset-apply-cancel'
export const PRESET_EDIT_REQUEST = 'preset-edit-request'

export interface ResolvedSkinModelRequest {
  resolvedSkinModel: {
    modelId: string
    skinDataUrl?: string
    requested: VoxelSkinModelPreference
    resolved: VoxelSkinModel
  }
}

export function isResolvedSkinModelRequest(value: unknown): value is ResolvedSkinModelRequest {
  if (!value || typeof value !== 'object' || !('resolvedSkinModel' in value)) return false
  const correction = value.resolvedSkinModel as ResolvedSkinModelRequest['resolvedSkinModel'] | undefined
  return !!correction && typeof correction === 'object' && correction.modelId === 'dmeloper'
    && (correction.skinDataUrl === undefined || typeof correction.skinDataUrl === 'string')
    && ['auto', 'wide', 'slim'].includes(correction.requested)
    && ['wide', 'slim'].includes(correction.resolved)
}

export const PRESET_APPEARANCE_KEYS = [
  'selectedModelId',
  'dmeloperSkinDataUrl',
  'minecraftSkinUsername',
  'activeSkinLibraryEntryId',
  'dmeloperSkinModel',
  'useDefaultDmeloperSkin',
] as const satisfies readonly (keyof BlockStore['customization3d'])[]

// Tab-owned settings are explicit: new common/runtime fields never opt in by accident.
export const PRESET_SETTING_KEYS = [
  // 3D Pet
  'petRightArmBendPercent',
  'petRightArmSpreadDegrees',
  'petLeftArmBendPercent',
  'petLeftArmSpreadDegrees',
  'petHeadScalePercent',
  'petRotationDegrees',
  'petDeskOffset',
  'dmeloperEyebrows',
  'dmeloperPalmColor',
  // 3D Scene
  'lighting',
  'showDisplayArea',
  'autoViewportEnabled',
  'autoViewportPaddingPixels',
  'manualViewportRect',
  'sceneRotationOffsetDegrees',
  'cameraHorizontalOffset',
  'cameraVerticalOffset',
  'cameraZoomPercent',
  // 3D Objects
  ...DESK_SETTING_KEYS,
  ...DEVICE_COLOR_KEYS,
  'mouseEnabled',
  'mouseBaseXOffset',
  'mouseBaseZOffset',
  'mouseScalePercent',
  'keyboardBaseXOffset',
  'keyboardBaseZOffset',
  'keyboardScalePercent',
  'keyboardLegendLanguage',
] as const satisfies readonly (keyof Pet3dPreset)[]

export interface PresetSnapshot {
  preset: Pick<Pet3dPreset, typeof PRESET_SETTING_KEYS[number]>
  appearance: Pick<BlockStore['customization3d'], typeof PRESET_APPEARANCE_KEYS[number]>
  mirror: boolean
  opacity: number
  eyebrowAnimationEnabled: boolean
}

export interface PresetEntry {
  id: string
  name: string
  favorite: boolean
  snapshot: PresetSnapshot
}

/** Runtime presentation only; bundled entries never enter the saved user catalog. */
export interface PresetListEntry extends PresetEntry {
  origin: 'builtin' | 'user'
}

export interface PresetCollection {
  schemaVersion: number
  // Legacy storage/recovery compatibility only; normal catalogs always save null.
  activeId: string | null
  entries: PresetEntry[]
  // One-time recovery evidence only; never applied to a preset or skin.
  legacyAppearanceArchive?: Record<string, Record<string, unknown>>
}

export interface PresetApplyRequest {
  requestId: string
  snapshot: PresetSnapshot
  // Transaction rollback state, separate from persisted preset settings.
  restoreVisibility?: boolean
}

export interface PresetApplyResponse {
  requestId: string
  success: boolean
  revision: number
  restored?: boolean
  snapshot?: PresetSnapshot
}
