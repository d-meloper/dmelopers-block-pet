import type { ResolvedKeyboardLanguage } from '@/config/keyboardLanguage'
import type { Pet3dPreset } from '@/stores/block'
import type { Three3DRenderer } from '@/utils/three3d'

import { resolveKeyboardLanguage } from '@/config/keyboardLanguage'
import { MODEL_3D_CONFIG } from '@/config/model3d'
import { normalizePetMotionSettings } from '@/config/petMotion'

/** Shared by the desktop renderer and isolated, input-free thumbnail renderer. */
export function applyPresetVisualSettings(renderer: Three3DRenderer, preset: Pet3dPreset, mouseEnabled = preset.mouseEnabled, systemLanguage?: ResolvedKeyboardLanguage): void {
  renderer.setLightingSettings(preset.lighting)
  renderer.setAutoViewportPadding(preset.autoViewportPaddingPixels)
  renderer.setDeskSettings(preset)
  renderer.setMouseEnabled(mouseEnabled)
  renderer.setSceneRotation(MODEL_3D_CONFIG.scene.rotationDegrees + preset.sceneRotationOffsetDegrees)
  renderer.setPetTransform(preset.petRotationDegrees, preset.petDeskOffset)
  renderer.setPetHeadScalePercent(preset.petHeadScalePercent ?? 100)
  renderer.setPetArmPoseSettings(preset)
  renderer.setAnimationMode(preset.petAnimationMode ?? 'default')
  const motion = normalizePetMotionSettings(preset)
  renderer.setHeadbuttMaxRadiusOffset(motion.petHeadbuttMaxRadiusOffset)
  renderer.setHeadbuttRecoilSettings(motion)
  renderer.setTypingMotionSettings(motion)
  renderer.setShoulderTorsoConnected(preset.petShoulderTorsoConnected === true)
  renderer.setPetArmsDisabled(preset.petRightArmDisabled === true, preset.petLeftArmDisabled === true)
  renderer.setMouseBasePosition(preset.mouseBaseXOffset, preset.mouseBaseZOffset)
  renderer.setMouseScalePercent(preset.mouseScalePercent)
  renderer.setKeyboardBasePosition(preset.keyboardBaseXOffset, preset.keyboardBaseZOffset)
  renderer.setKeyboardScalePercent(preset.keyboardScalePercent)
  renderer.setDeviceColors(preset)
  renderer.setCameraPan(preset.autoViewportEnabled ? 0 : -preset.cameraHorizontalOffset, preset.autoViewportEnabled ? 0 : -preset.cameraVerticalOffset)
  renderer.setCameraDistance(MODEL_3D_CONFIG.camera.distancePercent * 100 / preset.cameraZoomPercent)
  renderer.setKeyboardLegendLanguage(resolveKeyboardLanguage(preset.keyboardLegendLanguage, systemLanguage))
  renderer.setDmeloperEyebrows(preset.dmeloperEyebrows)
  renderer.setDmeloperPalmColor(preset.dmeloperPalmColor)
}
