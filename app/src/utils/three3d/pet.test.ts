/* eslint-disable test/no-import-node-test */
import type { Object3D } from 'three'

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Group, MathUtils, Matrix4, Quaternion, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { MODEL_3D_CONFIG } from '@/config/model3d'
import { DEFAULT_PET_ARM_POSE_SETTINGS } from '@/config/petArmPose'

import { Three3DRenderer } from '../three3d'
import { createDmeloperEyebrowController } from './dmeloperEyebrows'
import { createKeyboardGroup } from './keyboard'
import { createPetAnimator } from './pet'
import { createVoxelSkinModelController } from './voxelSkin'

const config = MODEL_3D_CONFIG.pet.animation
const target = (x: number, z = 0) => ({ position: [x, 0.2, z] as [number, number, number] })

// Only legend painting needs a browser; use the real keyboard geometry and targets.
function keyboardFixture() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({
          clearRect() {},
          fillText() {},
          measureText: () => ({ width: 1 }),
        }),
      }),
    },
  })
  try {
    return createKeyboardGroup()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  }
}

async function fixture(model: 'wide' | 'slim' = 'wide', mouseAtKeyboard = false) {
  const bytes = await readFile(new URL('../../../src-tauri/assets/models/dmeloper/dmeloper.glb', import.meta.url))
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
  const root = gltf.scene
  root.scale.setScalar(MODEL_3D_CONFIG.pet.normalizedHeight / 32)
  root.position.set(...MODEL_3D_CONFIG.pet.position)
  createVoxelSkinModelController(root, model)
  const keyboard = keyboardFixture()
  const keyboardGroup = keyboard.group
  keyboardGroup.scale.setScalar(MODEL_3D_CONFIG.keyboard.scale)
  keyboardGroup.rotation.y = MathUtils.degToRad(MODEL_3D_CONFIG.keyboard.rotationYDegrees)
  keyboardGroup.position.set(...MODEL_3D_CONFIG.keyboard.position)
  const keyboardRightRestTarget = keyboard.getKeyTarget(config.inputMode.rightIdleKey)!
  const mouseGroup = new Group()
  const anchor = new Group()
  anchor.name = 'mouseHandAnchor'
  if (mouseAtKeyboard) {
    anchor.position.fromArray(keyboardRightRestTarget.position)
    anchor.position.y += config.keyboard.restHoverHeight
    keyboardGroup.localToWorld(anchor.position)
  } else {
    anchor.position.set(-1, 0.16, 0.45)
  }
  mouseGroup.add(anchor)
  const animator = createPetAnimator(root, {
    keyboardBodyDefaultTarget: keyboard.getKeyTarget(config.inputMode.leftIdleKey)!,
    keyboardBodyTurnThresholdTarget: keyboard.getKeyTarget('KeyL')!,
    keyboardGroup,
    keyboardLeftRestTarget: keyboard.getKeyTarget(config.inputMode.leftIdleKey)!,
    keyboardRestTarget: keyboard.getKeyTarget('Space')!,
    keyboardRightRestTarget,
    mouseGroup,
  })!
  assert.ok(animator)
  const pose = (name: string) => root.getObjectByName(name)!.quaternion.toArray()
  const advance = (start: number, end: number) => {
    for (let time = start; time <= end; time += 16) animator.update(16, time)
  }
  const dispose = () => {
    animator.dispose()
    keyboard.dispose()
  }
  const worldPosition = (name: string) => root.getObjectByName(name)!.getWorldPosition(new Vector3())
  return { animator, root, pose, advance, keyboard, anchor, dispose, worldPosition }
}

function close(actual: number[], expected: number[], epsilon = 0.00001) {
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < epsilon, `${value} != ${expected[index]}`))
}

