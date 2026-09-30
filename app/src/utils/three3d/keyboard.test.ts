/* eslint-disable test/no-import-node-test */
import type { TestContext } from 'node:test'
import type { Box3, BufferGeometry, DirectionalLight, Material, Texture, Vector2, WebGLRenderer } from 'three'

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Color, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Raycaster, Scene, Vector3 } from 'three'

import { DEFAULT_DEVICE_COLORS, normalizeDeviceColors } from '@/config/deviceColors'
import { createDefaultLightingSettings } from '@/config/lighting'
import { MODEL_3D_CONFIG } from '@/config/model3d'
import { applyPresetVisualSettings } from '@/features/presets/visualSettings'
import { createDefaultPet3dPreset } from '@/stores/cat'

import type { MouseGroupResult } from './mouse'
import type { RenderCadence } from './renderCadence'

import { Three3DRenderer } from '../three3d'
import { createKeyboardGroup } from './keyboard'

const { interaction, palette } = MODEL_3D_CONFIG.keyboard
const customColors = {
  keyboardColor: '#aa2244',
  keyboardKeycapColor: '#229988',
  keyboardLegendColor: '#abcdef',
  keyboardPressedColor: '#6644ff',
  mouseColor: '#88ffaa',
  mousePressedColor: '#ff2288',
}

function installLegendCanvas(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const inkColors: string[] = []
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => {
        assert.equal(tag, 'canvas')
        const context = {
          fillStyle: '',
          clearRect: () => {},
          measureText: () => ({ width: 100 }),
          fillText: () => inkColors.push(context.fillStyle),
        }
        return { width: 0, height: 0, getContext: () => context }
      },
    },
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  return inkColors
}

function getMesh(group: Group, name: string) {
  const mesh = group.getObjectByName(name)
  assert.ok(mesh instanceof Mesh)
  assert.ok(mesh.material instanceof MeshStandardMaterial || mesh.material instanceof MeshBasicMaterial)
  return mesh as Mesh<BufferGeometry, MeshStandardMaterial | MeshBasicMaterial>
}

function sameColor(actual: Color, expected: Color) {
  for (const channel of ['r', 'g', 'b'] as const) {
    assert.ok(Math.abs(actual[channel] - expected[channel]) < 1e-12, `${channel}: ${actual[channel]} != ${expected[channel]}`)
  }
}

