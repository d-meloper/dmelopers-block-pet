import type { Box3, Mesh } from 'three'

import { InstancedMesh, Matrix4, SkinnedMesh } from 'three'

/** Visit individual world AABBs, retaining the pre-batching crop/light fit. */
export function forEachMeshWorldBounds(mesh: Mesh, target: Box3, visit: (bounds: Box3) => void): void {
  if (mesh instanceof SkinnedMesh) mesh.computeBoundingBox()
  else if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
  const local = mesh instanceof SkinnedMesh ? mesh.boundingBox : mesh.geometry.boundingBox
  if (!local || local.isEmpty()) return
  if (mesh instanceof InstancedMesh) {
    const transform = new Matrix4()
    for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, transform)
      transform.premultiply(mesh.matrixWorld)
      visit(target.copy(local).applyMatrix4(transform))
    }
  } else {
    visit(target.copy(local).applyMatrix4(mesh.matrixWorld))
  }
}
