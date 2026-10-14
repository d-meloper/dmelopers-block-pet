/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { MathUtils, Quaternion, SkinnedMesh, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { createLegLift } from './legRig'

async function fixture() {
  const bytes = await readFile(new URL('../../../src-tauri/assets/models/dmeloper/dmeloper.glb', import.meta.url))
  const root = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene
  root.scale.setScalar(0.075)
  root.position.set(0.3, 0.4, -0.5)
  root.rotation.y = 0.6
  root.updateMatrixWorld(true)
  const spine = root.getObjectByName('Spine02')!
  const rest = { object: spine, basePosition: spine.position.clone(), baseQuaternion: spine.quaternion.clone(), baseScale: spine.scale.clone() }
  const legs = createLegLift(root, rest)
  const authoredFeet = ['L_Foot', 'R_Foot'].map(name => root.getObjectByName(name)!.getWorldPosition(new Vector3()))
  const refresh = () => {
    root.updateMatrixWorld(true)
    root.traverse((object) => {
      if (object instanceof SkinnedMesh) object.skeleton.update()
    })
  }
  const world = (name: string) => root.getObjectByName(name)!.getWorldPosition(new Vector3())
  return { root, spine, rest, legs, authoredFeet, refresh, world }
}

describe('connected actual Dmeloper leg rig', () => {
  it('bounds fresh-press charge at 100 degrees of lift and 50 degrees of knee bend, then resets to the baseline', async () => {
    const rig = await fixture()
    try {
      for (let time = 0; time <= 1000; time += 10) rig.legs.update(1, 25, 1, time)
      const hip = rig.world('R_Leg')
      const down = rig.authoredFeet[1].clone().sub(hip).normalize()
      for (let time = 1001; time <= 1200; time++) {
        rig.legs.notePress(time)
        rig.legs.update(1, 25, 1, time)
      }
      for (let time = 1210; time <= 5000; time += 10) rig.legs.update(1, 25, 1, time)
      const lift = MathUtils.radToDeg(rig.world('R_Foot').sub(hip).normalize().angleTo(down))
      assert.ok(Math.abs(lift - 100) < 0.01, `${lift}: bounded maximum lift`)
      assert.ok(Math.abs(MathUtils.radToDeg(rig.root.getObjectByName('R_Shin')!.quaternion.angleTo(new Quaternion())) - 50) < 0.01)
      assert.ok(rig.world('L_Foot').distanceTo(rig.authoredFeet[0]) < 1e-6)
      rig.legs.resetInput()
      for (let time = 5010; time <= 8000; time += 10) rig.legs.update(1, 25, 1, time)
      assert.ok(Math.abs(MathUtils.radToDeg(rig.root.getObjectByName('R_Shin')!.quaternion.angleTo(new Quaternion())) - 5) < 0.01)
    } finally {
      rig.legs.dispose()
    }
  })

  it('raises the opposite foot backward, flexes its knee 5 degrees and keeps the support grounded under torso stretch', async () => {
    const rig = await fixture()
    try {
      rig.spine.position.y += 0.1
      rig.spine.scale.y = 1.5
      rig.spine.quaternion.copy(rig.rest.baseQuaternion).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(25))).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), MathUtils.degToRad(65)))
      rig.legs.setParentStretch(1.5)
      for (let time = 0; time <= 1200; time += 16) rig.legs.update(1, 25, 1, time)
      rig.refresh()
      assert.ok(rig.world('L_Foot').distanceTo(rig.authoredFeet[0]) < 1e-6, 'supporting foot must remain on its authored stance')
      const raised = rig.world('R_Foot').sub(rig.authoredFeet[1])
      const facing = rig.root.getObjectByName('Root')!.getWorldQuaternion(new Quaternion()).multiply(rig.rest.baseQuaternion).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(25)))
      assert.ok(raised.dot(new Vector3(0, 1, 0).applyQuaternion(facing)) > 0.04, '20-degree lift with a shallow knee bend raises the foot')
      assert.ok(raised.dot(new Vector3(0, 0, -1).applyQuaternion(facing)) > 0.2, 'foot extends toward the back')
      assert.ok(Math.abs(MathUtils.radToDeg(rig.root.getObjectByName('R_Shin')!.quaternion.angleTo(new Quaternion())) - 5) < 1e-6)
      assert.ok(rig.root.getObjectByName('L_Shin')!.quaternion.angleTo(new Quaternion()) < 1e-8)
      const thighScale = rig.root.getObjectByName('R_Leg')!.getWorldScale(new Vector3())
      const shinScale = rig.root.getObjectByName('R_Shin')!.getWorldScale(new Vector3())
      assert.ok(Math.abs(thighScale.x - 0.075) < 1e-6 && Math.abs(thighScale.z - 0.075) < 1e-6, 'thigh thickness is invariant')
      assert.ok(Math.abs(shinScale.x - 0.075) < 1e-6 && Math.abs(shinScale.z - 0.075) < 1e-6, 'shin thickness is invariant')
    } finally {
      rig.legs.dispose()
    }
  })

  it('keeps duplicate surface corners coincident at the waist and knee through movement, stretch and flexion', async () => {
    const rig = await fixture()
    try {
      const base = rig.root.getObjectByName('VoxelHumanoidBase') as SkinnedMesh
      const positions = base.geometry.getAttribute('position')
      const joints = base.geometry.getAttribute('skinIndex')
      const weights = base.geometry.getAttribute('skinWeight')
      const groups = new Map<string, number[]>()
      for (let index = 0; index < positions.count; index++) {
        const position = new Vector3().fromBufferAttribute(positions, index)
        if (position.y > 12) continue
        // The two legs can separate below the waist; only duplicate corners of
        // the same leg are a seam there. The waist must match across all parts.
        let side = ''
        if (position.y < 12) {
          for (let component = 0; component < 4; component++) {
            const name = base.skeleton.bones[joints.getComponent(index, component)].name
            if (weights.getComponent(index, component) > 0 && /^[LR]_(?:Leg|Shin)$/.test(name)) side = name[0]
          }
        }
        const key = `${side}:${position.toArray().join(',')}`
        groups.set(key, [...(groups.get(key) ?? []), index])
      }
      let comparisons = 0
      for (const turn of [-30, 30]) {
        for (const stretch of [1, 1.5]) {
          rig.spine.position.copy(rig.rest.basePosition).add(new Vector3(0, 0.1, 0))
          rig.spine.scale.y = stretch
          rig.spine.quaternion.copy(rig.rest.baseQuaternion).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(turn))).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), MathUtils.degToRad(65)))
          rig.legs.setParentStretch(stretch)
          for (let time = comparisons * 1000; time <= comparisons * 1000 + 1000; time += 16) rig.legs.update(1, turn, 1, time)
          rig.refresh()
          for (const indices of groups.values()) {
            const first = base.getVertexPosition(indices[0], new Vector3())
            for (const index of indices.slice(1)) {
              assert.ok(base.getVertexPosition(index, new Vector3()).distanceTo(first) < 1e-5, 'shared surface corners cannot crack apart')
            }
          }
          comparisons++
        }
      }
    } finally {
      rig.legs.dispose()
    }
  })

  it('carries a bounded key tremor, lowers before switching feet and restores authored bones on disposal', async () => {
    const rig = await fixture()
    const authored = ['L_Leg', 'R_Leg', 'L_Shin', 'R_Shin'].map((name) => {
      const bone = rig.root.getObjectByName(name)!
      return { name, position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone(), matrixAutoUpdate: bone.matrixAutoUpdate }
    })
    for (let time = 0; time <= 1000; time += 10) rig.legs.update(1, 25, 1, time)
    const initial = rig.root.getObjectByName('R_Leg')!.quaternion.clone()
    rig.legs.notePress(1000)
    rig.legs.update(1, 25, 1, 1010)
    const shaken = rig.root.getObjectByName('R_Leg')!.quaternion.angleTo(initial)
    assert.ok(shaken > 0.0001 && shaken < MathUtils.degToRad(1.01), 'one press creates a small bounded motion')
    for (let time = 1020; time <= 2000; time += 10) {
      rig.legs.update(1, -25, 1, time)
      const knees = ['L_Shin', 'R_Shin'].map(name => rig.root.getObjectByName(name)!.quaternion.angleTo(new Quaternion()))
      assert.ok(Math.min(...knees) < 1e-8, 'only one foot can be raised at a time')
    }
    assert.ok(rig.root.getObjectByName('L_Shin')!.quaternion.angleTo(new Quaternion()) > MathUtils.degToRad(4.9))
    rig.legs.dispose()
    for (const rest of authored) {
      const bone = rig.root.getObjectByName(rest.name)!
      assert.deepEqual(bone.position.toArray(), rest.position.toArray())
      assert.deepEqual(bone.quaternion.toArray(), rest.quaternion.toArray())
      assert.deepEqual(bone.scale.toArray(), rest.scale.toArray())
      assert.equal(bone.matrixAutoUpdate, rest.matrixAutoUpdate)
    }
  })
})