describe('keyboard color and input feedback', () => {
  it('normalizes incomplete colors and preserves the original default palette', (t) => {
    installLegendCanvas(t)
    const keyboard = createKeyboardGroup()
    t.after(keyboard.dispose)
    assert.deepEqual(normalizeDeviceColors(undefined), DEFAULT_DEVICE_COLORS)
    assert.deepEqual(normalizeDeviceColors({ keyboardColor: '#AaBbCc', mouseColor: 'red', keyboardLegendColor: '#abcd' }), {
      ...DEFAULT_DEVICE_COLORS,
      keyboardColor: '#aabbcc',
    })
    const housing = getMesh(keyboard.group, 'keyboard-housing')
    const keycap = getMesh(keyboard.group, 'keyboard-key-r1-c1')
    const legend = getMesh(keyboard.group, 'keyboard-key-r1-c1-legend')
    sameColor(housing.material.color, new Color(palette.housing))
    sameColor(keycap.material.color, new Color(palette.keycap))
    sameColor(legend.material.color, new Color(palette.legend))
    keyboard.setColors(DEFAULT_DEVICE_COLORS)
    sameColor(housing.material.color, new Color(palette.housing))
    sameColor(keycap.material.color, new Color(palette.keycap))
    sameColor(legend.material.color, new Color(palette.legend))
  })

  it('recolors held and releasing keys at their existing progress without replacing meshes', (t) => {
    installLegendCanvas(t)
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const keyboard = createKeyboardGroup()
    t.after(keyboard.dispose)
    const keycap = getMesh(keyboard.group, 'keyboard-key-r1-c1')
    const idleKeycap = getMesh(keyboard.group, 'keyboard-key-r1-c2')
    const originalGeometry = keycap.geometry
    const originalMaterial = keycap.material
    const homeY = keycap.parent!.position.y
    keyboard.setKeyPressed('KeyQ', true)
    keyboard.update(interaction.pressDurationMs / 2, now)
    const halfwayY = keycap.parent!.position.y
    assert.equal(halfwayY, homeY - interaction.pressTravel / 2)
    keyboard.setColors(customColors)
    assert.equal(keycap.parent!.position.y, halfwayY)
    sameColor(keycap.material.color, new Color(customColors.keyboardKeycapColor).lerp(new Color(customColors.keyboardPressedColor), 0.5))
    sameColor(idleKeycap.material.color, new Color(customColors.keyboardKeycapColor))
    sameColor(getMesh(keyboard.group, 'keyboard-housing').material.color, new Color(customColors.keyboardColor))
    now += 1000
    keyboard.update(interaction.pressDurationMs, now)
    sameColor(keycap.material.color, new Color(customColors.keyboardPressedColor))
    keyboard.setContactPressed({ row: 1, column: 1 }, false)
    keyboard.update(interaction.releaseDurationMs / 2, now)
    const releasingColors = { ...customColors, keyboardKeycapColor: '#ff0000', keyboardPressedColor: '#0000ff' }
    keyboard.setColors(releasingColors)
    assert.equal(keycap.parent!.position.y, halfwayY)
    sameColor(keycap.material.color, new Color('#ff0000').lerp(new Color('#0000ff'), 0.5))
    keyboard.update(interaction.releaseDurationMs / 2, now + interaction.releaseDurationMs)
    sameColor(keycap.material.color, new Color(releasingColors.keyboardKeycapColor))
    assert.equal(keycap.parent!.position.y, homeY)
    assert.equal(keycap.geometry, originalGeometry)
    assert.equal(keycap.material, originalMaterial)
  })

  it('tints cached and new language legends without allocating textures for color edits and disposes every cache', (t) => {
    const inkColors = installLegendCanvas(t)
    const keyboard = createKeyboardGroup()
    t.after(keyboard.dispose)
    const materials = new Set<Material>()
    const textures = new Set<Texture>()
    const geometries = new Set<BufferGeometry>()
    const collect = () => keyboard.group.traverse((object) => {
      if (!(object instanceof Mesh)) return
      geometries.add(object.geometry)
      materials.add(object.material)
      if (object.material instanceof MeshBasicMaterial && object.material.map) {
        textures.add(object.material.map)
        sameColor(object.material.color, new Color(customColors.keyboardLegendColor))
      }
    })
    keyboard.setColors(customColors)
    collect()
    const koreanMaterial = getMesh(keyboard.group, 'keyboard-key-r1-c1-legend').material
    const koreanTextureCount = inkColors.length
    keyboard.setColors({ ...customColors, keyboardColor: '#112233' })
    assert.equal(inkColors.length, koreanTextureCount)
    keyboard.setLegendLanguage('en')
    collect()
    const englishMaterial = getMesh(keyboard.group, 'keyboard-key-r1-c1-legend').material
    assert.notEqual(englishMaterial, koreanMaterial)
    assert.equal(inkColors.length, koreanTextureCount + 26)
    for (let index = 0; index < 5; index++) {
      keyboard.setColors({ ...customColors, keyboardLegendColor: '#000000' })
      keyboard.setLegendLanguage('ko')
      assert.equal(getMesh(keyboard.group, 'keyboard-key-r1-c1-legend').material, koreanMaterial)
      sameColor(koreanMaterial.color, new Color('#000000'))
      keyboard.setColors(customColors)
      keyboard.setLegendLanguage('en')
      assert.equal(getMesh(keyboard.group, 'keyboard-key-r1-c1-legend').material, englishMaterial)
      sameColor(englishMaterial.color, new Color(customColors.keyboardLegendColor))
    }
    assert.equal(inkColors.length, koreanTextureCount + 26)
    assert.ok(inkColors.every(color => color === '#ffffff'))
    let disposals = 0
    for (const resource of [...materials, ...textures, ...geometries]) {
      resource.addEventListener('dispose', () => disposals++)
    }
    keyboard.dispose()
    keyboard.dispose()
    assert.equal(disposals, materials.size + textures.size + geometries.size)
    assert.equal(keyboard.group.children.length, 0)
  })
})

