import type { BufferGeometry, Material } from 'three'

import { Float32BufferAttribute, ShaderChunk } from 'three'

type FaceRect = readonly [number, number, number, number]

/** Java 64x64 atlas islands, including all six base and outer body parts. */
export function skinFaceRects(model: 'wide' | 'slim'): FaceRect[] {
  const arm = model === 'slim' ? 3 : 4
  return [
    [0, 0, 8, 8, 8],
    [32, 0, 8, 8, 8],
    [16, 16, 8, 12, 4],
    [16, 32, 8, 12, 4],
    [0, 16, 4, 12, 4],
    [0, 32, 4, 12, 4],
    [16, 48, 4, 12, 4],
    [0, 48, 4, 12, 4],
    [40, 16, arm, 12, 4],
    [40, 32, arm, 12, 4],
    [32, 48, arm, 12, 4],
    [48, 48, arm, 12, 4],
  ].flatMap(([u, v, w, h, d]): FaceRect[] => [
    [u, v + d, u + d, v + d + h],
    [u + d + w, v + d, u + 2 * d + w, v + d + h],
    [u + d, v + d, u + d + w, v + d + h],
    [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h],
    [u + d, v, u + d + w, v + d],
    [u + d + w, v, u + d + 2 * w, v + d],
  ])
}

/** Assign one island per triangle, so UVs exactly on an edge cannot change islands. */
export function createSkinFaceBounds(geometry: BufferGeometry, model: 'wide' | 'slim'): Float32BufferAttribute {
  const uv = geometry.getAttribute('uv')
  const bounds = new Float32Array(geometry.getAttribute('position').count * 4)
  if (!uv) return new Float32BufferAttribute(bounds, 4)
  const rects = skinFaceRects(model)
  const index = geometry.getIndex()
  const count = index?.count ?? uv.count
  for (let i = 0; i + 2 < count; i += 3) {
    const vertices = [0, 1, 2].map(offset => index ? index.getX(i + offset) : i + offset)
    const x = vertices.reduce((sum, vertex) => sum + uv.getX(vertex) * 64, 0) / 3
    const y = vertices.reduce((sum, vertex) => sum + uv.getY(vertex) * 64, 0) / 3
    const rect = rects.find(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)
    if (!rect) continue
    for (const vertex of vertices) bounds.set([rect[0] + 0.5, rect[1] + 0.5, rect[2] - 0.5, rect[3] - 0.5], vertex * 4)
  }
  return new Float32BufferAttribute(bounds, 4)
}

/**
 * Screen-footprint interpolation with face-clamped, alpha-weighted RGB taps.
 * Keep nearest alpha: the original skin owns coverage and outer-layer topology.
 * See https://themaister.net/blog/2018/08/25/pseudo-bandlimited-pixel-art-filtering-in-3d-a-mathematical-derivation/
 */
export function installPixelFilter(material: Material, enabled: { value: boolean }): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.pixelFilterEnabled = enabled
    shader.vertexShader = `attribute vec4 skinFaceBounds; varying vec4 vSkinFaceBounds;\n${shader.vertexShader}`
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSkinFaceBounds = skinFaceBounds;')
    shader.fragmentShader = `uniform bool pixelFilterEnabled; varying vec4 vSkinFaceBounds;\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', ShaderChunk.map_fragment.replace(
        'vec4 sampledDiffuseColor = texture2D( map, vMapUv );',
        `vec2 pixel = vMapUv * 64.0;
        // MSAA may interpolate the pixel center outside the covered triangle.
        // Clamp nearest RGBA too, so adjacent atlas alpha cannot punch a seam.
        vec2 nearestUv = vSkinFaceBounds.z > vSkinFaceBounds.x
          ? clamp(pixel, vSkinFaceBounds.xy, vSkinFaceBounds.zw) / 64.0
          : vMapUv;
        vec4 sampledDiffuseColor = texture2D(map, nearestUv);
        vec2 footprint = clamp(fwidth(pixel), vec2(0.0001), vec2(1.0));
        if (pixelFilterEnabled && vSkinFaceBounds.z > vSkinFaceBounds.x) {
          vec2 cell = floor(pixel - 0.5);
          vec2 phase = fract(pixel - 0.5);
          vec2 blend = smoothstep(vec2(0.5) - footprint * 0.5, vec2(0.5) + footprint * 0.5, phase);
          vec2 lo = clamp(cell + 0.5, vSkinFaceBounds.xy, vSkinFaceBounds.zw) / 64.0;
          vec2 hi = clamp(cell + 1.5, vSkinFaceBounds.xy, vSkinFaceBounds.zw) / 64.0;
          vec4 a = texture2D(map, lo);
          vec4 b = texture2D(map, vec2(hi.x, lo.y));
          vec4 c = texture2D(map, vec2(lo.x, hi.y));
          vec4 d = texture2D(map, hi);
          a.rgb *= a.a; b.rgb *= b.a; c.rgb *= c.a; d.rgb *= d.a;
          vec4 filtered = mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y);
          if (filtered.a > 0.00001) sampledDiffuseColor.rgb = filtered.rgb / filtered.a;
        }`,
      ))
  }
  material.customProgramCacheKey = () => 'skin-pixel-filter-v2'
}
