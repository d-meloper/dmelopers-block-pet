/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } from 'three'

import { renderPetHealthFrame } from './renderHealth'

test('health requires a draw from the selected pet and restores temporary hooks after success or failure', () => {
  const scene = new Scene()
  const camera = new PerspectiveCamera()
  const pet = new Group()
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ opacity: 0, transparent: true }))
  pet.add(mesh)
  scene.add(pet)
  const originalBefore = mesh.onBeforeRender
  const originalAfter = mesh.onAfterRender
  let mode: 'background' | 'empty' | 'lost' | 'pet' | 'throw' = 'pet'
  const gl = { NO_ERROR: 0, isContextLost: () => mode === 'lost', getError: () => 0 }
  const info = { render: { calls: 0 } }
  const renderer = {
    info,
    getContext: () => gl,
    render: () => {
      assert.equal(mesh.frustumCulled, false)
      info.render.calls = 4 // A keyboard/background draw cannot prove pet health.
      if (mode === 'throw') throw new Error('draw failed')
      if (mode === 'background') return
      const args = [renderer, scene, camera, mesh.geometry, mesh.material, null] as unknown as Parameters<typeof mesh.onBeforeRender>
      mesh.onBeforeRender(...args)
      if (mode === 'pet') info.render.calls++
      mesh.onAfterRender(...args)
    },
  } as unknown as Parameters<typeof renderPetHealthFrame>[0]
  for (mode of ['pet', 'background', 'empty', 'lost'] as const) {
    assert.equal(renderPetHealthFrame(renderer, scene, camera, pet), mode === 'pet')
    assert.equal(mesh.frustumCulled, true)
    assert.equal(mesh.onBeforeRender, originalBefore)
    assert.equal(mesh.onAfterRender, originalAfter)
    assert.equal(mesh.material.opacity, 0)
  }
  mode = 'throw'
  assert.throws(() => renderPetHealthFrame(renderer, scene, camera, pet), /draw failed/)
  assert.equal(mesh.frustumCulled, true)
  assert.equal(mesh.onBeforeRender, originalBefore)
  assert.equal(mesh.onAfterRender, originalAfter)
})
