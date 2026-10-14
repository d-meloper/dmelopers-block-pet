import type { Object3D } from 'three'

import { MathUtils, Quaternion, Vector3 } from 'three'

import { MODEL_3D_CONFIG } from '@/config/model3d'

import { updateStretchCompensatedBoneMatrix } from './boneMatrix'

interface SpineRestPose {
  object: Object3D
  basePosition: Vector3
  baseQuaternion: Quaternion
  baseScale: Vector3
}

interface LegNode {
  side: 'left' | 'right'
  object: Object3D
  basePosition: Vector3
  baseQuaternion: Quaternion
  baseScale: Vector3
  baseMatrixAutoUpdate: boolean
  shin: Object3D
  shinBasePosition: Vector3
  shinBaseQuaternion: Quaternion
  shinBaseScale: Vector3
  shinBaseMatrixAutoUpdate: boolean
  stanceInRoot: Vector3
  length: number
}

/** Actual leg bones share the skinned hip band with the moving torso. */
export function createLegLift(root: Object3D, spine: SpineRestPose) {
  const rootBone = root.getObjectByName('Root')
  const legs: LegNode[] = []
  for (const [side, name, shinName, footName] of [['left', 'L_Leg', 'L_Shin', 'L_Foot'], ['right', 'R_Leg', 'R_Shin', 'R_Foot']] as const) {
    const object = root.getObjectByName(name)
    const shin = root.getObjectByName(shinName)
    const foot = root.getObjectByName(footName)
    // Older fixed fixtures remain usable without the additive leg rig.
    if (!rootBone || !object || !shin || !foot || object.parent !== spine.object || shin.parent !== object || foot.parent !== shin) continue
    const basePosition = object.position.clone()
    const baseQuaternion = object.quaternion.clone()
    const baseScale = object.scale.clone()
    const shinBasePosition = shin.position.clone()
    const shinBaseQuaternion = shin.quaternion.clone()
    const shinBaseScale = shin.scale.clone()
    const stanceInRoot = foot.position.clone().multiply(shinBaseScale).applyQuaternion(shinBaseQuaternion).add(shinBasePosition).multiply(baseScale).applyQuaternion(baseQuaternion).add(basePosition).multiply(spine.baseScale).applyQuaternion(spine.baseQuaternion).add(spine.basePosition)
    const length = object.getWorldPosition(new Vector3()).distanceTo(foot.getWorldPosition(new Vector3()))
    legs.push({
      side,
      object,
      basePosition,
      baseQuaternion,
      baseScale,
      stanceInRoot,
      length,
      baseMatrixAutoUpdate: object.matrixAutoUpdate,
      shin,
      shinBasePosition,
      shinBaseQuaternion,
      shinBaseScale,
      shinBaseMatrixAutoUpdate: shin.matrixAutoUpdate,
    })
  }
  const up = new Vector3(0, 1, 0)
  const localKneeAxis = new Vector3(1, 0, 0)
  const hip = new Vector3()
  const stance = new Vector3()
  const direction = new Vector3()
  const restDirection = new Vector3()
  const backLiftAxis = new Vector3()
  const rootQuaternion = new Quaternion()
  const parentInverseQuaternion = new Quaternion()
  const facingQuaternion = new Quaternion()
  const yawQuaternion = new Quaternion()
  const restWorldQuaternion = new Quaternion()
  const targetQuaternion = new Quaternion()
  const liftQuaternion = new Quaternion()
  let selectedSide: LegNode['side'] = 'right'
  let angle = 0
  let repeatedLiftGoal = 0
  let repeatedLift = 0
  let parentStretch = 1
  let lastTimestamp: number | undefined
  let disposed = false
  let shakeAt: number | undefined
  let shakeDegrees = 0
  let shakeVelocity = 0

  const advanceShake = (timestamp: number) => {
    const nextAt = Math.max(timestamp, shakeAt ?? timestamp)
    const elapsed = shakeAt === undefined ? 0 : (nextAt - shakeAt) / 1000
    shakeAt = nextAt
    const tuning = MODEL_3D_CONFIG.pet.animation.legLift
    const omega = Math.PI * 2 * tuning.pressShakeCycles * 1000 / tuning.pressShakeMs
    const decayRate = omega * tuning.pressShakeDampingRatio
    const dampedOmega = omega * Math.sqrt(1 - tuning.pressShakeDampingRatio ** 2)
    const decay = Math.exp(-decayRate * elapsed)
    const cosine = Math.cos(dampedOmega * elapsed)
    const sine = Math.sin(dampedOmega * elapsed)
    const previous = shakeDegrees
    shakeDegrees = MathUtils.clamp(decay * (previous * cosine + (shakeVelocity + decayRate * previous) / dampedOmega * sine), -tuning.pressShakeDegrees, tuning.pressShakeDegrees)
    shakeVelocity = decay * (shakeVelocity * cosine - (decayRate * shakeVelocity + omega ** 2 * previous) / dampedOmega * sine)
    return omega
  }

  return {
    setParentStretch(stretch: number) {
      if (disposed) return
      parentStretch = stretch
      for (const leg of legs) updateStretchCompensatedBoneMatrix(leg.object, leg.baseMatrixAutoUpdate, stretch)
    },
    notePress(timestamp: number) {
      if (disposed) return
      const omega = advanceShake(timestamp)
      const tuning = MODEL_3D_CONFIG.pet.animation.legLift
      if (angle > tuning.switchThresholdDegrees) {
        repeatedLiftGoal = Math.min(tuning.maxRepeatedLiftDegrees - tuning.maxDegrees, repeatedLiftGoal + tuning.repeatedLiftDegreesPerPress)
      }
      const limit = omega * tuning.pressShakeDegrees * 2
      shakeVelocity = MathUtils.clamp(shakeVelocity + limit / 2, -limit, limit)
    },
    resetInput() {
      repeatedLiftGoal = 0
    },
    update(distanceRatio: number, turnDegrees: number, activity: number, timestamp: number) {
      if (disposed || !rootBone || legs.length !== 2) return
      const deltaSeconds = lastTimestamp === undefined ? 0 : Math.max(0, (timestamp - lastTimestamp) / 1000)
      lastTimestamp = timestamp
      const tuning = MODEL_3D_CONFIG.pet.animation.legLift
      advanceShake(timestamp)
      const desiredSide = activity > 0 && Math.abs(turnDegrees) > tuning.turnDeadZoneDegrees
        ? turnDegrees > 0 ? 'right' : 'left'
        : selectedSide
      const reach = MathUtils.smoothstep(distanceRatio, tuning.startDistanceRatio, tuning.fullDistanceRatio)
      const changingSide = desiredSide !== selectedSide
      if (changingSide || (activity === 0 && angle <= tuning.switchThresholdDegrees)) repeatedLiftGoal = 0
      repeatedLift = MathUtils.damp(repeatedLift, activity > 0 && !changingSide ? repeatedLiftGoal : 0, tuning.raiseDamping, deltaSeconds)
      const requestedAngle = (tuning.maxDegrees + repeatedLift) * reach * MathUtils.clamp(activity, 0, 1)
      const targetAngle = changingSide ? 0 : requestedAngle
      const damping = changingSide ? tuning.switchDamping : targetAngle > angle ? tuning.raiseDamping : tuning.returnDamping
      angle = MathUtils.damp(angle, targetAngle, damping, deltaSeconds)
      if (changingSide && angle <= tuning.switchThresholdDegrees) {
        angle = 0
        selectedSide = desiredSide
      }
      if (targetAngle === 0 && angle < 0.01) angle = 0

      rootBone.updateWorldMatrix(true, false)
      rootBone.getWorldQuaternion(rootQuaternion)
      spine.object.getWorldQuaternion(parentInverseQuaternion).invert()
      yawQuaternion.setFromAxisAngle(up, MathUtils.degToRad(turnDegrees))
      facingQuaternion.copy(rootQuaternion).multiply(spine.baseQuaternion).multiply(yawQuaternion)
      backLiftAxis.set(1, 0, 0).applyQuaternion(facingQuaternion)
      for (const leg of legs) {
        // Follow the current hip while keeping the supporting foot at its
        // authored stance. The raised foot leaves that stance along the same leg.
        leg.object.getWorldPosition(hip)
        stance.copy(leg.stanceInRoot).applyMatrix4(rootBone.matrixWorld)
        direction.copy(stance).sub(hip)
        const length = direction.length()
        if (length < 0.0001 || leg.length < 0.0001) continue
        direction.normalize()
        const liftWeight = leg.side === selectedSide ? MathUtils.smoothstep(angle, 0, tuning.kneeBendRampLiftDegrees) : 0
        const repeatedAmount = MathUtils.clamp(repeatedLift / Math.max(0.0001, tuning.maxRepeatedLiftDegrees - tuning.maxDegrees), 0, 1)
        const kneeDegrees = MathUtils.lerp(tuning.kneeBendDegrees, tuning.maxRepeatedKneeBendDegrees, repeatedAmount) * liftWeight
        if (liftWeight > 0) {
          // Split flexion around the lift centerline: the thigh leads by half
          // the knee angle, while the shin adds the full bend below it.
          const thighDegrees = Math.max(0, angle + shakeDegrees * liftWeight) - kneeDegrees / 2
          liftQuaternion.setFromAxisAngle(backLiftAxis, MathUtils.degToRad(thighDegrees))
          direction.applyQuaternion(liftQuaternion)
        }
        restWorldQuaternion.copy(facingQuaternion).multiply(leg.baseQuaternion)
        restDirection.copy(up).applyQuaternion(restWorldQuaternion)
        targetQuaternion.setFromUnitVectors(restDirection, direction).multiply(restWorldQuaternion)
        leg.object.quaternion.copy(parentInverseQuaternion).multiply(targetQuaternion)
        leg.object.scale.copy(leg.baseScale)
        const lengthScale = MathUtils.clamp(length / leg.length, tuning.minLengthScale, tuning.maxLengthScale)
        leg.object.scale.y *= lengthScale
        updateStretchCompensatedBoneMatrix(leg.object, leg.baseMatrixAutoUpdate, parentStretch)
        leg.shin.quaternion.copy(leg.shinBaseQuaternion).multiply(liftQuaternion.setFromAxisAngle(localKneeAxis, MathUtils.degToRad(kneeDegrees)))
        leg.shin.scale.copy(leg.shinBaseScale)
        leg.shin.scale.y *= lengthScale
        updateStretchCompensatedBoneMatrix(leg.shin, leg.shinBaseMatrixAutoUpdate, lengthScale)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const leg of legs) {
        leg.object.position.copy(leg.basePosition)
        leg.object.quaternion.copy(leg.baseQuaternion)
        leg.object.scale.copy(leg.baseScale)
        leg.object.matrixAutoUpdate = leg.baseMatrixAutoUpdate
        leg.object.updateMatrix()
        leg.shin.position.copy(leg.shinBasePosition)
        leg.shin.quaternion.copy(leg.shinBaseQuaternion)
        leg.shin.scale.copy(leg.shinBaseScale)
        leg.shin.matrixAutoUpdate = leg.shinBaseMatrixAutoUpdate
        leg.shin.updateMatrix()
      }
    },
  }
}