describe('renderer input suspension', () => {
  it('releases every held keyboard contact when key-up arrives during a skin load', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const actual = await fixture()
    const released = await fixture()
    t.after(actual.dispose)
    t.after(released.dispose)
    const rigs = [actual, released].map((rig) => {
      const renderer = new Three3DRenderer()
      const eyebrows = createDmeloperEyebrowController(rig.root, { random: () => 0.5 })!
      const state = renderer as unknown as {
        keyboard: typeof rig.keyboard
        petAnimator: typeof rig.animator
        dmeloperEyebrowController: typeof eyebrows
      }
      Object.assign(state, { keyboard: rig.keyboard, petAnimator: rig.animator, dmeloperEyebrowController: eyebrows })
      renderer.setMouseEnabled(false)
      t.after(() => eyebrows.dispose())
      return { ...rig, renderer, eyebrows }
    })
    const contacts = [{ row: 1, column: 1 }, { row: 2, column: 11 }]
    const restingHeights = contacts.map(({ row, column }) => actual.keyboard.group.getObjectByName(`keyboard-key-r${row}-c${column}-group`)!.position.y)
    for (const rig of rigs) {
      for (const contact of contacts) {
        rig.renderer.handleSemanticInput({ kind: 'typing', active: true, intensity: 1, contact: { ...contact, pressed: true } })
      }
      rig.keyboard.update(200, now + 200)
      rig.animator.update(200, now + 200)
      rig.eyebrows.update(now + 200)
    }
    now += 200
    rigs[0].renderer.setInputActive(false)
    // Global key-up is ignored while the main page suspends input for a skin load.
    for (const rig of rigs) {
      for (const contact of contacts) {
        rig.renderer.handleSemanticInput({ kind: 'typing', active: false, intensity: 0, contact: { ...contact, pressed: false } })
      }
    }
    rigs[0].renderer.setInputActive(true)
    for (let frame = 0; frame < 300; frame++) {
      now += 16
      for (const rig of rigs) {
        rig.keyboard.update(16, now)
        rig.animator.update(16, now)
        rig.eyebrows.update(now)
      }
    }
    contacts.forEach(({ row, column }, index) => {
      const key = actual.keyboard.group.getObjectByName(`keyboard-key-r${row}-c${column}-group`)!
      assert.equal(key.position.y, restingHeights[index], 'a released key must not remain depressed after input resumes')
    })
    for (const name of ['L_Upperarm', 'R_Upperarm', 'L_Forearm', 'R_Forearm', 'LeftEyebrow', 'RightEyebrow']) {
      close(actual.pose(name), released.pose(name))
    }
  })
})

