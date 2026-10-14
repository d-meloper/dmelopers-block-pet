import type { Object3D } from 'three'

/** Cancel parent elongation before rotating a rigid child, retaining its anchor. */
export function updateStretchCompensatedBoneMatrix(object: Object3D, baseMatrixAutoUpdate: boolean, parentStretch = 1): void {
  if (parentStretch !== 1) {
    object.matrixAutoUpdate = false
    object.matrix.compose(object.position, object.quaternion, object.scale)
    const inverseStretch = 1 / parentStretch
    const elements = object.matrix.elements
    elements[1] *= inverseStretch
    elements[5] *= inverseStretch
    elements[9] *= inverseStretch
    object.matrixWorldNeedsUpdate = true
  } else {
    object.matrixAutoUpdate = baseMatrixAutoUpdate
    object.updateMatrix()
  }
}
