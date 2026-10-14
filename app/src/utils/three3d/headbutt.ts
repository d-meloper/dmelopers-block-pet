import type { Object3D } from 'three'

import { Box3, Euler, MathUtils, Mesh, Quaternion, SkinnedMesh, Vector3 } from 'three'

import type { HeadbuttRecoilSettings } from '@/config/headbuttRecoil'

import { MODEL_3D_CONFIG } from '@/config/model3d'

import type { KeyboardKeyTarget } from './keyboard'

import { createHeadbuttRecoil } from './headbuttRecoil'

export interface HeadbuttTuning {
  chordWindowMs: number
  gripMs: number
  leftGripSideOffset: number
  downMs: number
  contactMs: number
  reboundMs: number
  minReboundMs: number
  reboundStartSpeedRatio: number
  recoilMaxDegrees: number
  recoilInputGapMs: number
  recoilDurationMs: number
  quietMs: number
  returnMs: number
  neckBasePitchDegrees: number
  neckMaxPitchDegrees: number
  holdNeckPitchDegrees: number
  holdNeckMs: number
  holdBreathMs: number
  holdBreathFadeMs: number
  maxTorsoPitchDegrees: number
  minExtendedTorsoPitchDegrees: number
  maxExtendedHeadYawDegrees: number
  minNearTorsoPitchDegrees: number
  maxNearTorsoPitchDegrees: number
  nearContactDepthRatio: number
  contactHeightTolerance: number
  maxStretch: number
  maxExtendedStretch: number
}

export const DEFAULT_HEADBUTT_TUNING: Readonly<HeadbuttTuning> = MODEL_3D_CONFIG.pet.animation.headbutt

type Phase = 'idle' | 'grip' | 'down' | 'contact' | 'hold' | 'rebound' | 'quiet' | 'return'

export interface HeadbuttPose {
  phase: Phase
  recovering: boolean
  grip: number
  depth: number
  recoilDegrees: number
  holdNeckAmount: number
  holdShakeDegrees: number
  holdBreathAmount: number
  target?: KeyboardKeyTarget
  session: number
  cycle: number
}

export interface HeadbuttHitGeometry {
  targetInSpineParent: Vector3
  reachDistanceRatio?: number
  extendedReachAmount?: number
  radialReachAmount?: number
  prioritizeContactHeight?: boolean
  contactNormalInSpineParent?: Vector3
  contactHeightTolerance?: number
  forehead: Vector3
  headScale: Vector3
  headOffset: Vector3
  spineScale: Vector3
  spineBaseQuaternion: Quaternion
  headBaseQuaternion: Quaternion
  restSpineQuaternion: Quaternion
}

