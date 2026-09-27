import type { CatStore, Pet3dPreset } from '@/stores/cat'

import { DESK_SETTING_KEYS } from '@/config/desk'
import { DEVICE_COLOR_KEYS } from '@/config/deviceColors'

export const BUILTIN_PRESET_ID = 'builtin:default'
export const PRESET_COLLECTION_VERSION = 3
export const PRESET_APPLY_REQUEST = 'preset-apply-request'
export const PRESET_APPLY_RESPONSE = 'preset-apply-response'
export const PRESET_APPLY_CANCEL = 'preset-apply-cancel'
export const PRESET_EDIT_REQUEST = 'preset-edit-request'

export const PRESET_APPEARANCE_KEYS = [
  'selectedModelId',
  'dmeloperSkinDataUrl',
  'minecraftSkinUsername',
  'activeSkinLibraryEntryId',
  'dmeloperSkinModel',
  'useDefaultDmeloperSkin',
] as const satisfies readonly (keyof CatStore['customization3d'])[]

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
  appearance: Pick<CatStore['customization3d'], typeof PRESET_APPEARANCE_KEYS[number]>
  mirror: boolean
  opacity: number
  eyebrowAnimationEnabled: boolean
}

export interface PresetEntry {
  id: string
  name: string
  builtin: boolean
  favorite: boolean
  snapshot: PresetSnapshot
}

export interface PresetCollection {
  schemaVersion: number
  activeId: string
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
