/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Vector3 } from 'three'

import { createDefaultDmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'
import { normalizeManualViewport, resizeAutoViewportPadding, viewportSizeChanged } from '@/features/scene/viewportSettings'
import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'

import renderer from '../three3d'
import { padContentRect, projectVisibleSceneBounds } from './projectedBounds'

function cameraFixture() {
  const root = new Group()
  const mesh = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial())
  const group = new Group()
  group.name = 'petGroup'
  group.add(mesh)
  root.add(group)
  const camera = new PerspectiveCamera(28, 500 / 422, 0.01, 100)
  const state = renderer as unknown as { sceneRoot: Group, camera: PerspectiveCamera, cameraPanX: number, cameraPanY: number, cameraDistancePercent: number }
  state.sceneRoot = root
  state.camera = camera
  state.cameraPanX = 0
  state.cameraPanY = 0
  state.cameraDistancePercent = 60
  renderer.refitComposition()
  return { root, camera, mesh, dispose: () => {
    mesh.geometry.dispose()
    mesh.material.dispose()
    renderer.destroy()
  } }
}

describe('scene viewport geometry and camera', () => {
  it('rejects a queued content scan when eyebrow depth moves visible geometry', async () => {
    const preset = createDefaultDmeloperEyebrowPreset()
    renderer.setDmeloperEyebrows({ ...preset, depthPercent: 0 })
    const measurement = renderer.measureVisibleContentRect()
    renderer.setDmeloperEyebrows({ ...preset, depthPercent: 200 })
    try {
      assert.deepEqual(await measurement, { status: 'stale' })
    } finally {
      renderer.setDmeloperEyebrows(preset)
    }
  })

  it('includes visible off-screen meshes and ignores hidden models and the depth-only desk', () => {
    const f = cameraFixture()
    try {
      f.mesh.position.x = 4
      const bounds = projectVisibleSceneBounds(f.root, f.camera, 500, 422)!
      assert.ok(bounds.x + bounds.width > 500)
      const hidden = new Mesh(new BoxGeometry(100, 100, 100), new MeshBasicMaterial())
      hidden.visible = false
      const desk = new Mesh(new BoxGeometry(50, 50, 50), new MeshBasicMaterial({ colorWrite: false }))
      f.root.add(hidden, desk)
      assert.deepEqual(projectVisibleSceneBounds(f.root, f.camera, 500, 422), bounds)
      desk.userData.excludeFromContentBounds = true
      desk.material.colorWrite = true
      assert.deepEqual(projectVisibleSceneBounds(f.root, f.camera, 500, 422), bounds)
    } finally {
      f.dispose()
    }
  })

  it('keeps orientation, distance and linear displacement identical while panning', () => {
    const f = cameraFixture()
    try {
      const start = f.camera.position.clone()
      const rotation = f.camera.quaternion.clone()
      renderer.setCameraPan(0, 0.5)
      const halfway = f.camera.position.clone().sub(start)
      renderer.setCameraPan(0, 1)
      const full = f.camera.position.clone().sub(start)
      assert.ok(full.distanceTo(halfway.multiplyScalar(2)) < 1e-9)
      assert.ok(f.camera.quaternion.angleTo(rotation) < 1e-7)
      assert.ok(Math.abs(full.dot(f.camera.getWorldDirection(new Vector3()))) < 1e-9)
      renderer.setCameraPan(1, 1)
      assert.ok(f.camera.position.clone().sub(start).sub(full).distanceTo(new Vector3(1, 0, 0)) < 1e-9)
    } finally {
      f.dispose()
    }
  })

  it('pads each side at the selected value and zoom without changing camera composition', () => {
    const f = cameraFixture()
    try {
      for (const zoom of [25, 75, 100, 125, 133.3, 150, 200]) {
        renderer.setCameraDistance(60 * 100 / zoom)
        const bounds = projectVisibleSceneBounds(f.root, f.camera, 500, 422)!
        let current = renderer.getConservativeContentRect()
        let previousPadding = 16
        for (const padding of [0, 1, 4, 8, 10, 15, 16, 17, 20, 29, 30, 0, 30, 16]) {
          current = resizeAutoViewportPadding(current, previousPadding, padding, zoom)
          renderer.setAutoViewportPadding(padding)
          assert.deepEqual(renderer.getConservativeContentRect(), padContentRect(bounds, Math.ceil(padding * zoom / 100)))
          assert.deepEqual(current, renderer.getConservativeContentRect())
          assert.deepEqual(projectVisibleSceneBounds(f.root, f.camera, 500, 422), bounds)
          previousPadding = padding
        }
      }
      const before = renderer.getConservativeContentRect()
      renderer.resizeOutput(100, 100)
      assert.deepEqual(renderer.getConservativeContentRect(), before)
    } finally {
      renderer.setAutoViewportPadding(16)
      f.dispose()
    }
  })

  it('zooms at a fixed camera distance without refitting moved geometry or crossing its near plane', () => {
    const f = cameraFixture()
    try {
      const start = f.camera.position.clone()
      const rotation = f.camera.quaternion.clone()
      const center = new Vector3(0.5, 0, 0).project(f.camera)
      f.mesh.position.x = 1.5
      renderer.setCameraDistance(30)
      assert.ok(f.camera.position.distanceTo(start) < 1e-9)
      assert.ok(f.camera.quaternion.angleTo(rotation) < 1e-7)
      const zoomed = new Vector3(0.5, 0, 0).project(f.camera)
      assert.ok(Math.abs(zoomed.x - center.x * 2) < 1e-9)
      assert.ok(Math.abs(zoomed.y - center.y * 2) < 1e-9)
      assert.equal(f.camera.zoom, 2)
    } finally {
      f.dispose()
    }
  })

  it('normalizes integer manual sizes, keeps the center on monitor clamp, and detects only size changes', () => {
    assert.deepEqual(normalizeManualViewport({ x: 10, y: 20, width: 2000, height: 1600 }, { width: 1000, height: 800 }), {
      x: 510,
      y: 420,
      width: 1000,
      height: 800,
    })
    assert.deepEqual(normalizeManualViewport({ x: 0, y: 0, width: 99.8, height: 100.2 }), { x: 0, y: 0, width: 100, height: 100 })
    assert.equal(viewportSizeChanged(undefined, { width: 500, height: 422 }), false)
    assert.equal(viewportSizeChanged({ width: 500, height: 422 }, { width: 500, height: 422 }), false)
    assert.equal(viewportSizeChanged({ width: 500, height: 422 }, { width: 501, height: 422 }), true)
  })
})

