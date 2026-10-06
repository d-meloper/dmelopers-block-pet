import { BUILTIN_DMELOPER_SKIN } from '@/config/skinIdentity'

import type { PresetListEntry, PresetSnapshot } from './types'

import { clonePreset } from './model'

// Authored scenes are independent of changing program defaults. Shared PNG bytes
// are resolved from the bundled skin asset only when rendered, applied or copied.
const DEFAULT_SCENE: PresetSnapshot = {
  appearance: {
    activeSkinLibraryEntryId: BUILTIN_DMELOPER_SKIN.id,
    dmeloperSkinModel: 'wide',
    selectedModelId: 'dmeloper',
    useDefaultDmeloperSkin: true,
  },
  eyebrowAnimationEnabled: true,
  mirror: false,
  opacity: 100,
  preset: {
    autoViewportEnabled: true,
    autoViewportPaddingPixels: 2,
    cameraHorizontalOffset: 0,
    cameraVerticalOffset: 0,
    cameraZoomPercent: 100,
    deskColor: '#D9D9D9',
    deskDepthOffset: 0.1,
    deskHeightOffset: 0,
    deskTransparent: true,
    deskWidthOffset: -0.28,
    dmeloperEyebrows: {
      centerOffsetPixels: 0,
      color: '#523830',
      depthPercent: 50,
      enabled: true,
      heightOffsetPixels: 0.3,
      spacingPixels: 1.5,
      thicknessPixels: 0.5,
      widthPixels: 2,
    },
    dmeloperPalmColor: '#FFDFCE',
    keyboardBaseXOffset: 0,
    keyboardBaseZOffset: 0,
    keyboardColor: '#d5d8dc',
    keyboardKeycapColor: '#f7f3e8',
    keyboardLegendColor: '#31343a',
    keyboardLegendLanguage: 'ko',
    keyboardPressedColor: '#f2b36d',
    keyboardScalePercent: 100,
    lighting: { key: { azimuthDegrees: -39, color: '#ffffff', elevationDegrees: 44, strengthPercent: 100 } },
    manualViewportRect: { height: 422, width: 500, x: 0, y: 0 },
    mouseBaseXOffset: 0,
    mouseBaseZOffset: 0,
    mouseColor: '#ffffff',
    mouseEnabled: true,
    mousePressedColor: '#f2b36d',
    mouseScalePercent: 100,
    petDeskOffset: 0,
    petHeadScalePercent: 100,
    petLeftArmBendPercent: 100,
    petLeftArmSpreadDegrees: 0,
    petRightArmBendPercent: 100,
    petRightArmSpreadDegrees: 0,
    petRotationDegrees: 0,
    sceneRotationOffsetDegrees: 0,
    showDisplayArea: false,
  },
}

const SCENES: ReadonlyArray<{ key: string, preset?: Partial<PresetSnapshot['preset']> }> = [
  { key: 'default' },
  { key: 'sunset', preset: { lighting: { key: { azimuthDegrees: 90.20999999999998, color: '#FFA600', elevationDegrees: 49.06, strengthPercent: 169 } } } },
  { key: 'front', preset: {
    keyboardBaseXOffset: -0.264,
    mouseBaseXOffset: -0.426,
    mouseBaseZOffset: -0.27,
    petLeftArmBendPercent: 26,
    petLeftArmSpreadDegrees: 14.850000000000001,
    petRotationDegrees: -16.8,
    sceneRotationOffsetDegrees: 21.599999999999998,
  } },
  { key: 'bigHeadKeyboard', preset: {
    keyboardBaseXOffset: -0.296,
    keyboardScalePercent: 152,
    mouseEnabled: false,
    petHeadScalePercent: 150,
  } },
]

export function builtinPresets(t: (key: string) => string): PresetListEntry[] {
  return SCENES.map(({ key, preset }) => ({
    id: `builtin:preset:${key}`,
    name: t(`pages.preference.presets.builtinNames.${key}`),
    favorite: false,
    origin: 'builtin',
    snapshot: clonePreset({ ...DEFAULT_SCENE, preset: { ...DEFAULT_SCENE.preset, ...preset } }),
  }))
}
