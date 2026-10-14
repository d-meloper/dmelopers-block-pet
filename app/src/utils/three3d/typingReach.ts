import type { Object3D } from 'three'

import { MathUtils, Matrix3, Vector3 } from 'three'

/** Minimum torso elongation needed to bring a rigid arm within contact reach. */
export function solveReachStretch(contact: Vector3, shoulder: Vector3, stretchAxis: Vector3, reach: number, maxStretch: number): number {
  const dx = contact.x - shoulder.x
  const dy = contact.y - shoulder.y
  const dz = contact.z - shoulder.z
  const distanceError = dx * dx + dy * dy + dz * dz - reach * reach
  const axisLengthSq = stretchAxis.lengthSq()
  if (distanceError <= 0 || axisLengthSq < 0.000001 || maxStretch <= 1) return 1
  const projection = dx * stretchAxis.x + dy * stretchAxis.y + dz * stretchAxis.z
  const discriminant = projection * projection - axisLengthSq * distanceError
  const elongation = discriminant >= 0
    ? (projection - Math.sqrt(discriminant)) / axisLengthSq
    : projection / axisLengthSq
  return 1 + MathUtils.clamp(elongation, 0, maxStretch - 1)
}

/** One animator-owned workspace for planar hand/head reach in world units. */
export function createTypingReachConstraint(root: Object3D, keyboard: Object3D, keycapHeight: number) {
  const center = new Vector3()
  const normal = new Vector3()
  const delta = new Vector3()
  const normalMatrix = new Matrix3()
  const project = (point: Vector3) => {
    delta.copy(point).sub(center)
    delta.addScaledVector(normal, -delta.dot(normal))
    return delta
  }
  const projectedDistance = (point: Vector3) => project(point).length()
  const clampWorldPoint = (point: Vector3, radius: number) => {
    const distance = projectedDistance(point)
    if (distance > radius) point.addScaledVector(delta, radius / distance - 1)
    return distance
  }
  return {
    center,
    normal,
    update() {
      keyboard.updateWorldMatrix(true, false)
      root.getWorldPosition(center)
      keyboard.worldToLocal(center)
      center.y = keycapHeight
      keyboard.localToWorld(center)
      normal.set(0, 1, 0).applyMatrix3(normalMatrix.getNormalMatrix(keyboard.matrixWorld)).normalize()
    },
    projectedDistance,
    clampWorldPoint,
    clampLocalPoint(point: Vector3, radius: number) {
      keyboard.localToWorld(point)
      clampWorldPoint(point, radius)
      return keyboard.worldToLocal(point)
    },
    containsWorldPoint: (point: Vector3, radius: number, tolerance = 0.000001) => project(point).lengthSq() <= (radius + tolerance) ** 2,
  }
}
