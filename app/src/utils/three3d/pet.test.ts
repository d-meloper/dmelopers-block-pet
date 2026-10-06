/* eslint-disable test/no-import-node-test */
import type { Object3D, WebGLRenderer } from 'three'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Euler, Group, MathUtils, Matrix4, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { MODEL_3D_CONFIG } from '@/config/model3d'
import { DEFAULT_PET_ARM_POSE_SETTINGS } from '@/config/petArmPose'

import { Three3DRenderer } from '../three3d'
import { createDmeloperEyebrowController } from './dmeloperEyebrows'
import { createKeyboardGroup } from './keyboard'
import { createMouseGroup } from './mouse'
import { createPetAnimator } from './pet'
import { padContentRect, projectVisibleSceneBounds, unionContentRects } from './projectedBounds'
import { createVoxelSkinModelController } from './voxelSkin'

const config = MODEL_3D_CONFIG.pet.animation
const strikeDurationMs = config.keyboard.strikeContactMs + config.keyboard.strikeRiseMs + config.keyboard.strikeFallMs
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
          getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
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

async function fixture(model: 'wide' | 'slim' = 'wide', mouseAtKeyboard = false, random: () => number = () => 1, navigationTurn = true) {
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
    keyboardNavigationTargets: navigationTurn ? config.keyboard.navigationKeys.map(key => keyboard.getKeyTarget(key)!) : [],
    keyboardGroup,
    keyboardLeftRestTarget: keyboard.getKeyTarget(config.inputMode.leftIdleKey)!,
    keyboardRestTarget: keyboard.getKeyTarget('Space')!,
    keyboardRightRestTarget,
    mouseGroup,
  }, { random })!
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

function stillFrameFixture(rig: Awaited<ReturnType<typeof fixture>>) {
  const renderer = new Three3DRenderer()
  const scene = new Scene()
  const sceneRoot = new Group()
  const petGroup = new Group()
  petGroup.name = 'petGroup'
  petGroup.add(rig.root)
  sceneRoot.add(petGroup, rig.keyboard.group, rig.anchor.parent!)
  scene.add(sceneRoot)
  const mouse = createMouseGroup()
  const state = renderer as unknown as {
    renderer: WebGLRenderer
    scene: Scene
    sceneRoot: Group
    camera: PerspectiveCamera
    keyboard: typeof rig.keyboard
    mouse: typeof mouse
    petAnimator: typeof rig.animator
    lastAnimationAt: number
  }
  Object.assign(state, {
    renderer: { render: () => scene.updateMatrixWorld(true) } as unknown as WebGLRenderer,
    scene,
    sceneRoot,
    camera: new PerspectiveCamera(28, 500 / 422, 0.01, 100),
    keyboard: rig.keyboard,
    mouse,
    petAnimator: rig.animator,
  })
  renderer.refitComposition()
  return { renderer, mouse, state }
}