describe('scene and eyebrow persistence', () => {
  it('defaults automatic sizing ON and accepts 25% zoom plus persisted manual geometry', () => {
    setActivePinia(createPinia())
    const store = useBlockStore()
    assert.equal(createDefaultPet3dPreset().autoViewportEnabled, true)
    Object.assign(store.activePet3dPreset, {
      autoViewportEnabled: false,
      viewportModeRevision: 3,
      manualViewportRect: { x: -300.5, y: -200.5, width: 1251, height: 901 },
      cameraZoomPercent: 25,
    })
    store.init()
    assert.equal(store.activePet3dPreset.cameraZoomPercent, 25)
    assert.equal(store.activePet3dPreset.autoViewportEnabled, false)
    assert.equal(store.activePet3dPreset.viewportModeRevision, 3)
    assert.deepEqual(store.activePet3dPreset.manualViewportRect, { x: -300.5, y: -200.5, width: 1251, height: 901 })
  })

  it('keeps animation global across skin changes and restores it with eyebrow reset', () => {
    setActivePinia(createPinia())
    const store = useBlockStore()
    store.model.eyebrowAnimationEnabled = false
    store.resetDmeloperSkinToDefault()
    store.updateDmeloperEyebrows({ widthPixels: 3 })
    assert.equal(store.model.eyebrowAnimationEnabled, false)
    assert.equal('animationEnabled' in store.activePet3dPreset.dmeloperEyebrows, false)
    store.resetDmeloperEyebrows()
    assert.equal(store.model.eyebrowAnimationEnabled, true)
  })
})
