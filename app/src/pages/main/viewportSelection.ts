import type { Pet3dPresetSelectionPayload } from '@/stores/cat'

import { normalizeAutoViewportPadding } from '@/features/scene/viewportSettings'
import { getResolvedDmeloperSkinUrl } from '@/services/dmeloperSkin'

export interface VisibleBoundsSelectionSignature {
  modelId: Pet3dPresetSelectionPayload['modelId']
  dmeloperSkinDataUrl?: string
  dmeloperSkinModel?: Pet3dPresetSelectionPayload['dmeloperSkinModel']
  useDefaultDmeloperSkin?: boolean
  sceneRotationOffsetDegrees: number
  cameraHorizontalOffset: number
  cameraVerticalOffset: number
  cameraZoomPercent: number
  autoViewportEnabled: boolean
  autoViewportPaddingPixels: number
  petHeadScalePercent: number
  petRotationDegrees: number
  petDeskOffset: number
  deskHeightOffset: number
  petRightArmBendPercent: number
  petRightArmSpreadDegrees: number
  petLeftArmBendPercent: number
  petLeftArmSpreadDegrees: number
  mouseEnabled: boolean
  mouseBaseXOffset: number
  mouseBaseZOffset: number
  mouseScalePercent: number
  keyboardBaseXOffset: number
  keyboardBaseZOffset: number
  keyboardScalePercent: number
  eyebrowEnabled?: boolean
  eyebrowCenterOffsetPixels?: number
  eyebrowHeightOffsetPixels?: number
  eyebrowSpacingPixels?: number
  eyebrowWidthPixels?: number
  eyebrowThicknessPixels?: number
  eyebrowDepthPercent?: number
}

export function createVisibleBoundsSelectionSignature(
  selection: Pet3dPresetSelectionPayload,
): VisibleBoundsSelectionSignature {
  const { preset } = selection
  const { dmeloperEyebrows } = preset
  const usesEyebrowGeometry = dmeloperEyebrows.enabled
  const skinUrl = getResolvedDmeloperSkinUrl(selection.dmeloperSkinDataUrl)

  return {
    modelId: selection.modelId,
    dmeloperSkinDataUrl: skinUrl,
    dmeloperSkinModel: selection.dmeloperSkinModel,
    useDefaultDmeloperSkin: !skinUrl
      ? selection.useDefaultDmeloperSkin
      : undefined,
    sceneRotationOffsetDegrees: preset.sceneRotationOffsetDegrees,
    autoViewportEnabled: preset.autoViewportEnabled,
    autoViewportPaddingPixels: preset.autoViewportEnabled ? normalizeAutoViewportPadding(preset.autoViewportPaddingPixels) : 0,
    cameraHorizontalOffset: preset.autoViewportEnabled ? 0 : preset.cameraHorizontalOffset,
    cameraVerticalOffset: preset.autoViewportEnabled ? 0 : preset.cameraVerticalOffset,
    cameraZoomPercent: preset.cameraZoomPercent,
    petHeadScalePercent: preset.petHeadScalePercent,
    petRotationDegrees: preset.petRotationDegrees,
    petDeskOffset: preset.petDeskOffset,
    deskHeightOffset: preset.deskHeightOffset ?? 0,
    petRightArmBendPercent: preset.petRightArmBendPercent,
    petRightArmSpreadDegrees: preset.petRightArmSpreadDegrees,
    petLeftArmBendPercent: preset.petLeftArmBendPercent,
    petLeftArmSpreadDegrees: preset.petLeftArmSpreadDegrees,
    mouseEnabled: preset.mouseEnabled,
    mouseBaseXOffset: preset.mouseBaseXOffset,
    mouseBaseZOffset: preset.mouseBaseZOffset,
    mouseScalePercent: preset.mouseScalePercent,
    keyboardBaseXOffset: preset.keyboardBaseXOffset,
    keyboardBaseZOffset: preset.keyboardBaseZOffset,
    keyboardScalePercent: preset.keyboardScalePercent,
    eyebrowEnabled: dmeloperEyebrows.enabled,
    eyebrowCenterOffsetPixels: usesEyebrowGeometry
      ? dmeloperEyebrows.centerOffsetPixels
      : undefined,
    eyebrowHeightOffsetPixels: usesEyebrowGeometry
      ? dmeloperEyebrows.heightOffsetPixels
      : undefined,
    eyebrowSpacingPixels: usesEyebrowGeometry
      ? dmeloperEyebrows.spacingPixels
      : undefined,
    eyebrowWidthPixels: usesEyebrowGeometry
      ? dmeloperEyebrows.widthPixels
      : undefined,
    eyebrowThicknessPixels: usesEyebrowGeometry
      ? dmeloperEyebrows.thicknessPixels
      : undefined,
    eyebrowDepthPercent: usesEyebrowGeometry
      ? dmeloperEyebrows.depthPercent
      : undefined,
  }
}

export function visibleBoundsSelectionChanged(
  previous: VisibleBoundsSelectionSignature | undefined,
  current: VisibleBoundsSelectionSignature,
): boolean {
  if (!previous) return true

  return Object.keys(current).some((key) => {
    const property = key as keyof VisibleBoundsSelectionSignature
    return previous[property] !== current[property]
  })
}

/** Padding changes reuse measured content; geometry/appearance changes must rescan. */
export function visibleBoundsCompositionChanged(
  previous: VisibleBoundsSelectionSignature | undefined,
  current: VisibleBoundsSelectionSignature,
): boolean {
  return visibleBoundsSelectionChanged(previous && { ...previous, autoViewportPaddingPixels: current.autoViewportPaddingPixels }, current)
}

export function requiresVisibleBoundsRefresh(
  applied: VisibleBoundsSelectionSignature | undefined,
  current: VisibleBoundsSelectionSignature,
  refreshPending: boolean,
): boolean {
  return refreshPending || visibleBoundsSelectionChanged(applied, current)
}