describe('rig matrix refresh equivalence', () => {
  for (const model of ['wide', 'slim'] as const) {
    it(`${model}: preserves every rendered node across 2400 frames while avoiding redundant matrix work`, async (t) => {
      let now = 1000
      t.mock.method(performance, 'now', () => now)
      const actual = await fixture(model)
      const eager = await fixture(model)
      t.after(actual.dispose)
      t.after(eager.dispose)
      const rigs = [actual, eager].map((rig) => {
        const scene = new Group()
        const orientation = new Group()
        scene.add(orientation, rig.keyboard.group, rig.anchor.parent!)
        orientation.add(rig.root)
        const nodes: Object3D[] = []
        rig.root.traverse(node => nodes.push(node))
        return { ...rig, scene, orientation, nodes }
      })
      // A conservative eager root refresh is the oracle; keep one IK algorithm.
      const updateWorldMatrix = eager.root.updateWorldMatrix
      t.mock.method(eager.root, 'updateWorldMatrix', function (this: Object3D, updateParents: boolean, _updateChildren: boolean, force?: boolean) {
        updateWorldMatrix.call(this, updateParents, true, force)
      })
      for (let frame = 0; frame < 2400; frame++) {
        now = 1000 + frame * 16
        for (const rig of rigs) {
          if (frame % 100 === 0) {
            rig.scene.rotation.y += 0.11
            rig.orientation.rotation.y -= 0.07
            rig.keyboard.group.scale.setScalar(MODEL_3D_CONFIG.keyboard.scale * (0.5 + frame % 300 / 200))
            rig.keyboard.group.rotation.y += 0.1
            rig.keyboard.group.position.x = Math.sin(frame) * 1.5
            rig.keyboard.group.position.z = Math.cos(frame) * 1.5
            rig.animator.setArmPoseSettings({
              petLeftArmBendPercent: frame * 3 % 401,
              petRightArmBendPercent: frame * 7 % 401,
              petLeftArmSpreadDegrees: frame % 91 - 45,
              petRightArmSpreadDegrees: 45 - frame % 91,
            })
          }
          if (frame % 120 === 0) rig.animator.setMouseEnabled(frame % 240 === 0)
          for (const [index, key] of ['KeyF', 'PageUp', 'Space', 'KeyJ', 'KeyA'].entries()) {
            if (frame % 35 === index) rig.animator.setKeyPressed(key, true, rig.keyboard.getKeyTarget(key))
            if (frame % 35 === index + 10) rig.animator.setKeyPressed(key, false, rig.keyboard.getKeyTarget(key))
          }
          rig.anchor.position.x = -1 + Math.sin(frame / 20) * 0.6
          rig.anchor.position.z = 0.45 + Math.cos(frame / 23) * 0.5
          rig.animator.setMousePosition((Math.sin(frame / 20) + 1) / 2, (Math.cos(frame / 23) + 1) / 2)
          if (frame % 30 === 0) rig.animator.setMouseButtonPressed('Left', true)
          if (frame % 30 === 2) rig.animator.setMouseButtonPressed('Left', false)
          rig.animator.update(16, now)
          // WebGLRenderer refreshes the complete scene before drawing.
          rig.scene.updateMatrixWorld(true)
        }
        rigs[0].nodes.forEach((node, index) => {
          assert.deepEqual(node.quaternion.toArray(), rigs[1].nodes[index].quaternion.toArray())
          assert.deepEqual(node.matrixWorld.elements, rigs[1].nodes[index].matrixWorld.elements)
        })
      }
      const multiplyMatrices = Matrix4.prototype.multiplyMatrices
      let multiplications = 0
      t.mock.method(Matrix4.prototype, 'multiplyMatrices', function (this: Matrix4, left: Matrix4, right: Matrix4) {
        multiplications++
        return multiplyMatrices.call(this, left, right)
      })
      actual.animator.update(16, now)
      const actualMultiplications = multiplications
      multiplications = 0
      eager.animator.update(16, now)
      assert.ok(actualMultiplications < multiplications)
      t.diagnostic(`Eager oracle vs optimized IK matrix multiplications: ${multiplications} -> ${actualMultiplications}; all 2400 frame poses identical`)

      // Unrelated model siblings belong to the renderer's scene update, so
      // adding them must not increase the work required to solve either arm.
      for (let index = 0; index < 10; index++) actual.root.add(new Group())
      multiplications = 0
      actual.animator.update(16, now)
      assert.equal(multiplications, actualMultiplications)
    })
  }
})