describe('live pose before broadcast auto crop', () => {
  it('uses the pre-trance visible scene and mouse crop even with an attached head rig', async (t) => {
    const rig = await fixture()
    const { renderer, mouse, state } = stillFrameFixture(rig)
    t.after(rig.dispose)
    t.after(mouse.dispose)
    // Keep the model attached so reintroducing automatic head padding fails.
    Object.assign(state, { petModel: rig.root })
    renderer.setAutoViewportPadding(2)
    rig.advance(0, 2000)
    const visible = projectVisibleSceneBounds(state.sceneRoot, state.camera, 500, 422)!
    const crop = renderer.getConservativeContentRect()
    t.diagnostic(JSON.stringify({ visible, crop }))
    const motion = renderer as unknown as { getMouseMotionContentRect: () => ReturnType<typeof projectVisibleSceneBounds> }
    assert.deepEqual(crop, padContentRect(unionContentRects(visible, motion.getMouseMotionContentRect()), 2))
  })

  it('measures the extended actual rig rather than the previous narrow arm pose', async (t) => {
    const rig = await fixture()
    const { renderer, mouse } = stillFrameFixture(rig)
    t.after(rig.dispose)
    t.after(mouse.dispose)
    renderer.setAutoViewportPadding(0)
    renderer.setMouseEnabled(false)
    renderer.setKeyboardScalePercent(50)
    renderer.setPetHeadScalePercent(25)
    renderer.setSceneRotation(0)
    renderer.setPetArmPoseSettings({ ...DEFAULT_PET_ARM_POSE_SETTINGS, petLeftArmSpreadDegrees: -45, petRightArmSpreadDegrees: -45 })
    renderer.renderStillFrame(50_000)
    const narrow = renderer.getConservativeContentRect()
    renderer.setPetArmPoseSettings({ ...DEFAULT_PET_ARM_POSE_SETTINGS, petLeftArmSpreadDegrees: 45, petRightArmSpreadDegrees: 45 })
    assert.deepEqual(renderer.getConservativeContentRect(), narrow, 'settings alone have not updated the rig')
    renderer.renderStillFrame(50_000)
    const measured = renderer.getConservativeContentRect()
    assert.ok(measured.x < narrow.x - 20, 'left arm would escape the previous crop')
    assert.ok(measured.x + measured.width > narrow.x + narrow.width + 20, 'right arm would escape the previous crop')
    rig.animator.update(16, 50_016)
    const nextFrame = renderer.getConservativeContentRect()
    assert.ok(nextFrame.x >= measured.x - 1)
    assert.ok(nextFrame.x + nextFrame.width <= measured.x + measured.width + 1)
  })

  it('keeps held keys/buttons and their live clock through settling and the next frame', async (t) => {
    let now = 50_000
    t.mock.method(performance, 'now', () => now)
    const rig = await fixture()
    const { renderer, mouse, state } = stillFrameFixture(rig)
    t.after(rig.dispose)
    t.after(mouse.dispose)
    const key = rig.keyboard.group.getObjectByName('keyboard-key-r2-c3-group')!
    const button = mouse.group.getObjectByName('mouseRightButton')!
    const restingKey = key.position.y
    const restingButton = button.position.y
    renderer.handleSemanticInput({ kind: 'typing', active: true, intensity: 1, contact: { row: 2, column: 3, pressed: true } })
    renderer.handleSemanticInput({ kind: 'mouse_primary', active: true })
    const keyUpdate = t.mock.method(rig.keyboard, 'update')
    const mouseUpdate = t.mock.method(mouse, 'update')
    const petUpdate = t.mock.method(rig.animator, 'update')
    state.lastAnimationAt = now - 16
    renderer.renderStillFrame(now)
    for (const update of [keyUpdate, mouseUpdate, petUpdate]) {
      assert.equal(update.mock.calls.length, 60)
      assert.ok(update.mock.calls.every(call => call.arguments[1] === now), 'neither rewind nor advance input time')
    }
    assert.equal(state.lastAnimationAt, now - 16, 'leave the real frame clock unchanged')
    const heldKey = key.position.y
    const heldButton = button.position.y
    assert.ok(heldKey < restingKey)
    assert.ok(heldButton < restingButton)
    now += 1000
    rig.keyboard.update(16, now)
    mouse.update(16, now)
    rig.animator.update(16, now)
    assert.equal(key.position.y, heldKey, 'held input survives beyond the minimum press pulse')
    assert.equal(button.position.y, heldButton)
    renderer.handleSemanticInput({ kind: 'typing', active: false, intensity: 0, contact: { row: 2, column: 3, pressed: false } })
    renderer.handleSemanticInput({ kind: 'mouse_primary', active: false })
    renderer.renderStillFrame(now)
    assert.equal(key.position.y, restingKey)
    assert.equal(button.position.y, restingButton)
  })
})

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
      const originalPoseHash = createHash('sha256')
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
          originalPoseHash.update(new Uint8Array(new Float64Array([
            ...node.quaternion.toArray(),
            ...node.matrixWorld.elements,
          ]).buffer))
        })
      }
      // This fingerprint includes independent cursor gaze and the owner-requested
      // 10-degree forward lean, 50/40/30 ms per-input strikes, chord grouping,
      // 7/Y/H/N hand boundaries, distance-weighted torso reach and planar hand travel.
      // The eager oracle verifies every quaternion/world matrix on every frame.
      assert.equal(originalPoseHash.digest('hex'), 'e1b7ca6a11056c43786eecb4cdbb59c1d81657df939388e7d8228d749131d3a9')
      const multiplyMatrices = Matrix4.prototype.multiplyMatrices
      const cloneVector = Vector3.prototype.clone
      const cloneQuaternion = Quaternion.prototype.clone
      let mathClones = 0
      t.mock.method(Vector3.prototype, 'clone', function (this: Vector3) {
        mathClones++
        return cloneVector.call(this)
      })
      t.mock.method(Quaternion.prototype, 'clone', function (this: Quaternion) {
        mathClones++
        return cloneQuaternion.call(this)
      })
      let multiplications = 0
      t.mock.method(Matrix4.prototype, 'multiplyMatrices', function (this: Matrix4, left: Matrix4, right: Matrix4) {
        multiplications++
        return multiplyMatrices.call(this, left, right)
      })
      actual.animator.update(16, now)
      const actualMultiplications = multiplications
      assert.equal(mathClones, 0)
      t.diagnostic(`Animator math clones per frame: 32 -> ${mathClones}; independent gaze pose fingerprint verified`)
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
  it('returns from a mid-strike pose to the mouse without following subsequent typing lifts', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const rigs = await Promise.all([fixture(), fixture()])
    for (const rig of rigs) {
      t.after(rig.dispose)
      rig.animator.setKeyPressed('Y', true, rig.keyboard.getKeyTarget('KeyY'))
      rig.advance(now, now + 2000)
    }
    now += 2000
    for (const rig of rigs) {
      rig.animator.setKeyPressed('Y', false, rig.keyboard.getKeyTarget('KeyY'))
      rig.animator.setKeyPressed('Y', true, rig.keyboard.getKeyTarget('KeyY'))
      rig.advance(now, now + 80)
    }
    now += 80
    const start = now
    const before = rigs[0]!.worldPosition('R_Hand')
    let previous = before.clone()
    let arrival: Vector3 | undefined
    for (; now <= start + 1200; now += 16) {
      // Only one rig keeps striking; both return to the same moving mouse.
      if (now > start && now < start + 220 && (now - start) % 32 === 0) {
        const rig = rigs[0]!
        rig.animator.setKeyPressed('Y', false, rig.keyboard.getKeyTarget('KeyY'))
        rig.animator.setKeyPressed('Y', true, rig.keyboard.getKeyTarget('KeyY'))
      }
      for (const rig of rigs) {
        rig.anchor.position.x = -1 + Math.min((now - start) / 1000, 0.2)
        rig.animator.setMousePosition(now % 32 ? 0.4 : 0.6, 0.5)
        rig.animator.update(16, now)
      }
      const current = rigs[0]!.worldPosition('R_Hand')
      close(current.toArray(), rigs[1]!.worldPosition('R_Hand').toArray())
      assert.ok(current.distanceTo(previous) < 0.2, 'return and arrival must remain continuous')
      if (now === start) assert.ok(current.distanceTo(before) < 0.05)
      if (now === start + 800) arrival = current.clone()
      previous = current
    }
    assert.ok(previous.distanceTo(before) > 0.1)
    assert.ok(arrival!.distanceTo(previous) < 0.02, 'the return must settle promptly')
    // A reversal cancels the captured mouse route and still permits typing.
    for (const rig of rigs) {
      rig.animator.setKeyPressed('F', true, rig.keyboard.getKeyTarget('KeyF'))
      rig.animator.setKeyPressed('Y', false, rig.keyboard.getKeyTarget('KeyY'))
      rig.animator.setKeyPressed('Y', true, rig.keyboard.getKeyTarget('KeyY'))
      rig.advance(now, now + 1000)
    }
    assert.ok(rigs[0]!.worldPosition('R_Hand').distanceTo(previous) > 0.1)
    now += 1000
    for (const rig of rigs) {
      rig.animator.setMousePosition(0.1, 0.5)
      rig.advance(now, now + 80)
    }
    now += 80
    const halfway = rigs[0]!.worldPosition('R_Hand')
    for (const rig of rigs) {
      for (const key of ['KeyF', 'KeyY']) {
        rig.animator.setKeyPressed(key, false, rig.keyboard.getKeyTarget(key))
        rig.animator.setKeyPressed(key, true, rig.keyboard.getKeyTarget(key))
      }
      rig.animator.update(16, now)
    }
    assert.ok(rigs[0]!.worldPosition('R_Hand').distanceTo(halfway) < 0.2)
    for (const rig of rigs) rig.advance(now + 16, now + 1000)
    assert.ok(rigs[0]!.worldPosition('R_Hand').distanceTo(previous) > 0.1)
  })

  it('moves from mouse rest into typing continuously and settles on the held contact', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const rig = await fixture()
    t.after(rig.dispose)
    rig.animator.setMousePosition(0.5, 0.5)
    for (; now < 2000; now += 16) {
      rig.animator.setMousePosition(now % 32 ? 0.4 : 0.6, 0.5)
      rig.animator.update(16, now)
    }
    const before = rig.worldPosition('R_Hand')
    rig.animator.setKeyPressed('F', true, rig.keyboard.getKeyTarget('KeyF'))
    rig.animator.setKeyPressed('Y', true, rig.keyboard.getKeyTarget('KeyY'))
    const start = now
    let previous = before.clone()
    let firstStep = 0
    let largestStep = 0
    for (; now < start + 800; now += 16) {
      rig.animator.update(16, now)
      const current = rig.worldPosition('R_Hand')
      const step = current.distanceTo(previous)
      if (now === start) firstStep = step
      largestStep = Math.max(largestStep, step)
      previous = current
    }
    const arrived = rig.worldPosition('R_Hand')
    assert.ok(arrived.distanceTo(before) > 0.1, 'the hand must reach a different device')
    assert.ok(firstStep < 0.05, 'the first frame must not jump to the key')
    assert.ok(largestStep < 0.2, 'the transfer must not contain a discontinuity')
    rig.advance(now, now + 1200)
    assert.ok(arrived.distanceTo(rig.worldPosition('R_Hand')) < 0.02, 'travel must settle quickly without a long tail')
  })

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

  it('keeps disabled mouse gaze independent from button reactions and simultaneous keyboard holds', async (t) => {
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
    for (const name of ['L_Upperarm', 'R_Upperarm', 'R_Hand']) close(actual.pose(name), control.pose(name))
    assert.notDeepEqual(actual.pose('Head'), control.pose('Head'))
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

it('holds a deeper reach across nearby keys, releases smoothly, and clears the hold on input reset', async (t) => {
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  const actual = await fixture()
  const control = await fixture()
  t.after(actual.dispose)
  t.after(control.dispose)
  for (const rig of [actual, control]) rig.animator.setMouseEnabled(false)
  const far = target(0, config.keyboard.farLeanEndZ)
  const near = target(0, config.keyboard.farLeanStartZ)
  const lean = () => MathUtils.radToDeg(actual.root.getObjectByName('Spine02')!.quaternion
    .angleTo(control.root.getObjectByName('Spine02')!.quaternion))
  const advanceTo = (end: number) => {
    for (; now <= end; now += 16) {
      actual.animator.update(16, now)
      control.animator.update(16, now)
    }
  }
  actual.animator.setKeyPressed('reach', true, far)
  advanceTo(2000)
  assert.ok(lean() > 9)
  const switchedAt = now
  actual.animator.setKeyPressed('reach', false, far)
  actual.animator.setKeyPressed('near', true, near)
  advanceTo(switchedAt + 320)
  assert.ok(lean() > 9, 'a nearer key must not immediately pull the torso upright')
  advanceTo(switchedAt + 750)
  assert.ok(lean() > 1 && lean() < 9, 'the retained reach eases out after the hold')
  advanceTo(switchedAt + 1800)
  assert.ok(lean() < 0.1, 'continued nearby input must not retain an old deep reach forever')

  for (let strike = 0; strike < 16; strike++) {
    actual.animator.setKeyPressed('near', false, near)
    actual.animator.setKeyPressed('reach', false, far)
    actual.animator.setKeyPressed(strike % 2 ? 'near' : 'reach', true, strike % 2 ? near : far)
    advanceTo(now + 96)
    if (strike >= 6) assert.ok(lean() > 9, 'alternating key distance must not pump the torso')
  }
  actual.animator.resetInput()
  advanceTo(now + 128)
  assert.ok(lean() < 7.5, 'input reset clears the retained target while normal pose damping remains')
  advanceTo(now + 1500)
  assert.ok(lean() < 0.1)
})

describe('keyboard row hand boundaries on the actual rig', () => {
  it('routes 7/Y/H/N and their right neighbors to the right hand, preserving left neighbors and Space', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const actual = await fixture()
    const expected = await fixture()
    t.after(actual.dispose)
    t.after(expected.dispose)
    for (const rig of [actual, expected]) rig.animator.setMouseEnabled(false)
    const cases = [
      ['Num6', 'Left'],
      ['Num7', 'Right'],
      ['Num8', 'Right'],
      ['KeyT', 'Left'],
      ['KeyY', 'Right'],
      ['KeyU', 'Right'],
      ['KeyG', 'Left'],
      ['KeyH', 'Right'],
      ['KeyJ', 'Right'],
      ['KeyB', 'Left'],
      ['KeyN', 'Right'],
      ['KeyM', 'Right'],
      ['Space', 'Left'],
    ] as const
    for (const [key, side] of cases) {
      for (const rig of [actual, expected]) rig.animator.resetInput()
      actual.animator.setKeyPressed(key, true, actual.keyboard.getKeyTarget(key))
      expected.animator.setKeyPressed(key, true, { ...expected.keyboard.getKeyTarget(key)!, typingSide: side })
      const end = now + 500
      for (; now < end; now += 10) {
        for (const rig of [actual, expected]) rig.animator.update(10, now)
        for (const joint of ['L_Hand', 'R_Hand']) {
          close(actual.worldPosition(joint).toArray(), expected.worldPosition(joint).toArray())
        }
      }
    }
    for (const [row, column, key] of [[0, 7, 'Num7'], [1, 6, 'KeyY'], [2, 6, 'KeyH'], [3, 6, 'KeyN']] as const) {
      assert.equal(actual.keyboard.getContactTarget({ row, column }), actual.keyboard.getKeyTarget(key))
    }
  })
})

describe('physical typing strikes on the actual rig', () => {
  for (const mouseEnabled of [false, true]) {
    it(`mouse ${mouseEnabled}: holds semantic contacts through key repeat without retriggering or reordering hands`, async (t) => {
      let now = 1000
      t.mock.method(performance, 'now', () => now)
      const rigs = await Promise.all([fixture(), fixture()])
      const scenes = rigs.map((rig) => {
        const scene = stillFrameFixture(rig)
        t.after(rig.dispose)
        t.after(scene.mouse.dispose)
        scene.renderer.setMouseEnabled(mouseEnabled)
        return scene
      })
      const left = { row: 2, column: 3 }
      const right = { row: 2, column: 7 }
      const send = (index: number, contact: typeof left, pressed: boolean) => {
        scenes[index]!.renderer.handleSemanticInput({ kind: 'typing', active: pressed, intensity: pressed ? 1 : 0, contact: { ...contact, pressed } })
      }
      for (; now <= 5500; now += 10) {
        for (let index = 0; index < rigs.length; index++) {
          if (now === 1000 || now === 4400) send(index, left, true)
          if (now === 2400) send(index, right, true)
          if (now === 3600) {
            send(index, left, false)
            send(index, right, false)
          }
          // Exercise the combined mouse/keyboard track as well as both hand tracks.
          if (mouseEnabled) scenes[index]!.renderer.handleSemanticInput({ kind: 'pointer_activity', x: 0.5 + Math.sin(now / 1000) / 10, y: 0.5 })
        }
        // The control receives only physical edges. The actual renderer also
        // receives Windows-style repeated downs, including an older held key.
        if (((now >= 1500 && now < 3600) || now >= 4800) && now % 30 === 0) send(0, left, true)
        for (const rig of rigs) {
          rig.keyboard.update(10, now)
          rig.animator.update(10, now)
        }
        for (const joint of ['L_Hand', 'R_Hand', 'L_Forearm', 'R_Forearm', 'Head']) {
          close(rigs[0]!.pose(joint), rigs[1]!.pose(joint))
          close(rigs[0]!.worldPosition(joint).toArray(), rigs[1]!.worldPosition(joint).toArray())
        }
        for (const contact of [left, right]) {
          const name = `keyboard-key-r${contact.row}-c${contact.column}-group`
          assert.equal(rigs[0]!.keyboard.group.getObjectByName(name)!.position.y, rigs[1]!.keyboard.group.getObjectByName(name)!.position.y)
        }
      }
    })
  }

  for (const mouseEnabled of [false, true]) {
    it(`mouse ${mouseEnabled}: restarts contact for physical presses at fast input rates and settles on hold`, async (t) => {
      let now = 1000
      t.mock.method(performance, 'now', () => now)
      const period = strikeDurationMs
      const intervals = [20, 40, 80, period]
      const rigs = await Promise.all(intervals.map(() => fixture()))
      for (const rig of rigs) {
        t.after(rig.dispose)
        rig.animator.setMouseEnabled(mouseEnabled)
      }
      const heights: number[][] = intervals.map(() => [])
      for (; now <= 3400; now++) {
        for (const [index, rig] of rigs.entries()) {
          if ((now - 1000) % intervals[index]! === 0) {
            for (const key of ['KeyF', 'KeyJ']) {
              rig.animator.setKeyPressed(key, false, rig.keyboard.getKeyTarget(key))
              rig.animator.setKeyPressed(key, true, rig.keyboard.getKeyTarget(key))
            }
          }
          rig.animator.update(1, now)
        }
        if (now >= 3400 - period && now < 3400) {
          rigs.forEach((rig, index) => heights[index]!.push(rig.worldPosition('L_Hand').y))
        }
      }
      const fastRange = Math.max(...heights[0]!) - Math.min(...heights[0]!)
      const fullCycleRange = Math.max(...heights.at(-1)!) - Math.min(...heights.at(-1)!)
      assert.ok(fastRange < 0.01, 'presses inside the contact phase restart contact instead of continuing a shared cycle')
      assert.ok(fullCycleRange > 0.05, 'spaced presses retain visible lift between strikes')
      // No more key-downs: a held key must not keep the cadence looping forever.
      for (; now <= 6000; now++) {
        for (const rig of rigs) rig.animator.update(1, now)
      }
      for (const rig of rigs.slice(0, -1)) {
        close(rig.pose('L_Hand'), rigs.at(-1)!.pose('L_Hand'))
        close(rig.pose('R_Hand'), rigs.at(-1)!.pose('R_Hand'))
      }
    })
  }

  it('groups chord keys once, retains physical retriggers and resets the fixed grouping window', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const cases = [
      { inputs: [['B', 0], ['C', 8], ['D', 16], ['E', 39]], extraStrike: false },
      { inputs: [['B', 40]], extraStrike: true },
      { inputs: [['B', 25], ['C', 50]], extraStrike: true },
      { inputs: [['A', 8]], extraStrike: true },
    ] as const
    for (const mouseEnabled of [false, true]) {
      for (const scenario of cases) {
        const actual = await fixture()
        const control = await fixture()
        for (const rig of [actual, control]) {
          t.after(rig.dispose)
          rig.animator.setMouseEnabled(mouseEnabled)
        }
        // Equal targets isolate strike scheduling from travel between key positions.
        for (const start of [1000, 1010]) {
          now = start
          for (const rig of [actual, control]) {
            rig.animator.resetInput()
            rig.animator.setKeyPressed('A', true, rig.keyboard.getKeyTarget('KeyF'))
          }
          let difference = 0
          for (; now <= start + 600; now++) {
            for (const [key, offset] of scenario.inputs) {
              if (now === start + offset) {
                const target = actual.keyboard.getKeyTarget('KeyF')!
                actual.animator.setKeyPressed(key, false, target)
                actual.animator.setKeyPressed(key, true, target)
              }
            }
            for (const rig of [actual, control]) rig.animator.update(1, now)
            if (now >= start + strikeDurationMs) {
              difference = Math.max(difference, actual.worldPosition('L_Hand').distanceTo(control.worldPosition('L_Hand')))
            }
          }
          if (scenario.extraStrike) assert.ok(difference > 0.01, 'separate strokes still animate')
          else assert.ok(difference < 1e-8, 'one chord must match one held-key strike')
        }
      }
    }
  })

  it('finishes fast input without a backlog and clears strikes on reset', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const actual = await fixture()
    const resting = await fixture()
    t.after(actual.dispose)
    t.after(resting.dispose)
    for (const rig of [actual, resting]) rig.animator.setMouseEnabled(false)
    const key = actual.keyboard.getKeyTarget('KeyF')!
    for (; now <= 3000; now += 10) {
      actual.animator.setKeyPressed('F', false, key)
      actual.animator.setKeyPressed('F', true, key)
      actual.animator.update(10, now)
      resting.animator.update(10, now)
    }
    actual.animator.setKeyPressed('F', false, key)
    for (; now <= 5500; now += 10) {
      actual.animator.update(10, now)
      resting.animator.update(10, now)
    }
    close(actual.pose('L_Hand'), resting.pose('L_Hand'))
    // Reset a second burst, then compare a new isolated strike to a clean rig.
    for (; now <= 6000; now += 10) {
      actual.animator.setKeyPressed('F', false, key)
      actual.animator.setKeyPressed('F', true, key)
      actual.animator.update(10, now)
    }
    actual.animator.resetInput()
    resting.animator.resetInput()
    for (; now <= 8500; now += 10) {
      actual.animator.update(10, now)
      resting.animator.update(10, now)
    }
    for (const rig of [actual, resting]) rig.animator.setKeyPressed('F', true, key)
    for (let frame = 0; frame < 100; frame++, now += 10) {
      actual.animator.update(10, now)
      resting.animator.update(10, now)
      close(actual.pose('L_Hand'), resting.pose('L_Hand'))
    }
  })
})

