import { MathUtils } from 'three'

import type { HeadbuttRecoilSettings } from '@/config/headbuttRecoil'

import { DEFAULT_HEADBUTT_RECOIL_SETTINGS, normalizeHeadbuttRecoilSettings } from '@/config/headbuttRecoil'
import { MODEL_3D_CONFIG } from '@/config/model3d'

import type { HeadbuttTuning } from './headbutt'

/** Carry the actual recovery velocity into a bounded, elapsed-time spring. */
export function createHeadbuttRecoil(tuning: Readonly<HeadbuttTuning>, random: () => number = Math.random) {
  let settings = { ...DEFAULT_HEADBUTT_RECOIL_SETTINGS }
  let typingStartedAt = 0
  let lastPressAt = Number.NEGATIVE_INFINITY
  let heldStartedAt: number | undefined
  let startedAt: number | undefined
  let releasedAt: number | undefined
  let disabledAt: number | undefined
  let releaseMs = 1
  let omega = 1
  let damping = 1
  let durationMs = 1
  let initialVelocity = 0
  let recoveryPrepared = false
  let recoveryVelocity = 0
  let recoveryAmplitude = 0

  const sampleStep = (minimum: number, maximum: number, unitsPerOne: number) => {
    const first = Math.round(minimum * unitsPerOne)
    const last = Math.round(maximum * unitsPerOne)
    const count = last - first + 1
    const value = random()
    const fraction = MathUtils.clamp(Number.isFinite(value) ? value : 0.5, 0, 1)
    const index = Math.min(count - 1, Math.floor(fraction * count))
    return (first + index) / unitsPerOne
  }

  const clear = () => {
    startedAt = undefined
    releasedAt = undefined
    disabledAt = undefined
  }

  const getStage = (now: number) => {
    const chargeUntil = heldStartedAt === undefined ? lastPressAt : Math.max(lastPressAt, now)
    const span = Number.isFinite(lastPressAt) ? Math.max(0, chargeUntil - typingStartedAt) : 0
    const stages = MODEL_3D_CONFIG.pet.animation.headbuttRecoilStages
    return stages.find(candidate => span <= candidate.maxInputMs) ?? stages[stages.length - 1]!
  }

  const setRecoveryVelocity = (distanceDegrees: number, recoveryMs: number, arrivalSpeedRatio = 1) => {
    if (!recoveryPrepared) return
    recoveryVelocity = Math.max(0, distanceDegrees) * 1000 / Math.max(1, recoveryMs) * arrivalSpeedRatio
    const dampedRatio = Math.sqrt(1 - damping * damping)
    const peakDecay = Math.exp(-damping * Math.acos(damping) / dampedRatio)
    // x(0) = 0 and x'(0) = incoming velocity. Choose stiffness so the first
    // turning point reaches the selected cap, without a clipped, flat peak.
    omega = recoveryVelocity > 0 ? recoveryVelocity * peakDecay / recoveryAmplitude : 1
  }

  const getDegrees = (now: number) => {
    if (startedAt === undefined) return 0
    const age = Math.max(0, now - startedAt)
    if (age >= durationMs || (releasedAt !== undefined && now - releasedAt >= releaseMs)
      || (disabledAt !== undefined && now - disabledAt >= 120)) {
      clear()
      return 0
    }
    const seconds = age / 1000
    const dampedOmega = omega * Math.sqrt(1 - damping * damping)
    const tail = 1 - MathUtils.smootherstep(age, durationMs * 0.8, durationMs)
    const release = releasedAt === undefined ? 1 : 1 - MathUtils.smootherstep(now - releasedAt, 0, releaseMs)
    const disabled = disabledAt === undefined ? 1 : 1 - MathUtils.smootherstep(now - disabledAt, 0, 120)
    const degrees = initialVelocity / dampedOmega * Math.exp(-damping * omega * seconds)
      * Math.sin(dampedOmega * seconds)
    return MathUtils.clamp(degrees * tail * release * disabled, -tuning.recoilMaxDegrees, tuning.recoilMaxDegrees)
  }

  return {
    get active() {
      return startedAt !== undefined
    },
    getDegrees,
    setSettings(next: Partial<HeadbuttRecoilSettings>, now: number) {
      settings = normalizeHeadbuttRecoilSettings(next, settings)
      if (settings.petHeadbuttRecoilEnabled && settings.petHeadbuttRecoilStrengthPercent > 0) return
      recoveryPrepared = false
      // Keep an existing input-release envelope and its velocity. Disabling
      // owns a separate bounded fade, which repeated setting snapshots retain.
      if (startedAt !== undefined) disabledAt ??= now
    },
    getRecoveryDuration: (now: number) => getStage(now).recoveryMs,
    notePress(now: number) {
      const continuingHold = heldStartedAt !== undefined && heldStartedAt <= lastPressAt
      if ((!continuingHold && now - lastPressAt > tuning.recoilInputGapMs) || now < lastPressAt) typingStartedAt = now
      lastPressAt = now
    },
    setHeld(held: boolean, now: number) {
      if (held) {
        heldStartedAt ??= now
      } else if (heldStartedAt !== undefined) {
        // Count the physical hold through key-up, never through recovery.
        if (Number.isFinite(lastPressAt)) lastPressAt = Math.max(lastPressAt, now)
        heldStartedAt = undefined
      }
    },
    prepareRecovery(distanceDegrees: number, recoveryMs: number, arrivalSpeedRatio = 1, now = lastPressAt) {
      clear()
      recoveryPrepared = false
      if (!settings.petHeadbuttRecoilEnabled || !Number.isFinite(lastPressAt) || tuning.recoilMaxDegrees === 0) return
      const stage = getStage(now)
      // Sample once for this rise. Matching the measured arrival velocity below
      // must not resample these values and introduce per-frame motion noise.
      recoveryAmplitude = Math.min(sampleStep(stage.minDegrees, stage.maxDegrees, 2) * settings.petHeadbuttRecoilStrengthPercent / 50, tuning.recoilMaxDegrees)
      if (recoveryAmplitude <= 0) return
      damping = sampleStep(stage.minDampingRatio, stage.maxDampingRatio, 20)
      const wobble = (settings.petHeadbuttRecoilWobblePercent - 50) / 50
      damping = wobble >= 0 ? MathUtils.lerp(damping, 0.05, wobble) : MathUtils.lerp(damping, 0.95, -wobble)
      durationMs = tuning.recoilDurationMs * (1 + wobble * 0.5)
      recoveryPrepared = true
      setRecoveryVelocity(distanceDegrees, recoveryMs, arrivalSpeedRatio)
    },
    setRecoveryVelocity,
    start(now: number) {
      if (!recoveryPrepared) return
      recoveryPrepared = false
      if (recoveryVelocity <= 0) return
      initialVelocity = recoveryVelocity
      startedAt = now
      releasedAt = undefined
    },
    release(now: number, duration: number) {
      getDegrees(now)
      if (startedAt === undefined || releasedAt !== undefined) return
      releasedAt = now
      releaseMs = Math.max(1, duration)
    },
    resetCharge() {
      typingStartedAt = 0
      lastPressAt = Number.NEGATIVE_INFINITY
      heldStartedAt = undefined
    },
  }
}
