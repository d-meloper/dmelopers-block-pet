import type { Object3D, PerspectiveCamera } from 'three'

import { Box3, Mesh, SkinnedMesh, Vector3 } from 'three'

import type { VisibleContentRect } from './contentBounds'

/** Conservative screen bounds before alpha readback, including off-screen geometry. */
export function projectVisibleSceneBounds(
  root: Object3D,
  camera: PerspectiveCamera,
  width: number,
  height: number,
  worldOffsets: readonly Vector3[] = [new Vector3()],
): VisibleContentRect | undefined {
  root.updateWorldMatrix(true, true)
  camera.updateWorldMatrix(true, false)
  const view = camera.clone()
  view.clearViewOffset()
  view.aspect = width / height
  view.updateProjectionMatrix()
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  const world = new Box3()
  const point = new Vector3()
  root.traverseVisible((object) => {
    if (!(object instanceof Mesh) || object.userData.excludeFromContentBounds === true) return
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    if (!materials.some(material => material.visible && material.colorWrite && material.opacity > 0)) return
    if (object instanceof SkinnedMesh) object.computeBoundingBox()
    else if (!object.geometry.boundingBox) object.geometry.computeBoundingBox()
    const bounds = object instanceof SkinnedMesh ? object.boundingBox : object.geometry.boundingBox
    if (!bounds || bounds.isEmpty()) return
    world.copy(bounds).applyMatrix4(object.matrixWorld)
    for (const x of [world.min.x, world.max.x]) {
      for (const y of [world.min.y, world.max.y]) {
        for (const z of [world.min.z, world.max.z]) {
          for (const offset of worldOffsets) {
            point.set(x, y, z).add(offset).applyMatrix4(view.matrixWorldInverse)
            // Near-plane crossings require a conservative bound, never silently
            // dropping an object just because its old 500x422 crop missed it.
            point.z = Math.min(point.z, -view.near)
            point.applyMatrix4(view.projectionMatrix)
            const pixelX = (point.x + 1) * width / 2
            const pixelY = (1 - point.y) * height / 2
            left = Math.min(left, pixelX)
            top = Math.min(top, pixelY)
            right = Math.max(right, pixelX)
            bottom = Math.max(bottom, pixelY)
          }
        }
      }
    }
  })
  if (![left, top, right, bottom].every(Number.isFinite)) return undefined
  return { x: Math.floor(left), y: Math.floor(top), width: Math.max(1, Math.ceil(right) - Math.floor(left)), height: Math.max(1, Math.ceil(bottom) - Math.floor(top)) }
}

export function unionContentRects(first: VisibleContentRect, second?: VisibleContentRect): VisibleContentRect {
  if (!second) return first
  const x = Math.min(first.x, second.x)
  const y = Math.min(first.y, second.y)
  return { x, y, width: Math.max(first.x + first.width, second.x + second.width) - x, height: Math.max(first.y + first.height, second.y + second.height) - y }
}

export function padContentRect(rect: VisibleContentRect, padding: number): VisibleContentRect {
  const margin = Math.max(0, Math.ceil(padding))
  return { x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 }
}