describe('right-hand leftward torso reach', () => {
  it('spreads the turn across the main right-hand row with two degrees per standard key', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const rig = await fixture()
    t.after(rig.dispose)
    rig.animator.setMouseEnabled(false)
    const yaw = () => new Euler().setFromQuaternion(rig.root.getObjectByName('Spine02')!.quaternion).y
    rig.advance(now, now + 2000)
    now += 2000
    const restingYaw = yaw()
    for (const [index, key] of ['KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'LeftBracket', 'RightBracket'].entries()) {
      rig.animator.resetInput()
      rig.animator.setKeyPressed(key, true, rig.keyboard.getKeyTarget(key))
      rig.advance(now, now + 2000)
      now += 2000
      const turnDegrees = MathUtils.radToDeg(yaw() - restingYaw)
      assert.ok(Math.abs(turnDegrees - (20 - 2 * index)) < 0.01, `${key}: got ${turnDegrees} degrees`)
    }
  })

  it('turns progressively left, eases back on release/reset and stops when the right hand holds the mouse', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const rig = await fixture()
    t.after(rig.dispose)
    rig.animator.setMouseEnabled(false)
    const spine = rig.root.getObjectByName('Spine02')!
    const rootPosition = rig.root.position.clone()
    const spinePosition = spine.position.clone()
    const yaw = () => new Euler().setFromQuaternion(spine.quaternion).y
    const advance = (duration: number) => {
      rig.advance(now, now + duration)
      now += duration
    }
    advance(2000)
    const restingYaw = yaw()
    let previousTurn = 0
    for (const key of ['KeyM', 'KeyN', 'KeyY']) {
      rig.animator.resetInput()
      advance(2000)
      rig.animator.setKeyPressed(key, true, rig.keyboard.getKeyTarget(key))
      advance(16)
      assert.ok(Math.abs(yaw() - restingYaw) < 0.04, 'the first frame must ease into the turn')
      advance(2000)
      const turn = yaw() - restingYaw
      assert.ok(turn > previousTurn + 0.001, `${key}: farther left must increase leftward yaw`)
      assert.ok(turn <= MathUtils.degToRad(config.keyboard.rightHandLeftTurnDegrees) + 0.00001)
      previousTurn = turn
      assert.deepEqual(rig.root.position.toArray(), rootPosition.toArray())
      assert.deepEqual(spine.position.toArray(), spinePosition.toArray())
    }
    const heldYaw = yaw()
    rig.animator.setKeyPressed('KeyY', false, rig.keyboard.getKeyTarget('KeyY'))
    advance(16)
    assert.ok(Math.abs(yaw() - heldYaw) < 0.001, 'release must start smoothly')
    advance(400)
    assert.ok(yaw() > restingYaw && yaw() < heldYaw, 'release must ease back instead of snapping')
    advance(3000)
    assert.ok(Math.abs(yaw() - restingYaw) < 0.00001)
    rig.animator.setKeyPressed('KeyT', true, rig.keyboard.getKeyTarget('KeyT'))
    advance(2000)
    assert.ok(Math.abs(yaw() - restingYaw) < 0.00001, 'left-hand keys must not trigger right-hand reach')
    rig.animator.resetInput()
    rig.animator.setKeyPressed('KeyY', true, rig.keyboard.getKeyTarget('KeyY'))
    advance(2000)
    assert.ok(yaw() > restingYaw + 0.09)
    rig.animator.setMouseEnabled(true)
    for (let frame = 0; frame < 200; frame++) {
      now += 16
      rig.animator.setMousePosition(frame % 2, 0)
      rig.animator.update(16, now)
    }
    assert.ok(Math.abs(yaw() - restingYaw) < 0.00001, 'mouse-hand mode must remove left reach')
    rig.animator.setMouseEnabled(false)
    advance(2000)
    assert.ok(yaw() > restingYaw + 0.09)
    rig.animator.resetInput()
    advance(3000)
    assert.ok(Math.abs(yaw() - restingYaw) < 0.00001)
  })
})