describe('actual Dmeloper rig mouse control', () => {
  for (const model of ['wide', 'slim'] as const) {
    it(`${model}: OFF rests both hands at keyboard targets while ON keeps the mouse rest`, async (t) => {
      let now = 1000
      t.mock.method(performance, 'now', () => now)
      const off = await fixture(model)
      const keyboardControl = await fixture(model, true)
      const on = await fixture(model)
      off.animator.update(16, now)
      on.animator.update(16, now)
      close(off.pose('R_Upperarm'), on.pose('R_Upperarm'))
      const before = off.pose('R_Upperarm')
      off.animator.setMouseEnabled(false)
      off.animator.update(16, now + 16)
      assert.notDeepEqual(off.pose('R_Upperarm'), before)
      off.advance(1016, 3000)
      keyboardControl.advance(1016, 3000)
      on.advance(1016, 3000)
      for (const name of ['L_Upperarm', 'L_Forearm', 'L_Hand', 'R_Upperarm', 'R_Forearm', 'R_Hand', 'Head']) {
        close(off.pose(name), keyboardControl.pose(name))
      }
      assert.notDeepEqual(off.pose('R_Upperarm'), on.pose('R_Upperarm'))
      now = 3000
      off.animator.setMouseEnabled(true)
      off.advance(3016, 5000)
      on.advance(3016, 5000)
      close(off.pose('R_Upperarm'), on.pose('R_Upperarm'))
      off.dispose()
      keyboardControl.dispose()
      on.dispose()
    })
  }

  it('ignores disabled mouse input, clears held strikes/gaze, and preserves simultaneous keyboard holds', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const actual = await fixture()
    const control = await fixture()
    actual.animator.setMousePosition(0, 1)
    actual.animator.setMouseButtonPressed('Middle', true)
    actual.advance(1000, 1100)
    now = 1100
    for (const rig of [actual, control]) {
      rig.animator.setKeyPressed('left-contact', true, target(-0.8, -0.2))
      rig.animator.setKeyPressed('right-contact', true, target(0.8, -0.2))
      rig.animator.setMouseEnabled(false)
    }
    actual.animator.setMousePosition(1, 0)
    for (const button of ['Left', 'Right', 'Middle'] as const) actual.animator.setMouseButtonPressed(button, true)
    actual.advance(1100, 3000)
    control.advance(1100, 3000)
    for (const name of ['L_Upperarm', 'R_Upperarm', 'R_Hand', 'Head']) close(actual.pose(name), control.pose(name))
    const heldLeft = actual.pose('L_Upperarm')
    const heldRight = actual.pose('R_Upperarm')
    now = 3000
    for (const rig of [actual, control]) {
      rig.animator.setKeyPressed('left-contact', false, target(-0.8, -0.2))
      rig.animator.setKeyPressed('right-contact', false, target(0.8, -0.2))
      rig.advance(3000, 5000)
      rig.animator.setMouseEnabled(true)
      rig.advance(5000, 7000)
    }
    assert.notDeepEqual(actual.pose('L_Upperarm'), heldLeft)
    assert.notDeepEqual(actual.pose('R_Upperarm'), heldRight)
    close(actual.pose('Head'), control.pose('Head'))
    close(actual.pose('R_Upperarm'), control.pose('R_Upperarm'))
    now = 7000
    actual.animator.setMousePosition(0, 0)
    actual.advance(7000, 7400)
    control.advance(7000, 7400)
    assert.notDeepEqual(actual.pose('Head'), control.pose('Head'))
    actual.dispose()
    const disposedPose = actual.pose('Head')
    actual.animator.setMouseEnabled(false)
    actual.animator.setMousePosition(1, 1)
    actual.animator.update(1000, 9000)
    close(actual.pose('Head'), disposedPose)
    control.dispose()
  })
})