/** Bone-local pose search, independent of animator input and shared IK plumbing. */
export function solveHeadbuttHit(
  geometry: HeadbuttHitGeometry,
  tuning: Readonly<HeadbuttTuning>,
  canReach: (spineQuaternion: Quaternion, stretch: number, foreheadOffset: Vector3) => boolean,
) {
  const direction = geometry.targetInSpineParent.clone().applyQuaternion(geometry.spineBaseQuaternion.clone().invert())
  const yaw = Math.atan2(direction.x, direction.z)
  const spineQuaternion = new Quaternion()
  const headQuaternion = new Quaternion()
  const rotation = new Quaternion()
  const euler = new Euler()
  const point = new Vector3()
  const headOffset = new Vector3()
  const rotatedForehead = new Vector3()
  const pitchedPoint = new Vector3()
  const difference = new Vector3()
  const prioritizeHeight = geometry.prioritizeContactHeight === true
  const extension = MathUtils.clamp(geometry.extendedReachAmount ?? 0, 0, 1)
  const radialAmount = MathUtils.clamp(geometry.radialReachAmount ?? extension, 0, 1)
  const maxStretch = MathUtils.lerp(tuning.maxStretch, Math.max(tuning.maxStretch, tuning.maxExtendedStretch), radialAmount)
  const contactNormal = geometry.contactNormalInSpineParent ?? new Vector3(0, 1, 0)
  const heightTolerance = geometry.contactHeightTolerance ?? tuning.contactHeightTolerance
  const preferredPitch = Math.max(prioritizeHeight ? tuning.minNearTorsoPitchDegrees : 0, tuning.minExtendedTorsoPitchDegrees * radialAmount)
  const neckPitch = MathUtils.lerp(
    tuning.neckBasePitchDegrees,
    tuning.neckMaxPitchDegrees,
    MathUtils.clamp(geometry.reachDistanceRatio ?? 0, 0, 1),
  )
  const setHeadYaw = (headYaw: number) => {
    headQuaternion.copy(geometry.headBaseQuaternion).multiply(rotation.setFromEuler(euler.set(MathUtils.degToRad(neckPitch), headYaw, 0, 'YXZ')))
    rotatedForehead.copy(geometry.forehead).multiply(geometry.headScale).applyQuaternion(headQuaternion)
  }
  setHeadYaw(0)
  const result = { spineQuaternion: geometry.restSpineQuaternion.clone(), headQuaternion: headQuaternion.clone(), stretch: 1 }
  let bestError = Infinity
  let bestPitchPreference = Infinity
  let bestHeightError = Infinity
  let hasContact = false
  const evaluate = (pitch: number, stretch: number, yawOffset = 0) => {
    point.copy(rotatedForehead)
    point.add(headOffset.set(geometry.headOffset.x, geometry.headOffset.y * stretch, geometry.headOffset.z))
    point.multiply(geometry.spineScale)
    pitchedPoint.copy(point).applyQuaternion(rotation.setFromEuler(euler.set(MathUtils.degToRad(pitch), 0, 0, 'YXZ')))
    // Aim the actual forehead, including lateral neck rotation, along the
    // target ray. Torso yaw alone is not the forehead's radial direction.
    const candidateYaw = yaw - Math.atan2(pitchedPoint.x, pitchedPoint.z) + yawOffset
    spineQuaternion.copy(geometry.spineBaseQuaternion).multiply(rotation.setFromEuler(euler.set(MathUtils.degToRad(pitch), candidateYaw, 0, 'YXZ')))
    point.applyQuaternion(spineQuaternion)
    difference.copy(point).sub(geometry.targetInSpineParent)
    const error = difference.lengthSq()
    const heightError = Math.abs(difference.dot(contactNormal))
    if (difference.dot(contactNormal) < -heightTolerance) return
    const contact = heightError <= heightTolerance
    const pitchPreference = Math.max(0, preferredPitch - pitch)
    const improves = !prioritizeHeight || (contact && hasContact)
      ? error < bestError - 0.0000001 || (Math.abs(error - bestError) <= 0.0000001 && pitchPreference < bestPitchPreference)
      : contact !== hasContact
        ? contact
        : heightError < bestHeightError - 0.00001
          || (Math.abs(heightError - bestHeightError) <= 0.00001 && error < bestError)
    if (!improves || !canReach(spineQuaternion, stretch, point)) return
    bestError = error
    bestPitchPreference = pitchPreference
    bestHeightError = heightError
    hasContact = contact
    result.spineQuaternion.copy(spineQuaternion)
    result.headQuaternion.copy(headQuaternion)
    result.stretch = stretch
  }
  const maxPitch = prioritizeHeight ? tuning.maxNearTorsoPitchDegrees : tuning.maxTorsoPitchDegrees
  const minPitch = Math.min(maxPitch, prioritizeHeight ? tuning.minNearTorsoPitchDegrees : 0)
  const maxHeadYaw = MathUtils.degToRad(tuning.maxExtendedHeadYawDegrees) * radialAmount
  const headYaws = maxHeadYaw > 0 ? [0, maxHeadYaw / 2, -maxHeadYaw / 2, maxHeadYaw, -maxHeadYaw] : [0]
  const contactErrorLimit = heightTolerance * heightTolerance
  const search = (minimum: number, maximum: number, yawOffset = 0) => {
    for (const headYaw of headYaws) {
      setHeadYaw(headYaw)
      if (yawOffset === 0) {
        // Rotation preserves length. Solve the needed height/stretch first,
        // then pitch/yaw, giving exact contact without a key-specific bias.
        const x = (rotatedForehead.x + geometry.headOffset.x) * geometry.spineScale.x
        const z = (rotatedForehead.z + geometry.headOffset.z) * geometry.spineScale.z
        const heightSq = direction.lengthSq() - x * x - z * z
        const forwardSq = direction.x * direction.x + direction.z * direction.z - x * x
        const heightPerStretch = geometry.headOffset.y * geometry.spineScale.y
        if (heightSq >= 0 && forwardSq >= 0 && Math.abs(heightPerStretch) > 0.000001) {
          const height = Math.sqrt(heightSq)
          const stretch = (height - rotatedForehead.y * geometry.spineScale.y) / heightPerStretch
          const pitch = MathUtils.radToDeg(Math.atan2(Math.sqrt(forwardSq), direction.y) - Math.atan2(z, height))
          if (stretch >= 1 && stretch <= maxStretch && pitch >= minimum && pitch <= maximum) evaluate(pitch, stretch)
          if (hasContact && bestError <= contactErrorLimit) return
        }
      }
      for (let stretch = 1; stretch <= maxStretch + 0.0001; stretch += 0.025) {
        for (let pitch = Math.ceil(minimum); pitch <= maximum; pitch += 1) evaluate(pitch, stretch, yawOffset)
        if (hasContact && bestError <= contactErrorLimit) return
      }
    }
  }
  search(minPitch, maxPitch)
  if ((!hasContact || bestError > contactErrorLimit) && minPitch > 0) search(0, minPitch - 1)
  // Keep fixed hands for impossible poses, using the nearest safe neighbor
  // only after every directly aligned candidate has been considered.
  if (!hasContact || bestError > contactErrorLimit) {
    for (const yawOffset of [Math.PI / 12, -Math.PI / 12, Math.PI / 6, -Math.PI / 6]) {
      search(0, maxPitch, yawOffset)
      if (hasContact && bestError <= contactErrorLimit) break
    }
  }
  return result
}