describe('navigation-key torso turn', () => {
  for (const model of ['wide', 'slim'] as const) {
    it(`${model}: turns the upper body for all six semantic targets while the hips stay fixed`, async (t) => {
      let now = 1000
      t.mock.method(performance, 'now', () => now)
      const actual = await fixture(model)
      const control = await fixture(model, false, () => 1, false)
      t.after(actual.dispose)
      t.after(control.dispose)
      const rest = actual.root.position.clone()
      const spinePosition = actual.root.getObjectByName('Spine02')!.position.clone()
      const elbowAngle = (rig: typeof actual) => {
        const elbow = rig.worldPosition('R_Forearm')
        return MathUtils.radToDeg(rig.worldPosition('R_Upperarm').sub(elbow)
          .angleTo(rig.worldPosition('R_Hand').sub(elbow)))
      }
      const contacts = [
        { row: 4, column: 6 },
        { row: 4, column: 7 },
        { row: 4, column: 8 },
        { row: 3, column: 12 },
        { row: 2, column: 13 },
        { row: 3, column: 13 },
      ]
      for (const rig of [actual, control]) {
        rig.animator.setMouseEnabled(false)
        rig.keyboard.group.position.z -= 0.15
      }
      for (const [index, key] of config.keyboard.navigationKeys.entries()) {
        for (const rig of [actual, control]) {
          rig.animator.resetInput()
          rig.advance(now, now + 2000)
        }
        now += 2000
        const spine = actual.root.getObjectByName('Spine02')!
        const beforeTurn = spine.quaternion.clone()
        for (const rig of [actual, control]) {
          const contact = rig.keyboard.getContactTarget(contacts[index])!
          assert.equal(contact, rig.keyboard.getKeyTarget(key))
          rig.animator.setKeyPressed(`${contacts[index].row}:${contacts[index].column}`, true, contact)
        }
        actual.animator.update(16, now + 16)
        assert.ok(spine.quaternion.angleTo(beforeTurn) < 0.04, 'the first frame must not snap to the full turn')
        actual.advance(now + 32, now + 2000)
        control.advance(now + 16, now + 2000)
        now += 2000
        assert.deepEqual(actual.root.position.toArray(), rest.toArray())
        assert.deepEqual(spine.position.toArray(), spinePosition.toArray(), 'turn at the waist without translating it')
        const rotation = new Euler().setFromQuaternion(spine.quaternion)
        assert.ok(Math.abs(MathUtils.radToDeg(rotation.y) + 6.6) < 0.01)
        assert.ok(MathUtils.radToDeg(rotation.x) > -4 && MathUtils.radToDeg(rotation.x) < -1)
        const before = elbowAngle(control)
        const after = elbowAngle(actual)
        t.diagnostic(`${key}: elbow opens ${before.toFixed(2)} -> ${after.toFixed(2)} degrees`)
        assert.ok(after >= before - 0.00001, `${key}: the subtle turn must not fold the elbow farther`)
      }
    })
  }

  it('holds through repeats/key changes and smoothly returns on release and reset', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const actual = await fixture()
    const control = await fixture()
    t.after(actual.dispose)
    t.after(control.dispose)
    for (const rig of [actual, control]) rig.animator.setMouseEnabled(false)
    const yaw = () => new Euler().setFromQuaternion(actual.root.getObjectByName('Spine02')!.quaternion).y
    const key = actual.keyboard.getKeyTarget('LeftArrow')!
    actual.animator.setKeyPressed('left', true, key)
    actual.advance(now, now + 2000)
    now += 2000
    const held = yaw()
    for (let frame = 0; frame < 50; frame++) {
      now += 16
      actual.animator.setKeyPressed('left', true, key)
      actual.animator.update(16, now)
      assert.ok(Math.abs(yaw() - held) < 0.00001)
    }
    actual.animator.setKeyPressed('left', false, key)
    const next = actual.keyboard.getKeyTarget('PageDown')!
    actual.animator.setKeyPressed('page', true, next)
    actual.animator.update(16, now + 16)
    assert.ok(Math.abs(yaw() - held) < 0.00001)
    now += 16
    actual.animator.setKeyPressed('page', false, next)
    actual.advance(now, now + 400)
    assert.ok(Math.abs(yaw() - held) < 0.00001)
    actual.advance(now + 416, now + 800)
    assert.ok(yaw() > held && yaw() < 0)
    for (const rig of [actual, control]) rig.advance(now + 816, now + 4000)
    close(actual.pose('Spine02'), control.pose('Spine02'))
    now += 4000
    actual.animator.setKeyPressed('page', true, next)
    actual.advance(now, now + 1000)
    actual.animator.resetInput()
    for (const rig of [actual, control]) rig.advance(now + 1000, now + 4000)
    close(actual.pose('Spine02'), control.pose('Spine02'))
  })

  it('wires semantic navigation targets, preserves normal keys and respects mouse-hand mode', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const actual = await fixture()
    const control = await fixture('wide', false, () => 1, false)
    const { renderer, mouse } = stillFrameFixture(actual)
    t.after(actual.dispose)
    t.after(control.dispose)
    t.after(mouse.dispose)
    const targets = (renderer as unknown as { getPetAnimatorTargets: () => Parameters<typeof createPetAnimator>[1] }).getPetAnimatorTargets()
    assert.deepEqual(targets.keyboardNavigationTargets, config.keyboard.navigationKeys.map(key => actual.keyboard.getKeyTarget(key)))
    renderer.setMouseEnabled(false)
    control.animator.setMouseEnabled(false)
    for (const key of ['KeyJ', 'Return', 'Home', 'Delete', 'ShiftRight', 'Space']) {
      for (const rig of [actual, control]) {
        rig.animator.resetInput()
        rig.animator.setKeyPressed(key, true, rig.keyboard.getKeyTarget(key))
        rig.advance(now, now + 1000)
      }
      now += 1000
      close(actual.pose('Spine02'), control.pose('Spine02'))
    }
    for (const rig of [actual, control]) {
      rig.animator.resetInput()
      rig.animator.setMouseEnabled(true)
      rig.animator.setMousePosition(0, 0)
      rig.advance(now, now + 300)
    }
    now += 300
    renderer.handleSemanticInput({ kind: 'typing', active: true, intensity: 1, contact: { row: 4, column: 8, pressed: true } })
    control.animator.setKeyPressed('4:8', true, control.keyboard.getContactTarget({ row: 4, column: 8 }))
    for (let frame = 0; frame < 60; frame++) {
      now += 16
      for (const rig of [actual, control]) {
        rig.animator.setMousePosition(frame % 2, 0)
        rig.animator.update(16, now)
      }
      close(actual.pose('Spine02'), control.pose('Spine02'))
    }
    renderer.setMouseEnabled(false)
    actual.advance(now, now + 2000)
    assert.ok(new Euler().setFromQuaternion(actual.root.getObjectByName('Spine02')!.quaternion).y < -0.1)
  })
})

