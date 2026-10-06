/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Box3, Color, FrontSide, MathUtils, Mesh, MeshStandardMaterial, Raycaster, Vector3 } from 'three'

import { DEFAULT_DEVICE_COLORS, normalizeDeviceColors } from '@/config/deviceColors'
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
  it('matches eager button and movement updates while avoiding unchanged appearance and arrays', (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const actual = createMouseGroup()
    const eager = createMouseGroup()
    t.after(actual.dispose)
    t.after(eager.dispose)
    const names = { Left: 'mouseLeftButton', Right: 'mouseRightButton', Middle: 'mouseWheel' } as const
    const states = Object.fromEntries(Object.entries(names).map(([button, name]) => {
      const mesh = getMesh(eager, name)
      return [button, {
        mesh,
        baseColor: mesh.material.color.clone(),
        baseY: mesh.position.y,
        baseRotationX: mesh.rotation.x,
        pressed: false,
        minimumPressedUntil: 0,
        progress: 0,
      }]
    })) as Record<keyof typeof names, {
      mesh: ReturnType<typeof getMesh>
      baseColor: Color
      baseY: number
      baseRotationX: number
      pressed: boolean
      minimumPressedUntil: number
      progress: number
    }>
    const actualMeshes = Object.values(names).map(name => getMesh(actual, name))
    const resources = actualMeshes.map(mesh => ({ geometry: mesh.geometry, material: mesh.material }))
    const actualDevice = actual.group.getObjectByName('mouseDevice')!
    const eagerDevice = eager.group.getObjectByName('mouseDevice')!
    const pressedColor = new Color(interaction.pressedColor)
    const zeroEmissive = new Color(0)
    let enabled = true
    let targetX = 0
    let targetZ = 0
    const applyEagerAppearance = (state: typeof states.Left) => {
      const eased = MathUtils.smoothstep(state.progress, 0, 1)
      if (state !== states.Middle) {
        state.mesh.position.y = state.baseY - Math.min(interaction.buttonTravel, 0.0035) * eased
        state.mesh.rotation.x = state.baseRotationX + Math.min(interaction.buttonTravel * 0.8, 0.018) * eased
      }
      state.mesh.material.color.lerpColors(state.baseColor, pressedColor, eased)
      state.mesh.material.emissive.lerpColors(zeroEmissive, pressedColor, eased)
      state.mesh.material.emissiveIntensity = 0.18 * eased
    }
    let lerps = 0
    let valueArrays = 0
    const lerpColors = Color.prototype.lerpColors
    const objectValues = Object.values
    t.mock.method(Color.prototype, 'lerpColors', function (this: Color, from: Color, to: Color, alpha: number) {
      lerps++
      return lerpColors.call(this, from, to, alpha)
    })
    t.mock.method(Object, 'values', (value: object) => {
      valueArrays++
      return objectValues(value)
    })
    let actualLerps = 0
    let eagerLerps = 0
    const compare = () => {
      assert.equal(actual.group.visible, eager.group.visible)
      assert.deepEqual(actualDevice.position.toArray(), eagerDevice.position.toArray())
      objectValues(states).forEach((state, index) => {
        const mesh = actualMeshes[index]
        assert.deepEqual(mesh.position.toArray(), state.mesh.position.toArray(), mesh.name)
        assert.deepEqual(mesh.quaternion.toArray(), state.mesh.quaternion.toArray(), mesh.name)
        assert.deepEqual(mesh.material.color.toArray(), state.mesh.material.color.toArray(), mesh.name)
        assert.deepEqual(mesh.material.emissive.toArray(), state.mesh.material.emissive.toArray(), mesh.name)
        assert.equal(mesh.material.emissiveIntensity, state.mesh.material.emissiveIntensity, mesh.name)
        assert.equal(mesh.geometry, resources[index].geometry)
        assert.equal(mesh.material, resources[index].material)
      })
    }
    // Keep the prior unconditional button update and its own progress as the oracle.
    const advance = (delta: number) => {
      lerps = valueArrays = 0
      actual.update(delta, now)
      const actualCalls = lerps
      actualLerps += actualCalls
      assert.equal(valueArrays, 0, 'updates reuse the button-state list')
      lerps = 0
      if (enabled) {
        eagerDevice.position.x = MathUtils.damp(eagerDevice.position.x, targetX, interaction.followDamping, delta / 1000)
        eagerDevice.position.z = MathUtils.damp(eagerDevice.position.z, targetZ, interaction.followDamping, delta / 1000)
        objectValues(states).forEach((state) => {
          const pressed = state.pressed || now < state.minimumPressedUntil
          const duration = pressed ? interaction.pressDurationMs : interaction.releaseDurationMs
          state.progress = MathUtils.clamp(state.progress + (pressed ? 1 : -1) * delta / duration, 0, 1)
          applyEagerAppearance(state)
        })
      }
      eagerLerps += lerps
      compare()
      now += delta
      return actualCalls
    }
    const reset = () => {
      actual.resetInput()
      eager.resetInput()
      targetX = targetZ = 0
      for (const state of objectValues(states)) {
        state.pressed = false
        state.minimumPressedUntil = 0
        state.progress = 0
        applyEagerAppearance(state)
      }
      compare()
    }
    const press = (button: keyof typeof names, pressed: boolean) => {
      actual.setMouseButtonPressed(button, pressed)
      const state = states[button === 'Middle' ? 'Middle' : button === 'Left' ? 'Right' : 'Left']
      if (!enabled || state.pressed === pressed) return
      state.pressed = pressed
      if (pressed) state.minimumPressedUntil = now + interaction.minimumPressMs
    }
    const setColors = (colors: { mouseColor: string, mousePressedColor: string }) => {
      actual.setColors(colors)
      eager.setColors(colors)
      const normalized = normalizeDeviceColors(colors)
      const tint = new Color(normalized.mouseColor)
      states.Left.baseColor.set(palette.button).multiply(tint)
      states.Right.baseColor.set(palette.button).multiply(tint)
      pressedColor.set(normalized.mousePressedColor)
      objectValues(states).forEach(applyEagerAppearance)
      compare()
    }
    const setPosition = (x: number, y: number) => {
      actual.setMousePosition(x, y)
      if (!enabled) return
      const horizontal = MathUtils.lerp(-1, 1, 1 - MathUtils.clamp(x, 0, 1))
      targetX = horizontal * interaction.xRange
      targetZ = MathUtils.lerp(-interaction.zRange, interaction.zRange, 1 - MathUtils.clamp(y, 0, 1))
        - horizontal * horizontal * interaction.curveDepth
    }
    const setEnabled = (value: boolean) => {
      actual.setMouseEnabled(value)
      eager.setMouseEnabled(value)
      if (enabled === value) return
      enabled = value
      reset()
    }
    assert.equal(advance(16), 6, 'the first update initializes default emissive intensity')
    assert.equal(advance(16), 0)
    for (let frame = 0; frame < 240; frame++) {
      if (frame === 0) press('Left', true)
      if (frame === 1) press('Left', false)
      if (frame === 2) setColors({ mouseColor: '#88aacc', mousePressedColor: '#ff00aa' })
      if (frame === 8) {
        press('Right', true)
        press('Middle', true)
        setPosition(0.9, 0.2)
      }
      if (frame === 10) {
        press('Right', false)
        press('Right', false)
      }
      if (frame === 12) setColors({ mouseColor: '#0000ff', mousePressedColor: '#ff0000' })
      if (frame === 15) reset()
      if (frame === 20) setEnabled(false)
      if (frame === 21) {
        press('Middle', true)
        setPosition(0.1, 1)
        actual.pulseWheelScroll(0, 1)
        setColors({ mouseColor: '#ffaa00', mousePressedColor: '#00ff00' })
      }
      if (frame === 25) setEnabled(true)
      if (frame === 30) {
        actual.pulseWheelScroll(0, 1)
        states.Middle.minimumPressedUntil = now + interaction.minimumPressMs
      }
      if (frame === 40) setPosition(-0.3, 1.4)
      const calls = advance([0, 8, 16, 67, 100][frame % 5])
      if (frame > 80) assert.equal(calls, 0)
    }
    assert.ok(actualLerps < eagerLerps / 5, `${actualLerps} vs ${eagerLerps} color interpolations`)
    t.diagnostic(`Mouse appearance color interpolations: eager ${eagerLerps} -> changed buttons ${actualLerps}; per-frame state arrays 1 -> 0`)
    actual.dispose()
    eager.dispose()
    lerps = 0
    actual.setMouseButtonPressed('Left', true)
    actual.setColors({ mouseColor: '#ff0000', mousePressedColor: '#00ff00' })
    actual.update(100, now)
    assert.equal(lerps, 0)
    assert.equal(actual.group.children.length, eager.group.children.length)
  })

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

