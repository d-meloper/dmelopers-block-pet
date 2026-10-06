import { MODEL_3D_CONFIG } from '@/config/model3d'

const config = MODEL_3D_CONFIG.pet.animation.typingTrance
function smooth(value: number) {
  const progress = Math.min(1, Math.max(0, value))
  return progress * progress * (3 - 2 * progress)
}

/** Runtime-only state. Each renderer makes one independent decision per fast burst. */
export function createTypingTrance(random: () => number = Math.random) {
  let presses: number[] = []
  let lastPress = Number.NEGATIVE_INFINITY
  let fastSince: number | undefined
  let quietSince: number | undefined
  let decided = false
  let activationAt: number | undefined
  let activationFrom = 0
  let returnAt: number | undefined
  let returnFrom = 0
  let shakePulses: Array<{ at: number, direction: number, blendMs: number }> = []
  let shakeDirection = 1

  const blendAt = (now: number) => {
    if (activationAt !== undefined) return activationFrom + (1 - activationFrom) * smooth((now - activationAt) / config.enterMs)
    if (returnAt !== undefined) return returnFrom * (1 - smooth((now - returnAt) / config.returnMs))
    return 0
  }
  const update = (now: number) => {
    const boundary = now - config.windowMs
    const roundingTolerance = Number.EPSILON * Math.max(1, Math.abs(now), Math.abs(boundary))
    // A frame at the next 12 Hz press must not break qualification before that
    // press arrives. Include the boundary, allowing only arithmetic roundoff.
    presses = presses.filter(time => time >= boundary - roundingTolerance)
    if (presses.length >= config.fastPressCount) fastSince ??= now
    else fastSince = undefined
    // Quiet still uses the exclusive window: at exactly 2 Hz the expiring key
    // must not create a transient third press and restart the quiet timer.
    const quietPresses = presses.filter(time => now - time < config.windowMs).length
    if (quietPresses < config.quietPressCount) quietSince ??= now
    else quietSince = undefined
    const quiet = now - lastPress >= config.quietMs
      || (quietSince !== undefined && now - quietSince >= config.quietMs)
    if (quiet) {
      if (activationAt !== undefined) {
        returnFrom = blendAt(now)
        returnAt = now
        activationAt = undefined
      }
      decided = false
      fastSince = undefined
    } else if (!decided && fastSince !== undefined && now - fastSince >= config.qualificationMs) {
      decided = true
      if (random() < config.probability) {
        activationFrom = blendAt(now)
        activationAt = now
        returnAt = undefined
      }
    }
    const amount = blendAt(now)
    // Keep only live pulses, with no recursive closures retaining expired work.
    // Smooth convex crossfades preserve displacement and velocity on a new key,
    // while each unchanged pulse and the final result remain within [-1, 1].
    shakePulses = shakePulses.filter(pulse => now - pulse.at < config.shakeMs)
    let shake = 0
    for (const pulse of shakePulses) {
      const age = now - pulse.at
      const value = age >= 0 ? Math.sin(Math.PI * age / config.shakeMs) ** 2 * pulse.direction : 0
      const blend = pulse.blendMs > 0 ? smooth(age / pulse.blendMs) : 1
      shake += (value - shake) * blend
    }
    shake *= amount
    return { amount, yawDegrees: shake * config.shakeYawDegrees, rollDegrees: shake * config.shakeRollDegrees }
  }

  return {
    press(now: number) {
      // A new press after silence first ends the preceding burst.
      update(now)
      lastPress = now
      presses.push(now)
      // Only the timing window is needed; never retain typed content/history.
      if (presses.length > 64) presses.shift()
      const pose = update(now)
      if (activationAt !== undefined && pose.amount >= config.shakeStartAmount) {
        shakeDirection *= -1
        const previous = shakePulses.at(-1)
        shakePulses.push({
          at: now,
          direction: shakeDirection,
          blendMs: previous ? Math.max(0, previous.at + config.shakeMs - now) : 0,
        })
      }
    },
    update,
    reset() {
      presses = []
      lastPress = Number.NEGATIVE_INFINITY
      fastSince = undefined
      quietSince = undefined
      decided = false
      activationAt = undefined
      activationFrom = 0
      returnAt = undefined
      returnFrom = 0
      shakePulses = []
      shakeDirection = 1
    },
  }
}