describe('rounded sculpt keyboard compatibility', () => {
  it('retains housing dimensions, all key footprints and the existing hand targets', (t) => {
    installLegendCanvas(t)
    const keyboard = createKeyboardGroup()
    t.after(keyboard.dispose)
    const housing = getMesh(keyboard.group, 'keyboard-housing')
    const housingSize = housing.geometry.boundingBox!.getSize(new Vector3())
    ;[3.3, 0.1, 1.16].forEach((value, index) => assert.ok(Math.abs(housingSize.getComponent(index) - value) < 1e-6))
    let keys = 0
    const widths = new Map<number, BufferGeometry>()
    keyboard.group.traverse((object) => {
      if (!(object instanceof Mesh) || !/^keyboard-key-r\d+-c\d+$/.test(object.name)) return
      keys += 1
      const units = object.userData.units as number
      const size = (object.geometry.boundingBox as Box3).getSize(new Vector3())
      assert.ok(Math.abs(size.x - (units * 3.08 / 16 - 0.014)) < 1e-6)
      assert.ok(Math.abs(size.y - 0.105) < 1e-6)
      assert.ok(Math.abs(size.z - 0.18) < 1e-6)
      if (widths.has(units)) assert.equal(widths.get(units), object.geometry)
      else widths.set(units, object.geometry)
    })
    assert.equal(keys, 67)
    for (const [key, x, z] of [['KeyF', -0.5053125, 0], ['PageUp', 1.4196875, 0], ['Space', -0.1684375, 0.41]] as const) {
      const position = keyboard.getKeyTarget(key)!.position
      ;[x, 0.217, z].forEach((value, index) => assert.ok(Math.abs(position[index] - value) < 1e-10, key))
    }
  })

  it('recesses the cap center and keeps lettering just above the same dish, including wide keys', (t) => {
    installLegendCanvas(t)
    const keyboard = createKeyboardGroup()
    t.after(keyboard.dispose)
    keyboard.group.updateMatrixWorld(true)
    for (const name of ['keyboard-key-r1-c1', 'keyboard-key-r4-c3']) {
      const keycap = getMesh(keyboard.group, name)
      const legend = getMesh(keyboard.group, `${name}-legend`)
      const origin = keycap.getWorldPosition(new Vector3())
      const width = keycap.geometry.boundingBox!.getSize(new Vector3()).x
      for (const [x, z] of [[0, 0], [width * 0.25, 0.025], [-width * 0.25, -0.025]]) {
        const ray = new Raycaster(new Vector3(origin.x + x, 1, origin.z + z), new Vector3(0, -1, 0))
        const capHit = ray.intersectObject(keycap)[0]
        const legendHit = ray.intersectObject(legend)[0]
        assert.ok(capHit && legendHit, `${name}: missing upward surface`)
        assert.ok(Math.abs(legendHit.point.y - capHit.point.y - 0.0006) < 1e-6)
        if (x === 0) assert.ok(Math.abs(capHit.point.y - (origin.y + 0.105 / 2 - 0.0055)) < 1e-6)
      }
      const normals = keycap.geometry.getAttribute('normal')
      for (let index = 0; index < normals.count; index += 1) {
        assert.ok(Math.abs(new Vector3().fromBufferAttribute(normals, index).length() - 1) < 1e-5)
      }
      const uv = legend.geometry.getAttribute('uv')
      const positions = legend.geometry.getAttribute('position')
      for (let index = 0; index < positions.count; index += 1) {
        assert.ok(Math.abs(uv.getX(index) - (positions.getX(index) / (width * 0.82) + 0.5)) < 1e-6)
        assert.ok(Math.abs(uv.getY(index) - (0.5 - positions.getZ(index) / (0.18 * 0.8))) < 1e-6)
      }
    }
  })
})

