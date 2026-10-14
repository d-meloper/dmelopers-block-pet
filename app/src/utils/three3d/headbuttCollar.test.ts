/* eslint-disable test/no-import-node-test */
import type { SkinnedMesh } from 'three'

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { BufferAttribute, MathUtils, Quaternion, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { createHeadbuttCollar } from './headbuttCollar'

async function fixture() {
  const bytes = await readFile(new URL('../../../src-tauri/assets/models/dmeloper/dmeloper.glb', import.meta.url))
  const root = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene
  const spine = root.getObjectByName('Spine02')!
  const head = root.getObjectByName('Head')!
  const mesh = root.getObjectByName('VoxelHumanoidBase') as SkinnedMesh
  const authored = mesh.geometry.clone()
  const collar = createHeadbuttCollar(root, spine, head)
  head.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), MathUtils.degToRad(65)))
  collar.update(true)
  return { root, head, mesh, authored, collar }
}

describe('headbutt collar lifetime and topology', () => {
  it('retracts the upper front, fixes the waist and remains stable under held yaw', async () => {
    const rig = await fixture()
    try {
      const original = rig.authored.getAttribute('position')
      const positions = rig.mesh.geometry.getAttribute('position')
      let retracted = 0
      for (let index = 0; index < positions.count; index++) {
        if (original.getY(index) <= 12) assert.deepEqual([positions.getX(index), positions.getY(index), positions.getZ(index)], [original.getX(index), original.getY(index), original.getZ(index)])
        if (positions.getZ(index) < original.getZ(index) - 0.001) retracted++
      }
      assert.ok(retracted > 0)
      const stable = Array.from(positions.array)
      rig.head.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(3.2)))
      rig.collar.update(true)
      assert.deepEqual(Array.from(positions.array), stable, 'local yaw must not toggle collar compression')
      assert.deepEqual(rig.mesh.geometry.getAttribute('uv').array, rig.authored.getAttribute('uv').array)
      assert.deepEqual(rig.mesh.geometry.getIndex()!.array, rig.authored.getIndex()!.array)
      const normals = rig.mesh.geometry.getAttribute('normal')
      for (const value of normals.array) assert.ok(Number.isFinite(value))
      rig.collar.update(false)
      assert.deepEqual(positions.array, original.array)
      assert.deepEqual(normals.array, rig.authored.getAttribute('normal').array)
    } finally {
      rig.collar.dispose()
      rig.authored.dispose()
    }
  })

  it('forgets disposed skin geometries immediately while restoring each live replacement', async () => {
    const rig = await fixture()
    try {
      const retired = rig.mesh.geometry
      retired.dispose()
      const retiredPositions = retired.getAttribute('position')
      assert.ok(retiredPositions instanceof BufferAttribute)
      const retiredVersion = retiredPositions.version
      rig.mesh.geometry = rig.authored.clone()
      rig.collar.update(true)
      assert.notDeepEqual(rig.mesh.geometry.getAttribute('position').array, rig.authored.getAttribute('position').array)
      rig.collar.dispose()
      assert.equal(retiredPositions.version, retiredVersion, 'disposed geometry must no longer be retained or rewritten')
      assert.deepEqual(rig.mesh.geometry.getAttribute('position').array, rig.authored.getAttribute('position').array)
      assert.deepEqual(rig.mesh.geometry.getAttribute('normal').array, rig.authored.getAttribute('normal').array)
    } finally {
      rig.collar.dispose()
      rig.mesh.geometry.dispose()
      rig.authored.dispose()
    }
  })
})
