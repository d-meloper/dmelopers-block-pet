/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Group, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three'

import { createSkinFaceBounds, skinFaceRects } from './pixelFilter'
import { applyVoxelSkin, normalizeVoxelSkin } from './voxelSkin'

describe('whole-skin pixel filter', () => {
  it('keeps all Wide/Slim base and outer triangles inside their atlas face', () => {
    for (const model of ['wide', 'slim'] as const) {
      const rects = skinFaceRects(model)
      assert.equal(rects.length, 72)
      for (const [x0, y0, x1, y1] of rects) {
        const geometry = new PlaneGeometry()
        const uv = geometry.getAttribute('uv')
        for (let i = 0; i < uv.count; i++) {
          uv.setXY(i, (x0 + uv.getX(i) * (x1 - x0)) / 64, (y0 + uv.getY(i) * (y1 - y0)) / 64)
        }
        const bounds = createSkinFaceBounds(geometry, model)
        for (let i = 0; i < uv.count; i++) {
          assert.deepEqual(Array.from(bounds.array.slice(i * 4, i * 4 + 4)), [x0 + 0.5, y0 + 0.5, x1 - 0.5, y1 - 0.5])
        }
        geometry.dispose()
      }
    }
  })

  it('switches uniforms without replacing skin resources and restores geometry on disposal', () => {
    const root = new Group()
    const geometry = new PlaneGeometry()
    const material = new MeshStandardMaterial({ name: 'Voxel External Skin' })
    const palm = new MeshStandardMaterial({ name: 'Solid Palm' })
    const skinMesh = new Mesh(geometry, material)
    const palmMesh = new Mesh(geometry, palm)
    root.add(skinMesh, palmMesh)
    const skin = normalizeVoxelSkin({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(255) }, 'wide')
    const applied = applyVoxelSkin(root, skin, { materialNames: [material.name] })
    const filtered = skinMesh.material
    const shader = { uniforms: {}, vertexShader: '#include <uv_vertex>', fragmentShader: '#include <map_fragment>' }
    filtered.onBeforeCompile(shader as never, {} as never)
    const uniforms = shader.uniforms as { pixelFilterEnabled: { value: boolean } }
    const version = filtered.version
    let geometryDisposals = 0
    skinMesh.geometry.addEventListener('dispose', () => geometryDisposals++)
    for (const enabled of [true, false, true]) {
      applied.setPixelFilterEnabled(enabled)
      assert.equal(uniforms.pixelFilterEnabled.value, enabled)
      assert.equal(skinMesh.material, filtered)
      assert.equal(filtered.version, version)
      assert.equal(filtered.map, applied.texture)
    }
    assert.equal(palmMesh.material, palm)
    assert.equal(palmMesh.geometry, geometry)
    assert.notEqual(skinMesh.geometry, geometry)
    assert.ok(skinMesh.geometry.hasAttribute('skinFaceBounds'))
    assert.ok(!geometry.hasAttribute('skinFaceBounds'))
    applied.dispose()
    applied.dispose()
    assert.equal(skinMesh.geometry, geometry)
    assert.equal(skinMesh.material, material)
    assert.equal(geometryDisposals, 1)
    geometry.dispose()
    material.dispose()
    palm.dispose()
  })
})
