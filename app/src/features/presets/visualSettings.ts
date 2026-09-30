import type { Pet3dPreset } from '@/stores/cat'
import type { Three3DRenderer } from '@/utils/three3d'

import { MODEL_3D_CONFIG } from '@/config/model3d'

/** Shared by the desktop renderer and isolated, input-free thumbnail renderer. */
export function applyPresetVisualSettings(renderer: Three3DRenderer, preset: Pet3dPreset, mouseEnabled = preset.mouseEnabled): void {
  renderer.setLightingSettings(preset.lighting)
  renderer.setAutoViewportPadding(preset.autoViewportPaddingPixels)
  renderer.setDeskSettings(preset)
  renderer.setMouseEnabled(mouseEnabled)
  renderer.setSceneRotation(MODEL_3D_CONFIG.scene.rotationDegrees + preset.sceneRotationOffsetDegrees)
  renderer.setPetTransform(preset.petRotationDegrees, preset.petDeskOffset)
  renderer.setPetHeadScalePercent(preset.petHeadScalePercent ?? 100)
  renderer.setPetArmPoseSettings(preset)
  renderer.setMouseBasePosition(preset.mouseBaseXOffset, preset.mouseBaseZOffset)
  renderer.setMouseScalePercent(preset.mouseScalePercent)
  renderer.setKeyboardBasePosition(preset.keyboardBaseXOffset, preset.keyboardBaseZOffset)
  renderer.setKeyboardScalePercent(preset.keyboardScalePercent)
  renderer.setDeviceColors(preset)
  renderer.setCameraPan(preset.autoViewportEnabled ? 0 : -preset.cameraHorizontalOffset, preset.autoViewportEnabled ? 0 : -preset.cameraVerticalOffset)
  renderer.setCameraDistance(MODEL_3D_CONFIG.camera.distancePercent * 100 / preset.cameraZoomPercent)
  renderer.setKeyboardLegendLanguage(preset.keyboardLegendLanguage)
  renderer.setDmeloperEyebrows(preset.dmeloperEyebrows)
  renderer.setDmeloperPalmColor(preset.dmeloperPalmColor)
}
