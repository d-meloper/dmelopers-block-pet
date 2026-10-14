import { MathUtils } from 'three'

import { MODEL_3D_CONFIG } from '@/config/model3d'

/** No extra headroom in the forward half; ramp smoothly toward the rear. */
export function getHeadbuttRearViewWeight(sceneRotationDegrees: number, petRotationDegrees: number): number {
  const facing = MathUtils.degToRad(sceneRotationDegrees + petRotationDegrees + MODEL_3D_CONFIG.pet.rotationYDegrees)
  const rearDegrees = MathUtils.radToDeg(Math.acos(MathUtils.clamp(Math.cos(facing), -1, 1)))
  return MathUtils.smoothstep(rearDegrees, MODEL_3D_CONFIG.pet.animation.headbuttViewport.rearStartDegrees, 180)
}
