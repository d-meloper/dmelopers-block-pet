interface BoundaryPoint {
  index: number
  x: number
  z: number
}

function signedArea(a: BoundaryPoint, b: BoundaryPoint, c: BoundaryPoint): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
}

/** Retessellate a simple horizontal polygon without dropping any boundary vertex. */
export function triangulatePlanarBoundary(positions: ArrayLike<number>, boundary: readonly number[]): number[] {
  if (boundary.length < 3 || new Set(boundary).size !== boundary.length) {
    throw new Error('A planar boundary needs at least three distinct vertices.')
  }
  const height = positions[boundary[0] * 3 + 1]
  const points = boundary.map((index): BoundaryPoint => {
    const x = positions[index * 3]
    const y = positions[index * 3 + 1]
    const z = positions[index * 3 + 2]
    if (!Number.isSafeInteger(index) || index < 0 || ![x, y, z].every(Number.isFinite) || y !== height) {
      throw new Error('The boundary must contain finite vertices on one horizontal plane.')
    }
    return { index, x, z }
  })
  const twiceArea = points.slice(1, -1).reduce((area, point, index) => area + signedArea(points[0], point, points[index + 2]), 0)
  if (twiceArea === 0) throw new Error('The planar boundary has no area.')
  const winding = Math.sign(twiceArea)
  const indices: number[] = []
  while (points.length > 3) {
    // Always choose the first valid ear in the authored boundary order.
    const ear = points.findIndex((point, index) => {
      const previous = points[(index + points.length - 1) % points.length]
      const next = points[(index + 1) % points.length]
      if (signedArea(previous, point, next) * winding <= 0) return false
      return !points.some(other => other !== previous && other !== point && other !== next
        && signedArea(previous, point, other) * winding >= 0
        && signedArea(point, next, other) * winding >= 0
        && signedArea(next, previous, other) * winding >= 0)
    })
    if (ear < 0) throw new Error('The planar boundary could not be triangulated without losing a boundary vertex.')
    indices.push(points[(ear + points.length - 1) % points.length].index, points[ear].index, points[(ear + 1) % points.length].index)
    points.splice(ear, 1)
  }
  if (signedArea(points[0], points[1], points[2]) * winding <= 0) {
    throw new Error('The planar boundary would leave a degenerate triangle.')
  }
  indices.push(...points.map(point => point.index))
  return indices
}
