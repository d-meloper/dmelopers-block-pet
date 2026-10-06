import type { Object3D, WebGLRenderer } from 'three'

import { Box3, DirectionalLight, Group, HemisphereLight, MathUtils, Mesh, NoToneMapping, Vector3 } from 'three'

import type { LightingSettings } from '@/config/lighting'

import { forEachMeshWorldBounds } from './meshBounds'

/** Original pre-pastel output, shared by desktop, OBS and thumbnails. */
export function applyLightingOutput(renderer: WebGLRenderer): void {
  renderer.toneMapping = NoToneMapping
  renderer.toneMappingExposure = 1
}

function direction(settings: LightingSettings['key']): Vector3 {
  const azimuth = MathUtils.degToRad(settings.azimuthDegrees)
  const elevation = MathUtils.degToRad(settings.elevationDegrees)
  return new Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation))
}

/** Key color, direction and relative strength are editable; lights stay fixed in world space. */
export class SceneLighting {
  readonly group = new Group()
  readonly key = new DirectionalLight(0xFFFFFF, 3.1)
  readonly hemisphere = new HemisphereLight(0xFFFFFF, 0x647080, 2.15)

  constructor() {
    this.group.name = 'sceneLighting'
    this.key.name = 'lighting-key'
    this.group.add(this.key, this.key.target, this.hemisphere)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(512, 512)
    this.key.shadow.bias = -0.0004
  }

  apply(settings: LightingSettings): void {
    this.key.color.set(settings.key.color)
    this.key.intensity = 3.1 * settings.key.strengthPercent / 100
    this.key.position.copy(direction(settings.key).multiplyScalar(7.5))
    this.key.target.position.set(0, 0, 0)
  }

  fitShadow(root: Object3D, settings: LightingSettings): void {
    root.updateWorldMatrix(true, true)
    this.group.updateWorldMatrix(true, true)
    const bounds = new Box3()
    const world = new Box3()
    root.traverseVisible((object) => {
      if (!(object instanceof Mesh) || object.userData.excludeFromContentBounds) return
      forEachMeshWorldBounds(object, world, box => bounds.union(box))
    })
    if (bounds.isEmpty()) bounds.setFromCenterAndSize(new Vector3(), new Vector3(4, 4, 4))
    // Reserve animated hands/mouse/key travel without refitting on every frame.
    const radius = Math.max(1, bounds.getSize(new Vector3()).length() / 2 + 0.75)
    const center = this.group.worldToLocal(bounds.getCenter(new Vector3()))
    this.key.target.position.copy(center)
    this.key.position.copy(direction(settings.key).multiplyScalar(radius + 1).add(center))
    const camera = this.key.shadow.camera
    camera.up.set(0, Math.abs(direction(settings.key).y) > 0.999 ? 0 : 1, Math.abs(direction(settings.key).y) > 0.999 ? 1 : 0)
    camera.left = camera.bottom = -radius
    camera.right = camera.top = radius
    camera.near = 0.1
    camera.far = radius * 2 + 2
    camera.updateProjectionMatrix()
    this.group.updateWorldMatrix(true, true)
    this.key.shadow.needsUpdate = true
  }
}
