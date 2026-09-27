import type { Material, Object3D } from 'three'

import { Mesh, ShaderChunk } from 'three'

const installed = new WeakSet<Material>()
const stockPCF = /shadow = \(\s*texture\( shadowMap,[\s\S]*?\) \* 0\.2;/
const softPCF = ShaderChunk.shadowmap_pars_fragment.replace(stockPCF, original => `
  if (petHighShadows) {
    shadow = 0.0;
    for (int i = 0; i < 16; i++) {
      shadow += texture(shadowMap, vec3(shadowCoord.xy + vogelDiskSample(i, 16, phi) * radius, shadowCoord.z));
    }
    shadow *= 0.0625;
  } else {
    ${original}
  }
`)

/** Compose after skin hooks; never change Three's shared chunks or other scenes. */
export function installSoftShadows(root: Object3D, enabled: { value: boolean }): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of materials) {
      if (installed.has(material)) continue
      if (!['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshPhongMaterial', 'MeshLambertMaterial', 'ShadowMaterial'].includes(material.type)) continue
      if (softPCF === ShaderChunk.shadowmap_pars_fragment) throw new Error('Unsupported Three.js PCF shader')
      const beforeCompile = material.onBeforeCompile
      const cacheKey = material.customProgramCacheKey()
      material.onBeforeCompile = function (shader, renderer) {
        beforeCompile.call(this, shader, renderer)
        shader.uniforms.petHighShadows = enabled
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <shadowmap_pars_fragment>',
          `uniform bool petHighShadows;\n${softPCF}`,
        )
      }
      material.customProgramCacheKey = () => `${cacheKey}|pet-soft-shadows-v1`
      material.needsUpdate = true
      installed.add(material)
    }
  })
}