describe('typing trance on the actual rig', () => {
  for (const kind of ['mouse_primary', 'mouse_secondary', 'mouse_middle'] as const) {
    it(`${kind}: counts fresh clicks, ignores holds and releases, and returns after quiet`, async (t) => {
      let now = 1000
      let decisions = 0
      t.mock.method(performance, 'now', () => now)
      const actual = await fixture('wide', false, () => {
        decisions++
        return 0
      })
      const control = await fixture()
      const scenes = [actual, control].map(stillFrameFixture)
      for (const rig of [actual, control]) t.after(rig.dispose)
      for (const scene of scenes) t.after(scene.mouse.dispose)
      for (; now <= 3000; now += 80) {
        for (const scene of scenes) scene.renderer.handleSemanticInput({ kind, active: true })
        for (const rig of [actual, control]) rig.animator.update(80, now)
      }
      assert.equal(decisions, 0, 'a held button is a single click')
      for (now = 3200; now <= 5200; now += 80) {
        for (const scene of scenes) scene.renderer.handleSemanticInput({ kind, active: false })
        for (const rig of [actual, control]) rig.animator.update(80, now)
      }
      assert.equal(decisions, 0, 'releases are not fresh presses')
      for (now = 5400; now <= 9400; now += 20) {
        if (now % 80 === 0) {
          for (const scene of scenes) {
            scene.renderer.handleSemanticInput({ kind, active: false })
            scene.renderer.handleSemanticInput({ kind, active: true })
          }
        }
        for (const rig of [actual, control]) rig.animator.update(20, now)
      }
      assert.equal(decisions, 1)
      const head = () => actual.root.getObjectByName('Head')!.quaternion.angleTo(control.root.getObjectByName('Head')!.quaternion)
      assert.ok(head() > 0.2 && head() < 0.3)
      for (const scene of scenes) scene.renderer.handleSemanticInput({ kind, active: false })
      for (const rig of [actual, control]) rig.advance(9420, 12400)
      assert.ok(head() < 0.01)
    })
  }

  it('combines keyboard and click presses that are individually below the entry threshold', async (t) => {
    let now = 1000
    const decisions = [0, 0, 0]
    t.mock.method(performance, 'now', () => now)
    const rigs = await Promise.all(decisions.map((_count, index) => fixture('wide', false, () => {
      decisions[index]++
      return 0
    })))
    const scenes = rigs.map(stillFrameFixture)
    for (const rig of rigs) t.after(rig.dispose)
    for (const scene of scenes) t.after(scene.mouse.dispose)
    const contact = { row: 2, column: 3 }
    assert.ok(rigs[0].keyboard.getContactTarget(contact))
    for (; now <= 5000; now += 20) {
      if ((now - 1000) % 160 === 0) {
        for (const index of [0, 1]) {
          for (const pressed of [false, true]) scenes[index].renderer.handleSemanticInput({ kind: 'typing', active: pressed, intensity: 1, contact: { ...contact, pressed } })
        }
      } else if ((now - 1000) % 160 === 80) {
        for (const index of [0, 2]) {
          for (const active of [false, true]) scenes[index].renderer.handleSemanticInput({ kind: 'mouse_primary', active })
        }
      }
      for (const rig of rigs) rig.animator.update(20, now)
    }
    assert.deepEqual(decisions, [1, 0, 0])
  })

  it('ignores disabled mouse clicks, movement and wheel activity', async (t) => {
    let now = 1000
    let decisions = 0
    t.mock.method(performance, 'now', () => now)
    const rig = await fixture('wide', false, () => {
      decisions++
      return 0
    })
    const { renderer, mouse } = stillFrameFixture(rig)
    t.after(rig.dispose)
    t.after(mouse.dispose)
    renderer.setMouseEnabled(false)
    for (; now <= 5000; now += 50) {
      for (const kind of ['mouse_primary', 'mouse_secondary', 'mouse_middle'] as const) {
        renderer.handleSemanticInput({ kind, active: false })
        renderer.handleSemanticInput({ kind, active: true })
      }
      // The direct animator boundary must enforce the same disabled-input gate.
      rig.animator.setMouseButtonPressed('Left', false)
      rig.animator.setMouseButtonPressed('Left', true)
      rig.animator.update(50, now)
    }
    assert.equal(decisions, 0)
    renderer.setMouseEnabled(true)
    for (; now <= 9000; now += 50) {
      renderer.handleSemanticInput({ kind: 'pointer_activity', x: now % 100 ? 0 : 1, y: 0 })
      renderer.handleSemanticInput({ kind: 'scroll', deltaX: 0, deltaY: 1 })
      rig.animator.update(50, now)
    }
    assert.equal(decisions, 0)
  })

  it('ignores held-key repeats, enters on new strikes, and returns after quiet', async (t) => {
    let now = 1000
    let decisions = 0
    t.mock.method(performance, 'now', () => now)
    const actual = await fixture('wide', false, () => {
      decisions++
      return 0
    })
    const control = await fixture()
    const key = actual.keyboard.getKeyTarget('KeyF')!
    for (; now <= 3000; now += 100) {
      actual.animator.setKeyPressed('F', true, key)
      actual.animator.update(100, now)
    }
    assert.equal(decisions, 0)
    actual.animator.resetInput()
    for (now = 3200; now <= 7200; now += 20) {
      for (const rig of [actual, control]) {
        if (now % 80 === 0) {
          rig.animator.setKeyPressed('F', false, key)
          rig.animator.setKeyPressed('F', true, key)
        }
        rig.animator.update(20, now)
      }
    }
    assert.equal(decisions, 1)
    const headDifference = actual.root.getObjectByName('Head')!.quaternion.angleTo(control.root.getObjectByName('Head')!.quaternion)
    assert.ok(headDifference > 0.2 && headDifference < 0.3, 'the full head tilt is approximately 15 degrees')
    for (const rig of [actual, control]) {
      rig.animator.setKeyPressed('F', false, key)
      rig.advance(7220, 10200)
    }
    assert.ok(actual.root.getObjectByName('Head')!.quaternion.angleTo(control.root.getObjectByName('Head')!.quaternion) < 0.01)
    actual.dispose()
    control.dispose()
  })
})
