/* eslint-disable test/no-import-node-test */
import type { TestContext } from 'node:test'
import type { BufferGeometry, Material, Texture } from 'three'

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Color, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Scene } from 'three'

import { DEFAULT_DEVICE_COLORS, normalizeDeviceColors } from '@/config/deviceColors'
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

describe('device colors through the shared preset renderer path', () => {
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
