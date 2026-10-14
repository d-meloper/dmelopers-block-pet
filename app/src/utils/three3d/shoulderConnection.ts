import type { BufferGeometry, Object3D } from 'three'

import { Matrix4, SkinnedMesh, Vector3 } from 'three'

interface ShoulderVertex {
  index: number
  joints: number[]
  weights: number[]
  upperJoint: number
}

interface ShoulderBinding {
  mesh: SkinnedMesh
  vertices: ShoulderVertex[]
  geometry?: BufferGeometry
}

/** Switch the authored shoulder band without replacing meshes or bone poses. */
export function createShoulderConnection(root: Object3D) {
  const bindings: ShoulderBinding[] = []
  const position = new Vector3()
  root.traverse((object) => {
    if (!(object instanceof SkinnedMesh)
      || !['wide', 'slim'].includes(object.userData.voxelSkinModel)) {
      return
    }
    const joints = object.geometry.getAttribute('skinIndex')
    const weights = object.geometry.getAttribute('skinWeight')
    const positions = object.geometry.getAttribute('position')
    if (!joints || !weights || !positions) return
    const spineJoint = object.skeleton.bones.findIndex(bone => bone.name === 'Spine02')
    const leftJoint = object.skeleton.bones.findIndex(bone => bone.name === 'L_Upperarm')
    const rightJoint = object.skeleton.bones.findIndex(bone => bone.name === 'R_Upperarm')
    if (spineJoint < 0 || leftJoint < 0 || rightJoint < 0) return
    const toSpine = new Matrix4().copy(object.skeleton.boneInverses[spineJoint]).multiply(object.bindMatrix)
    const vertices: ShoulderVertex[] = []
    for (let index = 0; index < positions.count; index += 1) {
      const originalJoints = [0, 1, 2, 3].map(component => joints.getComponent(index, component))
      const originalWeights = [0, 1, 2, 3].map(component => weights.getComponent(index, component))
      if (!originalJoints.some((joint, component) => joint === spineJoint && originalWeights[component] > 0)) continue
      position.fromBufferAttribute(positions, index).applyMatrix4(toSpine)
      vertices.push({ index, joints: originalJoints, weights: originalWeights, upperJoint: position.x >= 0 ? leftJoint : rightJoint })
    }
    if (vertices.length) bindings.push({ mesh: object, vertices })
  })
  let enabled = false
  let dirty = true
  let disposed = false
  const apply = (binding: ShoulderBinding, connected: boolean) => {
    const geometry = binding.mesh.geometry
    const joints = geometry.getAttribute('skinIndex')
    const weights = geometry.getAttribute('skinWeight')
    for (const vertex of binding.vertices) {
      for (let component = 0; component < 4; component += 1) {
        joints.setComponent(vertex.index, component, connected
          ? vertex.joints[component]
          : component === 0 ? vertex.upperJoint : 0)
        weights.setComponent(vertex.index, component, connected
          ? vertex.weights[component]
          : component === 0 ? 1 : 0)
      }
    }
    joints.needsUpdate = true
    weights.needsUpdate = true
    binding.geometry = geometry
  }
  const update = () => {
    if (disposed) return
    for (const binding of bindings) {
      // Skin/palm replacement clones the geometry; reapply only on a new buffer.
      if (dirty || binding.geometry !== binding.mesh.geometry) apply(binding, enabled)
    }
    dirty = false
  }
  update()
  return {
    setEnabled(connected: boolean) {
      if (disposed || enabled === connected) return
      enabled = connected
      dirty = true
      update()
    },
    update,
    dispose() {
      if (disposed) return
      for (const binding of bindings) apply(binding, true)
      disposed = true
      bindings.length = 0
    },
  }
}