function smooth(value: number) {
  const x = MathUtils.clamp(value, 0, 1)
  return x * x * x * (10 + x * (-15 + 6 * x))
}

/** Four hold milestones, with continuous phase and no accumulated frame state. */
function getHoldShakeDegrees(ageMs: number) {
  const age = Math.max(0, ageMs)
  let previousAt = 0
  let previousDegrees = 0
  let previousHz = 2
  let cycles = 0
  for (const stage of MODEL_3D_CONFIG.pet.animation.headbuttHoldStages) {
    const durationMs = Math.max(1, stage.atMs - previousAt)
    const progress = MathUtils.clamp((age - previousAt) / durationMs, 0, 1)
    // Integral of the quintic smoothstep used for the frequency ramp.
    const integratedSmooth = progress ** 4 * (2.5 - 3 * progress + progress ** 2)
    cycles += durationMs / 1000 * (previousHz * progress + (stage.hz - previousHz) * integratedSmooth)
    const amplitude = MathUtils.lerp(previousDegrees, stage.degrees, smooth(progress))
    if (age <= stage.atMs) return Math.sin(cycles * Math.PI * 2) * amplitude
    previousAt = stage.atMs
    previousDegrees = stage.degrees
    previousHz = stage.hz
  }
  cycles += (age - previousAt) / 1000 * previousHz
  return Math.sin(cycles * Math.PI * 2) * previousDegrees
}