describe('mouse enclosure compatibility', () => {
  it('keeps both button shoulders above the backing at rest and pressed', (t) => {
    const mouse = createMouseGroup()
    t.after(mouse.dispose)
    for (const pressed of [false, true]) {
      mouse.setMouseButtonPressed('Left', pressed)
      mouse.setMouseButtonPressed('Right', pressed)
      mouse.update(1000, performance.now() + 1000)
      mouse.group.updateMatrixWorld(true)
      for (const side of [-1, 1]) {
        for (const x of [0.2, 0.23, 0.25]) {
          for (const z of [0.06, 0.12, 0.2]) {
            const hits = new Raycaster(new Vector3(side * x, 1, z), new Vector3(0, -1, 0)).intersectObject(mouse.group)
            assert.equal(hits[0]?.object.name, side === -1 ? 'mouseLeftButton' : 'mouseRightButton', `exposed backing: side=${side}, x=${x}, z=${z}, pressed=${pressed}`)
          }
        }
      }
    }
  })

  it('retains the original envelope, local direction and independently owned hand anchor', () => {
    const mouse = createMouseGroup()
    try {
      const box = new Box3().setFromObject(mouse.group)
      // Recorded from the pre-remodel generator, before scene scale/placement.
      const expected = [-0.305, -0.395231828, -0.42, 0.305, 0.10645224, 0.38795802]
      const actual = [...box.min.toArray(), ...box.max.toArray()]
      actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6, `bound ${index}: ${value}`))
      assert.deepEqual(mouse.group.scale.toArray(), [1, 1, 1])
      assert.deepEqual(mouse.group.rotation.toArray().slice(0, 3), [0, 0, 0])
      const anchor = mouse.group.getObjectByName('mouseHandAnchor')!
      assert.deepEqual(anchor.position.toArray(), [...MODEL_3D_CONFIG.mouse.handAnchorPosition])
      assert.equal(anchor.parent?.name, 'mouseDevice')
      assert.ok(new Box3().setFromObject(getMesh(mouse, 'mouseRightButton')).getCenter(new Vector3()).z > 0)
    } finally {
      mouse.dispose()
    }
  })

  it('has closed, nondegenerate outward-facing surfaces within the accepted triangle budget', () => {
    const mouse = createMouseGroup()
    let triangles = 0
    try {
      mouse.group.traverse((object) => {
        if (!(object instanceof Mesh)) return
        assert.equal(object.material.side, FrontSide)
        const geometry = object.geometry
        const positions = geometry.getAttribute('position')
        const normals = geometry.getAttribute('normal')
        const edges = new Map<string, number>()
        let volume = 0
        const key = (point: Vector3) => point.toArray().map(value => value.toFixed(6)).join(',').split('-0.000000').join('0.000000')
        const count = geometry.index?.count ?? positions.count
        triangles += count / 3
        for (let index = 0; index < count; index += 3) {
          const points = [0, 1, 2].map(offset => new Vector3().fromBufferAttribute(positions, geometry.index?.getX(index + offset) ?? index + offset))
          const [a, b, c] = points
          const cross = b.clone().sub(a).cross(c.clone().sub(a))
          assert.ok(cross.length() > 1e-10, `${object.name}: collapsed face`)
          volume += a.dot(b.clone().cross(c)) / 6
          for (let edge = 0; edge < 3; edge += 1) {
            const pair = [key(points[edge]), key(points[(edge + 1) % 3])].sort().join('|')
            edges.set(pair, (edges.get(pair) ?? 0) + 1)
          }
        }
        assert.ok(volume > 0, `${object.name}: reversed surface`)
        for (const [edge, uses] of edges) assert.equal(uses, 2, `${object.name}: open/nonmanifold edge ${edge}`)
        for (let index = 0; index < normals.count; index += 1) {
          const normal = new Vector3().fromBufferAttribute(normals, index)
          assert.ok(Number.isFinite(normal.length()) && Math.abs(normal.length() - 1) < 1e-5, `${object.name}: invalid normal`)
        }
      })
      assert.equal(triangles, 814, `unexpected geometry cost: ${triangles}`)
    } finally {
      mouse.dispose()
    }
  })

  it('keeps held button panels above the backing across their full length', (t) => {
    const mouse = createMouseGroup()
    t.after(mouse.dispose)
    for (const [button, panelName, side] of [['Left', 'mouseRightButton', 1], ['Right', 'mouseLeftButton', -1]] as const) {
      mouse.resetInput()
      mouse.setMouseButtonPressed(button, true)
      mouse.update(100, performance.now())
      mouse.group.updateMatrixWorld(true)
      for (const z of [0.035, 0.12, 0.23, 0.3]) {
        const hits = new Raycaster(new Vector3(side * 0.12, 1, z), new Vector3(0, -1, 0)).intersectObject(mouse.group)
        assert.equal(hits[0]?.object.name, panelName, `pressed panel buried at ${z}`)
      }
    }
  })
})
