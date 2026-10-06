/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
} from 'three'

import { createDefaultDmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'

import { createDmeloperEyebrowController } from './dmeloperEyebrows'

function eyebrowModel() {
  const root = new Group()
  const head = new Group()
  head.name = 'Head'
  root.add(head)
  const material = new MeshStandardMaterial({ color: '#4A2818' })
  material.name = 'Dmeloper Eyebrow'
  const make = (name: string, side: 'left' | 'right', x: number) => {
    const mesh = new Mesh(new BoxGeometry(2, 0.5, 0.65), material)
    mesh.name = name
    mesh.position.set(x, 28.5, 4.275)
    Object.assign(mesh.userData, {
      petEyebrowVersion: 1,
      petEyebrowSide: side,
      petEyebrowBaseSpacingPixels: 1.5,
      petEyebrowBaseWidthPixels: 2,
      petEyebrowBaseThicknessPixels: 0.5,
    })
    head.add(mesh)
    return mesh
  }
  return {
    root,
    left: make('LeftEyebrow', 'left', 1.5),
    right: make('RightEyebrow', 'right', -1.5),
  }
}

type EyebrowController = NonNullable<ReturnType<typeof createDmeloperEyebrowController>>

function pressKey(controller: EyebrowController, key: string, timestamp: number) {
  controller.setKeyPressed(key, true, timestamp)
  controller.setKeyPressed(key, false, timestamp + 1)
}

function click(controller: EyebrowController, button: 'Left' | 'Right', timestamp: number) {
  controller.setMouseButtonPressed(button, true, timestamp)
  controller.setMouseButtonPressed(button, false, timestamp + 1)
}

function enterKeyboardFocus(controller: EyebrowController, start = 0) {
  for (let index = 0; index < 15; index++) pressKey(controller, `key-${index}`, start + index * 50)
  pressKey(controller, 'key-0', start + 850)
  controller.update(start + 920)
}

function enterMixedFocus(controller: EyebrowController) {
  for (let index = 0; index < 13; index++) pressKey(controller, `key-${index}`, index * 50)
  click(controller, 'Left', 650)
  click(controller, 'Right', 700)
  click(controller, 'Left', 850)
  controller.update(920)
}

describe('Dmeloper eyebrow controller', () => {
  it('combines static offsets and dimensions without changing depth', () => {
    const time = 0
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, {
      now: () => time,
      random: () => 0,
    })!
    controller.setPreset({
      ...createDefaultDmeloperEyebrowPreset(),
      centerOffsetPixels: 0.25,
      heightOffsetPixels: 0.5,
      spacingPixels: 2,
      widthPixels: 1,
      thicknessPixels: 1,
    })
    controller.update(time)

    const material = left.material as MeshStandardMaterial
    assert.equal(left.position.x, 2.25)
    assert.equal(right.position.x, -1.75)
    assert.equal(left.position.y, 29)
    assert.equal(right.position.y, 29)
    assert.equal(left.scale.x, 0.5)
    assert.equal(left.scale.y, 2)
    assert.equal(left.scale.z, 1)
    assert.equal(left.castShadow, false)
    assert.equal(left.receiveShadow, true)
    assert.equal(material.depthTest, true)
    assert.equal(material.depthWrite, true)
    assert.equal(material.polygonOffset, false)
  })

  it('uses the selected color until the next skin supplies a new suggestion', () => {
    const { root, left } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0 })!
    controller.setSuggestedColor('#123456')
    assert.equal((left.material as MeshStandardMaterial).color.getHexString(), '123456')

    controller.setPreset({
      ...createDefaultDmeloperEyebrowPreset(),
      color: '#ABCDEF',
    })
    assert.equal((left.material as MeshStandardMaterial).color.getHexString(), 'abcdef')

    controller.setSuggestedColor('#010203')
    assert.equal((left.material as MeshStandardMaterial).color.getHexString(), '010203')
  })

  it('requires fifteen presses and begins a 220 ms return exactly after 400 ms of silence', () => {
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    const baseY = left.position.y
    for (let index = 0; index < 14; index++) controller.setKeyPressed(`key-${index}`, true, index * 50)
    controller.update(690)
    assert.equal(left.quaternion.z, 0, 'fourteen presses do not enter focus')
    controller.setKeyPressed('key-14', true, 700)
    controller.setKeyPressed('extra', true, 850)
    controller.update(920)
    assert.ok(left.position.y < baseY - 0.09)
    assert.ok(left.quaternion.z > 0 && right.quaternion.z < 0)
    controller.setKeyPressed('extra', true, 1240)
    controller.setKeyPressed('key-14', false, 1245)
    controller.update(1249)
    assert.ok(left.position.y < baseY - 0.09)
    controller.update(1250)
    controller.update(1360)
    assert.ok(left.position.y > baseY - 0.06 && left.position.y < baseY - 0.04)
    controller.update(1470)
    assert.equal(left.position.y, baseY)
    assert.equal(left.quaternion.z, 0)
    assert.equal(right.quaternion.z, 0)
  })

  it('merges repeated key pulses without treating a held key as new input', () => {
    const time = 0
    const { root, left } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, {
      now: () => time,
      random: () => 0,
    })!
    const baseY = left.position.y
    controller.setKeyPressed('a', true, 0)
    controller.setKeyPressed('a', true, 30)
    controller.update(60)
    assert.ok(left.position.y > baseY + 0.07)
  })

  it('combines repeated keyboard presses and clicks in one fifteen-press window', () => {
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    for (let index = 0; index < 7; index++) {
      pressKey(controller, 'Left', index * 100)
      click(controller, 'Left', index * 100 + 50)
    }
    controller.update(690)
    assert.equal(left.quaternion.z, 0, 'seven key presses plus seven clicks remain below the threshold')
    pressKey(controller, 'Left', 700)
    click(controller, 'Left', 850)
    controller.update(920)
    assert.ok(left.quaternion.z > 0 && right.quaternion.z < 0)
    controller.update(1250)
    controller.update(1470)
    assert.equal(left.quaternion.z, 0)
  })

  it('ignores held-key and held-button repeats and unmatched releases', () => {
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    for (let timestamp = 0; timestamp <= 3000; timestamp += 30) {
      controller.setKeyPressed('held', true, timestamp)
      controller.setMouseButtonPressed('Left', true, timestamp)
      controller.setKeyPressed('released', false, timestamp)
      controller.setMouseButtonPressed('Right', false, timestamp)
      controller.update(timestamp + 10)
      assert.equal(left.quaternion.z, 0)
      assert.equal(right.quaternion.z, 0)
    }
  })

  it('counts repeated fresh presses of one key or either mouse button', () => {
    for (const source of ['keyboard', 'Left', 'Right'] as const) {
      const { root, left, right } = eyebrowModel()
      const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
      const press = (timestamp: number) => source === 'keyboard'
        ? pressKey(controller, 'repeated', timestamp)
        : click(controller, source, timestamp)
      for (let index = 0; index < 14; index++) press(index * 50)
      controller.update(690)
      assert.equal(left.quaternion.z, 0, `${source}: fourteen fresh presses`)
      press(700)
      press(850)
      controller.update(920)
      assert.ok(left.quaternion.z > 0 && right.quaternion.z < 0, source)
      controller.update(1249)
      assert.ok(left.quaternion.z > 0, source)
      controller.update(1250)
      controller.update(1470)
      assert.equal(left.quaternion.z, 0, `${source}: silence returns to neutral`)
    }
  })

  it('counts the exact 1.5-second boundary and discards presses beyond it', () => {
    for (const source of ['keyboard', 'mouse']) {
      for (const timestamp of [1500, 1501]) {
        const { root, left } = eyebrowModel()
        const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
        const press = (pressedAt: number) => source === 'keyboard'
          ? pressKey(controller, 'repeated', pressedAt)
          : click(controller, 'Left', pressedAt)
        for (let index = 0; index < 14; index++) press(index * 100)
        press(timestamp)
        controller.update(timestamp + 100)
        assert.equal(left.quaternion.z > 0, timestamp === 1500, source)
      }
    }
  })

  it('retains the latest qualifying presses during sustained repeated input and expires them later', () => {
    for (const source of ['keyboard', 'mouse']) {
      const { root, left } = eyebrowModel()
      const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
      const press = (timestamp: number) => source === 'keyboard'
        ? pressKey(controller, 'repeated', timestamp)
        : click(controller, 'Left', timestamp)
      for (let index = 0; index < 30; index++) press(index * 50)
      controller.update(1500)
      assert.ok(left.quaternion.z > 0, source)
      controller.update(1850)
      controller.update(2070)
      assert.equal(left.quaternion.z, 0, source)
      press(2080)
      press(2230)
      controller.update(2300)
      assert.ok(left.quaternion.z > 0, 'the most recent fifteen presses still qualify')
      controller.update(2630)
      controller.update(2850)
      press(3731)
      controller.update(3800)
      assert.equal(left.quaternion.z, 0, 'expired press history cannot requalify focus')
    }
  })

  it('extends focus at 399 ms but expires before a new press at 400 ms in either event order', () => {
    for (const source of ['keyboard', 'mouse']) {
      for (const frameFirst of [false, true]) {
        for (const inputAt of [1749, 1750]) {
          const { root, left } = eyebrowModel()
          const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
          for (let index = 0; index < 3; index++) pressKey(controller, `key-${index}`, index)
          for (let index = 3; index < 13; index++) pressKey(controller, `key-${index}`, 650 + (index - 3) * 50)
          click(controller, 'Left', 1150)
          click(controller, 'Right', 1200)
          click(controller, 'Left', 1350)
          controller.update(1420)
          assert.ok(left.quaternion.z > 0)
          if (frameFirst) controller.update(inputAt)
          if (source === 'keyboard') pressKey(controller, 'key-12', inputAt)
          else click(controller, 'Right', inputAt)
          if (!frameFirst) controller.update(inputAt)
          controller.update(inputAt + 220)
          assert.equal(left.quaternion.z > 0, inputAt === 1749, 'fourteen remaining presses can extend only unexpired focus')
        }
      }
    }
  })

  it('retains recent presses across an ordinary quiet return', () => {
    const { root, left } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    enterMixedFocus(controller)
    controller.update(1250)
    controller.update(1470)
    assert.equal(left.quaternion.z, 0)
    pressKey(controller, 'key-0', 1480)
    click(controller, 'Left', 1630)
    controller.update(1700)
    assert.ok(left.quaternion.z > 0, 'enough recent presses remain within the rolling window')
  })

  it('clears mixed mouse contributions on OFF and requires fresh clicks after ON', () => {
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    enterMixedFocus(controller)
    assert.ok(left.quaternion.z > 0)
    controller.setMouseButtonPressed('Left', true, 930)
    controller.setMouseEnabled(false, 940)
    click(controller, 'Left', 1000)
    click(controller, 'Right', 1100)
    controller.update(1160)
    assert.equal(left.quaternion.z, 0)
    assert.equal(right.quaternion.z, 0)
    controller.setMouseEnabled(true, 1160)
    controller.setMouseButtonPressed('Left', true, 1180)
    controller.setMouseButtonPressed('Left', true, 1190)
    controller.update(1195)
    assert.equal(left.quaternion.z, 0, 'one fresh button leaves thirteen keys plus one button')
    click(controller, 'Right', 1200)
    controller.setMouseButtonPressed('Left', false, 1349)
    click(controller, 'Left', 1350)
    controller.update(1420)
    assert.ok(left.quaternion.z > 0 && right.quaternion.z < 0)
  })

  it('keeps keyboard-qualified focus and held keys while removing mouse extensions', () => {
    const { root, left } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    for (let index = 0; index < 15; index++) controller.setKeyPressed(`key-${index}`, true, index * 50)
    controller.setKeyPressed('extra', true, 850)
    controller.update(920)
    assert.ok(left.quaternion.z > 0)
    controller.setMouseButtonPressed('Right', true, 950)
    controller.setMouseEnabled(false, 1000)
    controller.setKeyPressed('extra', true, 1240)
    controller.update(1249)
    assert.ok(left.quaternion.z > 0)
    controller.update(1250)
    controller.update(1470)
    assert.equal(left.quaternion.z, 0, 'the mouse extension must not survive reset')
    controller.setKeyPressed('extra', false, 1480)
    controller.setKeyPressed('extra', true, 1490)
    controller.update(1550)
    assert.ok(left.quaternion.z > 0, 'fresh input requalifies using the recent keyboard window')
  })

  it('preserves keyboard history and its current pulse during mouse reset', () => {
    const { root, left } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    const baseY = left.position.y
    for (let index = 0; index < 13; index++) pressKey(controller, `key-${index}`, index * 50)
    click(controller, 'Left', 650)
    controller.update(660)
    assert.ok(left.position.y > baseY)
    controller.resetMouseInput(660)
    assert.ok(left.position.y > baseY)
    pressKey(controller, 'fourteenth', 700)
    controller.resetMouseInput(720)
    assert.equal(left.quaternion.z, 0)
    pressKey(controller, 'fifteenth', 750)
    pressKey(controller, 'key-0', 900)
    controller.update(970)
    assert.ok(left.quaternion.z > 0)
  })

  it('does not promote mixed focus to keyboard-only focus without fifteen keyboard presses', () => {
    const { root, left } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    const baseY = left.position.y
    enterMixedFocus(controller)
    controller.setKeyPressed('held', true, 940)
    controller.resetMouseInput(950)
    controller.update(1000)
    assert.ok(left.position.y > baseY - 0.01, 'the current keyboard pulse survives the neutral transition')
    controller.update(1170)
    assert.equal(left.quaternion.z, 0)
    controller.setKeyPressed('held', true, 1200)
    controller.update(1260)
    assert.equal(left.position.y, baseY)
    controller.setKeyPressed('held', false, 2470)
    controller.setKeyPressed('held', true, 2480)
    controller.update(2540)
    assert.ok(left.position.y > baseY + 0.07)
  })

  it('resets partial mouse click history without changing idle or keyboard timing', () => {
    let time = 0
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => time, random: () => 0 })!
    const baseY = left.position.y
    for (let timestamp = 0; timestamp < 210; timestamp += 15) {
      controller.setMouseButtonPressed('Right', true, timestamp)
      controller.setMouseButtonPressed('Right', false, timestamp + 1)
    }
    time = 250
    controller.resetMouseInput()
    controller.setMouseButtonPressed('Right', true, 300)
    controller.update(520)
    assert.equal(left.position.y, baseY)
    time = 600
    controller.setMouseEnabled(false)
    controller.update(4000)
    controller.update(4220)
    assert.ok(left.position.y > right.position.y)
    const idleY = left.position.y
    controller.resetMouseInput(4220)
    controller.setMouseEnabled(true, 4220)
    assert.equal(left.position.y, idleY)
  })

  it('retains the mouse gate across preset resets and ignores input controls after dispose', () => {
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    const baseY = left.position.y
    controller.setMouseEnabled(false)
    controller.setPreset({ ...createDefaultDmeloperEyebrowPreset(), enabled: false })
    controller.setPreset(createDefaultDmeloperEyebrowPreset())
    for (let timestamp = 0; timestamp < 400; timestamp += 20) {
      controller.setMouseButtonPressed('Left', true, timestamp)
      controller.setMouseButtonPressed('Left', false, timestamp + 1)
    }
    controller.update(500)
    assert.equal(left.position.y, baseY)
    controller.dispose()
    controller.resetMouseInput()
    controller.setMouseEnabled(true)
    controller.setMouseButtonPressed('Left', true)
    controller.setKeyPressed('key', true)
    controller.update(8000)
    controller.dispose()
    assert.equal(left.visible, false)
    assert.equal(right.visible, false)
    assert.equal(left.position.y, baseY)
  })

  it('does not repeat adjacent idle states and resets immediately when disabled', () => {
    let time = 0
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, {
      now: () => time,
      random: () => 0,
    })!
    time = 4000
    controller.update(time)
    time += 220
    controller.update(time)
    assert.ok(left.position.y > right.position.y)

    time = 8220
    controller.update(time)
    time += 220
    controller.update(time)
    assert.equal(left.position.y, right.position.y)

    controller.setPreset({
      ...createDefaultDmeloperEyebrowPreset(),
      enabled: false,
    })
    assert.equal(left.visible, false)
    assert.equal(right.visible, false)

    controller.setPreset(createDefaultDmeloperEyebrowPreset())
    assert.equal(left.visible, true)
    assert.equal(right.visible, true)
    assert.equal(left.position.y, right.position.y)
    assert.equal(left.quaternion.z, 0)
    assert.equal(right.quaternion.z, 0)
  })

  it('stops an active expression immediately and keeps static appearance attached to the head', () => {
    let time = 0
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => time, random: () => 0 })!
    const preset = {
      ...createDefaultDmeloperEyebrowPreset(),
      centerOffsetPixels: 0.25,
      heightOffsetPixels: 0.5,
      spacingPixels: 2,
      widthPixels: 1,
      thicknessPixels: 1,
    }
    controller.setPreset(preset)
    enterKeyboardFocus(controller)
    time = 920
    controller.update(time)
    assert.ok(left.quaternion.z > 0)
    controller.setAnimationEnabled(false)
    assert.equal(left.position.y, 29)
    assert.equal(right.position.y, 29)
    assert.equal(left.quaternion.z, 0)
    assert.equal(right.quaternion.z, 0)
    assert.equal(left.position.x, 2.25)
    assert.equal(right.position.x, -1.75)
    assert.equal(left.scale.x, 0.5)
    assert.equal(left.scale.y, 2)
    assert.equal(left.visible, true)

    for (let index = 0; index < 10; index += 1) {
      time += 100
      controller.setKeyPressed(`key-${index}`, true, time)
      controller.setMouseButtonPressed('Left', true, time)
      controller.setMouseButtonPressed('Left', false, time + 1)
      controller.update(time + 60)
    }
    controller.update(10000)
    assert.equal(left.position.y, 29)
    assert.equal(right.quaternion.z, 0)

    // The animation gate never reparents or freezes the generated head nodes.
    const head = root.getObjectByName('Head')!
    assert.equal(left.parent, head)
    const worldPosition = left.getWorldPosition(left.position.clone())
    head.position.y += 5
    assert.equal(left.getWorldPosition(left.position.clone()).y, worldPosition.y + 5)
  })

  it('preserves animation OFF across skin presets, visibility and static edits', () => {
    let time = 0
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => time, random: () => 0 })!
    controller.update(4000)
    controller.update(4220)
    assert.ok(left.position.y > right.position.y)
    time = 4220
    controller.setAnimationEnabled(false)
    const preset = createDefaultDmeloperEyebrowPreset()
    controller.setPreset({ ...preset, enabled: false })
    assert.equal(left.visible, false)
    controller.setPreset({ ...preset, heightOffsetPixels: 1 })
    controller.setSuggestedColor('#ABCDEF')
    controller.setKeyPressed('key', true, 4500)
    controller.update(4560)
    controller.update(20000)
    assert.equal(left.visible, true)
    assert.equal(left.position.y, 29.5)
    assert.equal(right.position.y, 29.5)
    assert.equal(left.quaternion.z, 0)
    assert.equal((left.material as MeshStandardMaterial).color.getHexString(), 'abcdef')
  })

  it('starts fresh input and a full neutral idle interval when animation is reenabled', () => {
    let time = 0
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => time, random: () => 0 })!
    const baseY = left.position.y
    for (let index = 0; index < 11; index += 1) {
      controller.setKeyPressed(`held-${index}`, true, index * 60)
    }
    for (const timestamp of [300, 400]) {
      controller.setMouseButtonPressed('Left', true, timestamp)
      controller.setMouseButtonPressed('Left', false, timestamp + 1)
    }
    controller.setMouseButtonPressed('Right', true, 600)
    time = 660
    controller.update(time)
    assert.ok(left.position.y > baseY)
    controller.setAnimationEnabled(false)
    time = 10000
    controller.setKeyPressed('disabled-key', true)
    controller.setAnimationEnabled(true)
    assert.equal(left.position.y, baseY)
    controller.setKeyPressed('held-0', true, 10000)
    controller.update(10060)
    // Held state and partial focus history were discarded, so this is a fresh pulse.
    assert.ok(left.position.y > baseY + 0.07)
    controller.setMouseButtonPressed('Right', true, 10100)
    controller.update(10320)
    assert.equal(left.position.y, baseY)
    assert.equal(right.quaternion.z, 0)
    controller.update(13999)
    assert.equal(left.position.y, baseY)
    controller.update(14000)
    controller.update(14220)
    assert.ok(left.position.y > right.position.y)
    controller.dispose()
    controller.setAnimationEnabled(false)
    controller.setAnimationEnabled(true)
    controller.update(20000)
    assert.equal(left.visible, false)
  })

  it('disables only eyebrow nodes when the generated contract is incomplete', () => {
    const { root, left, right } = eyebrowModel()
    delete right.userData.petEyebrowVersion
    assert.equal(createDmeloperEyebrowController(root), undefined)
    assert.equal(left.visible, false)
    assert.equal(right.visible, false)
  })
})

