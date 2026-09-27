/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { Mesh, MeshStandardMaterial, ShaderChunk } from 'three'

import { installPixelFilter } from './pixelFilter'
import { installSoftShadows } from './softShadows'

it('composes high PCF with the skin filter without modifying shared shaders or recompiling toggles', () => {
  const original = ShaderChunk.shadowmap_pars_fragment
  const material = new MeshStandardMaterial()
  const mesh = new Mesh(undefined, material)
  const high = { value: true }
  const pixel = { value: false }
  installPixelFilter(material, pixel)
  installSoftShadows(mesh, high)
  const version = material.version
  installSoftShadows(mesh, high)
  assert.equal(material.version, version)
  const shader = {
    uniforms: {} as Record<string, { value: boolean }>,
    vertexShader: '#include <uv_vertex>',
    fragmentShader: '#include <map_fragment>\n#include <shadowmap_pars_fragment>',
  }
  material.onBeforeCompile(shader as never, {} as never)
  assert.match(shader.fragmentShader, /i < 16/)
  assert.match(shader.fragmentShader, /vogelDiskSample\( 4, 5, phi \)/)
  assert.match(shader.fragmentShader, /pixelFilterEnabled/)
  assert.equal(shader.uniforms.petHighShadows, high)
  assert.equal(shader.uniforms.pixelFilterEnabled, pixel)
  assert.equal(material.customProgramCacheKey(), 'skin-pixel-filter-v2|pet-soft-shadows-v1')
  high.value = false
  pixel.value = true
  assert.equal(shader.uniforms.petHighShadows.value, false)
  assert.equal(shader.uniforms.pixelFilterEnabled.value, true)
  assert.equal(material.version, version)
  assert.equal(ShaderChunk.shadowmap_pars_fragment, original)
  assert.notEqual(new MeshStandardMaterial().customProgramCacheKey(), material.customProgramCacheKey())
  mesh.geometry.dispose()
  material.dispose()
})