describe('device colors through the shared preset renderer path', () => {
  it('retains key lighting after scene recreation and keeps fixed output with common shadow quality', (t) => {
    installLegendCanvas(t)
    const renderer = new Three3DRenderer()
    const state = renderer as unknown as {
      scene: Scene
      sceneRoot: Group
      renderer?: WebGLRenderer
      directionalLight: DirectionalLight
      buildScene: (scene: Scene, root: Group) => void
    }
    t.after(() => {
      state.renderer = undefined
      renderer.destroy()
    })
    const lighting = createDefaultLightingSettings()
    lighting.key.color = '#123456'
    lighting.key.azimuthDegrees = 45
    lighting.key.strengthPercent = 125
    renderer.setLightingSettings(lighting)
    const build = () => {
      state.scene = new Scene()
      state.sceneRoot = new Group()
      state.buildScene(state.scene, state.sceneRoot)
    }
    build()
    sameColor(state.directionalLight.color, new Color('#123456'))
    const key = getMesh(state.sceneRoot, 'keyboard-key-r1-c1')
    const material = key.material
    const geometry = key.geometry
    const light = state.directionalLight
    state.renderer = {
      shadowMap: { enabled: true },
      getDrawingBufferSize: (target: Vector2) => target.set(512, 512),
      capabilities: { maxTextureSize: 2048 },
    } as unknown as WebGLRenderer
    renderer.setShadowQuality('high')
    lighting.key.elevationDegrees = 20
    renderer.setLightingSettings(lighting)
    assert.equal(state.renderer.toneMappingExposure, 1)
    assert.equal(light.shadow.mapSize.x, 1024)
    assert.equal(light.shadow.radius, 4)
    renderer.setShadowsEnabled(false)
    lighting.key.azimuthDegrees = 90
    renderer.setLightingSettings(lighting)
    assert.equal(state.renderer.shadowMap.enabled, false)
    assert.equal(state.directionalLight, light)
    assert.equal(key.geometry, geometry)
    assert.equal(key.material, material)
    state.renderer = undefined
    renderer.destroy()
    build()
    assert.notEqual(state.directionalLight, light)
    sameColor(state.directionalLight.color, new Color('#123456'))
    assert.equal(state.directionalLight.intensity, 3.875)
    assert.equal(state.scene.getObjectByName('lighting-fill'), undefined)
    assert.ok(state.directionalLight.position.x > 0)
    assert.ok(Math.abs(state.directionalLight.position.z) < 1e-10)
  })

  it('moves the desk and devices together without accumulating scale offsets or moving the pet', (t) => {
    installLegendCanvas(t)
    const renderer = new Three3DRenderer()
    const state = renderer as unknown as {
      scene: Scene
      sceneRoot: Group
      buildScene: (scene: Scene, root: Group) => void
    }
    t.after(() => renderer.destroy())
    const preset = createDefaultPet3dPreset()
    const build = () => {
      state.scene = new Scene()
      state.sceneRoot = new Group()
      state.buildScene(state.scene, state.sceneRoot)
    }
    build()
    const pet = state.sceneRoot.getObjectByName('petGroup')!
    const petPosition = pet.position.clone()
    for (const height of [-1, 0, 1, 0.25]) {
      for (const scale of [50, 100, 200, 50]) {
        Object.assign(preset, { deskTransparent: false, deskColor: '#123456', deskHeightOffset: height, keyboardScalePercent: scale, mouseScalePercent: scale })
        applyPresetVisualSettings(renderer, preset)
        const desk = getMesh(state.sceneRoot, 'desk')
        assert.equal(desk.material.colorWrite, true)
        assert.equal(desk.material.depthWrite, true)
        assert.equal(desk.castShadow, false)
        assert.equal(desk.receiveShadow, true)
        assert.ok(Math.abs(desk.position.y - (MODEL_3D_CONFIG.desk.position[1] - MODEL_3D_CONFIG.objectVerticalGap + height)) < 1e-12)
        sameColor(desk.material.color, new Color('#123456'))
        for (const device of ['keyboard', 'mouse'] as const) {
          const group = state.sceneRoot.getObjectByName(`${device}Group`)!
          const config = MODEL_3D_CONFIG[device]
          assert.ok(Math.abs(group.position.y - (config.position[1] + height + MODEL_3D_CONFIG.objectVerticalGap * (scale / 100 - 1))) < 1e-12)
          assert.equal(group.scale.x, config.scale * scale / 100)
        }
        assert.deepEqual(pet.position, petPosition)
        renderer.setDeskSettings({ ...preset, deskTransparent: true })
        assert.equal(desk.material.colorWrite, false)
        sameColor(desk.material.color, new Color('#123456'))
      }
    }
    renderer.destroy()
    build()
    assert.equal(getMesh(state.sceneRoot, 'desk').material.colorWrite, false)
    assert.ok(Math.abs(getMesh(state.sceneRoot, 'desk').position.y - (MODEL_3D_CONFIG.desk.position[1] - MODEL_3D_CONFIG.objectVerticalGap + 0.25)) < 1e-12)
  })

  it('retains colors and language through scene recreation and only wakes idle rendering for actual changes', (t) => {
    installLegendCanvas(t)
    let now = 0
    t.mock.method(performance, 'now', () => now)
    const renderer = new Three3DRenderer()
    const state = renderer as unknown as {
      scene: Scene
      sceneRoot: Group
      keyboard: ReturnType<typeof createKeyboardGroup>
      mouse: MouseGroupResult
      renderCadence: RenderCadence
      contentMeasurementGeneration: number
      buildScene: (scene: Scene, root: Group) => void
    }
    t.after(() => renderer.destroy())
    const preset = { ...createDefaultPet3dPreset(), ...customColors, keyboardLegendLanguage: 'en' as const, mouseEnabled: false }
    applyPresetVisualSettings(renderer, preset)
    renderer.setIdlePowerSavingEnabled(true)
    const build = () => {
      state.scene = new Scene()
      state.sceneRoot = new Group()
      state.buildScene(state.scene, state.sceneRoot)
      sameColor(getMesh(state.keyboard.group, 'keyboard-housing').material.color, new Color(customColors.keyboardColor))
      const legend = getMesh(state.keyboard.group, 'keyboard-key-r1-c1-legend')
      assert.ok(legend.material instanceof MeshBasicMaterial)
      assert.equal(legend.material.map!.name, 'keyboard-legend-Q')
      sameColor(legend.material.color, new Color(customColors.keyboardLegendColor))
      sameColor(getMesh(state.mouse.group, 'mouseBody').material.color, new Color(MODEL_3D_CONFIG.mouse.palette.body).multiply(new Color(customColors.mouseColor)))
      assert.equal(state.mouse.group.visible, false)
    }
    build()
    now = 6000
    const measurement = state.contentMeasurementGeneration
    assert.equal(state.renderCadence.getFrameLimit(now, 60), 15)
    renderer.setDeviceColors({ ...customColors, keyboardLegendColor: '#ABCDEF' })
    assert.equal(state.renderCadence.getFrameLimit(now, 60), 15)
    renderer.setDeviceColors({ ...customColors, keyboardLegendColor: '#123456' })
    assert.equal(state.renderCadence.getFrameLimit(now, 60), 60)
    assert.equal(state.contentMeasurementGeneration, measurement)
    applyPresetVisualSettings(renderer, preset)
    renderer.destroy()
    build()
    renderer.setMouseEnabled(true)
    renderer.handleSemanticInput({ kind: 'mouse_primary', active: true })
    state.mouse.update(MODEL_3D_CONFIG.mouse.interaction.pressDurationMs, now)
    sameColor(getMesh(state.mouse.group, 'mouseRightButton').material.color, new Color(customColors.mousePressedColor))
  })
})
