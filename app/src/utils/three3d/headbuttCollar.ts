import type { BufferGeometry, Object3D } from 'three'

import { Box3, MathUtils, Matrix3, Matrix4, SkinnedMesh, Vector3 } from 'three'

import { MODEL_3D_CONFIG } from '@/config/model3d'

interface CollarVertex {
  index: number
  position: Vector3
  normal: Vector3
  authoredPosition: Vector3
  authoredNormal: Vector3
}

interface CollarBinding {
  mesh: SkinnedMesh
  vertices: CollarVertex[]
  fromBone: Matrix4
  normalFromBone: Matrix3
  touched: Map<BufferGeometry, () => void>
  currentGeometry?: BufferGeometry
}

/** Retract the upper/front skin only; bone pivots and contacts stay untouched. */
export function createHeadbuttCollar(root: Object3D, spine: Object3D, head: Object3D) {
  const bindings: CollarBinding[] = []
  const torsoBounds = new Box3()
  const headBounds = new Box3()
  const point = new Vector3()
  root.traverse((object) => {
    if (!(object instanceof SkinnedMesh)) return
    const positions = object.geometry.getAttribute('position')
    const normals = object.geometry.getAttribute('normal')
    const indices = object.geometry.getAttribute('skinIndex')
    const weights = object.geometry.getAttribute('skinWeight')
    if (!positions || !normals || !indices || !weights) return
    const spineJoint = object.skeleton.bones.findIndex(bone => bone === spine)
    const headJoint = object.skeleton.bones.findIndex(bone => bone === head)
    const toBone = spineJoint >= 0
      ? object.skeleton.boneInverses[spineJoint].clone().multiply(object.bindMatrix)
      : new Matrix4()
    const normalToBone = new Matrix3().getNormalMatrix(toBone)
    const vertices: CollarVertex[] = []
    // Skin topology filters outer pixels through the index buffer. Only those
    // visible head faces define its bottom; hidden shell vertices add no gap.
    const meshIndex = object.geometry.getIndex()
    const visibleHeadVertices = meshIndex ? new Set<number>(Array.from(meshIndex.array)) : undefined
    for (let index = 0; index < positions.count; index += 1) {
      let spineWeight = 0
      let headWeight = 0
      for (let component = 0; component < 4; component += 1) {
        const joint = indices.getComponent(index, component)
        const weight = weights.getComponent(index, component)
        if (spineJoint >= 0 && joint === spineJoint) spineWeight += weight
        if (headJoint >= 0 && joint === headJoint) headWeight += weight
      }
      if (headWeight >= 0.99 && (!visibleHeadVertices || visibleHeadVertices.has(index))) {
        point.fromBufferAttribute(positions, index).applyMatrix4(object.bindMatrix).applyMatrix4(object.skeleton.boneInverses[headJoint])
        headBounds.expandByPoint(point)
      }
      if (spineWeight < 0.99) continue
      const authoredPosition = new Vector3().fromBufferAttribute(positions, index)
      const authoredNormal = new Vector3().fromBufferAttribute(normals, index)
      const position = authoredPosition.clone().applyMatrix4(toBone)
      torsoBounds.expandByPoint(position)
      vertices.push({
        index,
        position,
        authoredPosition,
        authoredNormal,
        normal: authoredNormal.clone().applyMatrix3(normalToBone).normalize(),
      })
    }
    if (vertices.length === 0) return
    const fromBone = toBone.clone().invert()
    bindings.push({ mesh: object, vertices, fromBone, normalFromBone: new Matrix3().getNormalMatrix(fromBone), touched: new Map() })
  })

  const headInSpine = new Matrix4()
  const normalMatrix = new Matrix3()
  const headBottom = new Vector3()
  const headNormal = new Vector3()
  const normal = new Vector3()
  let previousCompression = 0

  const restore = () => {
    for (const binding of bindings) {
      for (const [geometry, onDispose] of binding.touched) {
        geometry.removeEventListener('dispose', onDispose)
        const positions = geometry.getAttribute('position')
        const normals = geometry.getAttribute('normal')
        for (const vertex of binding.vertices) {
          positions.setXYZ(vertex.index, vertex.authoredPosition.x, vertex.authoredPosition.y, vertex.authoredPosition.z)
          normals.setXYZ(vertex.index, vertex.authoredNormal.x, vertex.authoredNormal.y, vertex.authoredNormal.z)
        }
        positions.needsUpdate = true
        normals.needsUpdate = true
      }
      binding.touched.clear()
      binding.currentGeometry = undefined
    }
    previousCompression = 0
  }

  return {
    update(active: boolean) {
      if (torsoBounds.isEmpty() || headBounds.isEmpty()) return
      if (!active) {
        if (previousCompression > 0) restore()
        return
      }
      head.updateWorldMatrix(true, false)
      headInSpine.copy(spine.matrixWorld).invert().multiply(head.matrixWorld)
      headNormal.set(0, 1, 0).applyMatrix3(normalMatrix.getNormalMatrix(headInSpine)).normalize()
      headBottom.set(0, headBounds.min.y, 0).applyMatrix4(headInSpine)
      const waistY = Math.max(0, torsoBounds.min.y)
      const height = torsoBounds.max.y - waistY
      const depth = torsoBounds.max.z - torsoBounds.min.z
      const tuning = MODEL_3D_CONFIG.pet.animation.headbuttCollar
      const worstX = headNormal.x >= 0 ? torsoBounds.max.x : torsoBounds.min.x
      const maxFront = headNormal.z > 0.0001
        ? (headNormal.dot(headBottom) - headNormal.y * torsoBounds.max.y
          - headNormal.x * worstX - height * tuning.clearanceHeightRatio) / headNormal.z
        : torsoBounds.max.z
      const compression = MathUtils.clamp(torsoBounds.max.z - maxFront, 0, depth * tuning.maxFrontCompressionRatio)
      if (compression === 0 || height <= 0 || depth <= 0) {
        if (previousCompression > 0) restore()
        return
      }
      if (Math.abs(compression - previousCompression) < 0.00001
        && bindings.every(binding => binding.currentGeometry === binding.mesh.geometry)) {
        return
      }
      for (const binding of bindings) {
        const geometry = binding.mesh.geometry
        const positions = geometry.getAttribute('position')
        const normals = geometry.getAttribute('normal')
        if (!binding.touched.has(geometry)) {
          const onDispose = () => {
            geometry.removeEventListener('dispose', onDispose)
            binding.touched.delete(geometry)
            if (binding.currentGeometry === geometry) binding.currentGeometry = undefined
          }
          binding.touched.set(geometry, onDispose)
          geometry.addEventListener('dispose', onDispose)
        }
        binding.currentGeometry = geometry
        for (const vertex of binding.vertices) {
          const upper = MathUtils.clamp((vertex.position.y - waistY) / height, 0, 1)
          const front = MathUtils.clamp((vertex.position.z - torsoBounds.min.z) / depth, 0, 1)
          point.copy(vertex.position)
          point.z -= compression * upper * front
          point.applyMatrix4(binding.fromBone)
          positions.setXYZ(vertex.index, point.x, point.y, point.z)
          // Inverse-transpose of the local taper's Jacobian; preserve authored
          // face normals without rebuilding indices or scanning the whole mesh.
          normal.copy(vertex.normal)
          normal.z /= 1 - compression * upper / depth
          if (vertex.position.y >= waistY) normal.y += compression * front / height * normal.z
          normal.applyMatrix3(binding.normalFromBone).normalize()
          normals.setXYZ(vertex.index, normal.x, normal.y, normal.z)
        }
        positions.needsUpdate = true
        normals.needsUpdate = true
      }
      previousCompression = compression
    },
    dispose: restore,
  }
}