it('moves both eyebrow front faces from nearly flush to their authored depth, including during expressions', () => {
  const { root, left, right } = eyebrowModel()
  let time = 0
  const controller = createDmeloperEyebrowController(root, { now: () => time, random: () => 0 })!
  for (const [depthPercent, protrusion] of [[200, 0.6], [100, 0.315475], [0, 0.03095]]) {
    time += 200
    controller.setPreset({ ...createDefaultDmeloperEyebrowPreset(), depthPercent })
    controller.setKeyPressed('KeyA', true, time)
    controller.update(time + 60)
    for (const brow of [left, right]) {
      assert.ok(Math.abs(brow.position.z + 0.325 - 4 - protrusion) < 1e-10)
      assert.equal(brow.scale.z, 1)
      assert.ok(brow.position.y > 28.5, 'key pulse still composes with depth')
    }
    controller.setKeyPressed('KeyA', false, time + 70)
  }
  for (let index = 0; index < 15; index++) controller.setKeyPressed(`focus-${index}`, true, time + 80)
  controller.update(time + 180)
  assert.notEqual(left.quaternion.z, 0, 'focus tilt remains enabled at zero depth')
  assert.ok(Math.abs(left.position.z + 0.325 - 4 - 0.03095) < 1e-10)
  controller.setAnimationEnabled(false, time + 401)
  const defaults = createDefaultDmeloperEyebrowPreset()
  controller.setPreset(defaults)
  const defaultProtrusion = 0.03095 + (0.6 - 0.03095) * defaults.depthPercent / 200
  assert.ok(Math.abs(left.position.z + 0.325 - 4 - defaultProtrusion) < 1e-10, 'reset follows the authored depth default')
  controller.setPreset({ ...createDefaultDmeloperEyebrowPreset(), depthPercent: 200 })
  assert.equal(left.position.z, 4.275, '200% restores the exact authored center')
  assert.equal(right.position.z, 4.275)
})
