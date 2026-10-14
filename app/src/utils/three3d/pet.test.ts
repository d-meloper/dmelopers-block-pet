/* eslint-disable test/no-import-node-test */
import type { Object3D, WebGLRenderer } from 'three'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { BoxGeometry, Euler, Group, MathUtils, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, Scene, SkinnedMesh, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { createDefaultDmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'
import { getHeadbuttReachRadius } from '@/config/headbuttRadius'
import { MODEL_3D_CONFIG } from '@/config/model3d'
import { DEFAULT_PET_ARM_POSE_SETTINGS } from '@/config/petArmPose'
import { DEFAULT_TYPING_MOTION_SETTINGS } from '@/config/typingMotion'

import { Three3DRenderer } from '../three3d'
import { createDmeloperEyebrowController } from './dmeloperEyebrows'
import { getDeskGrip, getForeheadPoint } from './headbutt'
import { createKeyboardGroup } from './keyboard'
import { createMouseGroup } from './mouse'
import { createPetAnimator } from './pet'
import { padContentRect, projectVisibleSceneBounds, unionContentRects } from './projectedBounds'
import { applyVoxelSkin, createVoxelSkinGeometryController, createVoxelSkinModelController, normalizeVoxelSkin } from './voxelSkin'

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

async function fixture(model: 'wide' | 'slim' = 'wide', mouseAtKeyboard = false, random: () => number = () => 1, navigationTurn = true, options: { now?: () => number, desk?: Object3D } = {}) {
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
    keyboardHeadbuttReachTarget: keyboard.getKeyTarget('KeyD')!,
    keyboardNavigationTargets: navigationTurn ? config.keyboard.navigationKeys.map(key => keyboard.getKeyTarget(key)!) : [],
    keyboardGroup,
    keyboardLeftRestTarget: keyboard.getKeyTarget(config.inputMode.leftIdleKey)!,
    keyboardRestTarget: keyboard.getKeyTarget('Space')!,
    keyboardRightRestTarget,
    mouseGroup,
    desk: options.desk,
  }, { random, now: options.now })!
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

describe('typing motion controls on the actual Dmeloper rig', () => {
  for (const model of ['wide', 'slim'] as const) {
    it(`${model}: varies compact typing continuously through near/far keys and suppresses waist bending only at minus one`, async (t) => {
      let clock = 1000
      const offsets = [-1, -0.75, -0.5, -0.25, 0]
      const rigs = await Promise.all([...offsets, 0].map(() => fixture(model, false, () => 1, true, { now: () => clock })))
      const idle = rigs[rigs.length - 1]
      const active = rigs.slice(0, -1)
      for (const [index, rig] of rigs.entries()) {
        t.after(rig.dispose)
        rig.animator.setMouseEnabled(false)
        rig.animator.setTypingMotionSettings({ petTypingMaxRadiusOffset: offsets[index] ?? 0, petTypingHandLiftPercent: 0 })
        rig.advance(0, clock)
      }
      const armLengths = active.map(rig => rig.worldPosition('L_Upperarm').distanceTo(rig.worldPosition('L_Forearm')))
      for (const key of ['KeyF', 'Escape']) {
        for (const rig of active) rig.animator.setKeyPressed(key, true, rig.keyboard.getKeyTarget(key))
        for (const rig of rigs) {
          rig.advance(clock, clock + 1200)
          rig.animator.update(16, clock + 1200)
        }
        clock += 1200
        const hands = active.map(rig => rig.worldPosition('L_Hand'))
        const idleSpine = idle.root.getObjectByName('Spine02')!.quaternion.clone()
        const pitches = active.map(rig => MathUtils.radToDeg(new Euler().setFromQuaternion(idleSpine.clone().invert().multiply(rig.root.getObjectByName('Spine02')!.quaternion), 'XYZ').x))
        close(active[0].pose('Spine02'), idle.pose('Spine02'), 1e-6)
        for (let index = 1; index < hands.length; index++) {
          assert.ok(hands[index].distanceTo(hands[index - 1]) > 0.002, `${key}: compact range has no dead interval: ${offsets}`)
          if (key === 'Escape') assert.ok(pitches[index] > pitches[index - 1] + 0.3, `waist changes continuously: ${pitches}`)
        }
        for (const [index, rig] of active.entries()) {
          assert.ok(Math.abs(rig.worldPosition('L_Upperarm').distanceTo(rig.worldPosition('L_Forearm')) - armLengths[index]) < 1e-8, 'arm bones retain their dimensions')
          rig.animator.setKeyPressed(key, false, rig.keyboard.getKeyTarget(key))
        }
        for (const rig of rigs) rig.advance(clock, clock + 3000)
        clock += 3000
        for (const rig of active) {
          close(rig.pose('Spine02'), idle.pose('Spine02'), 1e-6)
          close(rig.worldPosition('L_Hand').toArray(), idle.worldPosition('L_Hand').toArray(), 1e-6)
        }
      }
    })
  }

  for (const model of ['wide', 'slim'] as const) {
    it(`${model}: bends and reaches farther at radius one, and restores the idle pose after release`, async (t) => {
      let clock = 1000
      const rigs = await Promise.all([0, 1].map(() => fixture(model, false, () => 1, true, { now: () => clock })))
      const bases = rigs.map(rig => rig.root.getObjectByName('Spine02')!.quaternion.clone())
      const hips = rigs.map(rig => rig.worldPosition('Root'))
      for (const [index, rig] of rigs.entries()) {
        t.after(rig.dispose)
        rig.animator.setMouseEnabled(false)
        rig.animator.setTypingMotionSettings({ petTypingMaxRadiusOffset: index, petTypingHandLiftPercent: 0 })
        rig.advance(0, clock)
        rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
        rig.advance(clock, clock + 1000)
      }
      clock += 1000
      const measurements = rigs.map((rig, index) => {
        const spine = rig.root.getObjectByName('Spine02')!
        const key = rig.keyboard.group.localToWorld(new Vector3().fromArray(rig.keyboard.getKeyTarget('Escape')!.position))
        const pitch = MathUtils.radToDeg(new Euler().setFromQuaternion(bases[index].clone().invert().multiply(spine.quaternion), 'YXZ').x)
        assert.ok(rig.worldPosition('Root').distanceTo(hips[index]) < 1e-8, 'hips remain fixed')
        return { pitch, reachError: rig.worldPosition('L_Hand').distanceTo(key) }
      })
      assert.ok(measurements[1].pitch > measurements[0].pitch + 25, `waist: ${JSON.stringify(measurements)}`)
      assert.ok(measurements[1].reachError < measurements[0].reachError - 0.1, `hand reach: ${JSON.stringify(measurements)}`)
      for (const rig of rigs) {
        rig.animator.setKeyPressed('Escape', false, rig.keyboard.getKeyTarget('Escape'))
        rig.advance(clock, clock + 4000)
      }
      for (const name of ['Spine02', 'L_Hand', 'R_Hand']) {
        close(rigs[0].pose(name), rigs[1].pose(name), 1e-6)
        close(rigs[0].worldPosition(name).toArray(), rigs[1].worldPosition(name).toArray(), 1e-6)
      }
    })
  }

  for (const model of ['wide', 'slim'] as const) {
    it(`${model}: keeps both typing hands inside the selected fixed radius through holds and device transforms`, async (t) => {
      let clock = 1000
      const rig = await fixture(model, false, () => 1, true, { now: () => clock })
      t.after(rig.dispose)
      rig.animator.setMouseEnabled(false)
      rig.animator.setTypingMotionSettings({ petTypingHandLiftPercent: 0 })
      const distances: number[] = []
      for (const scale of [1, 1.3]) {
        rig.keyboard.group.scale.setScalar(MODEL_3D_CONFIG.keyboard.scale * scale)
        rig.keyboard.group.position.z = MODEL_3D_CONFIG.keyboard.position[2] + (scale - 1) * 0.3
        for (const offset of [-1, 0, 1]) {
          rig.animator.resetInput()
          rig.advance(clock, clock + 1500)
          clock += 1500
          rig.animator.setTypingMotionSettings({ petTypingMaxRadiusOffset: offset })
          const keys = ['Escape', 'KeyY']
          for (const key of keys) {
            const target = rig.keyboard.getKeyTarget(key)
            assert.ok(target)
            rig.animator.setKeyPressed(key, true, target)
          }
          rig.advance(clock, clock + 1000)
          clock += 1000
          const center = rig.root.getWorldPosition(new Vector3())
          let farthest = 0
          for (const side of ['L', 'R']) {
            const hand = rig.worldPosition(`${side}_Hand`)
            hand.y = center.y
            const distance = hand.distanceTo(center)
            assert.ok(distance <= getHeadbuttReachRadius(offset) + 0.02, `${scale}/${offset}/${side}: radius exceeded`)
            farthest = Math.max(farthest, distance)
          }
          if (scale === 1) distances.push(farthest)
          for (const key of keys) rig.animator.setKeyPressed(key, false, rig.keyboard.getKeyTarget(key))
        }
      }
      assert.ok(distances[2] > distances[0] + 0.05, 'a larger radius visibly extends the hand reach')
    })
  }

  it('keeps mouse motion and clicks unchanged by radius when body motion is disabled', async (t) => {
    let clock = 1000
    const rigs = await Promise.all([fixture('wide', false, () => 1, true, { now: () => clock }), fixture('wide', false, () => 1, true, { now: () => clock })])
    for (const [index, rig] of rigs.entries()) {
      t.after(rig.dispose)
      rig.animator.setTypingMotionSettings({ petTypingMaxRadiusOffset: index === 0 ? -1 : 1, petTypingBodyMotionPercent: 0 })
      rig.advance(0, clock)
      rig.animator.setKeyPressed('KeyF', true, rig.keyboard.getKeyTarget('KeyF'))
    }
    for (; clock <= 2200; clock += 10) {
      for (const rig of rigs) {
        rig.animator.setMousePosition(0.5 + Math.sin(clock / 500) * 0.2, 0.5)
        if (clock % 200 === 0) rig.animator.setMouseButtonPressed('Left', true)
        if (clock % 200 === 100) rig.animator.setMouseButtonPressed('Left', false)
        rig.animator.update(10, clock)
      }
      close(rigs[0].worldPosition('R_Hand').toArray(), rigs[1].worldPosition('R_Hand').toArray(), 1e-6)
    }
  })

  it('keeps the mouse arm near its contact while the other arm reaches a far key', async (t) => {
    const sample = async (offset: number) => {
      let clock = 1000
      const rig = await fixture('wide', false, () => 1, true, { now: () => clock })
      t.after(rig.dispose)
      rig.animator.setTypingMotionSettings({ petTypingMaxRadiusOffset: offset, petTypingHandLiftPercent: 0 })
      rig.advance(0, clock)
      rig.animator.setMousePosition(0.5, 0.5)
      rig.advance(clock, clock + config.inputMode.transitionMs + 500)
      clock += config.inputMode.transitionMs + 500
      rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
      let maximumDistance = 0
      let maximumStep = 0
      const previousHand = rig.worldPosition('R_Hand')
      const end = clock + 1200
      for (; clock <= end; clock += 10) {
        rig.animator.setMousePosition(0.5 + Math.sin(clock / 500) * 0.2, 0.5)
        if (clock % 200 === 0) rig.animator.setMouseButtonPressed('Left', true)
        if (clock % 200 === 100) rig.animator.setMouseButtonPressed('Left', false)
        rig.animator.update(10, clock)
        const hand = rig.worldPosition('R_Hand')
        maximumDistance = Math.max(maximumDistance, hand.distanceTo(rig.anchor.getWorldPosition(new Vector3())))
        maximumStep = Math.max(maximumStep, hand.distanceTo(previousHand))
        previousHand.copy(hand)
      }
      return { maximumDistance, maximumStep }
    }
    const baseline = await sample(0)
    const expanded = await sample(1)
    assert.ok(expanded.maximumDistance < 0.3 && expanded.maximumDistance < baseline.maximumDistance + 0.05, `far reach preserves mouse contact: ${JSON.stringify({ baseline, expanded })}`)
    assert.ok(expanded.maximumStep <= baseline.maximumStep + 0.01, `extra torso motion preserves click continuity: ${JSON.stringify({ baseline, expanded })}`)
  })

  it('keeps the outer-range waist bend through trance and obeys zero/maximum body motion', async (t) => {
    let clock = 1000
    const levels = [0, 100, 300]
    const rigs = await Promise.all(levels.map(() => fixture('wide', false, () => 0, true, { now: () => clock })))
    for (const [index, rig] of rigs.entries()) {
      t.after(rig.dispose)
      rig.animator.setMouseEnabled(false)
      rig.animator.setTypingMotionSettings({ petTypingMaxRadiusOffset: 1, petTypingBodyMotionPercent: levels[index] })
    }
    for (; clock <= 5000; clock += 10) {
      for (const rig of rigs) {
        if (clock % 80 === 0) {
          rig.animator.setKeyPressed('Escape', false, rig.keyboard.getKeyTarget('Escape'))
          rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
        }
        rig.animator.update(10, clock)
      }
    }
    const pitches = rigs.map(rig => MathUtils.radToDeg(new Euler().setFromQuaternion(rig.root.getObjectByName('Spine02')!.quaternion, 'YXZ').x))
    assert.ok(Math.abs(pitches[0]) < 2, `zero body motion: ${pitches}`)
    assert.ok(pitches[1] > 30, `outer reach remains in trance: ${pitches}`)
    assert.ok(pitches[2] > 60 && pitches[2] < 72, `maximum motion stays bounded: ${pitches}`)
    for (const rig of rigs) {
      for (const side of ['L', 'R']) assert.ok(rig.worldPosition(`${side}_Hand`).toArray().every(Number.isFinite), 'finite hand pose')
    }
  })

  it('retains default poses with explicit authored defaults through chords, holds, navigation, mouse input and reset', async (t) => {
    let clock = 1000
    const rigs = await Promise.all([fixture('wide', false, () => 0, true, { now: () => clock }), fixture('wide', false, () => 0, true, { now: () => clock })])
    rigs[1].animator.setTypingMotionSettings(DEFAULT_TYPING_MOTION_SETTINGS)
    for (const rig of rigs) t.after(rig.dispose)
    for (; clock <= 6000; clock += 10) {
      for (const rig of rigs) {
        if (clock === 1000) rig.animator.setKeyPressed('KeyF', true, rig.keyboard.getKeyTarget('KeyF'))
        if (clock === 1020) rig.animator.setKeyPressed('KeyJ', true, rig.keyboard.getKeyTarget('KeyJ'))
        if (clock === 1700) rig.animator.setKeyPressed('KeyF', false, rig.keyboard.getKeyTarget('KeyF'))
        if (clock === 1800) rig.animator.setKeyPressed('KeyJ', false, rig.keyboard.getKeyTarget('KeyJ'))
        if (clock === 2400) rig.animator.setKeyPressed('PageUp', true, rig.keyboard.getKeyTarget('PageUp'))
        if (clock === 2800) rig.animator.setKeyPressed('PageUp', false, rig.keyboard.getKeyTarget('PageUp'))
        if (clock >= 3000 && clock <= 4400 && clock % 80 === 0) {
          rig.animator.setMouseButtonPressed('Left', false)
          rig.animator.setMouseButtonPressed('Left', true)
          rig.animator.setMousePosition(0.2, 0.8)
        }
        if (clock === 4800) rig.animator.resetInput()
        rig.animator.update(10, clock)
      }
      for (const name of ['Spine02', 'Head', 'L_Hand', 'R_Hand', 'L_Forearm', 'R_Forearm', 'L_Shin', 'R_Shin']) {
        close(rigs[0].pose(name), rigs[1].pose(name), 1e-9)
        close(rigs[0].worldPosition(name).toArray(), rigs[1].worldPosition(name).toArray(), 1e-9)
      }
    }
  })

  for (const model of ['wide', 'slim'] as const) {
    it(`${model}: scales hand lift, preserves strike contact and physical holds, and keeps maximum motion finite`, async (t) => {
      let clock = 1000
      const levels = [0, 100, 300]
      const rigs = await Promise.all(levels.map(() => fixture(model, false, () => 1, true, { now: () => clock })))
      for (const [index, rig] of rigs.entries()) {
        t.after(rig.dispose)
        rig.animator.setMouseEnabled(false)
        rig.animator.setTypingMotionSettings({ petTypingHandLiftPercent: levels[index], petTypingBodyMotionPercent: 0, petTypingReturnSpeedPercent: 400 })
        rig.advance(0, 1000)
        rig.animator.setKeyPressed('KeyF', true, rig.keyboard.getKeyTarget('KeyF'))
      }
      const heights = levels.map(() => Number.NEGATIVE_INFINITY)
      for (; clock <= 2400; clock++) {
        for (const [index, rig] of rigs.entries()) {
          // Repeats must not restart the physical strike even with a fast return.
          if (clock % 10 === 0) rig.animator.setKeyPressed('KeyF', true, rig.keyboard.getKeyTarget('KeyF'))
          rig.animator.update(1, clock)
          const hand = rig.worldPosition('L_Hand')
          assert.ok(hand.toArray().every(Number.isFinite))
          if (clock < 1000 + config.keyboard.strikeContactMs) close(hand.toArray(), rigs[0].worldPosition('L_Hand').toArray(), 1e-8)
          if (clock >= 1030 && clock <= 1120) heights[index] = Math.max(heights[index], hand.y)
        }
      }
      assert.ok(heights[1] - heights[0] > 0.04, 'default lift rises visibly from zero lift')
      assert.ok(heights[2] - heights[1] > 0.04, 'maximum lift rises farther within the real arm reach')
      for (const rig of rigs.slice(1)) close(rig.worldPosition('L_Hand').toArray(), rigs[0].worldPosition('L_Hand').toArray(), 1e-4)
    })
  }

  for (const stage of ['quiet', 'return'] as const) {
    it(`preserves ${stage} progress when changing return speed live, then advances at the new speed`, async (t) => {
      let clock = 1000
      const rigs = await Promise.all([fixture('wide', false, () => 1, true, { now: () => clock }), fixture('wide', false, () => 1, true, { now: () => clock })])
      for (const rig of rigs) {
        t.after(rig.dispose)
        rig.animator.setMouseEnabled(false)
        rig.animator.setTypingMotionSettings({ petTypingHandLiftPercent: 0, petTypingBodyMotionPercent: 0 })
        rig.advance(0, 1000)
        rig.animator.setKeyPressed('KeyG', true, rig.keyboard.getKeyTarget('KeyG'))
      }
      const changedAt = stage === 'quiet' ? 1300 : 1580
      for (; clock <= changedAt; clock += 10) {
        if (clock === 1010) {
          for (const rig of rigs) rig.animator.setKeyPressed('KeyG', false, rig.keyboard.getKeyTarget('KeyG'))
        }
        for (const rig of rigs) rig.animator.update(10, clock)
      }
      clock = changedAt
      rigs[0].animator.setTypingMotionSettings({ petTypingReturnSpeedPercent: 400 })
      for (const rig of rigs) rig.animator.update(10, clock)
      close(rigs[0].worldPosition('L_Hand').toArray(), rigs[1].worldPosition('L_Hand').toArray(), 1e-9)
      if (stage === 'quiet') {
        for (clock = changedAt + 1; clock < changedAt + 30; clock++) {
          for (const rig of rigs) rig.animator.update(1, clock)
          close(rigs[0].worldPosition('L_Hand').toArray(), rigs[1].worldPosition('L_Hand').toArray(), 1e-9)
        }
      }
      for (clock = changedAt + 30; clock <= changedAt + 80; clock++) {
        for (const rig of rigs) rig.animator.update(1, clock)
      }
      assert.ok(rigs[0].worldPosition('L_Hand').distanceTo(rigs[1].worldPosition('L_Hand')) > 0.005, 'the edited return advances sooner than the unchanged control')
      for (; clock <= changedAt + 1500; clock += 10) {
        for (const rig of rigs) rig.animator.update(10, clock)
      }
      close(rigs[0].worldPosition('L_Hand').toArray(), rigs[1].worldPosition('L_Hand').toArray(), 1e-5)
    })
  }

  it('preserves far-reach hold and decay progress across live speed changes', async (t) => {
    let clock = 1000
    const rigs = await Promise.all([fixture('wide', false, () => 1, true, { now: () => clock }), fixture('wide', false, () => 1, true, { now: () => clock })])
    const far = target(0, config.keyboard.farLeanEndZ)
    const near = target(0, config.keyboard.farLeanStartZ)
    for (const rig of rigs) {
      t.after(rig.dispose)
      rig.animator.setMouseEnabled(false)
      rig.animator.setKeyPressed('far', true, far)
    }
    for (; clock <= 2000; clock += 10) {
      for (const rig of rigs) rig.animator.update(10, clock)
    }
    clock = 2000
    for (const rig of rigs) {
      rig.animator.setKeyPressed('far', false, far)
      rig.animator.setKeyPressed('near', true, near)
    }
    for (const at of [2200, 2600]) {
      for (; clock <= at; clock += 10) {
        for (const rig of rigs) rig.animator.update(10, clock)
      }
      clock = at
      rigs[0].animator.setTypingMotionSettings({ petTypingReturnSpeedPercent: 400 })
      for (const rig of rigs) rig.animator.update(10, clock)
      close(rigs[0].pose('Spine02'), rigs[1].pose('Spine02'), 1e-9)
      // Returning to the old speed at the same timestamp preserves either
      // the remaining hold or the already-started decay without pose changes.
      rigs[0].animator.setTypingMotionSettings({ petTypingReturnSpeedPercent: 100 })
      for (const rig of rigs) rig.animator.update(10, clock)
      close(rigs[0].pose('Spine02'), rigs[1].pose('Spine02'), 1e-9)
    }
    rigs[0].animator.setTypingMotionSettings({ petTypingReturnSpeedPercent: 400 })
    for (; clock <= 2850; clock += 10) {
      for (const rig of rigs) rig.animator.update(10, clock)
    }
    assert.ok(rigs[0].root.getObjectByName('Spine02')!.quaternion.angleTo(rigs[1].root.getObjectByName('Spine02')!.quaternion) > 0.01, 'the faster lean return now advances ahead')
  })

  it('preserves the return clock when custom speed resumes after headbutt cancellation', async (t) => {
    let clock = 1000
    const desk = new Mesh(new BoxGeometry(...MODEL_3D_CONFIG.desk.size), new MeshBasicMaterial())
    desk.position.set(...MODEL_3D_CONFIG.desk.position)
    const rigs = await Promise.all([fixture('wide', false, () => 0, true, { now: () => clock, desk }), fixture('wide', false, () => 0, true, { now: () => clock, desk })])
    t.after(() => {
      desk.geometry.dispose()
      desk.material.dispose()
    })
    for (const [index, rig] of rigs.entries()) {
      t.after(rig.dispose)
      rig.animator.setMouseEnabled(false)
      rig.animator.setTypingMotionSettings({ petTypingHandLiftPercent: 0, petTypingBodyMotionPercent: 0, petTypingReturnSpeedPercent: index === 0 ? 400 : 100 })
      rig.animator.setAnimationMode('headbutt')
      rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
    }
    for (; clock <= 2700; clock += 10) {
      for (const rig of rigs) {
        if (clock === 1250) {
          rig.animator.setKeyPressed('Escape', false, rig.keyboard.getKeyTarget('Escape'))
          rig.animator.setAnimationMode('default')
        }
        if (clock === 2000) rig.animator.setKeyPressed('KeyG', true, rig.keyboard.getKeyTarget('KeyG'))
        if (clock === 2010) rig.animator.setKeyPressed('KeyG', false, rig.keyboard.getKeyTarget('KeyG'))
      }
      // The control applies the same setting exactly when cancellation has
      // restored the previous frame's base pose. Automatic resumption must
      // preserve the virtual clock just like an explicit live slider change.
      if (clock === 2510) {
        assert.equal(rigs[0].animator.isHeadbuttActive(), false)
        rigs[1].animator.setTypingMotionSettings({ petTypingReturnSpeedPercent: 400 })
      }
      for (const rig of rigs) rig.animator.update(10, clock)
      for (const name of ['Spine02', 'Head', 'L_Hand', 'R_Hand']) {
        assert.ok(rigs[0].root.getObjectByName(name)!.quaternion.angleTo(rigs[1].root.getObjectByName(name)!.quaternion) < 1e-7, `${name} rotation at ${clock}`)
        assert.ok(rigs[0].worldPosition(name).distanceTo(rigs[1].worldPosition(name)) < 1e-8, `${name} position at ${clock}`)
      }
    }
  })

  it('retains added waist lean through trance while zero body motion removes typing lean', async (t) => {
    let clock = 1000
    const levels = [0, 100, 300]
    const rigs = await Promise.all(levels.map(() => fixture('wide', false, () => 0, true, { now: () => clock })))
    const key = target(0, config.keyboard.farLeanEndZ)
    for (const [index, rig] of rigs.entries()) {
      t.after(rig.dispose)
      rig.animator.setMouseEnabled(false)
      rig.animator.setTypingMotionSettings({ petTypingBodyMotionPercent: levels[index] })
    }
    for (; clock <= 6000; clock += 10) {
      for (const rig of rigs) {
        if (clock % 80 === 0) {
          rig.animator.setKeyPressed('far', false, key)
          rig.animator.setKeyPressed('far', true, key)
        }
        rig.animator.update(10, clock)
      }
    }
    const pitch = (index: number) => MathUtils.radToDeg(new Euler().setFromQuaternion(rigs[index].root.getObjectByName('Spine02')!.quaternion, 'XYZ').x)
    assert.ok(Math.abs(pitch(1) - pitch(0)) < 0.01, 'the default forward lean is removed at full trance')
    assert.ok(Math.abs(pitch(2) - pitch(0) - 20) < 0.01, 'the additional 200 percent waist bend remains through trance')
    assert.ok(rigs[1].root.getObjectByName('Head')!.quaternion.angleTo(new Quaternion()) > 0.1, 'the actual rig is in trance')
    for (const rig of rigs) rig.animator.resetInput()
    for (; clock <= 8500; clock += 10) {
      for (const rig of rigs) rig.animator.update(10, clock)
    }
    for (const rig of rigs.slice(1)) close(rig.pose('Spine02'), rigs[0].pose('Spine02'))
  })
})

describe('disabled arms on the actual Dmeloper rig', () => {
  for (const model of ['wide', 'slim'] as const) {
    for (const mode of ['default', 'headbutt'] as const) {
      for (const side of ['L', 'R'] as const) {
        it(`${model}/${mode}/${side}: freezes only the disabled local chain through typing, holds and mouse input`, async (t) => {
          let clock = 1000
          const desk = new Mesh(new BoxGeometry(...MODEL_3D_CONFIG.desk.size), new MeshBasicMaterial())
          desk.position.set(...MODEL_3D_CONFIG.desk.position)
          const rig = await fixture(model, false, () => 1, true, { now: () => clock, desk })
          t.after(rig.dispose)
          rig.animator.setAnimationMode(mode)
          rig.animator.setMouseEnabled(mode === 'headbutt')
          rig.advance(0, clock)
          rig.animator.setArmsDisabled(side === 'R', side === 'L')
          const names = ['Upperarm', 'Forearm', 'Hand'].map(part => `${side}_${part}`)
          const local = () => names.map((name) => {
            const node = rig.root.getObjectByName(name)!
            return [...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray(), ...node.matrix.toArray()]
          })
          const frozen = local()
          const head = rig.pose('Head')
          const key = rig.keyboard.getKeyTarget('KeyF')!
          rig.animator.setKeyPressed('KeyF', true, key)
          for (clock = 1016; clock < 2300; clock += 16) {
            rig.animator.setMousePosition(clock % 32 ? 0.2 : 0.8, 0.8)
            rig.animator.setMouseButtonPressed('Left', false)
            rig.animator.setMouseButtonPressed('Left', true)
            rig.animator.update(16, clock)
            assert.deepEqual(local(), frozen, 'disabled bones receive no pose writes')
          }
          assert.notDeepEqual(rig.pose('Head'), head, 'shared pet reaction remains active')
          rig.animator.setKeyPressed('KeyF', false, key)
          rig.advance(clock, clock + 1800)
          assert.deepEqual(local(), frozen)
          rig.animator.setArmsDisabled(false, false)
          rig.advance(clock + 1800, clock + 2100)
          assert.notDeepEqual(local(), frozen, 'the arm resumes its ordinary animation')
        })
      }
    }
  }

  it('filters both Wide/Slim base, sleeve and palm faces through texture cloning and skin replacement', async (t) => {
    const rig = await fixture()
    t.after(rig.dispose)
    const geometry = createVoxelSkinGeometryController(rig.root)
    const meshes: SkinnedMesh[] = []
    rig.root.traverse((object) => {
      if (object instanceof SkinnedMesh && object.userData.voxelSkinModel) meshes.push(object)
    })
    assert.equal(meshes.length, 4)
    const full = meshes.map(mesh => Array.from(mesh.geometry.getIndex()!.array))
    const body = rig.root.getObjectByName('VoxelHumanoidBase') as SkinnedMesh
    const bodyIndex = Array.from(body.geometry.getIndex()!.array)
    const data = new Uint8Array(64 * 64 * 4).fill(255)
    const skin = normalizeVoxelSkin({ width: 64, height: 64, data }, 'wide')
    geometry.setSkin(skin)
    let applied = applyVoxelSkin(rig.root, skin)
    try {
      for (const [right, left] of [[true, false], [false, true], [true, true], [false, false]] as const) {
        geometry.setArmsDisabled(right, left)
        for (const [index, mesh] of meshes.entries()) {
          const visible = Array.from(mesh.geometry.getIndex()!.array)
          const positions = mesh.geometry.getAttribute('position')
          if (right && left) {
            assert.equal(visible.length, 0)
          } else if (right || left) {
            assert.ok(visible.length > 0 && visible.length < full[index].length)
            assert.ok(visible.every(vertex => right ? positions.getX(vertex) > 0 : positions.getX(vertex) < 0))
          } else {
            assert.deepEqual(visible, full[index])
          }
          assert.equal(mesh.geometry.groups.reduce((sum, group) => sum + group.count, 0), visible.length)
        }
        assert.deepEqual(Array.from(body.geometry.getIndex()!.array), bodyIndex)
      }
      geometry.setArmsDisabled(true, true)
      applied.dispose()
      geometry.setSkin(undefined)
      applied = applyVoxelSkin(rig.root, skin)
      for (const mesh of meshes) assert.equal(mesh.geometry.getIndex()!.count, 0)
      geometry.setArmsDisabled(false, false)
      for (const [index, mesh] of meshes.entries()) assert.deepEqual(Array.from(mesh.geometry.getIndex()!.array), full[index])
    } finally {
      applied.dispose()
      geometry.dispose()
    }
  })
})

describe('headbutt on the actual Dmeloper rig', () => {
  const deskFixture = () => {
    const desk = new Mesh(new BoxGeometry(...MODEL_3D_CONFIG.desk.size), new MeshBasicMaterial())
    desk.position.set(...MODEL_3D_CONFIG.desk.position)
    return desk
  }

  it('returns only the right shoulder over 300 ms while preserving the left shoulder envelope and arm rotation continuity', async (t) => {
    let clock = 1000
    const rig = await fixture('wide', false, () => 0, true, { now: () => clock, desk: deskFixture() })
    t.after(rig.dispose)
    rig.animator.setAnimationMode('headbutt')
    rig.animator.setMouseEnabled(false)
    rig.advance(0, clock)
    const right = rig.root.getObjectByName('R_Upperarm')!
    const left = rig.root.getObjectByName('L_Upperarm')!
    const neutralRight = right.position.clone()
    const neutralLeft = left.position.clone()
    rig.animator.setKeyPressed('KeyF', true, rig.keyboard.getKeyTarget('KeyF'))
    rig.advance(clock, clock + 300)
    clock = 1400
    rig.animator.update(16, clock)
    const fromRight = right.position.clone()
    const fromLeft = left.position.clone()
    const rotation = right.quaternion.clone()
    rig.animator.setKeyPressed('KeyF', false, rig.keyboard.getKeyTarget('KeyF'))
    rig.animator.update(0, clock)
    assert.ok(right.position.distanceTo(fromRight) < 1e-8, 'return begins at the current shoulder position')
    assert.ok(right.quaternion.angleTo(rotation) < 1e-7, 'the arm does not rotate abruptly when recovery starts')
    clock += 150
    rig.animator.update(150, clock)
    assert.ok(right.position.distanceTo(fromRight.clone().lerp(neutralRight, 0.5)) < 1e-8)
    assert.ok(left.position.distanceTo(fromLeft) < 1e-8, 'left shoulder remains on the tabletop envelope')
    clock += 150
    rig.animator.update(150, clock)
    assert.ok(right.position.distanceTo(neutralRight) < 1e-8, 'right shoulder completes its short return')
    assert.ok(left.position.distanceTo(neutralLeft) > fromLeft.distanceTo(neutralLeft) * 0.9, 'left shoulder keeps its original slow return')
  })
  for (const model of ['wide', 'slim'] as const) {
    it(`${model}: holds captured tabletop contacts, safely approaches accepted keys and preserves hips/head/arm dimensions`, async (t) => {
      let clock = 1000
      const desk = deskFixture()
      const rig = await fixture(model, false, () => 1, true, { now: () => clock, desk })
      t.after(() => {
        rig.dispose()
        desk.geometry.dispose()
        desk.material.dispose()
      })
      rig.animator.setMouseEnabled(false)
      rig.animator.setAnimationMode('headbutt')
      rig.advance(0, clock)
      const hips = rig.worldPosition('Root')
      const forehead = getForeheadPoint(rig.root, rig.root.getObjectByName('Head')!)
      const scales = ['Head', 'L_Upperarm', 'R_Upperarm'].map(name => rig.root.getObjectByName(name)!.getWorldScale(new Vector3()))
      for (const key of ['KeyF', 'KeyJ', 'Escape', 'PageUp']) {
        const at = clock
        const accepted = rig.keyboard.getKeyTarget(key)!
        const keyWorld = rig.keyboard.group.localToWorld(new Vector3().fromArray(accepted.position))
        const restDistance = rig.root.getObjectByName('Head')!.localToWorld(forehead.clone()).distanceTo(keyWorld)
        let grips: Vector3[] = []
        rig.animator.setKeyPressed(key, true, accepted)
        rig.animator.setKeyPressed(key, false, accepted)
        for (const age of [50, 100, 160, 220, 240, 300, 399]) {
          clock = at + age
          rig.animator.update(16, clock)
          if (age === 50) grips = ['L', 'R'].map(side => rig.worldPosition(`${side}_Hand`))
          if (age >= 100 && age < config.headbutt.gripMs + config.headbutt.downMs + config.headbutt.contactMs) {
            for (const [index, side] of ['L', 'R'].entries()) assert.ok(rig.worldPosition(`${side}_Hand`).distanceTo(grips[index]) < 0.002, `${key}/${side}: grip error ${rig.worldPosition(`${side}_Hand`).distanceTo(grips[index])}`)
          }
          assert.ok(rig.worldPosition('Root').distanceTo(hips) < 1e-8)
          for (const [index, name] of ['Head', 'L_Upperarm', 'R_Upperarm'].entries()) close(rig.root.getObjectByName(name)!.getWorldScale(new Vector3()).toArray(), scales[index].toArray(), 1e-6)
          const stretch = rig.root.getObjectByName('Spine02')!.scale.y
          assert.ok(stretch >= 1 && stretch <= 1.5)
          if (age === 220) {
            const error = rig.root.getObjectByName('Head')!.localToWorld(forehead.clone()).distanceTo(keyWorld)
            t.diagnostic(`${key}: forehead error ${error.toFixed(4)}, stretch ${stretch.toFixed(3)}`)
            assert.ok(error < restDistance, `${key}: safe strike must approach the input`)
          }
        }
        clock = at + 1000
        rig.advance(at + 400, clock)
        assert.equal(rig.root.getObjectByName('Spine02')!.scale.y, 1)
      }
    })

    it(`${model}: keeps contact and dimensions through head/arm extremes and transformed devices`, async (t) => {
      let clock = 1000
      const desk = deskFixture()
      const rig = await fixture(model, false, () => 1, true, { now: () => clock, desk })
      t.after(() => {
        rig.dispose()
        desk.geometry.dispose()
        desk.material.dispose()
      })
      rig.animator.setMouseEnabled(false)
      rig.animator.setAnimationMode('headbutt')
      rig.animator.setHeadbuttMaxRadiusOffset(1)
      const forehead = getForeheadPoint(rig.root, rig.root.getObjectByName('Head')!)
      const scene = new Group()
      scene.position.set(0.5, 0.4, -0.8)
      scene.rotation.y = 0.7
      scene.add(rig.root, rig.keyboard.group, desk, rig.anchor.parent!)
      rig.keyboard.group.scale.multiplyScalar(1.2)
      rig.keyboard.group.position.x += 0.1
      rig.keyboard.group.rotation.y += 0.2
      desk.scale.set(1.1, 1.5, 0.8)
      for (const percent of [25, 100, 200]) {
        for (const spread of [-45, 45]) {
          rig.animator.resetInput()
          rig.advance(clock, clock + 1000)
          clock += 1000
          rig.animator.setHeadScalePercent(percent)
          const settings = { ...DEFAULT_PET_ARM_POSE_SETTINGS, petLeftArmBendPercent: spread < 0 ? 0 : 400, petRightArmBendPercent: spread > 0 ? 0 : 400, petLeftArmSpreadDegrees: spread, petRightArmSpreadDegrees: -spread }
          rig.animator.setArmPoseSettings(settings)
          const savedSettings = { ...settings }
          rig.animator.update(16, clock)
          const start = clock
          const accepted = rig.keyboard.getKeyTarget('Escape')!
          const keyWorld = rig.keyboard.group.localToWorld(new Vector3().fromArray(accepted.position))
          const restDistance = rig.root.getObjectByName('Head')!.localToWorld(forehead.clone()).distanceTo(keyWorld)
          let grips: Vector3[] = []
          const scales = ['Head', 'L_Upperarm', 'R_Upperarm'].map(name => rig.root.getObjectByName(name)!.getWorldScale(new Vector3()))
          rig.animator.setKeyPressed('Escape', true, accepted)
          rig.animator.setKeyPressed('Escape', false, accepted)
          for (const age of [100, 130, 170, 220, 240, 290, 350, 399]) {
            clock = start + age
            rig.animator.update(16, clock)
            if (age === 100) grips = ['L', 'R'].map(side => rig.worldPosition(`${side}_Hand`))
            if (age < config.headbutt.gripMs + config.headbutt.downMs + config.headbutt.contactMs) {
              for (const [index, side] of ['L', 'R'].entries()) assert.ok(rig.worldPosition(`${side}_Hand`).distanceTo(grips[index]) < 0.002, `${percent}/${spread}/${age}/${side}: grip drift`)
            }
            for (const [index, name] of ['Head', 'L_Upperarm', 'R_Upperarm'].entries()) close(rig.root.getObjectByName(name)!.getWorldScale(new Vector3()).toArray(), scales[index].toArray(), 1e-6)
            const stretch = rig.root.getObjectByName('Spine02')!.scale.y
            assert.ok(stretch >= 1 && stretch <= config.headbutt.maxExtendedStretch)
            if (age === 220) assert.ok(rig.root.getObjectByName('Head')!.localToWorld(forehead.clone()).distanceTo(keyWorld) < restDistance, 'even an unreachable key uses a nearer safe strike')
          }
          assert.deepEqual(settings, savedSettings)
          clock = start + 1500
          rig.advance(start + 400, clock)
          close(rig.root.getObjectByName('Head')!.scale.toArray(), [percent / 100, percent / 100, percent / 100])
          assert.equal(rig.root.getObjectByName('Spine02')!.scale.y, 1)
          assert.equal(rig.root.getObjectByName('Head')!.matrixAutoUpdate, true)
          assert.equal(rig.root.getObjectByName('L_Upperarm')!.matrixAutoUpdate, true)
        }
      }
    })
  }

  for (const model of ['wide', 'slim'] as const) {
    it(`${model}: limits headbutt reach to fixed world radii after moving and scaling the keyboard`, async (t) => {
      let clock = 1000
      const desk = deskFixture()
      const rig = await fixture(model, false, () => 1, true, { now: () => clock, desk })
      t.after(() => {
        rig.dispose()
        desk.geometry.dispose()
        desk.material.dispose()
      })
      rig.animator.setMouseEnabled(false)
      rig.animator.setAnimationMode('headbutt')
      const head = rig.root.getObjectByName('Head')!
      const forehead = getForeheadPoint(rig.root, head)
      for (const scale of [1, 1.5]) {
        rig.keyboard.group.scale.setScalar(MODEL_3D_CONFIG.keyboard.scale * scale)
        rig.keyboard.group.position.z = MODEL_3D_CONFIG.keyboard.position[2] + (scale - 1) * 0.4
        for (const offset of [-1, 0, 1]) {
          rig.animator.resetInput()
          rig.advance(clock, clock + 1500)
          clock += 1500
          rig.animator.setHeadbuttMaxRadiusOffset(offset)
          const start = clock
          const target = rig.keyboard.getKeyTarget('Escape')!
          rig.animator.setKeyPressed('Escape', true, target)
          rig.animator.setKeyPressed('Escape', false, target)
          rig.advance(start, start + config.headbutt.gripMs + config.headbutt.downMs)
          clock = start + config.headbutt.gripMs + config.headbutt.downMs
          rig.animator.update(16, clock)
          const center = rig.root.getWorldPosition(new Vector3())
          const hit = head.localToWorld(forehead.clone())
          hit.y = center.y
          assert.ok(hit.distanceTo(center) <= getHeadbuttReachRadius(offset) + 0.002, `${scale}/${offset}: fixed radius exceeded`)
          assert.ok(rig.root.getObjectByName('Spine02')!.scale.y <= MathUtils.lerp(config.headbutt.maxStretch, config.headbutt.maxExtendedStretch, Math.max(0, offset)))
          clock += 1000
        }
      }
    })
  }

  for (const model of ['wide', 'slim'] as const) {
    for (const mouseEnabled of [true, false]) {
      it(`${model}/${mouseEnabled}: prioritizes far-key contact and holds the lateral aim with fixed hands`, async (t) => {
        let clock = 1000
        const desks = [deskFixture(), deskFixture()]
        const rigs = await Promise.all(desks.map(desk => fixture(model, false, () => 1, true, { now: () => clock, desk })))
        const bases = rigs.map(rig => rig.root.getObjectByName('Spine02')!.quaternion.clone())
        for (const [index, rig] of rigs.entries()) {
          t.after(() => {
            rig.dispose()
            desks[index].geometry.dispose()
            desks[index].material.dispose()
          })
          rig.animator.setMouseEnabled(mouseEnabled)
          rig.animator.setAnimationMode('headbutt')
          rig.animator.setHeadbuttMaxRadiusOffset(1)
          if (index === 0) rig.animator.setHeadbuttTuning({ maxTorsoPitchDegrees: 80, minExtendedTorsoPitchDegrees: 45, maxExtendedHeadYawDegrees: 0 })
          rig.advance(0, clock)
          const target = rig.keyboard.getKeyTarget('Escape')!
          rig.animator.setKeyPressed('Escape', true, target)
        }
        const hands: Vector3[][] = []
        for (; clock <= 1130; clock += 10) {
          for (const [index, rig] of rigs.entries()) {
            rig.animator.update(10, clock)
            if (clock === 1050) hands[index] = ['L', 'R'].map(side => rig.worldPosition(`${side}_Hand`))
            if (clock > 1050) {
              for (const side of mouseEnabled ? ['L'] : ['L', 'R']) assert.ok(rig.worldPosition(`${side}_Hand`).distanceTo(hands[index][side === 'L' ? 0 : 1]) < 0.002, 'captured hand stays fixed')
            }
          }
        }
        const measurements = rigs.map((rig, index) => {
          const head = rig.root.getObjectByName('Head')!
          const forehead = head.localToWorld(getForeheadPoint(rig.root, head))
          const key = rig.keyboard.group.localToWorld(new Vector3().fromArray(rig.keyboard.getKeyTarget('Escape')!.position))
          const pitch = MathUtils.radToDeg(new Euler().setFromQuaternion(bases[index].clone().invert().multiply(rig.root.getObjectByName('Spine02')!.quaternion), 'YXZ').x)
          return { pitch, error: forehead.distanceTo(key), delta: forehead.clone().sub(key).toArray(), stretch: rig.root.getObjectByName('Spine02')!.scale.y }
        })
        assert.ok(measurements[1].pitch >= 0 && measurements[1].pitch <= config.headbutt.maxTorsoPitchDegrees, 'waist stays within its safe articulation range')
        // The approved radial solver minimizes actual contact error. More
        // available neck/waist angles need not increase the selected pitch.
        assert.ok(measurements[1].error <= measurements[0].error + 0.00001, `contact is no worse than restricted articulation: ${JSON.stringify(measurements)}`)
        assert.ok(Math.abs(measurements[1].delta[1]) <= config.headbutt.contactHeightTolerance, 'forehead reaches the keycap plane without passing through it')
        const headYaw = new Euler().setFromQuaternion(rigs[1].root.getObjectByName('Head')!.quaternion, 'YXZ').y
        rigs[1].advance(clock, clock + 500)
        const heldYaw = new Euler().setFromQuaternion(rigs[1].root.getObjectByName('Head')!.quaternion, 'YXZ').y
        assert.ok(Math.abs(headYaw - heldYaw) < MathUtils.degToRad(2), 'held neck pitch retains the strike lateral aim')
        for (const side of mouseEnabled ? ['L'] : ['L', 'R']) assert.ok(rigs[1].worldPosition(`${side}_Hand`).distanceTo(hands[1][side === 'L' ? 0 : 1]) < 0.002, 'held hand stays fixed')
      })
    }
  }

  it('matches the headbutt forecast with the applied stretched head transform', async (t) => {
    let clock = 1000
    const desk = deskFixture()
    const rig = await fixture('wide', false, () => 1, true, { now: () => clock, desk })
    t.after(() => {
      rig.dispose()
      desk.geometry.dispose()
      desk.material.dispose()
    })
    rig.animator.setAnimationMode('headbutt')
    rig.animator.setHeadbuttMaxRadiusOffset(1)
    const head = rig.root.getObjectByName('Head')!
    const spine = rig.root.getObjectByName('Spine02')!
    const headOffset = head.position.clone()
    const forehead = getForeheadPoint(rig.root, head)
    const baseScale = spine.scale.clone()
    rig.advance(0, clock)
    const target = rig.keyboard.getKeyTarget('Escape')!
    rig.animator.setKeyPressed('Escape', true, target)
    rig.animator.setKeyPressed('Escape', false, target)
    rig.advance(clock, clock + config.headbutt.gripMs + config.headbutt.downMs)
    clock += config.headbutt.gripMs + config.headbutt.downMs
    rig.animator.update(1, clock)
    const predicted = forehead.clone().multiply(head.scale).applyQuaternion(head.quaternion).add(headOffset.set(headOffset.x, headOffset.y * (spine.scale.y / baseScale.y), headOffset.z)).multiply(baseScale).applyQuaternion(spine.quaternion).add(spine.position)
    spine.parent!.localToWorld(predicted)
    const actual = head.localToWorld(forehead.clone())
    assert.ok(predicted.distanceTo(actual) < 1e-8)
  })

  it('preserves held input and ignores native repeat across mouse-only resets', async (t) => {
    let clock = 1000
    const desks = [deskFixture(), deskFixture()]
    const rigs = await Promise.all(desks.map(desk => fixture('wide', false, () => 1, true, { now: () => clock, desk })))
    for (const [index, rig] of rigs.entries()) {
      t.after(() => {
        rig.dispose()
        desks[index].geometry.dispose()
        desks[index].material.dispose()
      })
    }
    for (const rig of rigs) {
      rig.animator.setMouseEnabled(false)
      rig.animator.setAnimationMode('headbutt')
      rig.advance(0, clock)
      rig.animator.setKeyPressed('KeyF', true, rig.keyboard.getKeyTarget('KeyF'))
    }
    for (const age of [100, 150, 170, 220, 240]) {
      clock = 1000 + age
      for (const rig of rigs) rig.animator.update(16, clock)
      if (age === 150) {
        rigs[0].animator.resetMouseInput()
        rigs[0].animator.setKeyPressed('KeyF', true, rigs[0].keyboard.getKeyTarget('KeyF'))
      }
      for (const name of ['Head', 'Spine02', 'L_Hand', 'R_Hand']) close(rigs[0].root.getObjectByName(name)!.matrixWorld.toArray(), rigs[1].root.getObjectByName(name)!.matrixWorld.toArray())
    }
    clock = 1520
    for (const rig of rigs) rig.animator.update(16, clock)
    close(rigs[0].pose('Spine02'), rigs[1].pose('Spine02'))
    for (const rig of rigs) rig.animator.setKeyPressed('KeyF', false, rig.keyboard.getKeyTarget('KeyF'))
    clock = 3400
    for (const rig of rigs) rig.advance(1550, clock)
    for (const rig of rigs) {
      assert.equal(rig.root.getObjectByName('Spine02')!.scale.y, 1)
      close(rig.pose('Spine02'), rigs[1].pose('Spine02'))
    }
  })

  it('keeps the ON right hand on its independent moving/clicking mouse through keyboard strikes', async (t) => {
    let clock = 1000
    const desk = deskFixture()
    const rig = await fixture('wide', false, () => 0, true, { now: () => clock, desk })
    t.after(() => {
      rig.dispose()
      desk.geometry.dispose()
      desk.material.dispose()
    })
    rig.animator.setAnimationMode('headbutt')
    rig.advance(0, clock)
    rig.animator.setKeyPressed('KeyF', true, rig.keyboard.getKeyTarget('KeyF'))
    rig.animator.setKeyPressed('PageUp', true, rig.keyboard.getKeyTarget('PageUp'))
    const rest = rig.worldPosition('R_Hand')
    for (const age of [100, 120, 140, 160, 180, 200, 220, 240]) {
      clock = 1000 + age
      rig.anchor.position.x = -1.2 + age / 1000
      rig.animator.setMousePosition(age / 300, 0.6)
      if (age === 120) rig.animator.setMouseButtonPressed('Left', true)
      rig.animator.update(20, clock)
      assert.ok(rig.worldPosition('R_Hand').distanceTo(rig.anchor.getWorldPosition(new Vector3())) < 0.28, 'ON right hand follows mouse, not the right-side keyboard target')
      const grip = getDeskGrip(desk, rig.worldPosition('R_Upperarm'), rig.root.getWorldPosition(new Vector3()), new Vector3())!
      assert.ok(rig.worldPosition('R_Hand').distanceTo(grip) > 0.2)
    }
    assert.ok(rest.distanceTo(rig.worldPosition('R_Hand')) > 0.03, 'original movement/click path remains active')
  })

  for (const scenario of ['protected hold', 'cancelled recovery', 'released chord member'] as const) {
    it(`retains the physical hold through actual animator dispatch: ${scenario}`, async (t) => {
      let clock = 1000
      const desk = deskFixture()
      const rig = await fixture('wide', false, () => 1, true, { now: () => clock, desk })
      t.after(() => {
        rig.dispose()
        desk.geometry.dispose()
        desk.material.dispose()
      })
      rig.animator.setAnimationMode('headbutt')
      rig.animator.setMouseEnabled(false)
      rig.advance(0, clock)
      const input = (key: string, pressed: boolean) => rig.animator.setKeyPressed(key, pressed, rig.keyboard.getKeyTarget(key))
      input('KeyF', true)
      if (scenario === 'cancelled recovery') {
        clock = 1200
        rig.animator.update(16, clock)
        rig.animator.resetInput()
        clock = 1210
      } else {
        input('KeyF', false)
        clock = 1170
      }
      input('KeyS', true)
      if (scenario === 'released chord member') {
        clock += 10
        input('KeyD', true)
        clock += 5
        input('KeyD', false)
      }
      clock = 2000
      rig.animator.update(16, clock)
      const head = rig.root.getObjectByName('Head')!
      const pitch = MathUtils.radToDeg(new Euler().setFromQuaternion(head.quaternion, 'YXZ').x)
      // Held breathing and local yaw add a small rotation around the target.
      assert.ok(Math.abs(pitch - 65) < 1, `still-held key must reach the accepted hold pitch, got ${pitch}`)
      const hand = rig.worldPosition('L_Hand')
      for (let repeats = 0; repeats < 20; repeats++) input('KeyS', true)
      clock = 5000
      rig.animator.update(16, clock)
      assert.equal(rig.animator.isHeadbuttActive(), true)
      assert.ok(rig.worldPosition('L_Hand').distanceTo(hand) < 0.002)
      input('KeyS', false)
      clock = 8000
      rig.animator.update(16, clock)
      assert.equal(rig.animator.isHeadbuttActive(), false, 'final key-up retires the held animation')
    })
  }

  it('keeps both rest contacts within a reachable small tabletop', async (t) => {
    let clock = 1000
    const desk = deskFixture()
    desk.scale.set(0.5, 1, 0.5)
    const rig = await fixture('wide', false, () => 1, true, { now: () => clock, desk })
    t.after(() => {
      rig.dispose()
      desk.geometry.dispose()
      desk.material.dispose()
    })
    rig.animator.setMouseEnabled(false)
    rig.animator.setAnimationMode('headbutt')
    rig.advance(0, clock)
    rig.animator.setKeyPressed('KeyF', true, rig.keyboard.getKeyTarget('KeyF'))
    clock = 1050
    rig.animator.update(50, clock)
    desk.geometry.computeBoundingBox()
    const bounds = desk.geometry.boundingBox!
    for (const side of ['L', 'R']) {
      const point = desk.worldToLocal(rig.worldPosition(`${side}_Hand`))
      assert.ok(point.x >= bounds.min.x - 0.002 && point.x <= bounds.max.x + 0.002, `${side}: tabletop width ${point.x}`)
      assert.ok(point.z >= bounds.min.z - 0.002 && point.z <= bounds.max.z + 0.002, `${side}: tabletop depth ${point.z}`)
    }
  })

  it('cancels queued motion on mode/reset, returns saved poses and disposes all stretch matrices', async (t) => {
    let clock = 1000
    const desk = deskFixture()
    const rig = await fixture('wide', false, () => 1, true, { now: () => clock, desk })
    t.after(() => {
      rig.dispose()
      desk.geometry.dispose()
      desk.material.dispose()
    })
    rig.animator.setHeadScalePercent(150)
    rig.animator.setMouseEnabled(false)
    rig.animator.setAnimationMode('headbutt')
    rig.advance(0, clock)
    rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
    clock = 1160
    rig.animator.update(16, clock)
    rig.animator.setKeyPressed('PageUp', true, rig.keyboard.getKeyTarget('PageUp'))
    const before = rig.pose('Spine02')
    rig.animator.resetInput()
    rig.animator.setAnimationMode('default')
    rig.animator.update(0, clock)
    close(rig.pose('Spine02'), before)
    clock = 2500
    rig.advance(1176, clock)
    assert.equal(rig.root.getObjectByName('Spine02')!.scale.y, 1)
    close(rig.root.getObjectByName('Head')!.scale.toArray(), [1.5, 1.5, 1.5])
    for (const name of ['Head', 'L_Upperarm', 'R_Upperarm']) assert.equal(rig.root.getObjectByName(name)!.matrixAutoUpdate, true)
    rig.animator.setAnimationMode('headbutt')
    rig.animator.setHeadScalePercent(100)
    rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
    clock += 220
    rig.animator.update(16, clock)
    assert.ok(rig.root.getObjectByName('Spine02')!.scale.y > 1)
    rig.animator.dispose()
    assert.equal(rig.root.getObjectByName('Spine02')!.scale.y, 1)
    for (const name of ['Head', 'L_Upperarm', 'R_Upperarm']) assert.equal(rig.root.getObjectByName(name)!.matrixAutoUpdate, true)
  })

  it('produces the same contact on the actual rig across 8/16/33/100 ms frame intervals', async (t) => {
    const outputs: number[][][] = []
    for (const interval of [8, 16, 33, 100]) {
      let clock = 1000
      const desk = deskFixture()
      const rig = await fixture('slim', false, () => 1, true, { now: () => clock, desk })
      t.after(() => {
        rig.dispose()
        desk.geometry.dispose()
        desk.material.dispose()
      })
      rig.animator.setMouseEnabled(false)
      rig.animator.setAnimationMode('headbutt')
      rig.advance(0, clock)
      rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
      for (clock = 1000 + interval; clock < 1220; clock += interval) rig.animator.update(interval, clock)
      clock = 1220
      rig.animator.update(interval, clock)
      rig.root.updateMatrixWorld(true)
      outputs.push(['Head', 'L_Hand', 'R_Hand', 'Spine02'].map(name => rig.root.getObjectByName(name)!.matrixWorld.toArray()))
    }
    for (const [outputIndex, output] of outputs.entries()) {
      for (const [index, matrix] of output.entries()) {
        const error = Math.max(...matrix.map((value, component) => Math.abs(value - outputs[0][index][component])))
        t.diagnostic(`interval ${[8, 16, 33, 100][outputIndex]}/${['Head', 'L_Hand', 'R_Hand', 'Spine02'][index]}: matrix error ${error}`)
        close(matrix, outputs[0][index], 0.0001)
      }
    }
  })

  it('follows desk-local grip addresses through live desk/keyboard transforms without restarting a strike', async (t) => {
    let clock = 1000
    const desk = deskFixture()
    const rig = await fixture('wide', false, () => 1, true, { now: () => clock, desk })
    t.after(() => {
      rig.dispose()
      desk.geometry.dispose()
      desk.material.dispose()
    })
    rig.animator.setMouseEnabled(false)
    rig.animator.setAnimationMode('headbutt')
    rig.advance(0, clock)
    rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
    clock = 1210
    rig.animator.update(16, clock)
    const before = ['L', 'R'].map(side => rig.worldPosition(`${side}_Hand`))
    const localGrips = before.map(point => desk.worldToLocal(point.clone()))
    const beforeSpine = rig.root.getObjectByName('Spine02')!.quaternion.clone()
    desk.position.add(new Vector3(0.08, 0.04, 0.02))
    desk.scale.x = 1.08
    rig.keyboard.group.position.x += 0.06
    rig.keyboard.group.position.z += 0.025
    clock = 1220
    rig.animator.update(10, clock)
    assert.ok(rig.root.getObjectByName('Spine02')!.quaternion.angleTo(beforeSpine) < 0.03, 'geometry retarget starts from the existing body pose')
    for (const [index, side] of ['L', 'R'].entries()) assert.ok(rig.worldPosition(`${side}_Hand`).distanceTo(desk.localToWorld(localGrips[index].clone())) < 0.002, 'fixed contact follows the desk transform')
    clock = 1230
    rig.animator.setKeyPressed('KeyJ', true, rig.keyboard.getKeyTarget('KeyJ'))
    for (clock = 1230; clock <= 1550; clock += 10) rig.animator.update(10, clock)
    for (const [index, side] of ['L', 'R'].entries()) {
      const grip = desk.localToWorld(localGrips[index].clone())
      assert.ok(rig.worldPosition(`${side}_Hand`).distanceTo(grip) < 0.002, 'held local lip address must follow the transformed desk')
    }
    const forehead = getForeheadPoint(rig.root, rig.root.getObjectByName('Head')!)
    const keyWorld = rig.keyboard.group.localToWorld(new Vector3().fromArray(rig.keyboard.getKeyTarget('KeyJ')!.position))
    assert.ok(rig.root.getObjectByName('Head')!.localToWorld(forehead).distanceTo(keyWorld) < rig.worldPosition('Root').distanceTo(keyWorld), 'next strike safely approaches transformed key geometry')
  })

  it('enters and releases bracing continuously at exact phase boundaries', async (t) => {
    let clock = 1000
    const desk = deskFixture()
    const rig = await fixture('slim', false, () => 1, true, { now: () => clock, desk })
    t.after(() => {
      rig.dispose()
      desk.geometry.dispose()
      desk.material.dispose()
    })
    rig.animator.setMouseEnabled(false)
    rig.animator.setAnimationMode('headbutt')
    rig.advance(0, clock)
    const initial = ['L_Hand', 'R_Hand', 'L_Forearm', 'R_Forearm'].map(name => rig.worldPosition(name))
    rig.animator.setKeyPressed('KeyF', true, rig.keyboard.getKeyTarget('KeyF'))
    rig.animator.setKeyPressed('KeyF', false, rig.keyboard.getKeyTarget('KeyF'))
    rig.animator.update(0, clock)
    for (const [index, name] of ['L_Hand', 'R_Hand', 'L_Forearm', 'R_Forearm'].entries()) assert.ok(rig.worldPosition(name).distanceTo(initial[index]) < 1e-5)
    for (clock = 1016; clock < 1739; clock += 16) rig.animator.update(16, clock)
    clock = 1739
    rig.animator.update(1, clock)
    const before = ['L_Hand', 'R_Hand', 'L_Forearm', 'R_Forearm'].map(name => rig.worldPosition(name))
    clock = 1740
    rig.animator.update(1, clock)
    for (const [index, name] of ['L_Hand', 'R_Hand', 'L_Forearm', 'R_Forearm'].entries()) assert.ok(rig.worldPosition(name).distanceTo(before[index]) < 0.001, `${name}: discontinuity at release`)
  })

  it('keeps an unreachable target bounded and holds the nearest safe fixed grip for an impossible desk placement', async (t) => {
    let clock = 1000
    const desk = deskFixture()
    desk.position.y += 2
    const rig = await fixture('wide', false, () => 1, true, { now: () => clock, desk })
    t.after(() => {
      rig.dispose()
      desk.geometry.dispose()
      desk.material.dispose()
    })
    rig.animator.setMouseEnabled(false)
    rig.animator.setAnimationMode('headbutt')
    rig.advance(0, clock)
    rig.keyboard.group.position.z += 3
    rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
    clock = 1100
    rig.animator.update(100, clock)
    const fixed = ['L', 'R'].map(side => rig.worldPosition(`${side}_Hand`))
    for (const age of [160, 220, 240, 300, 399]) {
      clock = 1000 + age
      rig.animator.update(16, clock)
      assert.ok(rig.root.getObjectByName('Spine02')!.scale.y <= 1.5)
      assert.ok(MathUtils.radToDeg(new Euler().setFromQuaternion(rig.root.getObjectByName('Spine02')!.quaternion, 'YXZ').x) <= 65 + 1e-6)
      for (const [index, side] of ['L', 'R'].entries()) assert.ok(rig.worldPosition(`${side}_Hand`).distanceTo(fixed[index]) < 0.002, `${side}/${age}: nearest safe grip drift ${rig.worldPosition(`${side}_Hand`).distanceTo(fixed[index])}`)
    }
    assert.ok(fixed[0].distanceTo(getDeskGrip(desk, rig.worldPosition('L_Upperarm'), rig.root.getWorldPosition(new Vector3()), new Vector3())!) > 0.2, 'out-of-reach fallback is explicitly not actual desk contact')
  })

  it('does not turn a held key into a fresh headbutt when selecting the mode', async (t) => {
    let clock = 1000
    const desk = deskFixture()
    const rig = await fixture('wide', false, () => 1, true, { now: () => clock, desk })
    t.after(() => {
      rig.dispose()
      desk.geometry.dispose()
      desk.material.dispose()
    })
    rig.animator.setMouseEnabled(false)
    rig.advance(0, clock)
    const accepted = rig.keyboard.getKeyTarget('Escape')!
    rig.animator.setKeyPressed('Escape', true, accepted)
    rig.animator.setAnimationMode('headbutt')
    clock = 1100
    rig.animator.setKeyPressed('Escape', true, accepted)
    rig.advance(1000, 1400)
    const spine = rig.root.getObjectByName('Spine02')!
    assert.ok(Math.abs(MathUtils.radToDeg(new Euler().setFromQuaternion(spine.quaternion, 'YXZ').x)) < 5, 'native hold across mode change must not start a strike')
    clock = 1500
    rig.animator.setKeyPressed('Escape', false, accepted)
    rig.animator.setKeyPressed('Escape', true, accepted)
    clock = 1720
    rig.animator.update(16, clock)
    assert.ok(MathUtils.radToDeg(new Euler().setFromQuaternion(spine.quaternion, 'YXZ').x) > 10, 'a physical release/press still strikes in the new mode')
  })

  it('reports active headbutt through mode/reset cancellation until the actual final pose reset', async (t) => {
    let clock = 1000
    const desk = deskFixture()
    const rig = await fixture('wide', false, () => 1, true, { now: () => clock, desk })
    t.after(() => {
      rig.dispose()
      desk.geometry.dispose()
      desk.material.dispose()
    })
    assert.equal(rig.animator.isHeadbuttActive(), false)
    rig.animator.setAnimationMode('headbutt')
    rig.animator.setMouseEnabled(false)
    rig.advance(0, clock)
    assert.equal(rig.animator.isHeadbuttActive(), false)
    rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
    assert.equal(rig.animator.isHeadbuttActive(), true, 'grip is active before its first draw')
    for (const age of [50, 100, 220, 250]) {
      clock = 1000 + age
      rig.animator.update(16, clock)
      assert.equal(rig.animator.isHeadbuttActive(), true)
    }
    rig.animator.resetMouseInput()
    assert.equal(rig.animator.isHeadbuttActive(), true)
    rig.animator.resetInput()
    rig.animator.setAnimationMode('default')
    assert.equal(rig.animator.isHeadbuttActive(), true, 'mode selection does not retire the live rebound')
    const cancelDoneAt = 1250 + config.headbutt.reboundMs + config.headbutt.returnMs
    for (const at of [1325, 1400, cancelDoneAt - 1]) {
      clock = at
      rig.animator.update(16, clock)
      assert.equal(rig.animator.isHeadbuttActive(), true)
    }
    clock = cancelDoneAt
    rig.animator.update(1, clock)
    assert.equal(rig.animator.isHeadbuttActive(), false)

    clock = 3000
    rig.animator.setAnimationMode('headbutt')
    rig.animator.setKeyPressed('Escape', true, rig.keyboard.getKeyTarget('Escape'))
    clock = 3220
    rig.animator.update(16, clock)
    assert.ok(rig.root.getObjectByName('Spine02')!.scale.y > 1)
    rig.animator.setKeyPressed('Escape', false, rig.keyboard.getKeyTarget('Escape'))
    clock = 6000
    const before = rig.pose('Spine02')
    assert.equal(rig.animator.isHeadbuttActive(), true, 'read-only query retains the last drawn pose without advancing time')
    close(rig.pose('Spine02'), before)
    rig.animator.setAnimationMode('default')
    assert.equal(rig.animator.isHeadbuttActive(), true, 'an expired pulse still owns its applied stretch until update')
    rig.animator.update(16, clock)
    assert.equal(rig.animator.isHeadbuttActive(), false)
    assert.equal(rig.root.getObjectByName('Spine02')!.scale.y, 1)
    rig.animator.dispose()
    assert.equal(rig.animator.isHeadbuttActive(), false)
  })
})

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
  it('discards retired eyebrow focus history before accepting a fresh session', async (t) => {
    let now = 1000
    t.mock.method(performance, 'now', () => now)
    const rig = await fixture()
    const { renderer, mouse } = stillFrameFixture(rig)
    const eyebrows = createDmeloperEyebrowController(rig.root, { random: () => 0.5 })!
    Object.assign(renderer, { dmeloperEyebrowController: eyebrows })
    t.after(rig.dispose)
    t.after(mouse.dispose)
    t.after(() => eyebrows.dispose())
    renderer.setDmeloperEyebrows({ ...createDefaultDmeloperEyebrowPreset(), enabled: true })
    const brow = rig.root.getObjectByName('LeftEyebrow')!
    const neutral = brow.quaternion.clone()
    const contact = { row: 2, column: 3 }
    const press = (timestamp: number) => {
      now = timestamp
      renderer.handleSemanticInput({ kind: 'typing', active: true, intensity: 1, contact: { ...contact, pressed: true } })
      now++
      renderer.handleSemanticInput({ kind: 'typing', active: false, intensity: 0, contact: { ...contact, pressed: false } })
    }
    for (let index = 0; index < 15; index++) press(1001 + index * 40)
    now = 1570
    renderer.setInputActive(false)
    now = 1580
    renderer.setInputActive(true)
    // Old focus is silent for 400 ms, but its 1500 ms press window is still recent.
    press(2061)
    now = 2281
    renderer.renderStillFrame(now)
    assert.ok(neutral.angleTo(brow.quaternion) < 0.00001, 'one fresh press must not qualify using retired history')
  })

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
          // Added leg chains intentionally change the rendered pose. Preserve
          // the immutable fingerprint of every previously existing node.
          if (/^[LR]_(?:Leg|Shin|Foot)$/.test(node.name)) return
          originalPoseHash.update(new Uint8Array(new Float64Array([
            ...node.quaternion.toArray(),
            ...node.matrixWorld.elements,
          ]).buffer))
        })
      }
      // The pre-radius fixture remains e1b7ca6a11056c43786eecb4cdbb59c1d81657df939388e7d8228d749131d3a9.
      // Its transformed keys now intentionally clip to the approved fixed
      // circle at offset zero; this is the separate accepted-radius fixture.
      // The eager oracle still verifies every node/matrix on every frame.
      assert.equal(originalPoseHash.digest('hex'), 'b85b1a0d652459d04306abfaa9392931829985fbaa7e85d87bbf5d3be69f86d5')
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
