import { MathUtils, Vector3 } from 'three'

// Smooth only travel along the device plane. Strike height and exact mouse
// tracking keep their own response; each arm owns reusable scratch vectors.
export function createHandContactTransition(minDistance: number, durationMs: number) {
  const previousTarget = new Vector3()
  const offset = new Vector3()
  const jump = new Vector3()
  const output = new Vector3()
  let initialized = false
  let elapsedMs = durationMs

  return {
    update(target: Vector3, current: Vector3, planeNormal: Vector3, deltaMs: number, direct = false): Vector3 {
      if (!initialized || direct) {
        offset.set(0, 0, 0)
        elapsedMs = durationMs
        initialized = true
      } else {
        jump.copy(target).sub(previousTarget)
        jump.addScaledVector(planeNormal, -jump.dot(planeNormal))
        if (jump.lengthSq() > minDistance * minDistance) {
          // A new destination starts at the currently followed contact, even
          // when an earlier transition has not finished yet.
          offset.copy(current).sub(target)
          offset.addScaledVector(planeNormal, -offset.dot(planeNormal))
          elapsedMs = 0
        }
      }
      previousTarget.copy(target)
      elapsedMs = Math.min(durationMs, elapsedMs + deltaMs)
      const remaining = 1 - MathUtils.smoothstep(elapsedMs, 0, durationMs)
      return output.copy(target).addScaledVector(offset, remaining)
    },
    reset() {
      initialized = false
      elapsedMs = durationMs
      offset.set(0, 0, 0)
    },
  }
}