/** Elapsed-time pulses with a minimum rise and one latest pending target. */
export function createHeadbutt(initial: Partial<HeadbuttTuning> = {}, random: () => number = Math.random) {
  const tuning: HeadbuttTuning = { ...DEFAULT_HEADBUTT_TUNING }
  const recoil = createHeadbuttRecoil(tuning, random)
  let phase: Phase = 'idle'
  let startedAt = 0
  let lastPressAt = Number.NEGATIVE_INFINITY
  let target: KeyboardKeyTarget | undefined
  let pending: KeyboardKeyTarget | undefined
  let deferredHeld: KeyboardKeyTarget | undefined
  let heldTarget: KeyboardKeyTarget | undefined
  let cancelled = false
  let held = false
  let heldStartedAt = Number.POSITIVE_INFINITY
  let session = 0
  let cycle = 0
  let gripFrom = 0
  let depthFrom = 0
  let recoveryDistanceDegrees = 0
  let holdNeckAmount = 0
  let holdShakeDegrees = 0
  let holdBreathAmount = 0
  let holdMotionFadeStartedAt = Infinity

  const copyTarget = (next: KeyboardKeyTarget): KeyboardKeyTarget => ({
    ...next,
    position: [...next.position] as [number, number, number],
  })
  const sameTarget = (left: KeyboardKeyTarget, right: KeyboardKeyTarget) =>
    left.position.every((value, index) => value === right.position[index])

  const setTuning = (partial: Partial<HeadbuttTuning>) => {
    for (const key of Object.keys(tuning) as (keyof HeadbuttTuning)[]) {
      const value = partial[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      tuning[key] = key === 'maxStretch' || key === 'maxExtendedStretch'
        ? MathUtils.clamp(value, 1, key === 'maxExtendedStretch' ? DEFAULT_HEADBUTT_TUNING.maxExtendedStretch : 1.5)
        : key === 'maxTorsoPitchDegrees'
          ? MathUtils.clamp(value, 0, 90)
          : key === 'neckBasePitchDegrees' || key === 'neckMaxPitchDegrees'
            || key === 'minNearTorsoPitchDegrees' || key === 'minExtendedTorsoPitchDegrees' || key === 'maxExtendedHeadYawDegrees' || key === 'maxNearTorsoPitchDegrees' || key === 'holdNeckPitchDegrees'
            ? MathUtils.clamp(value, 0, 90)
            : key === 'nearContactDepthRatio'
              ? MathUtils.clamp(value, 0, 1)
              : key === 'contactHeightTolerance'
                ? MathUtils.clamp(value, 0.001, 0.1)
                : key === 'leftGripSideOffset'
                  ? MathUtils.clamp(value, 0, 30)
                  : key === 'reboundStartSpeedRatio'
                    ? MathUtils.clamp(value, 0.1, 1)
                    : key === 'recoilMaxDegrees'
                      ? MathUtils.clamp(value, 0, 27)
                      : key === 'chordWindowMs'
                        ? MathUtils.clamp(value, 0, 80)
                        : MathUtils.clamp(value, key === 'quietMs' ? 0 : 1, 5000)
    }
  }
  setTuning(initial)

  let reboundDurationMs = tuning.reboundMs
  const getReboundDuration = () => Math.max(reboundDurationMs, tuning.minReboundMs)
  const getReboundArrivalSpeedRatio = () => 2 - tuning.reboundStartSpeedRatio
  const beginRebound = (now: number) => {
    // Freeze the charge stage's duration for this rise, including spring speed.
    if (!cancelled) reboundDurationMs = recoil.getRecoveryDuration(now)
    phase = 'rebound'
    startedAt = now
    if (!cancelled) recoil.prepareRecovery(recoveryDistanceDegrees, getReboundDuration(), getReboundArrivalSpeedRatio(), now)
  }

  const getReboundDepth = (age: number) => {
    const duration = getReboundDuration()
    const progress = MathUtils.clamp(age / duration, 0, 1)
    // Constant acceleration through neutral, with no arrival ease-out. The
    // spring receives this curve's terminal speed, rather than its average.
    const recovered = progress * (tuning.reboundStartSpeedRatio + (1 - tuning.reboundStartSpeedRatio) * progress)
    return 1 - recovered
  }

  const update = (now: number): HeadbuttPose => {
    // Carry exact deadlines across skipped frames without building an input queue.
    for (let transitions = 0; transitions < 12; transitions += 1) {
      const duration = phase === 'idle' || phase === 'hold'
        ? Infinity
        : phase === 'quiet'
          ? Math.max(0, lastPressAt + tuning.quietMs - startedAt)
          : phase === 'rebound'
            ? (pending || deferredHeld) && !cancelled ? tuning.minReboundMs : getReboundDuration()
            : tuning[`${phase}Ms` as 'gripMs' | 'downMs' | 'contactMs' | 'reboundMs' | 'returnMs']
      const end = startedAt + duration
      if (now < end || phase === 'idle' || phase === 'hold') break
      startedAt = end
      if (phase === 'grip') {
        phase = 'down'
        gripFrom = 1
        cycle += 1
      } else if (phase === 'down') {
        phase = 'contact'
      } else if (phase === 'contact') {
        if (held && !pending && !cancelled) {
          phase = 'hold'
          if (deferredHeld) {
            target = deferredHeld
            deferredHeld = undefined
            cycle += 1
          }
        } else {
          beginRebound(end)
        }
      } else if (phase === 'rebound' && (pending || deferredHeld) && !cancelled) {
        depthFrom = getReboundDepth(duration)
        target = deferredHeld ?? pending
        if (deferredHeld) {
          lastPressAt = end
          recoil.release(end, tuning.downMs)
        }
        pending = undefined
        deferredHeld = undefined
        phase = 'down'
        holdMotionFadeStartedAt = end
        gripFrom = 1
        cycle += 1
      } else if (phase === 'rebound') {
        if (!cancelled) recoil.start(end)
        phase = cancelled ? 'return' : 'quiet'
        gripFrom = 1
      } else if (phase === 'quiet') {
        phase = 'return'
        gripFrom = 1
      } else if (phase === 'return') {
        phase = 'idle'
        target = undefined
        gripFrom = 0
        depthFrom = 0
        holdNeckAmount = 0
        holdShakeDegrees = 0
        holdBreathAmount = 0
      }
    }
    const age = now - startedAt
    if (phase === 'hold') {
      holdNeckAmount = smooth(age / tuning.holdNeckMs)
      const heldAge = Math.max(0, now - heldStartedAt)
      const breathFadeMs = Math.min(tuning.holdBreathFadeMs, tuning.holdBreathMs)
      holdBreathAmount = smooth(age / Math.min(tuning.holdNeckMs, 200))
        * (1 - smooth((heldAge - (tuning.holdBreathMs - breathFadeMs)) / breathFadeMs))
      holdShakeDegrees = getHoldShakeDegrees(age)
      holdMotionFadeStartedAt = Infinity
    }
    const holdMotionWeight = Number.isFinite(holdMotionFadeStartedAt)
      ? 1 - smooth((now - holdMotionFadeStartedAt) / tuning.downMs)
      : 1
    const depth = phase === 'down'
      ? depthFrom + (1 - depthFrom) * smooth(age / tuning.downMs)
      : phase === 'contact' || phase === 'hold'
        ? 1
        : phase === 'rebound' ? getReboundDepth(age) : 0
    const grip = phase === 'idle'
      ? 0
      : phase === 'grip' || phase === 'down'
        ? gripFrom + (1 - gripFrom) * smooth(age / tuning.gripMs)
        : phase === 'return' ? gripFrom * (1 - smooth(age / tuning.returnMs)) : 1
    const recoilDegrees = MathUtils.clamp(
      recoil.getDegrees(now),
      -tuning.recoilMaxDegrees,
      tuning.recoilMaxDegrees,
    ) * (1 - depth)
    return {
      phase,
      recovering: phase === 'quiet' || phase === 'return'
        || (phase === 'rebound' && !pending && !deferredHeld),
      depth,
      grip,
      target,
      session,
      cycle,
      recoilDegrees,
      holdNeckAmount: holdNeckAmount * holdMotionWeight,
      holdShakeDegrees: holdShakeDegrees * holdMotionWeight,
      holdBreathAmount: holdBreathAmount * holdMotionWeight,
    }
  }

  return {
    get active(): boolean {
      return phase !== 'idle' || recoil.active
    },
    get tuning(): Readonly<HeadbuttTuning> {
      return tuning
    },
    setTuning,
    setRecoilSettings: (settings: Partial<HeadbuttRecoilSettings>, now: number) => recoil.setSettings(settings, now),
    setRecoveryDistance(degrees: number) {
      if (!Number.isFinite(degrees)) return
      recoveryDistanceDegrees = MathUtils.clamp(degrees, 0, 360)
      if (phase === 'rebound' && !cancelled) recoil.setRecoveryVelocity(recoveryDistanceDegrees, getReboundDuration(), getReboundArrivalSpeedRatio())
    },
    update,
    setHeld(next: boolean, now: number, nextTarget?: KeyboardKeyTarget) {
      const nextHeldTarget = next ? nextTarget ?? target : undefined
      const dropsDeferred = deferredHeld && (!nextHeldTarget || !sameTarget(deferredHeld, nextHeldTarget))
      // A final key-up before the protected deadline cancels the deferred strike.
      // Releasing one chord member retains the remaining physical hold.
      // After that deadline, carry the old physical hold through skipped frames
      // before processing key-up, so it cannot recover ahead of the release.
      if (dropsDeferred && phase === 'rebound' && now < startedAt + tuning.minReboundMs) {
        deferredHeld = nextHeldTarget ? copyTarget(nextHeldTarget) : undefined
      }
      update(now)
      if (next && !held) heldStartedAt = now
      else if (!next) heldStartedAt = Number.POSITIVE_INFINITY
      held = next
      recoil.setHeld(next, now)
      heldTarget = nextHeldTarget
      if (deferredHeld && (!heldTarget || !sameTarget(deferredHeld, heldTarget))) deferredHeld = undefined
      if (!held && phase === 'hold') beginRebound(now)
    },
    press(next: KeyboardKeyTarget, now: number, coalesced = false) {
      const current = update(now)
      // Physical chord members share the first key's pulse and target. They do
      // not create a pending strike or prolong the anchored chord/burst window.
      if (coalesced) {
        if (held && phase === 'grip') target = copyTarget(next)
        else if (held && (phase === 'down' || phase === 'contact' || phase === 'rebound')) deferredHeld = copyTarget(next)
        return current
      }
      recoil.notePress(now)
      // Only a target still physically held at the rise deadline can resume.
      // Releasing it inside the protected window preserves short-tap discard.
      if (phase === 'rebound' && now - startedAt < tuning.minReboundMs) {
        if (held) {
          // A new physical hold may resume cancelled cleanup; an old held key
          // cannot reach this path because the animator rejects auto-repeat.
          cancelled = false
          deferredHeld = copyTarget(next)
        }
        return current
      }
      recoil.release(now, tuning.downMs)
      const copy = copyTarget(next)
      deferredHeld = undefined
      lastPressAt = now
      cancelled = false
      if (phase === 'idle') {
        session += 1
        target = copy
        pending = undefined
        startedAt = now
        gripFrom = 0
        depthFrom = 0
        holdNeckAmount = 0
        holdShakeDegrees = 0
        holdBreathAmount = 0
        phase = 'grip'
      } else if (phase === 'grip') {
        target = copy
      } else if (phase === 'down' || phase === 'contact') {
        // Complete contact before the rise, retaining one latest pending key.
        pending = copy
      } else if (phase === 'hold') {
        pending = copy
        beginRebound(now)
      } else {
        // Enough rise has elapsed: descend from the current depth and grip.
        target = copy
        pending = undefined
        startedAt = now
        depthFrom = current.depth
        gripFrom = current.grip
        phase = 'down'
        holdMotionFadeStartedAt = now
        cycle += 1
      }
      return current
    },
    cancel(now: number) {
      const current = update(now)
      recoil.release(now, tuning.downMs)
      recoil.resetCharge()
      pending = undefined
      deferredHeld = undefined
      heldTarget = undefined
      cancelled = true
      held = false
      heldStartedAt = Number.POSITIVE_INFINITY
      if (phase === 'hold') beginRebound(now)
      if (phase === 'quiet') {
        phase = 'return'
        gripFrom = current.grip
        startedAt = now
      }
      // Finish the bounded strike curve while an already running recoil fades;
      // no queued hit or new recoil crosses the reset.
    },
  }
}

/** Actual geometry bounds, cached by the tabletop rest instead of read per frame. */
export function getDeskBounds(desk: Object3D): Box3 {
  const bounds = new Box3()
  const vertex = new Vector3()
  desk.updateWorldMatrix(true, true)
  desk.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const positions = object.geometry.getAttribute('position')
    if (!positions) return
    for (let index = 0; index < positions.count; index += 1) {
      vertex.fromBufferAttribute(positions, index)
      object.localToWorld(vertex)
      desk.worldToLocal(vertex)
      bounds.expandByPoint(vertex)
    }
  })
  return bounds
}

