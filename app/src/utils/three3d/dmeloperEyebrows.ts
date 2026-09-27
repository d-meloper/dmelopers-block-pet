import type { Material, Object3D } from 'three'

import {
  Color,
  MathUtils,
  Mesh,
  Quaternion,
  Vector3,
} from 'three'

import type { DmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'

import {
  createDefaultDmeloperEyebrowPreset,
  DMELOPER_EYEBROW_FALLBACK_COLOR,
} from '@/config/dmeloperEyebrows'

export type DmeloperEyebrowIdleState = 'neutral' | 'curious' | 'alert' | 'skeptical'

export interface DmeloperEyebrowController {
  setAnimationEnabled: (enabled: boolean, timestamp?: number) => void
  setMouseEnabled: (enabled: boolean, timestamp?: number) => void
  resetMouseInput: (timestamp?: number) => void
  setPreset: (preset: DmeloperEyebrowPreset) => void
  setSuggestedColor: (color?: string) => void
  setKeyPressed: (key: string, pressed: boolean, timestamp?: number) => void
  setMouseButtonPressed: (
    button: 'Left' | 'Right',
    pressed: boolean,
    timestamp?: number,
  ) => void
  update: (timestamp?: number) => void
  dispose: () => void
}

export interface DmeloperEyebrowControllerOptions {
  random?: () => number
  now?: () => number
}

interface BrowNode {
  object: Mesh
  basePosition: Vector3
  baseQuaternion: Quaternion
  baseScale: Vector3
  horizontal: Vector3
  vertical: Vector3
  front: Vector3
  widthScaleAxis: 'x'
  thicknessScaleAxis: 'y'
}

interface ExpressionPose {
  leftHeight: number
  rightHeight: number
  leftTilt: number
  rightTilt: number
}

const TRANSITION_MS = 220
const IDLE_MIN_MS = 4000
const IDLE_MAX_MS = 7000
const FOCUS_KEY_COUNT = 8
const FOCUS_WINDOW_MS = 1500
const FOCUS_RELEASE_MS = 1000
const MOUSE_FOCUS_CLICK_COUNT = 4
const MOUSE_FOCUS_WINDOW_MS = 800
const KEY_PULSE_MS = 120
const KEY_PULSE_MERGE_MS = 90
const BASE_SPACING_PIXELS = 1.5
const BASE_WIDTH_PIXELS = 2
const BASE_THICKNESS_PIXELS = 0.5
// The authored brow is 0.65px deep, with 0.05px embedded in the base head.
const BASE_PROTRUSION_PIXELS = 0.60
// The former 5% is the user-verified minimum that avoids face z-fighting.
const MIN_PROTRUSION_PIXELS = 0.03095
const IDLE_STATES: readonly DmeloperEyebrowIdleState[] = [
  'neutral',
  'curious',
  'alert',
  'skeptical',
]
const ZERO_POSE: ExpressionPose = {
  leftHeight: 0,
  rightHeight: 0,
  leftTilt: 0,
  rightTilt: 0,
}
const FOCUS_POSE: ExpressionPose = {
  leftHeight: -0.10,
  rightHeight: -0.10,
  leftTilt: 22,
  rightTilt: -22,
}

function clonePose(pose: ExpressionPose): ExpressionPose {
  return { ...pose }
}

function mixPose(from: ExpressionPose, to: ExpressionPose, progress: number): ExpressionPose {
  const mix = (left: number, right: number) => MathUtils.lerp(left, right, progress)
  return {
    leftHeight: mix(from.leftHeight, to.leftHeight),
    rightHeight: mix(from.rightHeight, to.rightHeight),
    leftTilt: mix(from.leftTilt, to.leftTilt),
    rightTilt: mix(from.rightTilt, to.rightTilt),
  }
}

function smoothstep(progress: number): number {
  const clamped = MathUtils.clamp(progress, 0, 1)
  return clamped * clamped * (3 - 2 * clamped)
}

function pulse(progress: number): number {
  return Math.sin(Math.PI * MathUtils.clamp(progress, 0, 1))
}

function idlePose(state: DmeloperEyebrowIdleState, curiousLeft: boolean): ExpressionPose {
  if (state === 'curious') {
    return curiousLeft
      ? { leftHeight: 0.16, rightHeight: 0, leftTilt: 0, rightTilt: 0 }
      : { leftHeight: 0, rightHeight: 0.16, leftTilt: 0, rightTilt: 0 }
  }
  if (state === 'alert') {
    return { leftHeight: 0.18, rightHeight: 0.18, leftTilt: 0, rightTilt: 0 }
  }
  if (state === 'skeptical') {
    return { leftHeight: 0, rightHeight: 0, leftTilt: 10, rightTilt: -10 }
  }
  return clonePose(ZERO_POSE)
}

function materialList(material: Material | Material[]): Material[] {
  return Array.isArray(material) ? material : [material]
}

function setMaterialColor(material: Material, value: string): void {
  if (!('color' in material) || !(material.color instanceof Color)) return
  material.color.set(value)
  material.needsUpdate = true
}

function makeBrowNode(root: Object3D, name: string, side: 'left' | 'right'): BrowNode | undefined {
  const object = root.getObjectByName(name)
  if (!(object instanceof Mesh)) return undefined
  if (
    object.userData.petEyebrowVersion !== 1
    || object.userData.petEyebrowSide !== side
    || object.userData.petEyebrowBaseWidthPixels !== BASE_WIDTH_PIXELS
    || object.userData.petEyebrowBaseThicknessPixels !== BASE_THICKNESS_PIXELS
    || object.userData.petEyebrowBaseSpacingPixels !== BASE_SPACING_PIXELS
    || !materialList(object.material).every(material => material.name === 'Dmeloper Eyebrow')
  ) {
    return undefined
  }

  const parent = object.parent
  if (!parent) return undefined
  root.updateWorldMatrix(true, true)
  const rootWorld = root.getWorldQuaternion(new Quaternion())
  const parentWorldInverse = parent.getWorldQuaternion(new Quaternion()).invert()
  const directionInParent = (direction: Vector3): Vector3 => direction
    .applyQuaternion(rootWorld)
    .applyQuaternion(parentWorldInverse)
    .normalize()

  object.castShadow = false
  object.receiveShadow = true
  return {
    object,
    basePosition: object.position.clone(),
    baseQuaternion: object.quaternion.clone(),
    baseScale: object.scale.clone(),
    horizontal: directionInParent(new Vector3(1, 0, 0)),
    vertical: directionInParent(new Vector3(0, 1, 0)),
    front: directionInParent(new Vector3(0, 0, 1)),
    widthScaleAxis: 'x',
    thicknessScaleAxis: 'y',
  }
}

export function createDmeloperEyebrowController(
  root: Object3D,
  options: DmeloperEyebrowControllerOptions = {},
): DmeloperEyebrowController | undefined {
  const left = makeBrowNode(root, 'LeftEyebrow', 'left')
  const right = makeBrowNode(root, 'RightEyebrow', 'right')
  if (!left || !right) {
    root.getObjectByName('LeftEyebrow')?.traverse(object => object.visible = false)
    root.getObjectByName('RightEyebrow')?.traverse(object => object.visible = false)
    console.warn('Dmeloper eyebrows are disabled because the generated eyebrow contract is missing.')
    return undefined
  }

  const random = options.random ?? Math.random
  const now = options.now ?? (() => performance.now())
  let preset = createDefaultDmeloperEyebrowPreset()
  let idleState: DmeloperEyebrowIdleState = 'neutral'
  let curiousLeft = true
  let currentPose = clonePose(ZERO_POSE)
  let transitionFrom = clonePose(ZERO_POSE)
  let transitionTarget = clonePose(ZERO_POSE)
  let transitionStartedAt = now()
  let nextIdleAt = transitionStartedAt + MathUtils.lerp(IDLE_MIN_MS, IDLE_MAX_MS, random())
  let focusActive = false
  let lastFocusInputAt = Number.NEGATIVE_INFINITY
  let lastKeyboardFocusInputAt = Number.NEGATIVE_INFINITY
  let keyPulseStartedAt = Number.NEGATIVE_INFINITY
  let animationEnabled = true
  let mouseEnabled = true
  let disposed = false
  const heldKeys = new Set<string>()
  const recentDistinctKeys = new Map<string, number>()
  const heldMouseButtons = new Set<'Left' | 'Right'>()
  const recentClickTimes: number[] = []

  const chooseNextIdleState = (): DmeloperEyebrowIdleState => {
    const candidates = IDLE_STATES.filter(state => state !== idleState)
    return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]
  }
  const scheduleIdle = (timestamp: number): void => {
    nextIdleAt = timestamp + MathUtils.lerp(IDLE_MIN_MS, IDLE_MAX_MS, random())
  }
  const beginTransition = (target: ExpressionPose, timestamp: number): void => {
    const progress = smoothstep((timestamp - transitionStartedAt) / TRANSITION_MS)
    currentPose = mixPose(transitionFrom, transitionTarget, progress)
    transitionFrom = clonePose(currentPose)
    transitionTarget = clonePose(target)
    transitionStartedAt = timestamp
  }
  const enterFocus = (timestamp: number): void => {
    lastFocusInputAt = timestamp
    if (focusActive) return
    focusActive = true
    beginTransition(FOCUS_POSE, timestamp)
  }
  const returnToNeutral = (timestamp: number): void => {
    idleState = 'neutral'
    curiousLeft = true
    focusActive = false
    lastFocusInputAt = Number.NEGATIVE_INFINITY
    lastKeyboardFocusInputAt = Number.NEGATIVE_INFINITY
    keyPulseStartedAt = Number.NEGATIVE_INFINITY
    recentDistinctKeys.clear()
    recentClickTimes.length = 0
    beginTransition(ZERO_POSE, timestamp)
    scheduleIdle(timestamp)
  }
  const resetAnimation = (timestamp: number): void => {
    idleState = 'neutral'
    curiousLeft = true
    currentPose = clonePose(ZERO_POSE)
    transitionFrom = clonePose(ZERO_POSE)
    transitionTarget = clonePose(ZERO_POSE)
    transitionStartedAt = timestamp
    focusActive = false
    lastFocusInputAt = Number.NEGATIVE_INFINITY
    lastKeyboardFocusInputAt = Number.NEGATIVE_INFINITY
    keyPulseStartedAt = Number.NEGATIVE_INFINITY
    heldKeys.clear()
    recentDistinctKeys.clear()
    heldMouseButtons.clear()
    recentClickTimes.length = 0
    scheduleIdle(timestamp)
  }
  const applyColor = (): void => {
    for (const node of [left, right]) {
      materialList(node.object.material).forEach(material => setMaterialColor(material, preset.color))
    }
  }
  const applyNode = (
    node: BrowNode,
    side: 'left' | 'right',
    pose: ExpressionPose,
  ): void => {
    const sideSign = side === 'left' ? 1 : -1
    const spacingOffset = sideSign * (preset.spacingPixels - BASE_SPACING_PIXELS)
    const height = preset.heightOffsetPixels
      + (side === 'left' ? pose.leftHeight : pose.rightHeight)
    const tilt = side === 'left' ? pose.leftTilt : pose.rightTilt
    node.object.position.copy(node.basePosition)
      .addScaledVector(node.horizontal, preset.centerOffsetPixels + spacingOffset)
      .addScaledVector(node.vertical, height)
      .addScaledVector(
        node.front,
        (MIN_PROTRUSION_PIXELS - BASE_PROTRUSION_PIXELS) * (1 - preset.depthPercent / 200),
      )
    node.object.quaternion.copy(
      new Quaternion()
        .setFromAxisAngle(node.front, MathUtils.degToRad(tilt))
        .multiply(node.baseQuaternion),
    )
    node.object.scale.copy(node.baseScale)
    node.object.scale[node.widthScaleAxis]
      = node.baseScale[node.widthScaleAxis] * preset.widthPixels / BASE_WIDTH_PIXELS
    node.object.scale[node.thicknessScaleAxis]
      = node.baseScale[node.thicknessScaleAxis]
        * preset.thicknessPixels / BASE_THICKNESS_PIXELS
    node.object.visible = preset.enabled
  }
  const apply = (timestamp: number): void => {
    if (!preset.enabled || disposed) {
      left.object.visible = false
      right.object.visible = false
      return
    }
    if (!animationEnabled) {
      applyNode(left, 'left', ZERO_POSE)
      applyNode(right, 'right', ZERO_POSE)
      return
    }
    const transitionProgress = smoothstep((timestamp - transitionStartedAt) / TRANSITION_MS)
    currentPose = mixPose(transitionFrom, transitionTarget, transitionProgress)
    const rendered = clonePose(currentPose)
    if (!focusActive) {
      const keyProgress = (timestamp - keyPulseStartedAt) / KEY_PULSE_MS
      if (keyProgress >= 0 && keyProgress < 1) {
        const amount = 0.08 * pulse(keyProgress)
        rendered.leftHeight += amount
        rendered.rightHeight += amount
      }
    }
    applyNode(left, 'left', rendered)
    applyNode(right, 'right', rendered)
  }

  const setPreset: DmeloperEyebrowController['setPreset'] = (nextPreset) => {
    const wasEnabled = preset.enabled
    preset = { ...createDefaultDmeloperEyebrowPreset(), ...nextPreset }
    if (!preset.enabled || !wasEnabled) resetAnimation(now())
    applyColor()
    apply(now())
  }
  const setSuggestedColor: DmeloperEyebrowController['setSuggestedColor'] = (color) => {
    preset.color = /^#[0-9a-f]{6}$/i.test(color ?? '')
      ? color!
      : DMELOPER_EYEBROW_FALLBACK_COLOR
    applyColor()
  }
  const setAnimationEnabled: DmeloperEyebrowController['setAnimationEnabled'] = (
    enabled,
    timestamp = now(),
  ) => {
    if (disposed || animationEnabled === enabled) return
    animationEnabled = enabled
    resetAnimation(timestamp)
    apply(timestamp)
  }
  const setKeyPressed: DmeloperEyebrowController['setKeyPressed'] = (
    key,
    pressed,
    timestamp = now(),
  ) => {
    if (disposed || !preset.enabled || !animationEnabled) return
    if (!pressed) {
      heldKeys.delete(key)
      return
    }
    if (heldKeys.has(key)) return
    heldKeys.add(key)
    lastFocusInputAt = timestamp
    for (const [knownKey, pressedAt] of recentDistinctKeys) {
      if (timestamp - pressedAt > FOCUS_WINDOW_MS) recentDistinctKeys.delete(knownKey)
    }
    recentDistinctKeys.set(key, timestamp)
    // Track keyboard-qualified focus separately from a mouse-induced focus or
    // its click extensions, so disabling the mouse preserves only keyboard input.
    if (
      timestamp - lastKeyboardFocusInputAt < FOCUS_RELEASE_MS
      || recentDistinctKeys.size >= FOCUS_KEY_COUNT
    ) {
      lastKeyboardFocusInputAt = timestamp
    }
    // Focus hides the pulse while active; keep its keyboard-only timing so a
    // mouse reset can reveal an ongoing key pulse without dropping the key.
    if (timestamp - keyPulseStartedAt >= KEY_PULSE_MERGE_MS) {
      keyPulseStartedAt = timestamp
    }
    if (focusActive || recentDistinctKeys.size >= FOCUS_KEY_COUNT) {
      enterFocus(timestamp)
    }
  }
  const setMouseButtonPressed: DmeloperEyebrowController['setMouseButtonPressed'] = (
    button,
    pressed,
    timestamp = now(),
  ) => {
    if (disposed || !preset.enabled || !animationEnabled || !mouseEnabled) return
    if (!pressed) {
      heldMouseButtons.delete(button)
      return
    }
    if (heldMouseButtons.has(button)) return
    heldMouseButtons.add(button)
    if (focusActive) lastFocusInputAt = timestamp
    while (
      recentClickTimes.length > 0
      && timestamp - recentClickTimes[0] > MOUSE_FOCUS_WINDOW_MS
    ) {
      recentClickTimes.shift()
    }
    recentClickTimes.push(timestamp)
    if (recentClickTimes.length >= MOUSE_FOCUS_CLICK_COUNT) {
      recentClickTimes.length = 0
      enterFocus(timestamp)
    }
  }
  const resetMouseInput: DmeloperEyebrowController['resetMouseInput'] = (timestamp = now()) => {
    if (disposed) return
    heldMouseButtons.clear()
    recentClickTimes.length = 0
    if (focusActive) {
      if (timestamp - lastKeyboardFocusInputAt < FOCUS_RELEASE_MS) {
        lastFocusInputAt = lastKeyboardFocusInputAt
      } else {
        focusActive = false
        lastFocusInputAt = Number.NEGATIVE_INFINITY
        idleState = 'neutral'
        curiousLeft = true
        beginTransition(ZERO_POSE, timestamp)
        scheduleIdle(timestamp)
      }
    }
    apply(timestamp)
  }
  const setMouseEnabled: DmeloperEyebrowController['setMouseEnabled'] = (enabled, timestamp = now()) => {
    if (disposed || mouseEnabled === enabled) return
    mouseEnabled = enabled
    resetMouseInput(timestamp)
  }
  const update: DmeloperEyebrowController['update'] = (timestamp = now()) => {
    if (disposed || !preset.enabled || !animationEnabled) return
    if (focusActive && timestamp - lastFocusInputAt >= FOCUS_RELEASE_MS) {
      returnToNeutral(timestamp)
    }
    if (!focusActive && timestamp >= nextIdleAt) {
      idleState = chooseNextIdleState()
      curiousLeft = random() < 0.5
      beginTransition(idlePose(idleState, curiousLeft), timestamp)
      scheduleIdle(timestamp + TRANSITION_MS)
    }
    apply(timestamp)
  }
  const dispose: DmeloperEyebrowController['dispose'] = () => {
    if (disposed) return
    resetAnimation(now())
    left.object.visible = false
    right.object.visible = false
    disposed = true
  }

  applyColor()
  apply(transitionStartedAt)
  return {
    setAnimationEnabled,
    setMouseEnabled,
    resetMouseInput,
    setPreset,
    setSuggestedColor,
    setKeyPressed,
    setMouseButtonPressed,
    update,
    dispose,
  }
}
