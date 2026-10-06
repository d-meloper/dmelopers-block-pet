import type { BufferGeometry, Color, DataArrayTexture } from 'three'

import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshBasicMaterial,
  SRGBColorSpace,
} from 'three'

import type { LegendPixels } from './legendPixels'

import { createPackedLegendTexture, packLegendCanvas } from './legendPixels'

// Array layers retain each glyph's original UV domain and independent mip chain.
// A conventional atlas would also need to preserve out-of-range ClampToEdge UVs.
export function createLegendBatch(
  geometry: BufferGeometry,
  count: number,
  color: Color,
  name: string,
  createCanvas: (text: string) => HTMLCanvasElement,
  anisotropy: number,
) {
  const layers = new InstancedBufferAttribute(new Float32Array(count), 1)
    .setUsage(DynamicDrawUsage)
  geometry.setAttribute('legendLayer', layers)
  const material = new MeshBasicMaterial({
    color,
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  material.customProgramCacheKey = () => 'keyboard-legend-array-v1'
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nattribute float legendLayer;\nvarying float vLegendLayer;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLegendLayer = legendLayer;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', 'uniform highp sampler2DArray map;\nvarying float vLegendLayer;')
      .replace('#include <map_fragment>', 'diffuseColor *= texture( map, vec3( vMapUv, vLegendLayer ) );')
  }
  const mesh = new InstancedMesh(geometry, material, count)
  mesh.name = name
  mesh.renderOrder = 1
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  const texts: string[] = []
  const indices = new Map<string, number>()
  const glyphs: LegendPixels[] = []
  let texture: DataArrayTexture | undefined
  let uploadedLayers = 0

  const setText = (instance: number, text: string) => {
    let layer = indices.get(text)
    if (layer === undefined) {
      layer = texts.length
      texts.push(text)
      indices.set(text, layer)
    }
    if (layers.getX(instance) === layer) return
    layers.setX(instance, layer)
    layers.needsUpdate = true
  }

  const flush = () => {
    if (uploadedLayers === texts.length) return
    for (let layer = uploadedLayers; layer < texts.length; layer++) {
      glyphs[layer] ??= packLegendCanvas(createCanvas(texts[layer]))
    }
    const next = createPackedLegendTexture(glyphs)
    next.name = name
    next.colorSpace = SRGBColorSpace
    next.minFilter = LinearMipmapLinearFilter
    next.magFilter = LinearFilter
    next.generateMipmaps = true
    next.anisotropy = anisotropy
    next.needsUpdate = true
    material.map = next
    if (!texture) material.needsUpdate = true
    texture?.dispose()
    texture = next
    uploadedLayers = texts.length
  }

  const dispose = () => {
    mesh.dispose()
    texture?.dispose()
    texture = undefined
    material.map = null
    texts.length = 0
    glyphs.length = 0
    indices.clear()
  }
  return { mesh, setText, flush, dispose }
}