describe('keyboard edge rest and independent arm settings on the actual rig', () => {
  for (const model of ['wide', 'slim'] as const) {
    it(`${model}: follows the outer home-row key through keyboard transforms and returns after typing`, async (t) => {
      let now = 1000
      t.mock.method(performance, 'now', () => now)
      const off = await fixture(model)
      const control = await fixture(model, true)
      t.after(off.dispose)
      t.after(control.dispose)
      off.animator.setMouseEnabled(false)
      const rest = off.keyboard.getKeyTarget(config.inputMode.rightIdleKey)!
      const j = off.keyboard.getKeyTarget('KeyJ')!
      assert.equal(rest.position[2], j.position[2])
      assert.ok(rest.position[0] > j.position[0])
      assert.deepEqual(rest, off.keyboard.getContactTarget({ row: 2, column: 13 }))

      for (const scale of [0.5, 1, 2]) {
        for (const rig of [off, control]) {
          rig.keyboard.group.scale.setScalar(MODEL_3D_CONFIG.keyboard.scale * scale)
          rig.keyboard.group.position.x += 0.15
          rig.keyboard.group.position.z -= 0.1
          rig.keyboard.group.rotation.y += MathUtils.degToRad(15)
        }
        control.anchor.position.fromArray(rest.position)
        control.anchor.position.y += config.keyboard.restHoverHeight
        control.keyboard.group.localToWorld(control.anchor.position)
        off.advance(now, now + 2000)
        control.advance(now, now + 2000)
        close(off.pose('R_Upperarm'), control.pose('R_Upperarm'))
        close(off.pose('R_Forearm'), control.pose('R_Forearm'))

        now += 2000
        const resting = off.pose('R_Upperarm')
        off.animator.setKeyPressed('J', true, j)
        off.advance(now, now + 400)
        assert.notDeepEqual(off.pose('R_Upperarm'), resting)
        now += 400
        off.animator.setKeyPressed('J', false, j)
        off.advance(now, now + 3000)
        control.advance(now, now + 3000)
        close(off.pose('R_Upperarm'), control.pose('R_Upperarm'))
        now += 3000
      }
    })

    it(`${model}: preserves full shoulder rotations across device transforms and typing transitions`, async (t) => {
      let now = 1000
      t.mock.method(performance, 'now', () => now)
      const actual = await fixture(model)
      const control = await fixture(model)
      t.after(actual.dispose)
      t.after(control.dispose)
      let angle = 0
      const assertArmRotation = () => {
        for (const [side, rotationSign] of [['L', 1], ['R', 1]] as const) {
          const shoulder = control.worldPosition(`${side}_Upperarm`)
          const axis = new Vector3(0, 1, 0).applyQuaternion(control.keyboard.group.getWorldQuaternion(new Quaternion()))
          const expectedHand = control.worldPosition(`${side}_Hand`).sub(shoulder).applyAxisAngle(axis, MathUtils.degToRad(angle) * rotationSign).add(shoulder)
          close(actual.worldPosition(`${side}_Hand`).toArray(), expectedHand.toArray())
          close(actual.worldPosition(`${side}_Upperarm`).toArray(), shoulder.toArray())
          for (const [from, to] of [['Upperarm', 'Forearm'], ['Forearm', 'Hand']]) {
            const length = (rig: typeof actual) => rig.worldPosition(`${side}_${from}`).distanceTo(rig.worldPosition(`${side}_${to}`))
            assert.ok(Math.abs(length(actual) - length(control)) < 0.000001)
          }
        }
      }
      for (const size of [0.5, 1, 2]) {
        for (const rig of [actual, control]) {
          rig.keyboard.group.scale.setScalar(MODEL_3D_CONFIG.keyboard.scale * size)
          rig.keyboard.group.position.x += 0.2
          rig.keyboard.group.position.z -= 0.15
          rig.keyboard.group.rotation.y += MathUtils.degToRad(15)
          rig.root.rotation.y = MathUtils.degToRad(25)
          rig.anchor.position.x -= 0.1
        }
        for (const mouseEnabled of [false, true]) {
          for (const rig of [actual, control]) {
            rig.animator.setMouseEnabled(mouseEnabled)
            rig.advance(now, now + 2000)
          }
          now += 2000
          for (const bend of [0, 100, 200, 400]) {
            for (angle of [-45, 0, 45]) {
              actual.animator.setArmPoseSettings({
                petLeftArmBendPercent: bend,
                petRightArmBendPercent: 400 - bend,
                petLeftArmSpreadDegrees: angle,
                petRightArmSpreadDegrees: -angle,
              })
              control.animator.setArmPoseSettings({
                ...DEFAULT_PET_ARM_POSE_SETTINGS,
                petLeftArmBendPercent: bend,
                petRightArmBendPercent: 400 - bend,
              })
              for (const rig of [actual, control]) rig.animator.update(0, now)
              assertArmRotation()
            }
          }
          for (const rig of [actual, control]) {
            rig.animator.setKeyPressed('J', true, rig.keyboard.getKeyTarget('KeyJ'))
            rig.advance(now, now + 500)
          }
          now += 500
          assertArmRotation()
          for (const rig of [actual, control]) {
            rig.animator.setKeyPressed('J', false, rig.keyboard.getKeyTarget('KeyJ'))
            rig.advance(now, now + 3000)
          }
          now += 3000
          assertArmRotation()
        }
      }
    })

    for (const activity of ['mouse', 'idle', 'typing'] as const) {
      it(`${model}/${activity}: bends each arm independently and rotates its whole chain by the full requested angle`, async (t) => {
        t.mock.method(performance, 'now', () => 1000)
        const actual = await fixture(model)
        const control = await fixture(model)
        t.after(actual.dispose)
        t.after(control.dispose)
        for (const rig of [actual, control]) {
          if (activity !== 'mouse') rig.animator.setMouseEnabled(false)
          if (activity === 'typing') {
            rig.animator.setKeyPressed('F', true, rig.keyboard.getKeyTarget('KeyF'))
            rig.animator.setKeyPressed('J', true, rig.keyboard.getKeyTarget('KeyJ'))
          }
          rig.advance(1000, 3000)
          rig.animator.update(16, 3000)
        }
        for (const side of ['Left', 'Right'] as const) {
          const prefix = side === 'Left' ? 'L' : 'R'
          const other = side === 'Left' ? 'R' : 'L'
          const outwardSign = side === 'Left' ? 1 : -1
          for (const bend of [0, 100, 200, 400]) {
            for (const spread of [-45, 0, 45]) {
              actual.animator.setArmPoseSettings({
                ...DEFAULT_PET_ARM_POSE_SETTINGS,
                [`pet${side}ArmBendPercent`]: bend,
                [`pet${side}ArmSpreadDegrees`]: spread,
              })
              actual.animator.update(0, 3000)
              control.animator.update(0, 3000)
              control.animator.setArmPoseSettings({
                ...DEFAULT_PET_ARM_POSE_SETTINGS,
                [`pet${side}ArmBendPercent`]: bend,
              })
              control.animator.update(0, 3000)
              const shoulder = control.worldPosition(`${prefix}_Upperarm`)
              const axis = new Vector3(0, 1, 0).applyQuaternion(control.keyboard.group.getWorldQuaternion(new Quaternion()))
              for (const joint of ['Forearm', 'Hand']) {
                const expected = control.worldPosition(`${prefix}_${joint}`).sub(shoulder).applyAxisAngle(axis, MathUtils.degToRad(spread) * outwardSign).add(shoulder)
                close(actual.worldPosition(`${prefix}_${joint}`).toArray(), expected.toArray())
              }
              for (const joint of ['Upperarm', 'Forearm', 'Hand']) {
                close(actual.pose(`${other}_${joint}`), control.pose(`${other}_${joint}`))
                const node = actual.root.getObjectByName(`${prefix}_${joint}`)!
                assert.ok(node.quaternion.toArray().every(Number.isFinite))
                assert.ok(Math.abs(node.quaternion.length() - 1) < 0.000001)
                close(node.position.toArray(), control.root.getObjectByName(`${prefix}_${joint}`)!.position.toArray())
              }
              const handDeviation = actual.worldPosition(`${prefix}_Hand`).distanceTo(control.worldPosition(`${prefix}_Hand`))
              if (spread !== 0) assert.ok(handDeviation > 0.1, `${side}/${bend}/${spread}: the hand follows the full shoulder rotation`)
              else assert.ok(handDeviation < 0.000001)
              const handDelta = actual.worldPosition(`${prefix}_Hand`).sub(control.worldPosition(`${prefix}_Hand`))
              assert.ok(Math.abs(handDelta.y) < 0.000001, 'shoulder spread stays parallel to the keyboard plane')
              if (spread !== 0) {
                assert.ok(handDelta.x * outwardSign * Math.sign(spread) > 0, `${side}/${bend}/${spread}: horizontal direction follows the slider`)
              }
            }
          }
        }
      })

      it(`${model}/${activity}: increases the elbow bend without moving shoulder attachments or destabilizing joints`, async (t) => {
        t.mock.method(performance, 'now', () => 1000)
        const results: Array<{ spread: number, shoulders: number[][] }> = []
        for (const percent of [0, 100, 200, 400]) {
          const rig = await fixture(model)
          t.after(rig.dispose)
          rig.animator.setArmPoseSettings({
            ...DEFAULT_PET_ARM_POSE_SETTINGS,
            petLeftArmBendPercent: percent,
            petRightArmBendPercent: percent,
          })
          if (activity !== 'mouse') rig.animator.setMouseEnabled(false)
          if (activity === 'typing') {
            rig.animator.setKeyPressed('F', true, rig.keyboard.getKeyTarget('KeyF'))
            rig.animator.setKeyPressed('J', true, rig.keyboard.getKeyTarget('KeyJ'))
          }
          rig.advance(1000, 3000)
          const position = (name: string) => rig.root.worldToLocal(rig.worldPosition(name))
          const leftElbow = position('L_Forearm')
          const rightElbow = position('R_Forearm')
          for (const name of ['L_Upperarm', 'R_Upperarm', 'L_Forearm', 'R_Forearm', 'L_Hand', 'R_Hand']) {
            assert.ok(rig.pose(name).every(Number.isFinite))
            assert.ok(Math.abs(rig.root.getObjectByName(name)!.quaternion.length() - 1) < 0.000001)
          }
          results.push({
            spread: Math.abs(leftElbow.x - rightElbow.x),
            shoulders: [position('L_Upperarm').toArray(), position('R_Upperarm').toArray()],
          })
        }
        assert.ok(results[0]!.spread < results[1]!.spread)
        assert.ok(results[1]!.spread < results[2]!.spread)
        assert.ok(results[2]!.spread < results[3]!.spread, '400% extends the former maximum bend')
        for (const sample of results) {
          sample.shoulders.forEach((position, side) => close(position, results[1]!.shoulders[side]!))
        }
      })
    }
  }

  it('preserves the default pose and converges after rapid arm updates without restarting input', async (t) => {
    t.mock.method(performance, 'now', () => 1000)
    const actual = await fixture()
    const control = await fixture()
    t.after(actual.dispose)
    t.after(control.dispose)
    for (const rig of [actual, control]) {
      rig.animator.setKeyPressed('F', true, rig.keyboard.getKeyTarget('KeyF'))
    }
    actual.animator.setArmPoseSettings(DEFAULT_PET_ARM_POSE_SETTINGS)
    actual.advance(1000, 2000)
    control.advance(1000, 2000)
    close(actual.pose('L_Upperarm'), control.pose('L_Upperarm'))
    for (const percent of [400, 200, 0, 150, Number.NaN, 20, Infinity, 100]) {
      actual.animator.setArmPoseSettings({
        petLeftArmBendPercent: percent,
        petRightArmBendPercent: 200 - percent,
        petLeftArmSpreadDegrees: percent - 100,
        petRightArmSpreadDegrees: 100 - percent,
      })
      actual.animator.update(16, 2000)
    }
    actual.advance(2000, 4000)
    control.advance(2000, 4000)
    for (const name of ['L_Upperarm', 'R_Upperarm', 'L_Hand', 'R_Hand']) {
      close(actual.pose(name), control.pose(name))
    }
  })
})

it('scales the head independently through animation without accumulating scale', async () => {
  const pet = await fixture()
  try {
    const head = pet.root.getObjectByName('Head')!
    const base = head.scale.clone()
    const torso = pet.root.getObjectByName('Spine02')!
    const torsoScale = torso.scale.clone()
    for (const percent of [25, 200, 100, 200]) {
      pet.animator.setHeadScalePercent(percent)
      pet.advance(0, 500)
      close(head.scale.toArray(), base.clone().multiplyScalar(percent / 100).toArray())
      close(torso.scale.toArray(), torsoScale.toArray())
    }
  } finally {
    pet.dispose()
  }
})
