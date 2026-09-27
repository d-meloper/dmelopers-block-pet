import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'

import type { DeskSettings } from '@/config/desk'
import type { DeviceColorSettings } from '@/config/deviceColors'
import type { DmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'
import type { PetModelId } from '@/config/model3d'
import type { ShadowQuality, ShadowQualitySelection } from '@/config/performance'
import type { PetArmPoseSettings } from '@/config/petArmPose'
import type { PresetCollection } from '@/features/presets/types'
import type { VoxelSkinModel, VoxelSkinModelPreference } from '@/utils/three3d/voxelSkin'
import type { ViewportRect } from '@/utils/viewportGeometry'

import { DEFAULT_MODEL_SETTINGS, DEFAULT_PET_PRESET, DEFAULT_SKIN_APPEARANCE, DEFAULT_WINDOW_SETTINGS } from '@/config/defaultSettings'
import { DEFAULT_DESK_SETTINGS, DESK_SETTING_KEYS, migrateDeskSettings, normalizeDeskSettings } from '@/config/desk'
import { DEVICE_COLOR_KEYS, normalizeDeviceColors } from '@/config/deviceColors'
import {
  createDefaultDmeloperEyebrowPreset,
  DMELOPER_EYEBROW_LIMITS,
  migrateDmeloperEyebrowDepth,
} from '@/config/dmeloperEyebrows'
import { DEFAULT_PET_MODEL_ID, getPetModelOption, MODEL_3D_CONFIG } from '@/config/model3d'
import { DEFAULT_PERFORMANCE_SETTINGS, MAX_FPS, normalizeShadowQuality } from '@/config/performance'
import { DEFAULT_PET_ARM_POSE_SETTINGS, normalizePetArmPoseSettings } from '@/config/petArmPose'
import { BUILTIN_DMELOPER_SKIN, isSkinSelectionId } from '@/config/skinIdentity'
import { markPresetUserEdit } from '@/features/presets/editIntent'
import { createPresetCollection, migratePresetCollection } from '@/features/presets/model'
import { normalizeAutoViewportPadding, normalizeManualViewport } from '@/features/scene/viewportSettings'

import { migrateLegacySkinAppearanceState, migratePetCharacterState } from './petSettingsMigration'

export interface Pet3dPreset extends PetArmPoseSettings, DeviceColorSettings, DeskSettings {
  windowScalePercent: number
  showDisplayArea: boolean
  autoViewportEnabled: boolean
  autoViewportPaddingPixels: number
  viewportModeRevision: number
  manualViewportRect: ViewportRect
  sceneRotationOffsetDegrees: number
  cameraHorizontalOffset: number
  cameraVerticalOffset: number
  cameraZoomPercent: number
  petHeadScalePercent: number
  petRotationDegrees: number
  petDeskOffset: number
  mouseEnabled: boolean
  mouseBaseXOffset: number
  mouseBaseZOffset: number
  mouseScalePercent: number
  keyboardBaseXOffset: number
  keyboardBaseZOffset: number
  keyboardScalePercent: number
  keyboardLegendLanguage: 'ko' | 'en'
  dmeloperEyebrows: DmeloperEyebrowPreset
  dmeloperPalmColor: string
}

export interface Pet3dPresetSelectionPayload {
  modelId: PetModelId
  dmeloperSkinDataUrl?: string
  dmeloperSkinModel: VoxelSkinModelPreference
  useDefaultDmeloperSkin: boolean
  preset: Pet3dPreset
}

export interface MinecraftSkinSelection {
  dataUrl: string
  canonicalName: string
  skinModel: VoxelSkinModel
  palmColor?: string
  libraryEntryId?: string
}

export interface SkinLibrarySelection {
  entryId: string
  source: 'java' | 'local'
  dataUrl: string
  canonicalNickname?: string
  skinModel: VoxelSkinModel
  palmColor?: string
}

export interface PendingSkinLibraryMigration {
  source: 'java' | 'local'
  displayName: string
  canonicalNickname?: string
  originalFilename?: string
  modelPreference: VoxelSkinModelPreference
  dataUrl: string
}

export interface CatStore {
  model: {
    mirror: boolean
    mouseMirror: boolean
    motionSound: boolean
    behavior: boolean
    autoReleaseDelay: number
    maxFPS: number
    shadowsEnabled: boolean
    renderScalePercent: number
    idlePowerSavingEnabled: boolean
    shadowQuality: ShadowQuality
    antialiasEnabled: boolean
    pixelFilterEnabled: boolean
    eyebrowAnimationEnabled: boolean
    ignoreMouse: boolean
  }
  window: {
    visible: boolean
    passThrough: boolean
    alwaysOnTop: boolean
    scale: number
    opacity: number
    hideOnHover: boolean
    hideOnHoverDelay: number
    keepInScreen: boolean
  }
  scene: {
    rotationDegrees: number
  }
  customization3d: {
    schemaVersion: number
    selectedModelId: PetModelId
    dmeloperSkinDataUrl?: string
    minecraftSkinUsername?: string
    activeSkinLibraryEntryId?: string
    skinLibraryMigrationCompleted: boolean
    dmeloperSkinModel: VoxelSkinModelPreference
    useDefaultDmeloperSkin: boolean
    preset: Pet3dPreset
  }
}

const PRESET_SCHEMA_VERSION = 13
const MINECRAFT_USERNAME_PATTERN = /^\w{3,16}$/
const SKIN_LIBRARY_ENTRY_ID_PATTERN = /^[0-9a-f]{64}$/

const PET_3D_PRESET_KEYS = [
  ...DESK_SETTING_KEYS,
  ...DEVICE_COLOR_KEYS,
  'windowScalePercent',
  'showDisplayArea',
  'autoViewportEnabled',
  'autoViewportPaddingPixels',
  'viewportModeRevision',
  'manualViewportRect',
  'sceneRotationOffsetDegrees',
  'cameraHorizontalOffset',
  'cameraVerticalOffset',
  'cameraZoomPercent',
  'petRightArmBendPercent',
  'petRightArmSpreadDegrees',
  'petLeftArmBendPercent',
  'petLeftArmSpreadDegrees',
  'petHeadScalePercent',
  'petRotationDegrees',
  'petDeskOffset',
  'mouseEnabled',
  'mouseBaseXOffset',
  'mouseBaseZOffset',
  'mouseScalePercent',
  'keyboardBaseXOffset',
  'keyboardBaseZOffset',
  'keyboardScalePercent',
  'keyboardLegendLanguage',
  'dmeloperEyebrows',
  'dmeloperPalmColor',
] as const satisfies readonly (keyof Pet3dPreset)[]

export function createDefaultPet3dPreset(): Pet3dPreset {
  return {
    ...DEFAULT_PET_PRESET,
    manualViewportRect: { ...DEFAULT_PET_PRESET.manualViewportRect },
    dmeloperEyebrows: createDefaultDmeloperEyebrowPreset(),
  }
}

function migratePetArmPoseSettings(
  source: Partial<PetArmPoseSettings> & { petArmSpacingPercent?: number },
): PetArmPoseSettings {
  const legacyBend = typeof source.petArmSpacingPercent === 'number' && Number.isFinite(source.petArmSpacingPercent)
    ? Math.min(200, Math.max(0, source.petArmSpacingPercent))
    : undefined
  return normalizePetArmPoseSettings({
    ...source,
    petRightArmBendPercent: source.petRightArmBendPercent === undefined
      ? legacyBend
      : source.petRightArmBendPercent,
    petLeftArmBendPercent: source.petLeftArmBendPercent === undefined
      ? legacyBend
      : source.petLeftArmBendPercent,
  })
}

// Pinia deep-merges incoming state. Migrate before that merge can fill absent
// arm fields with defaults and hide the legacy values that should be inherited.
export function preparePetArmPoseStateForSync(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const customization = state.customization3d
  if (!customization || typeof customization !== 'object') return state
  const source = (customization as Record<string, unknown>).preset
  if (!source || typeof source !== 'object') return state
  if (
    !('petArmSpacingPercent' in source)
    && !Object.keys(DEFAULT_PET_ARM_POSE_SETTINGS).some(key => key in source)
  ) {
    return state
  }
  const preset: Record<string, unknown> = {
    ...source,
    ...migratePetArmPoseSettings(source),
  }
  delete preset.petArmSpacingPercent
  return {
    ...state,
    customization3d: { ...customization, preset },
  }
}

export function preparePetStateForSync(state: Record<string, unknown>): Record<string, unknown> {
  let next = preparePetArmPoseStateForSync(migrateLegacySkinAppearanceState(migratePetCharacterState(state)))
  if (next.model && typeof next.model === 'object' && !Array.isArray(next.model)) {
    const model = { ...next.model } as Record<string, unknown>
    if (!('pixelFilterEnabled' in model) && 'facePixelFilterEnabled' in model) {
      model.pixelFilterEnabled = model.facePixelFilterEnabled === true
    }
    delete model.facePixelFilterEnabled
    delete model.supersampling
    next = { ...next, model }
  }
  let customization = next.customization3d
  if (customization && typeof customization === 'object' && !Array.isArray(customization)
    && 'preset' in customization && customization.preset && typeof customization.preset === 'object'
    && !Array.isArray(customization.preset)) {
    customization = { ...customization, preset: {
      ...migrateDeskSettings(customization.preset),
      ...('dmeloperEyebrows' in customization.preset ? { dmeloperEyebrows: migrateDmeloperEyebrowDepth(customization.preset.dmeloperEyebrows) } : {}),
    } }
    next = { ...next, customization3d: customization }
  }
  if (customization && typeof customization === 'object'
    && 'activeSkinLibraryEntryId' in customization
    && customization.activeSkinLibraryEntryId === BUILTIN_DMELOPER_SKIN.id) {
    // JSON omits undefined fields, but Pinia merges nested objects. Explicitly
    // clear old user bytes/name while retaining a materialized bundled PNG.
    next = { ...next, customization3d: {
      ...customization,
      dmeloperSkinDataUrl: 'dmeloperSkinDataUrl' in customization ? customization.dmeloperSkinDataUrl : undefined,
      minecraftSkinUsername: undefined,
    } }
  } else if (customization && typeof customization === 'object'
    && 'dmeloperSkinDataUrl' in customization && !('activeSkinLibraryEntryId' in customization)) {
    // A legacy PNG without an identity must not inherit the store's built-in ID.
    next = { ...next, customization3d: { ...customization, activeSkinLibraryEntryId: undefined } }
  }
  return 'presetCollection' in next
    ? { ...next, presetCollection: migratePresetCollection(next.presetCollection) }
    : next
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

function restoreLegacyEyebrowColor(
  ...candidates: unknown[]
): DmeloperEyebrowPreset {
  const preset = createDefaultDmeloperEyebrowPreset()
  const customColor = candidates.find(isHexColor)
  if (customColor) preset.color = customColor
  return preset
}

function migrateDmeloperEyebrows(value: unknown): Partial<DmeloperEyebrowPreset> {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  const color = isHexColor(source.color)
    ? source.color
    : source.colorMode === 'custom' && isHexColor(source.customColor)
      ? source.customColor
      : undefined
  return {
    ...(source as Partial<DmeloperEyebrowPreset>),
    color,
  }
}

function sanitizeDmeloperEyebrows(value: unknown): DmeloperEyebrowPreset {
  const defaults = createDefaultDmeloperEyebrowPreset()
  const source = value && typeof value === 'object'
    ? value as Partial<DmeloperEyebrowPreset>
    : {}
  const clampNumber = (
    candidate: unknown,
    fallback: number,
    minimum: number,
    maximum: number,
  ) => typeof candidate === 'number' && Number.isFinite(candidate)
    ? Math.min(maximum, Math.max(minimum, candidate))
    : fallback

  return {
    enabled: source.enabled !== false,
    color: isHexColor(source.color) ? source.color : defaults.color,
    centerOffsetPixels: clampNumber(
      source.centerOffsetPixels,
      defaults.centerOffsetPixels,
      DMELOPER_EYEBROW_LIMITS.centerOffsetPixels.min,
      DMELOPER_EYEBROW_LIMITS.centerOffsetPixels.max,
    ),
    heightOffsetPixels: clampNumber(
      source.heightOffsetPixels,
      defaults.heightOffsetPixels,
      DMELOPER_EYEBROW_LIMITS.heightOffsetPixels.min,
      DMELOPER_EYEBROW_LIMITS.heightOffsetPixels.max,
    ),
    spacingPixels: clampNumber(
      source.spacingPixels,
      defaults.spacingPixels,
      DMELOPER_EYEBROW_LIMITS.spacingPixels.min,
      DMELOPER_EYEBROW_LIMITS.spacingPixels.max,
    ),
    widthPixels: clampNumber(
      source.widthPixels,
      defaults.widthPixels,
      DMELOPER_EYEBROW_LIMITS.widthPixels.min,
      DMELOPER_EYEBROW_LIMITS.widthPixels.max,
    ),
    depthPercent: clampNumber(
      source.depthPercent,
      defaults.depthPercent,
      DMELOPER_EYEBROW_LIMITS.depthPercent.min,
      DMELOPER_EYEBROW_LIMITS.depthPercent.max,
    ),
    thicknessPixels: clampNumber(
      source.thicknessPixels,
      defaults.thicknessPixels,
      DMELOPER_EYEBROW_LIMITS.thicknessPixels.min,
      DMELOPER_EYEBROW_LIMITS.thicknessPixels.max,
    ),
  }
}

function createDefault3dCustomization(): CatStore['customization3d'] {
  return {
    schemaVersion: PRESET_SCHEMA_VERSION,
    ...DEFAULT_SKIN_APPEARANCE,
    dmeloperSkinDataUrl: undefined,
    minecraftSkinUsername: undefined,
    activeSkinLibraryEntryId: BUILTIN_DMELOPER_SKIN.id,
    skinLibraryMigrationCompleted: false,
    preset: createDefaultPet3dPreset(),
  }
}

export const useCatStore = defineStore('cat', () => {
  /* ------------ 废弃字段（后续删除） ------------ */

  /** @deprecated 请使用 `model.mirror` */
  const mirrorMode = ref(DEFAULT_MODEL_SETTINGS.mirror)

  /** @deprecated 请使用 `model.mouseMirror` */
  const mouseMirror = ref(DEFAULT_MODEL_SETTINGS.mouseMirror)

  /** @deprecated 请使用 `window.passThrough` */
  const penetrable = ref(DEFAULT_WINDOW_SETTINGS.passThrough)

  /** @deprecated 请使用 `window.alwaysOnTop` */
  const alwaysOnTop = ref(DEFAULT_WINDOW_SETTINGS.alwaysOnTop)

  /** @deprecated 请使用 `window.scale` */
  const scale = ref(DEFAULT_WINDOW_SETTINGS.scale)

  /** @deprecated 请使用 `window.opacity` */
  const opacity = ref(DEFAULT_WINDOW_SETTINGS.opacity)

  /** @deprecated 用于标识数据是否已迁移，后续版本将删除 */
  const migrated = ref(false)

  const model = reactive<CatStore['model']>({ ...DEFAULT_MODEL_SETTINGS })

  // One control, preserving both persisted keys and previously disabled shadows.
  const shadowQualitySelection = computed<ShadowQualitySelection>({
    get: () => model.shadowsEnabled ? normalizeShadowQuality(model.shadowQuality) : 'off',
    set: (selection) => {
      if (selection === 'off') {
        model.shadowsEnabled = false
      } else {
        model.shadowQuality = normalizeShadowQuality(selection)
        model.shadowsEnabled = true
      }
    },
  })

  const window = reactive<CatStore['window']>({ ...DEFAULT_WINDOW_SETTINGS })

  const scene = reactive<CatStore['scene']>({
    rotationDegrees: MODEL_3D_CONFIG.scene.rotationDegrees,
  })

  const presetCollection = ref<PresetCollection>()
  // Read-only recovery data from retired per-skin settings, never applied.
  const legacyAppearanceArchive = ref<Record<string, unknown> | null>()

  const customization3d = reactive<CatStore['customization3d']>(
    createDefault3dCustomization(),
  )

  const migrateCustomization3dPresets = () => {
    if (customization3d.schemaVersion >= PRESET_SCHEMA_VERSION) return

    const legacy = customization3d as unknown as Record<string, unknown>
    const previousSchemaVersion = typeof legacy.schemaVersion === 'number'
      ? legacy.schemaVersion
      : 0
    if (previousSchemaVersion >= 6) {
      if (previousSchemaVersion === 7) {
        customization3d.activeSkinLibraryEntryId = undefined
        customization3d.skinLibraryMigrationCompleted = false
      }
      customization3d.schemaVersion = PRESET_SCHEMA_VERSION
      return
    }
    if (previousSchemaVersion === 5) {
      const existingPreset = legacy.preset && typeof legacy.preset === 'object'
        ? legacy.preset as Record<string, unknown>
        : {}
      existingPreset.dmeloperEyebrows = migrateDmeloperEyebrows(existingPreset.dmeloperEyebrows)
      customization3d.preset = existingPreset as unknown as Pet3dPreset
      customization3d.schemaVersion = PRESET_SCHEMA_VERSION
      return
    }
    if (previousSchemaVersion === 4) {
      const existingPreset = legacy.preset && typeof legacy.preset === 'object'
        ? legacy.preset as Record<string, unknown>
        : {}
      const existingEyebrows = existingPreset.dmeloperEyebrows
      if (!existingEyebrows || typeof existingEyebrows !== 'object') {
        existingPreset.dmeloperEyebrows = restoreLegacyEyebrowColor(
          existingPreset.eyebrowColor,
          legacy.eyebrowColor,
        )
      } else {
        existingPreset.dmeloperEyebrows = migrateDmeloperEyebrows(existingEyebrows)
      }
      delete existingPreset.eyebrowCenterX
      delete existingPreset.eyebrowSpacing
      delete existingPreset.eyebrowHeight
      delete existingPreset.eyebrowColor
      customization3d.preset = existingPreset as unknown as Pet3dPreset
      customization3d.schemaVersion = PRESET_SCHEMA_VERSION
      return
    }
    const selectedPetModelId = typeof legacy.selectedPetModelId === 'string'
      ? legacy.selectedPetModelId
      : undefined
    const storedPresets = legacy.presets
    let migratedPreset: Record<string, unknown> = {}

    if (storedPresets && typeof storedPresets === 'object' && selectedPetModelId) {
      const selectedPreset = (storedPresets as Record<string, unknown>)[selectedPetModelId]
      if (selectedPreset && typeof selectedPreset === 'object') {
        migratedPreset = { ...(selectedPreset as Record<string, unknown>) }
      }
    } else if (legacy.preset && typeof legacy.preset === 'object') {
      migratedPreset = { ...(legacy.preset as Record<string, unknown>) }
    }

    for (const key of PET_3D_PRESET_KEYS) {
      if (key in legacy) {
        migratedPreset[key] = legacy[key]
        delete legacy[key]
      }
    }

    migratedPreset.dmeloperEyebrows = restoreLegacyEyebrowColor(
      migratedPreset.eyebrowColor,
      legacy.eyebrowColor,
    )
    delete migratedPreset.eyebrowCenterX
    delete migratedPreset.eyebrowSpacing
    delete migratedPreset.eyebrowHeight
    delete migratedPreset.eyebrowColor
    delete legacy.eyebrowCenterX
    delete legacy.eyebrowSpacing
    delete legacy.eyebrowHeight
    delete legacy.eyebrowColor

    customization3d.selectedModelId = DEFAULT_PET_MODEL_ID
    customization3d.dmeloperSkinDataUrl = typeof legacy.dmeloperSkinDataUrl === 'string'
      && legacy.dmeloperSkinDataUrl.startsWith('data:image/png;base64,')
      ? legacy.dmeloperSkinDataUrl
      : undefined
    customization3d.minecraftSkinUsername = undefined
    customization3d.dmeloperSkinModel = 'auto'
    customization3d.useDefaultDmeloperSkin = legacy.useDefaultDmeloperSkin !== false
    customization3d.preset = migratedPreset as unknown as Pet3dPreset
    delete legacy.selectedPetModelId
    delete legacy.selectedInstallId
    delete legacy.selectedVariantId
    delete legacy.presets
    customization3d.schemaVersion = PRESET_SCHEMA_VERSION
  }

  const sanitizePet3dPreset = (
    candidate: Partial<Pet3dPreset> | undefined,
  ): Pet3dPreset => {
    const defaults = createDefaultPet3dPreset()
    const source = candidate ?? {}
    const clampNumber = (
      value: unknown,
      fallback: number,
      minimum: number,
      maximum: number,
    ) => typeof value === 'number' && Number.isFinite(value)
      ? Math.min(maximum, Math.max(minimum, value))
      : fallback

    const preset: Pet3dPreset = {
      ...defaults,
      ...normalizeDeviceColors(source),
      ...normalizeDeskSettings(source),
      mouseEnabled: source.mouseEnabled !== false,
      showDisplayArea: source.showDisplayArea === true,
      autoViewportEnabled: source.autoViewportEnabled !== false,
      autoViewportPaddingPixels: normalizeAutoViewportPadding(source.autoViewportPaddingPixels),
      viewportModeRevision: Number.isSafeInteger(source.viewportModeRevision) && source.viewportModeRevision! >= 0 ? source.viewportModeRevision! : 0,
      manualViewportRect: normalizeManualViewport(source.manualViewportRect),
      windowScalePercent: clampNumber(
        source.windowScalePercent,
        defaults.windowScalePercent,
        10,
        100,
      ),
      sceneRotationOffsetDegrees: clampNumber(
        source.sceneRotationOffsetDegrees,
        defaults.sceneRotationOffsetDegrees,
        -360,
        360,
      ),
      cameraHorizontalOffset: clampNumber(
        source.cameraHorizontalOffset,
        defaults.cameraHorizontalOffset,
        -1.5,
        1.5,
      ),
      cameraVerticalOffset: clampNumber(
        source.cameraVerticalOffset,
        defaults.cameraVerticalOffset,
        -1.5,
        1.5,
      ),
      cameraZoomPercent: clampNumber(
        source.cameraZoomPercent,
        defaults.cameraZoomPercent,
        25,
        200,
      ),
      ...migratePetArmPoseSettings(source),
      petHeadScalePercent: clampNumber(source.petHeadScalePercent, defaults.petHeadScalePercent, 25, 200),
      petRotationDegrees: clampNumber(
        source.petRotationDegrees,
        defaults.petRotationDegrees,
        -180,
        180,
      ),
      petDeskOffset: clampNumber(
        source.petDeskOffset,
        defaults.petDeskOffset,
        -1.5,
        1.5,
      ),
      mouseBaseXOffset: clampNumber(
        source.mouseBaseXOffset,
        defaults.mouseBaseXOffset,
        -1.5,
        1.5,
      ),
      mouseBaseZOffset: clampNumber(
        source.mouseBaseZOffset,
        defaults.mouseBaseZOffset,
        -1.5,
        1.5,
      ),
      mouseScalePercent: clampNumber(
        source.mouseScalePercent,
        defaults.mouseScalePercent,
        50,
        200,
      ),
      keyboardBaseXOffset: clampNumber(
        source.keyboardBaseXOffset,
        defaults.keyboardBaseXOffset,
        -1.5,
        1.5,
      ),
      keyboardBaseZOffset: clampNumber(
        source.keyboardBaseZOffset,
        defaults.keyboardBaseZOffset,
        -1.5,
        1.5,
      ),
      keyboardScalePercent: clampNumber(
        source.keyboardScalePercent,
        defaults.keyboardScalePercent,
        50,
        200,
      ),
      dmeloperEyebrows: createDefaultDmeloperEyebrowPreset(),
    }

    preset.keyboardLegendLanguage
      = source.keyboardLegendLanguage === 'en'
        ? 'en'
        : defaults.keyboardLegendLanguage

    preset.dmeloperEyebrows = sanitizeDmeloperEyebrows(source.dmeloperEyebrows)
    preset.dmeloperPalmColor = isHexColor(source.dmeloperPalmColor)
      ? source.dmeloperPalmColor
      : defaults.dmeloperPalmColor

    return preset
  }

  const sanitizeCustomization3d = () => {
    const migratedState = migrateLegacySkinAppearanceState({
      customization3d,
      presetCollection: presetCollection.value,
      legacyAppearanceArchive: legacyAppearanceArchive.value,
    })
    const nextCustomization = migratedState.customization3d as CatStore['customization3d']
    for (const key of Object.keys(customization3d)) {
      if (!(key in nextCustomization)) delete (customization3d as unknown as Record<string, unknown>)[key]
    }
    Object.assign(customization3d, nextCustomization)
    legacyAppearanceArchive.value = migratedState.legacyAppearanceArchive as Record<string, unknown> | null | undefined
    migrateCustomization3dPresets()

    customization3d.selectedModelId = DEFAULT_PET_MODEL_ID
    if (
      typeof customization3d.dmeloperSkinDataUrl !== 'string'
      || !customization3d.dmeloperSkinDataUrl.startsWith('data:image/png;base64,')
    ) {
      customization3d.dmeloperSkinDataUrl = undefined
    }
    if (
      !customization3d.dmeloperSkinDataUrl
      || typeof customization3d.minecraftSkinUsername !== 'string'
      || !MINECRAFT_USERNAME_PATTERN.test(customization3d.minecraftSkinUsername)
    ) {
      customization3d.minecraftSkinUsername = undefined
    }
    if (!customization3d.dmeloperSkinDataUrl) {
      customization3d.activeSkinLibraryEntryId = BUILTIN_DMELOPER_SKIN.id
    } else if (!isSkinSelectionId(customization3d.activeSkinLibraryEntryId)) {
      customization3d.activeSkinLibraryEntryId = undefined
    }
    customization3d.skinLibraryMigrationCompleted
      = customization3d.skinLibraryMigrationCompleted === true
    if (
      customization3d.dmeloperSkinModel !== 'wide'
      && customization3d.dmeloperSkinModel !== 'slim'
      && customization3d.dmeloperSkinModel !== 'auto'
    ) {
      customization3d.dmeloperSkinModel = 'wide'
    }
    customization3d.useDefaultDmeloperSkin = customization3d.useDefaultDmeloperSkin !== false

    customization3d.preset = sanitizePet3dPreset(customization3d.preset)
    customization3d.schemaVersion = PRESET_SCHEMA_VERSION
  }

  const activePet3dPreset = computed(
    () => customization3d.preset,
  )

  const selectPetModel = (modelId: PetModelId) => {
    markPresetUserEdit()
    customization3d.selectedModelId = getPetModelOption(modelId).id
  }

  const setDmeloperSkinDataUrl = (dataUrl?: string, libraryEntryId?: string) => {
    markPresetUserEdit()
    customization3d.dmeloperSkinDataUrl = dataUrl?.startsWith('data:image/png;base64,')
      ? dataUrl
      : undefined
    customization3d.minecraftSkinUsername = undefined
    customization3d.activeSkinLibraryEntryId
      = customization3d.dmeloperSkinDataUrl
        && libraryEntryId
        && SKIN_LIBRARY_ENTRY_ID_PATTERN.test(libraryEntryId)
        ? libraryEntryId
        : customization3d.dmeloperSkinDataUrl ? undefined : BUILTIN_DMELOPER_SKIN.id
    if (customization3d.activeSkinLibraryEntryId && SKIN_LIBRARY_ENTRY_ID_PATTERN.test(customization3d.activeSkinLibraryEntryId)) {
      customization3d.skinLibraryMigrationCompleted = true
    }
    customization3d.useDefaultDmeloperSkin = Boolean(customization3d.dmeloperSkinDataUrl)
  }

  const applyMinecraftSkin = (selection: MinecraftSkinSelection): boolean => {
    if (
      !selection.dataUrl.startsWith('data:image/png;base64,')
      || !MINECRAFT_USERNAME_PATTERN.test(selection.canonicalName)
      || (selection.skinModel !== 'wide' && selection.skinModel !== 'slim')
      || (selection.palmColor !== undefined && !isHexColor(selection.palmColor))
      || (
        selection.libraryEntryId !== undefined
        && !SKIN_LIBRARY_ENTRY_ID_PATTERN.test(selection.libraryEntryId)
      )
    ) {
      return false
    }

    markPresetUserEdit()
    customization3d.dmeloperSkinDataUrl = selection.dataUrl
    customization3d.minecraftSkinUsername = selection.canonicalName
    customization3d.activeSkinLibraryEntryId = selection.libraryEntryId
      && SKIN_LIBRARY_ENTRY_ID_PATTERN.test(selection.libraryEntryId)
      ? selection.libraryEntryId
      : undefined
    if (customization3d.activeSkinLibraryEntryId) {
      customization3d.skinLibraryMigrationCompleted = true
    }
    customization3d.dmeloperSkinModel = selection.skinModel
    customization3d.useDefaultDmeloperSkin = true
    if (selection.palmColor !== undefined) customization3d.preset.dmeloperPalmColor = selection.palmColor
    return true
  }

  const resetDmeloperSkinToDefault = (palmColor?: string) => {
    if (palmColor !== undefined && !isHexColor(palmColor)) return
    markPresetUserEdit()
    if (palmColor !== undefined) customization3d.preset.dmeloperPalmColor = palmColor
    customization3d.dmeloperSkinDataUrl = undefined
    customization3d.minecraftSkinUsername = undefined
    customization3d.activeSkinLibraryEntryId = BUILTIN_DMELOPER_SKIN.id
    customization3d.dmeloperSkinModel = 'wide'
    customization3d.useDefaultDmeloperSkin = true
  }

  const setDmeloperSkinModel = (skinModel: VoxelSkinModel) => {
    customization3d.dmeloperSkinModel = skinModel
  }

  const updateDmeloperPalmColor = (color: string) => {
    if (!isHexColor(color)) return
    markPresetUserEdit()
    customization3d.preset.dmeloperPalmColor = color
  }

  const updateDmeloperEyebrows = (changes: Partial<DmeloperEyebrowPreset>) => {
    markPresetUserEdit()
    const eyebrows = sanitizeDmeloperEyebrows({
      ...customization3d.preset.dmeloperEyebrows,
      ...changes,
    })
    customization3d.preset.dmeloperEyebrows = eyebrows
  }

  const updateActivePet3dPreset = (changes: Partial<Pet3dPreset>) => {
    Object.assign(activePet3dPreset.value, changes)
  }

  const resetActivePet3dPreset = () => {
    customization3d.preset = createDefaultPet3dPreset()
  }

  const resetDmeloperEyebrows = () => {
    markPresetUserEdit()
    model.eyebrowAnimationEnabled = DEFAULT_MODEL_SETTINGS.eyebrowAnimationEnabled
    customization3d.preset.dmeloperEyebrows = createDefaultDmeloperEyebrowPreset()
  }

  const resetDmeloperPalmColor = (color: string = DEFAULT_PET_PRESET.dmeloperPalmColor) => {
    updateDmeloperPalmColor(color)
  }

  const resetPetBehavior = () => {
    markPresetUserEdit()
    const defaults = createDefaultPet3dPreset()
    Object.assign(customization3d.preset, {
      petRightArmBendPercent: defaults.petRightArmBendPercent,
      petRightArmSpreadDegrees: defaults.petRightArmSpreadDegrees,
      petLeftArmBendPercent: defaults.petLeftArmBendPercent,
      petLeftArmSpreadDegrees: defaults.petLeftArmSpreadDegrees,
      petHeadScalePercent: defaults.petHeadScalePercent,
      petRotationDegrees: defaults.petRotationDegrees,
      petDeskOffset: defaults.petDeskOffset,
    })
  }

  const resetDesk3d = () => {
    markPresetUserEdit()
    Object.assign(customization3d.preset, DEFAULT_DESK_SETTINGS)
  }

  const resetKeyboard3d = () => {
    markPresetUserEdit()
    const defaults = createDefaultPet3dPreset()
    Object.assign(customization3d.preset, {
      keyboardColor: defaults.keyboardColor,
      keyboardKeycapColor: defaults.keyboardKeycapColor,
      keyboardLegendColor: defaults.keyboardLegendColor,
      keyboardPressedColor: defaults.keyboardPressedColor,
      keyboardBaseXOffset: defaults.keyboardBaseXOffset,
      keyboardBaseZOffset: defaults.keyboardBaseZOffset,
      keyboardScalePercent: defaults.keyboardScalePercent,
      keyboardLegendLanguage: defaults.keyboardLegendLanguage,
    })
  }

  const resetMouse3d = () => {
    markPresetUserEdit()
    const defaults = createDefaultPet3dPreset()
    Object.assign(customization3d.preset, {
      mouseEnabled: defaults.mouseEnabled,
      mouseColor: defaults.mouseColor,
      mousePressedColor: defaults.mousePressedColor,
      mouseBaseXOffset: defaults.mouseBaseXOffset,
      mouseBaseZOffset: defaults.mouseBaseZOffset,
      mouseScalePercent: defaults.mouseScalePercent,
    })
  }

  const resetEnvironment3d = () => {
    resetDesk3d()
    resetKeyboard3d()
    resetMouse3d()
  }

  const resetScene3d = () => {
    markPresetUserEdit()
    const defaults = createDefaultPet3dPreset()
    Object.assign(customization3d.preset, {
      windowScalePercent: defaults.windowScalePercent,
      showDisplayArea: defaults.showDisplayArea,
      viewportModeRevision: customization3d.preset.viewportModeRevision + 1,
      autoViewportEnabled: defaults.autoViewportEnabled,
      autoViewportPaddingPixels: defaults.autoViewportPaddingPixels,
      manualViewportRect: { ...defaults.manualViewportRect },
      sceneRotationOffsetDegrees: defaults.sceneRotationOffsetDegrees,
      cameraHorizontalOffset: defaults.cameraHorizontalOffset,
      cameraVerticalOffset: defaults.cameraVerticalOffset,
      cameraZoomPercent: defaults.cameraZoomPercent,
    })
    model.mirror = DEFAULT_MODEL_SETTINGS.mirror
    window.opacity = DEFAULT_WINDOW_SETTINGS.opacity
  }

  const setActiveSkinLibraryEntryId = (entryId?: string): boolean => {
    if (entryId !== undefined && !isSkinSelectionId(entryId)) {
      return false
    }
    customization3d.activeSkinLibraryEntryId = entryId
    return true
  }

  const applySkinLibraryEntry = (selection: SkinLibrarySelection): boolean => {
    const valid = SKIN_LIBRARY_ENTRY_ID_PATTERN.test(selection.entryId)
      && (selection.source === 'java' || selection.source === 'local')
      && selection.dataUrl.startsWith('data:image/png;base64,')
      && (selection.skinModel === 'wide' || selection.skinModel === 'slim')
      && (selection.palmColor === undefined || isHexColor(selection.palmColor))
      && (
        selection.source === 'local'
          ? selection.canonicalNickname === undefined
          : typeof selection.canonicalNickname === 'string'
            && MINECRAFT_USERNAME_PATTERN.test(selection.canonicalNickname)
      )
    if (!valid) return false

    markPresetUserEdit()
    customization3d.dmeloperSkinDataUrl = selection.dataUrl
    customization3d.minecraftSkinUsername = selection.source === 'java'
      ? selection.canonicalNickname
      : undefined
    customization3d.activeSkinLibraryEntryId = selection.entryId
    customization3d.skinLibraryMigrationCompleted = true
    customization3d.dmeloperSkinModel = selection.skinModel
    customization3d.useDefaultDmeloperSkin = true
    if (selection.palmColor !== undefined) customization3d.preset.dmeloperPalmColor = selection.palmColor
    return true
  }

  const handleSkinLibraryEntriesDeleted = (entryIds: readonly string[], defaultPalmColor?: string) => {
    // Reset the live selection; saved preset snapshots retain their own PNG bytes.
    if (
      customization3d.activeSkinLibraryEntryId
      && entryIds.includes(customization3d.activeSkinLibraryEntryId)
    ) {
      resetDmeloperSkinToDefault(defaultPalmColor)
    }
  }

  const getPendingSkinLibraryMigration = (
  ): PendingSkinLibraryMigration | undefined => {
    if (
      customization3d.skinLibraryMigrationCompleted
      || customization3d.activeSkinLibraryEntryId === BUILTIN_DMELOPER_SKIN.id
      || !customization3d.dmeloperSkinDataUrl
    ) {
      return undefined
    }
    const canonicalNickname = customization3d.minecraftSkinUsername
    if (canonicalNickname && MINECRAFT_USERNAME_PATTERN.test(canonicalNickname)) {
      return {
        source: 'java',
        displayName: canonicalNickname,
        canonicalNickname,
        modelPreference: customization3d.dmeloperSkinModel,
        dataUrl: customization3d.dmeloperSkinDataUrl,
      }
    }
    return {
      source: 'local',
      displayName: '기존 스킨',
      originalFilename: '기존 스킨.png',
      modelPreference: customization3d.dmeloperSkinModel,
      dataUrl: customization3d.dmeloperSkinDataUrl,
    }
  }

  const completeSkinLibraryMigration = (
    entryId?: string,
    expectedDataUrl?: string,
  ): boolean => {
    if (entryId !== undefined && !SKIN_LIBRARY_ENTRY_ID_PATTERN.test(entryId)) {
      return false
    }
    if (
      expectedDataUrl !== undefined
      && customization3d.dmeloperSkinDataUrl !== expectedDataUrl
    ) {
      return false
    }
    customization3d.skinLibraryMigrationCompleted = true
    if (entryId) {
      customization3d.activeSkinLibraryEntryId = entryId
    }
    return true
  }

  const resetGeneralSettings = () => {
    Object.assign(window, {
      visible: DEFAULT_WINDOW_SETTINGS.visible,
      passThrough: DEFAULT_WINDOW_SETTINGS.passThrough,
      alwaysOnTop: DEFAULT_WINDOW_SETTINGS.alwaysOnTop,
      hideOnHover: DEFAULT_WINDOW_SETTINGS.hideOnHover,
      hideOnHoverDelay: DEFAULT_WINDOW_SETTINGS.hideOnHoverDelay,
      keepInScreen: DEFAULT_WINDOW_SETTINGS.keepInScreen,
    })
  }

  const resetPerformanceSettings = () => {
    Object.assign(model, DEFAULT_PERFORMANCE_SETTINGS)
  }

  const resetAllSettings = () => {
    mirrorMode.value = DEFAULT_MODEL_SETTINGS.mirror
    mouseMirror.value = DEFAULT_MODEL_SETTINGS.mouseMirror
    penetrable.value = DEFAULT_WINDOW_SETTINGS.passThrough
    alwaysOnTop.value = DEFAULT_WINDOW_SETTINGS.alwaysOnTop
    scale.value = DEFAULT_WINDOW_SETTINGS.scale
    opacity.value = DEFAULT_WINDOW_SETTINGS.opacity
    Object.assign(model, DEFAULT_MODEL_SETTINGS)
    delete (model as CatStore['model'] & { memorySavingMode?: unknown }).memorySavingMode
    Object.assign(window, DEFAULT_WINDOW_SETTINGS)
    Object.assign(scene, { rotationDegrees: MODEL_3D_CONFIG.scene.rotationDegrees })
    Object.assign(customization3d, createDefault3dCustomization())
    presetCollection.value = createPresetCollection()
    // Backend patches replace present top-level keys; undefined would retain old data.
    legacyAppearanceArchive.value = null
    migrated.value = true
  }

  const resetCustomization3d = resetActivePet3dPreset

  const init = () => {
    sanitizeCustomization3d()
    presetCollection.value = migratePresetCollection(presetCollection.value) as PresetCollection | undefined

    model.maxFPS = model.maxFPS === 0
      ? MAX_FPS
      : Number.isFinite(model.maxFPS)
        ? Math.min(MAX_FPS, Math.max(20, model.maxFPS))
        : DEFAULT_PERFORMANCE_SETTINGS.maxFPS
    model.shadowsEnabled = model.shadowsEnabled !== false
    model.renderScalePercent = Number.isFinite(model.renderScalePercent)
      ? Math.min(100, Math.max(50, model.renderScalePercent))
      : 100
    model.idlePowerSavingEnabled = typeof model.idlePowerSavingEnabled === 'boolean' ? model.idlePowerSavingEnabled : DEFAULT_PERFORMANCE_SETTINGS.idlePowerSavingEnabled
    model.shadowQuality = normalizeShadowQuality(model.shadowQuality)
    model.eyebrowAnimationEnabled = model.eyebrowAnimationEnabled !== false
    model.antialiasEnabled = model.antialiasEnabled !== false
    model.pixelFilterEnabled = typeof model.pixelFilterEnabled === 'boolean' ? model.pixelFilterEnabled : DEFAULT_PERFORMANCE_SETTINGS.pixelFilterEnabled
    delete (model as unknown as Record<string, unknown>).facePixelFilterEnabled
    delete (model as unknown as Record<string, unknown>).supersampling
    delete (model as CatStore['model'] & { memorySavingMode?: unknown }).memorySavingMode
    delete (window as CatStore['window'] & { radius?: unknown }).radius

    if (migrated.value) return

    model.mirror = mirrorMode.value
    model.mouseMirror = mouseMirror.value

    window.visible = DEFAULT_WINDOW_SETTINGS.visible
    window.passThrough = penetrable.value
    window.alwaysOnTop = alwaysOnTop.value
    window.scale = scale.value
    window.opacity = opacity.value
    if (
      customization3d.preset.windowScalePercent === 100
      && Number.isFinite(scale.value)
    ) {
      customization3d.preset.windowScalePercent = Math.min(
        100,
        Math.max(10, scale.value),
      )
    }

    migrated.value = true
  }

  return {
    migrated,
    model,
    shadowQualitySelection,
    window,
    scene,
    customization3d,
    presetCollection,
    legacyAppearanceArchive,
    activePet3dPreset,
    selectPetModel,
    setDmeloperSkinDataUrl,
    applyMinecraftSkin,
    resetDmeloperSkinToDefault,
    setDmeloperSkinModel,
    updateDmeloperPalmColor,
    updateDmeloperEyebrows,
    setActiveSkinLibraryEntryId,
    applySkinLibraryEntry,
    handleSkinLibraryEntriesDeleted,
    getPendingSkinLibraryMigration,
    completeSkinLibraryMigration,
    updateActivePet3dPreset,
    resetActivePet3dPreset,
    resetDmeloperEyebrows,
    resetDmeloperPalmColor,
    resetPetBehavior,
    resetDesk3d,
    resetKeyboard3d,
    resetMouse3d,
    resetEnvironment3d,
    resetScene3d,
    resetGeneralSettings,
    resetPerformanceSettings,
    resetAllSettings,
    resetCustomization3d,
    sanitizeCustomization3d,
    init,
  }
}, {
  tauri: {
    // The preference preset owner saves only settled snapshots (300ms debounce).
    saveOnChange: false,
    hooks: {
      beforeFrontendSync: preparePetStateForSync,
    },
  },
})
