/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Color, Mesh, MeshStandardMaterial } from 'three'

import { DEFAULT_DEVICE_COLORS } from '@/config/deviceColors'
import { MODEL_3D_CONFIG } from '@/config/model3d'

import { createMouseGroup } from './mouse'

const { interaction, palette } = MODEL_3D_CONFIG.mouse

function getMesh(mouse: ReturnType<typeof createMouseGroup>, name: string) {
  const mesh = mouse.group.getObjectByName(name)
  assert.ok(mesh instanceof Mesh)
  assert.ok(mesh.material instanceof MeshStandardMaterial)
  return mesh as Mesh<import('three').BufferGeometry, MeshStandardMaterial>
}

function sameColor(actual: Color, expected: Color) {
  for (const channel of ['r', 'g', 'b'] as const) {
    assert.ok(Math.abs(actual[channel] - expected[channel]) < 1e-12)
  }
}

describe('mouse mesh feedback', () => {
  it('preserves default shades and tints body/buttons without changing wheel or trim', (t) => {
    const mouse = createMouseGroup()
    t.after(mouse.dispose)
    const body = getMesh(mouse, 'mouseBody')
    const left = getMesh(mouse, 'mouseLeftButton')
    const right = getMesh(mouse, 'mouseRightButton')
    const wheel = getMesh(mouse, 'mouseWheel')
    const trim = getMesh(mouse, 'mouseCenterTrim')
    mouse.setColors(DEFAULT_DEVICE_COLORS)
    sameColor(body.material.color, new Color(palette.body))
    sameColor(left.material.color, new Color(palette.button))
    sameColor(right.material.color, new Color(palette.button))
    mouse.setColors({ mouseColor: '#88aacc', mousePressedColor: '#ff00aa' })
    sameColor(body.material.color, new Color(palette.body).multiply(new Color('#88aacc')))
    sameColor(left.material.color, new Color(palette.button).multiply(new Color('#88aacc')))
    sameColor(right.material.color, left.material.color)
    sameColor(wheel.material.color, new Color(palette.wheel))
    sameColor(trim.material.color, new Color(palette.trim))
    mouse.setColors(DEFAULT_DEVICE_COLORS)
    sameColor(body.material.color, new Color(palette.body))
    sameColor(left.material.color, new Color(palette.button))
  })

  it('updates a held or releasing button at its current progress and retains the palette through input resets', (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const mouse = createMouseGroup()
    t.after(mouse.dispose)
    const right = getMesh(mouse, 'mouseRightButton')
    const wheel = getMesh(mouse, 'mouseWheel')
    const geometry = right.geometry
    const material = right.material
    const colors = { mouseColor: '#aa8844', mousePressedColor: '#2288ff' }
    const baseColor = new Color(palette.button).multiply(new Color(colors.mouseColor))
    const pressedColor = new Color(colors.mousePressedColor)
    mouse.setMouseButtonPressed('Left', true)
    mouse.update(interaction.pressDurationMs / 2, now)
    const halfwayY = right.position.y
    mouse.setColors(colors)
    sameColor(right.material.color, baseColor.clone().lerp(pressedColor, 0.5))
    sameColor(right.material.emissive, pressedColor.clone().multiplyScalar(0.5))
    assert.equal(right.position.y, halfwayY)
    now += 1000
    mouse.update(interaction.pressDurationMs, now)
    sameColor(right.material.color, pressedColor)
    mouse.setMouseButtonPressed('Left', false)
    mouse.update(interaction.releaseDurationMs / 2, now)
    const nextColors = { mouseColor: '#8844aa', mousePressedColor: '#ff3366' }
    const nextBaseColor = new Color(palette.button).multiply(new Color(nextColors.mouseColor))
    const nextPressedColor = new Color(nextColors.mousePressedColor)
    mouse.setColors(nextColors)
    sameColor(right.material.color, nextBaseColor.clone().lerp(nextPressedColor, 0.5))
    assert.equal(right.position.y, halfwayY)
    mouse.update(interaction.releaseDurationMs / 2, now + interaction.releaseDurationMs)
    sameColor(right.material.color, nextBaseColor)
    mouse.setMouseEnabled(false)
    mouse.setColors(colors)
    mouse.setMouseEnabled(true)
    sameColor(right.material.color, baseColor)
    mouse.pulseWheelScroll(0, 1)
    mouse.update(interaction.pressDurationMs, now)
    sameColor(wheel.material.color, pressedColor)
    mouse.resetInput()
    sameColor(right.material.color, baseColor)
    sameColor(wheel.material.color, new Color(palette.wheel))
    mouse.setMouseButtonPressed('Middle', true)
    mouse.update(interaction.pressDurationMs, now)
    sameColor(wheel.material.color, pressedColor)
    assert.equal(right.geometry, geometry)
    assert.equal(right.material, material)
  })

  it('holds a middle click, preserves wheel orientation, and releases with existing timing', (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const mouse = createMouseGroup()
    const wheel = getMesh(mouse, 'mouseWheel')
    const rotation = wheel.rotation.clone()
    const position = wheel.position.clone()
    mouse.setMouseButtonPressed('Middle', true)
    mouse.update(interaction.pressDurationMs, now + interaction.pressDurationMs)
    sameColor(wheel.material.color, new Color(interaction.pressedColor))
    assert.equal(wheel.material.emissiveIntensity, 0.18)
    assert.ok(wheel.rotation.equals(rotation))
    assert.ok(wheel.position.equals(position))
    now += 5000
    mouse.update(16, now)
    assert.equal(wheel.material.emissiveIntensity, 0.18)
    mouse.setMouseButtonPressed('Middle', false)
    mouse.update(interaction.releaseDurationMs / 2, now)
    assert.ok(wheel.material.emissiveIntensity > 0)
    assert.ok(wheel.material.emissiveIntensity < 0.18)
    mouse.update(interaction.releaseDurationMs / 2, now + interaction.releaseDurationMs)
    sameColor(wheel.material.color, new Color(palette.wheel))
    assert.equal(wheel.material.emissiveIntensity, 0)
    mouse.dispose()
  })

  it('refreshes scrolling across directions and combines it with a held click', (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const mouse = createMouseGroup()
    const wheel = getMesh(mouse, 'mouseWheel')
    for (const [deltaX, deltaY] of [[0, 120], [0, -120], [120, 0], [-120, 0], [1, -1]]) {
      mouse.pulseWheelScroll(deltaX, deltaY)
      mouse.update(interaction.pressDurationMs, now + interaction.pressDurationMs)
      assert.equal(wheel.material.emissiveIntensity, 0.18)
      now += 80
    }
    mouse.setMouseButtonPressed('Middle', true)
    now += 500
    mouse.update(500, now)
    assert.equal(wheel.material.emissiveIntensity, 0.18)
    mouse.pulseWheelScroll(0, -1)
    mouse.setMouseButtonPressed('Middle', false)
    mouse.update(16, now + 16)
    assert.equal(wheel.material.emissiveIntensity, 0.18)
    mouse.update(interaction.releaseDurationMs, now + interaction.minimumPressMs + 1)
    assert.equal(wheel.material.emissiveIntensity, 0)
    mouse.pulseWheelScroll(0, 0)
    mouse.pulseWheelScroll(Number.NaN, 1)
    mouse.pulseWheelScroll(0, Infinity)
    mouse.update(70, now + 1000)
    assert.equal(wheel.material.emissiveIntensity, 0)
    mouse.dispose()
  })

  it('keeps left/right mapping, quick-click minimum hold, and independent wheel feedback', (t) => {
    t.mock.method(performance, 'now', () => 1000)
    const mouse = createMouseGroup()
    const left = getMesh(mouse, 'mouseLeftButton')
    const right = getMesh(mouse, 'mouseRightButton')
    const wheel = getMesh(mouse, 'mouseWheel')
    mouse.setMouseButtonPressed('Left', true)
    mouse.setMouseButtonPressed('Left', false)
    mouse.update(70, 1070)
    assert.equal(right.material.emissiveIntensity, 0.18)
    assert.equal(left.material.emissiveIntensity, 0)
    assert.equal(wheel.material.emissiveIntensity, 0)
    mouse.setMouseButtonPressed('Right', true)
    mouse.setMouseButtonPressed('Middle', true)
    mouse.update(140, 1200)
    assert.equal(right.material.emissiveIntensity, 0)
    assert.equal(left.material.emissiveIntensity, 0.18)
    assert.equal(wheel.material.emissiveIntensity, 0.18)
    sameColor(left.material.color, wheel.material.color)
    mouse.dispose()
  })

  it('clears every input on disable/reset/dispose and accepts only new input after enabling', (t) => {
    t.mock.method(performance, 'now', () => 1000)
    const mouse = createMouseGroup()
    const wheel = getMesh(mouse, 'mouseWheel')
    const device = mouse.group.getObjectByName('mouseDevice')!
    mouse.setMouseButtonPressed('Middle', true)
    mouse.pulseWheelScroll(1, 0)
    mouse.setMousePosition(0, 0)
    mouse.update(70, 1070)
    assert.notEqual(device.position.x, 0)
    mouse.setMouseEnabled(false)
    assert.equal(mouse.group.visible, false)
    const visibleMeshes: Mesh[] = []
    mouse.group.traverseVisible((object) => {
      if (object instanceof Mesh) visibleMeshes.push(object)
    })
    assert.equal(visibleMeshes.length, 0)
    assert.ok(mouse.group.getObjectByName('mouseHandAnchor'), 'retain the anchor for the pet rig')
    assert.equal(wheel.material.emissiveIntensity, 0)
    assert.equal(device.position.length(), 0)
    mouse.setMouseButtonPressed('Left', true)
    mouse.setMouseButtonPressed('Middle', true)
    mouse.pulseWheelScroll(1, 0)
    mouse.setMousePosition(1, 1)
    mouse.setMouseEnabled(true)
    assert.equal(mouse.group.visible, true)
    mouse.update(70, 1070)
    assert.equal(wheel.material.emissiveIntensity, 0)
    assert.equal(device.position.length(), 0)
    mouse.pulseWheelScroll(0, 1)
    mouse.update(70, 1070)
    assert.equal(wheel.material.emissiveIntensity, 0.18)
    mouse.resetInput()
    mouse.update(70, 1070)
    assert.equal(wheel.material.emissiveIntensity, 0)
    let geometryDisposals = 0
    let materialDisposals = 0
    mouse.group.traverse((object) => {
      if (!(object instanceof Mesh)) return
      object.geometry.addEventListener('dispose', () => geometryDisposals++)
      object.material.addEventListener('dispose', () => materialDisposals++)
    })
    mouse.dispose()
    mouse.dispose()
    mouse.setMouseEnabled(true)
    mouse.setMouseButtonPressed('Middle', true)
    mouse.pulseWheelScroll(0, 1)
    mouse.update(70, 1070)
    assert.equal(wheel.material.emissiveIntensity, 0)
    assert.equal(geometryDisposals, 5)
    assert.equal(materialDisposals, 5)
    assert.equal(mouse.group.children.length, 0)
    const recreated = createMouseGroup()
    recreated.setMouseEnabled(false)
    assert.equal(recreated.group.visible, false, 'startup restores an OFF selection before rendering')
    recreated.setMouseEnabled(true)
    recreated.update(70, 1070)
    assert.equal(getMesh(recreated, 'mouseWheel').material.emissiveIntensity, 0)
    recreated.dispose()
  })
})
