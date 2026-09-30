/* eslint-disable test/no-import-node-test */
import type { WebGLRenderer } from 'three'

import assert from 'node:assert/strict'
import { it } from 'node:test'
import { BoxGeometry, Color, Group, Light, Mesh, MeshStandardMaterial, NoToneMapping, Scene, Vector3 } from 'three'

import { createDefaultLightingSettings } from '@/config/lighting'

import { applyLightingOutput, SceneLighting } from './sceneLighting'

it('restores pre-pastel output and adjusts key strength around the original intensity', () => {
  const rig = new SceneLighting()
  const settings = createDefaultLightingSettings()
  rig.apply(settings)
  assert.ok(rig.key.position.clone().normalize().distanceTo(new Vector3(-3.4, 5.2, 4.2).normalize()) < 0.002)
  assert.ok(rig.key.color.equals(new Color('#ffffff')))
  const objects = [...rig.group.children]
  settings.key.color = '#123456'
  settings.key.azimuthDegrees = 90
  settings.key.elevationDegrees = 0
  // Retired persisted choices must have no effect even at the renderer boundary.
  Object.assign(settings, { toneMapping: 'none', exposurePercent: 400, brightnessPercent: 0, referenceFrame: 'scene', fill: { enabled: true }, hemisphere: { enabled: false }, shadow: { enabled: false } })
  Object.assign(settings.key, { enabled: false, intensityPercent: 0 })
  rig.apply(settings)
  assert.equal(rig.key.intensity, 3.1)
  assert.equal(rig.hemisphere.intensity, 2.15)
  assert.ok(rig.hemisphere.color.equals(new Color('#ffffff')))
  assert.ok(rig.hemisphere.groundColor.equals(new Color('#647080')))
  assert.ok(rig.hemisphere.position.clone().normalize().equals(new Vector3(0, 1, 0)))
  assert.ok(rig.key.color.equals(new Color('#123456')))
  assert.ok(rig.key.position.clone().normalize().distanceTo(new Vector3(1, 0, 0)) < 1e-12)
  assert.equal(rig.key.castShadow, true)
  assert.equal(rig.key.shadow.intensity, 1)
  assert.equal(rig.key.shadow.bias, -0.0004)
  assert.equal(rig.key.shadow.normalBias, 0)
  assert.equal(rig.group.rotation.y, 0)
  assert.equal(rig.group.children.filter(child => child instanceof Light).length, 2)
  assert.deepEqual(rig.group.children, objects)
  const output = {} as WebGLRenderer
  applyLightingOutput(output)
  assert.equal(output.toneMapping, NoToneMapping)
  assert.equal(output.toneMappingExposure, 1)
  for (const strength of [25, 75, 100, 125, 200]) {
    settings.key.strengthPercent = strength
    rig.apply(settings)
    assert.equal(rig.key.intensity, 3.1 * strength / 100)
    assert.equal(rig.hemisphere.intensity, 2.15)
    assert.deepEqual(rig.group.children, objects)
  }
  rig.key.shadow.dispose()
})

it('fits shadow projection at opposite/polar directions and after device movement', (t) => {
  const scene = new Scene()
  const root = new Group()
  const mesh = new Mesh(new BoxGeometry(4, 3, 2), new MeshStandardMaterial())
  t.after(() => {
    mesh.geometry.dispose()
    mesh.material.dispose()
  })
  root.add(mesh)
  const rig = new SceneLighting()
  t.after(() => rig.key.shadow.dispose())
  scene.add(root, rig.group)
  const settings = createDefaultLightingSettings()
  for (const elevation of [-90, 0, 90]) {
    for (const azimuth of [-180, 0, 180]) {
      mesh.position.set(azimuth / 20, 1, 3)
      settings.key.elevationDegrees = elevation
      settings.key.azimuthDegrees = azimuth
      root.rotation.y = 0.8
      rig.apply(settings)
      rig.fitShadow(root, settings)
      rig.key.shadow.updateMatrices(rig.key)
      for (const x of [-2, 2]) {
        for (const y of [-1.5, 1.5]) {
          for (const z of [-1, 1]) {
            const ndc = mesh.localToWorld(new Vector3(x, y, z)).project(rig.key.shadow.camera)
            assert.ok([ndc.x, ndc.y, ndc.z].every(value => Number.isFinite(value) && Math.abs(value) < 1))
          }
        }
      }
    }
  }
})
