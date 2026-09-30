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

  it('starts neutral, enters focus after eight distinct keys, and eases neutral after 1s', () => {
    let time = 0
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, {
      now: () => time,
      random: () => 0,
    })!
    const baseY = left.position.y
    for (let index = 0; index < 8; index += 1) {
      time = index * 100
      controller.setKeyPressed(`key-${index}`, true, time)
      controller.setKeyPressed(`key-${index}`, false, time + 1)
    }
    time += 220
    controller.update(time)
    assert.ok(left.position.y < baseY - 0.09)
    assert.ok(right.position.y < baseY - 0.09)
    assert.ok(left.quaternion.z > 0)
    assert.ok(right.quaternion.z < 0)

    time = 1699
    controller.update(time)
    assert.ok(left.position.y < baseY - 0.09)

    time = 1700
    controller.update(time)
    assert.ok(left.position.y < baseY - 0.09)
    assert.ok(right.position.y < baseY - 0.09)

    time = 1810
    controller.update(time)
    assert.ok(left.position.y > baseY - 0.06)
    assert.ok(left.position.y < baseY - 0.04)
    assert.ok(right.position.y > baseY - 0.06)
    assert.ok(right.position.y < baseY - 0.04)

    time = 1920
    controller.update(time)
    assert.ok(Math.abs(left.position.y - baseY) < 1e-6)
    assert.ok(Math.abs(right.position.y - baseY) < 1e-6)
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

  it('ignores ordinary clicks and enters keyboard-equivalent focus after four rapid clicks', () => {
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, {
      now: () => 0,
      random: () => 0,
    })!
    const baseY = left.position.y

    for (const timestamp of [0, 200, 400]) {
      controller.setMouseButtonPressed('Left', true, timestamp)
      controller.setMouseButtonPressed('Left', false, timestamp + 1)
      controller.update(timestamp + 100)
      assert.equal(left.position.y, baseY)
      assert.equal(right.position.y, baseY)
      assert.equal(left.quaternion.z, 0)
      assert.equal(right.quaternion.z, 0)
    }

    controller.setMouseButtonPressed('Left', true, 600)
    controller.setMouseButtonPressed('Left', false, 601)
    controller.update(820)
    assert.ok(left.position.y < baseY - 0.09)
    assert.ok(right.position.y < baseY - 0.09)
    assert.ok(left.quaternion.z > 0)
    assert.ok(right.quaternion.z < 0)

    controller.update(1599)
    assert.ok(left.position.y < baseY - 0.09)
    controller.update(1600)
    assert.ok(left.position.y < baseY - 0.09)
    controller.update(1710)
    assert.ok(left.position.y > baseY - 0.06)
    assert.ok(left.position.y < baseY - 0.04)
    controller.update(1820)
    assert.equal(left.position.y, baseY)
    assert.equal(right.position.y, baseY)
    assert.equal(left.quaternion.z, 0)
    assert.equal(right.quaternion.z, 0)
  })

  it('does not count held-button repeats or slow clicks as rapid clicks', () => {
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, {
      now: () => 0,
      random: () => 0,
    })!
    const baseY = left.position.y

    controller.setMouseButtonPressed('Left', true, 0)
    controller.setMouseButtonPressed('Left', true, 100)
    controller.setMouseButtonPressed('Left', true, 200)
    controller.setMouseButtonPressed('Left', true, 300)
    controller.setMouseButtonPressed('Left', false, 301)
    for (const timestamp of [900, 1800, 2700]) {
      controller.setMouseButtonPressed('Left', true, timestamp)
      controller.setMouseButtonPressed('Left', false, timestamp + 1)
    }
    controller.update(2920)
    assert.equal(left.position.y, baseY)
    assert.equal(right.position.y, baseY)
    assert.equal(left.quaternion.z, 0)
    assert.equal(right.quaternion.z, 0)
  })

  it('clears mouse focus on OFF, ignores late clicks, and requires fresh clicks after ON', () => {
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    const baseY = left.position.y
    const click = (timestamp: number) => {
      controller.setMouseButtonPressed('Left', true, timestamp)
      controller.setMouseButtonPressed('Left', false, timestamp + 1)
    }
    for (const timestamp of [0, 100, 200]) click(timestamp)
    controller.setMouseButtonPressed('Left', true, 300)
    controller.update(520)
    assert.ok(left.position.y < baseY - 0.09)
    controller.setMouseEnabled(false, 520)
    controller.update(630)
    assert.ok(left.position.y > baseY - 0.06 && left.position.y < baseY - 0.04)
    for (const timestamp of [540, 590, 640, 690]) click(timestamp)
    controller.update(740)
    assert.equal(left.position.y, baseY)
    assert.equal(right.quaternion.z, 0)
    controller.setMouseButtonPressed('Right', true, 750)
    controller.setMouseEnabled(true, 800)
    controller.update(900)
    assert.equal(left.position.y, baseY)
    // The held Left at OFF was cleared even though its release was ignored.
    for (const timestamp of [900, 1000, 1100]) click(timestamp)
    controller.update(1320)
    assert.equal(left.position.y, baseY)
    click(1400)
    controller.update(1620)
    assert.ok(left.position.y < baseY - 0.09)
    assert.ok(right.quaternion.z < 0)
  })

  it('keeps keyboard focus and held keys while removing mouse focus extensions', () => {
    const { root, left } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    const baseY = left.position.y
    for (let index = 0; index < 8; index += 1) {
      controller.setKeyPressed(`key-${index}`, true, index * 100)
    }
    controller.update(920)
    controller.setMouseButtonPressed('Right', true, 1400)
    controller.setMouseEnabled(false, 1500)
    // Repeated key-downs remain repeats across OFF and cannot extend focus.
    controller.setKeyPressed('key-7', true, 1600)
    controller.update(1699)
    assert.ok(left.position.y < baseY - 0.09)
    controller.update(1700)
    controller.update(1920)
    assert.equal(left.position.y, baseY)
    assert.equal(left.quaternion.z, 0)
    controller.setKeyPressed('key-7', false, 1930)
    controller.setKeyPressed('key-7', true, 1940)
    controller.update(2000)
    assert.ok(left.position.y > baseY + 0.07)
  })

  it('preserves a key pulse during mouse reset and keyboard history toward focus', () => {
    const { root, left } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    const baseY = left.position.y
    for (const timestamp of [0, 100, 200, 300]) {
      controller.setMouseButtonPressed('Left', true, timestamp)
      controller.setMouseButtonPressed('Left', false, timestamp + 1)
    }
    controller.update(520)
    controller.setMouseEnabled(false, 520)
    controller.setKeyPressed('first', true, 600)
    controller.update(660)
    assert.ok(left.position.y > baseY)
    controller.resetMouseInput(660)
    assert.ok(left.position.y > baseY)
    controller.setKeyPressed('first', true, 700)
    controller.update(720)
    assert.ok(left.position.y <= baseY)
    for (let index = 1; index < 7; index += 1) {
      controller.setKeyPressed(`key-${index}`, true, 800 + index * 50)
      controller.setKeyPressed(`key-${index}`, false, 801 + index * 50)
    }
    controller.resetMouseInput(1150)
    controller.setMouseEnabled(true, 1160)
    controller.setKeyPressed('eighth', true, 1200)
    controller.update(1420)
    assert.ok(left.position.y < baseY - 0.09)
  })

  it('does not promote a single key during mouse focus into keyboard focus on reset', () => {
    const { root, left } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => 0, random: () => 0 })!
    const baseY = left.position.y
    for (const timestamp of [0, 100, 200, 300]) {
      controller.setMouseButtonPressed('Left', true, timestamp)
      controller.setMouseButtonPressed('Left', false, timestamp + 1)
    }
    controller.update(520)
    controller.setKeyPressed('held', true, 540)
    controller.resetMouseInput(550)
    controller.update(600)
    // The pulse at its 60 ms peak remains visible over the neutral transition.
    assert.ok(left.position.y > baseY - 0.01)
    controller.update(770)
    assert.equal(left.position.y, baseY)
    assert.equal(left.quaternion.z, 0)
    controller.setKeyPressed('held', true, 800)
    controller.update(860)
    assert.equal(left.position.y, baseY)
    controller.setKeyPressed('held', false, 870)
    controller.setKeyPressed('held', true, 880)
    controller.update(940)
    assert.ok(left.position.y > baseY + 0.07)
  })

  it('resets partial mouse click history without changing idle or keyboard timing', () => {
    let time = 0
    const { root, left, right } = eyebrowModel()
    const controller = createDmeloperEyebrowController(root, { now: () => time, random: () => 0 })!
    const baseY = left.position.y
    for (const timestamp of [0, 100, 200]) {
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
    for (const timestamp of [0, 100, 200, 300]) {
      controller.setMouseButtonPressed('Left', true, timestamp)
      controller.setMouseButtonPressed('Left', false, timestamp + 1)
    }
    controller.update(520)
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
    for (const timestamp of [0, 100, 200, 300]) {
      controller.setMouseButtonPressed('Left', true, timestamp)
      controller.setMouseButtonPressed('Left', false, timestamp + 1)
    }
    time = 520
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
    for (let index = 0; index < 7; index += 1) {
      controller.setKeyPressed(`held-${index}`, true, index * 100)
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
  for (const key of ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH']) controller.setKeyPressed(key, true, time + 80)
  controller.update(time + 400)
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