/** Actual desk geometry in desk-local coordinates; retain the pet-facing lip. */
export function getDeskGrip(desk: Object3D, shoulderWorld: Vector3, petWorld: Vector3, output: Vector3, outwardOffset = 0): Vector3 | undefined {
  const bounds = getDeskBounds(desk)
  if (bounds.isEmpty()) return undefined
  const pet = desk.worldToLocal(petWorld.clone())
  const nearMinimum = Math.abs(pet.z - bounds.min.z) <= Math.abs(pet.z - bounds.max.z)
  const matrix = desk.matrixWorld.elements
  const depthScale = Math.max(0.0001, Math.hypot(matrix[8], matrix[9], matrix[10]))
  const edgeZ = nearMinimum ? bounds.min.z : bounds.max.z
  const outsideZ = edgeZ + (nearMinimum ? -1 : 1) * Math.max(0, outwardOffset) / depthScale
  output.copy(shoulderWorld)
  desk.worldToLocal(output)
  output.set(
    MathUtils.clamp(output.x, bounds.min.x, bounds.max.x),
    bounds.max.y,
    outsideZ,
  )
  return desk.localToWorld(output)
}

/** Forehead on the authored base head, extracted once from actual bone weights. */
export function getForeheadPoint(root: Object3D, head: Object3D): Vector3 {
  const bounds = new Box3()
  const vertex = new Vector3()
  root.updateWorldMatrix(true, true)
  root.traverse((object) => {
    if (!(object instanceof SkinnedMesh) || object.userData.voxelSkinLayer === 'outer') return
    const joint = object.skeleton.bones.findIndex(bone => bone === head)
    if (joint < 0) return
    const positions = object.geometry.getAttribute('position')
    const indices = object.geometry.getAttribute('skinIndex')
    const weights = object.geometry.getAttribute('skinWeight')
    if (!positions || !indices || !weights) return
    for (let index = 0; index < positions.count; index += 1) {
      let headWeight = 0
      for (let component = 0; component < 4; component += 1) {
        if (indices.getComponent(index, component) === joint) headWeight += weights.getComponent(index, component)
      }
      if (headWeight < 0.99) continue
      vertex.fromBufferAttribute(positions, index)
      // Read bind-space coordinates directly. Applying current bone transforms
      // here depends on SkinnedMesh's renderer-refreshed bindMatrixInverse and
      // can double-apply an enclosing normalized model scale before first draw.
      vertex.applyMatrix4(object.bindMatrix).applyMatrix4(object.skeleton.boneInverses[joint])
      bounds.expandByPoint(vertex)
    }
  })
  // Non-Dmeloper fixtures may lack weighted mesh geometry. Their unchanged
  // default animation remains usable; production always uses the extracted point.
  if (bounds.isEmpty()) return new Vector3(0, head.position.length() * 0.5, head.position.length() / 3)
  return new Vector3((bounds.min.x + bounds.max.x) / 2, MathUtils.lerp(bounds.min.y, bounds.max.y, 0.75), bounds.max.z)
}
