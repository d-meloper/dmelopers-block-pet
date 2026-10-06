import type { Object3D } from 'three'

import {
  Euler,
  MathUtils,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three'

import type { PetArmPoseSettings } from '@/config/petArmPose'

import { MODEL_3D_CONFIG } from '@/config/model3d'
import { DEFAULT_PET_ARM_POSE_SETTINGS, normalizePetArmPoseSettings } from '@/config/petArmPose'

import type { KeyboardKeyTarget } from './keyboard'

import { createHandContactTransition } from './handContactTransition'
import { createTypingTrance } from './typingTrance'

export interface PetAnimator {
  setHeadScalePercent: (percent: number) => void
  setMouseEnabled: (enabled: boolean) => void
  resetMouseInput: () => void
  resetInput: () => void
  setArmPoseSettings: (settings: PetArmPoseSettings) => void
  setKeyPressed: (
    key: string,
    pressed: boolean,
    target: KeyboardKeyTarget | undefined,
  ) => void
  setMousePosition: (xRatio: number, yRatio: number) => void
  setMouseButtonPressed: (
    button: 'Left' | 'Right' | 'Middle',
    pressed: boolean,
  ) => void
  update: (deltaMilliseconds: number, timestamp: number) => void
  dispose: () => void
}

interface PetAnimatorTargets {
  keyboardBodyDefaultTarget: KeyboardKeyTarget
  keyboardBodyTurnThresholdTarget: KeyboardKeyTarget
  keyboardNavigationTargets?: readonly KeyboardKeyTarget[]
  keyboardGroup: Object3D
  keyboardLeftRestTarget: KeyboardKeyTarget
  keyboardRestTarget: KeyboardKeyTarget
  keyboardRightRestTarget?: KeyboardKeyTarget
  mouseGroup: Object3D
}

interface AnimatedNode {
  object: Object3D
  basePosition: Vector3
  baseQuaternion: Quaternion
  baseScale: Vector3
}

interface ArmChain {
  upperarm: AnimatedNode
  forearm: AnimatedNode
  hand: AnimatedNode
  upperarmLength: number
  forearmLength: number
  handLength: number
  smoothedContactWorld: Vector3
  contactInitialized: boolean
  contactTransition: ReturnType<typeof createHandContactTransition>
}

type InputMode = 'KeyboardMouse' | 'KeyboardOnly'
type KeyboardSide = 'Left' | 'Right'

interface PressedKey {
  key: string
  target: KeyboardKeyTarget
  side: KeyboardSide
}

interface TypingTrack {
  lastTarget?: KeyboardKeyTarget
  lastKeyPressedAt: number
  chordKey?: string
  strikeStartedAt: number
  returnStartedAt: number
}

interface TypingPose {
  target?: KeyboardKeyTarget
  isTyping: boolean
  easedReturn: number
  impacting: boolean
}

const REQUIRED_NODE_NAMES = [
  'L_Upperarm',
  'L_Forearm',
  'L_Hand',
  'R_Upperarm',
  'R_Forearm',
  'R_Hand',
  'Head',
  'Spine02',
] as const

type RequiredNodeName = typeof REQUIRED_NODE_NAMES[number]
type NodeMap = Record<RequiredNodeName, AnimatedNode>

const BONE_AXIS = new Vector3(0, 1, 0)
const WORLD_UP = new Vector3(0, 1, 0)
const WORLD_UP_COMPONENTS = [0, 1, 0] as const
const EPSILON = 0.0001

function degreesToQuaternion(x: number, y: number, z: number, target: Quaternion, euler: Euler): Quaternion {
  return target.setFromEuler(euler.set(
    MathUtils.degToRad(x),
    MathUtils.degToRad(y),
    MathUtils.degToRad(z),
    'XYZ',
  ))
}

function makeTargetQuaternion(
  node: AnimatedNode,
  x: number,
  y: number,
  z: number,
  scratch: { target: Quaternion, rotation: Quaternion, euler: Euler },
): Quaternion {
  return scratch.target.copy(node.baseQuaternion)
    .multiply(degreesToQuaternion(x, y, z, scratch.rotation, scratch.euler))
}

function dampQuaternion(
  object: Object3D,
  target: Quaternion,
  damping: number,
  deltaSeconds: number,
  snap = false,
): void {
  if (snap) {
    object.quaternion.copy(target)
    return
  }

  const alpha = 1 - Math.exp(-damping * deltaSeconds)
  object.quaternion.slerp(target, alpha)
}

function getWorldDistance(left: Object3D, right: Object3D): number {
  return left.getWorldPosition(new Vector3())
    .distanceTo(right.getWorldPosition(new Vector3()))
}

function makeArmChain(
  upperarm: AnimatedNode,
  forearm: AnimatedNode,
  hand: AnimatedNode,
): ArmChain {
  const upperarmLength = getWorldDistance(upperarm.object, forearm.object)
  const forearmLength = getWorldDistance(forearm.object, hand.object)

  return {
    upperarm,
    forearm,
    hand,
    upperarmLength,
    forearmLength,
    handLength: forearmLength * 0.46,
    smoothedContactWorld: new Vector3(),
    contactInitialized: false,
    contactTransition: createHandContactTransition(
      (upperarmLength + forearmLength) * MODEL_3D_CONFIG.pet.animation.handTravel.minArmLengthRatio,
      MODEL_3D_CONFIG.pet.animation.handTravel.durationMs,
    ),
  }
}

function createArmSolveScratch() {
  return {
    shoulder: new Vector3(),
    shoulderToContact: new Vector3(),
    handDirection: new Vector3(),
    wristTarget: new Vector3(),
    poleDirection: new Vector3(),
    rotationMatrix: new Matrix4(),
    elbowTarget: new Vector3(),
    currentElbow: new Vector3(),
    forearmDirection: new Vector3(),
    spreadAxis: new Vector3(),
    spreadParentQuaternion: new Quaternion(),
    spreadRotation: new Quaternion(),
    bone: {
      parentWorldQuaternion: new Quaternion(),
      directionInParent: new Vector3(),
      restDirectionInParent: new Vector3(),
      rotationFromRest: new Quaternion(),
      targetQuaternion: new Quaternion(),
    },
  }
}

type ArmSolveScratch = ReturnType<typeof createArmSolveScratch>

function pointBoneAt(
  scratch: ArmSolveScratch['bone'],
  node: AnimatedNode,
  worldDirection: Vector3,
  damping: number,
  deltaSeconds: number,
  snap: boolean,
  rotationWeight = 1,
): void {
  const parent = node.object.parent
  if (!parent || worldDirection.lengthSq() < EPSILON) return

  const parentWorldQuaternion = parent.getWorldQuaternion(scratch.parentWorldQuaternion)
  const directionInParent = scratch.directionInParent.copy(worldDirection)
    .normalize()
    .applyQuaternion(parentWorldQuaternion.invert())
  const restDirectionInParent = scratch.restDirectionInParent.copy(BONE_AXIS)
    .applyQuaternion(node.baseQuaternion)
    .normalize()
  const rotationFromRest = scratch.rotationFromRest.setFromUnitVectors(
    restDirectionInParent,
    directionInParent,
  )
  const targetQuaternion = scratch.targetQuaternion.copy(node.baseQuaternion).slerp(
    rotationFromRest.multiply(node.baseQuaternion),
    MathUtils.clamp(rotationWeight, 0, 1),
  )

  dampQuaternion(
    node.object,
    targetQuaternion,
    damping,
    deltaSeconds,
    snap,
  )
}

function getTransformedDirection(root: Object3D, direction: readonly number[], target: Vector3, matrix: Matrix4): Vector3 {
  const rotationMatrix = matrix.extractRotation(root.matrixWorld)
  return target.set(direction[0], direction[1], direction[2])
    .transformDirection(rotationMatrix)
}

function solveArm(
  scratch: ArmSolveScratch,
  root: Object3D,
  chain: ArmChain,
  contactWorld: Vector3,
  elbowPole: readonly number[],
  bendAmount: number,
  spreadDegrees: number,
  spreadAxisWorld: Vector3,
  damping: number,
  deltaSeconds: number,
  snap: boolean,
  trackContactExactly = false,
): void {
  const directContact = snap || !chain.contactInitialized || trackContactExactly
  const travelContact = chain.contactTransition.update(
    contactWorld,
    chain.smoothedContactWorld,
    spreadAxisWorld,
    deltaSeconds * 1000,
    directContact,
  )
  if (directContact) {
    chain.smoothedContactWorld.copy(travelContact)
    chain.contactInitialized = true
  } else {
    const contactAlpha = 1 - Math.exp(-damping * deltaSeconds)
    chain.smoothedContactWorld.lerp(travelContact, contactAlpha)
  }

  // World-space joint queries refresh their ancestor chain below. Refreshing
  // every sibling mesh here repeats the same work once for each arm.
  root.updateWorldMatrix(true, false)

  const shoulder = chain.upperarm.object.getWorldPosition(scratch.shoulder)
  const shoulderToContact = scratch.shoulderToContact.copy(chain.smoothedContactWorld).sub(shoulder)
  if (shoulderToContact.lengthSq() < EPSILON) return

  const handDirection = scratch.handDirection.copy(shoulderToContact).normalize()
  const armLength = chain.upperarmLength + chain.forearmLength
  const desiredWristReach = shoulderToContact.length() - chain.handLength * 0.65
  const minimumReach = armLength * 0.55
  const maximumReach = armLength * 0.94
  const reach = MathUtils.clamp(
    desiredWristReach,
    minimumReach,
    maximumReach,
  )
  const wristTarget = scratch.wristTarget.copy(shoulder).addScaledVector(handDirection, reach)
  const reachDirection = handDirection

  const poleDirection = getTransformedDirection(root, elbowPole, scratch.poleDirection, scratch.rotationMatrix)
  const bendDirection = poleDirection
    .addScaledVector(reachDirection, -poleDirection.dot(reachDirection))

  if (bendDirection.lengthSq() < EPSILON) {
    bendDirection.copy(WORLD_UP)
      .addScaledVector(reachDirection, -WORLD_UP.dot(reachDirection))
  }
  bendDirection.normalize()

  const upperarmProjection = (
    chain.upperarmLength * chain.upperarmLength
    - chain.forearmLength * chain.forearmLength
    + reach * reach
  ) / (2 * reach)
  const elbowOffset = Math.sqrt(Math.max(
    0,
    chain.upperarmLength * chain.upperarmLength
    - upperarmProjection * upperarmProjection,
  ))
  const elbowTarget = scratch.elbowTarget.copy(shoulder)
    .addScaledVector(reachDirection, upperarmProjection)
    .addScaledVector(bendDirection, elbowOffset * bendAmount)

  const upperarmDirection = elbowTarget.sub(shoulder)

  pointBoneAt(
    scratch.bone,
    chain.upperarm,
    upperarmDirection,
    damping,
    deltaSeconds,
    true,
  )
  chain.upperarm.object.updateWorldMatrix(true, true)

  const currentElbow = chain.forearm.object.getWorldPosition(scratch.currentElbow)
  pointBoneAt(
    scratch.bone,
    chain.forearm,
    scratch.forearmDirection.copy(wristTarget).sub(currentElbow),
    damping,
    deltaSeconds,
    true,
  )
  chain.forearm.object.updateWorldMatrix(true, true)

  pointBoneAt(
    scratch.bone,
    chain.hand,
    handDirection,
    damping,
    deltaSeconds,
    true,
  )

  // Apply shoulder spread after the contact pose, carrying the forearm and hand
  // with it. Do not compensate toward the device or reduce the requested angle.
  const parent = chain.upperarm.object.parent
  if (spreadDegrees !== 0 && parent) {
    const axis = scratch.spreadAxis.copy(spreadAxisWorld)
      .applyQuaternion(parent.getWorldQuaternion(scratch.spreadParentQuaternion).invert())
    const rotation = scratch.spreadRotation.setFromAxisAngle(
      axis,
      MathUtils.degToRad(spreadDegrees) * Math.sign(elbowPole[0]),
    )
    chain.upperarm.object.quaternion.premultiply(rotation)
    chain.upperarm.object.updateWorldMatrix(true, true)
  }
}

export function createPetAnimator(
  root: Object3D,
  targets: PetAnimatorTargets,
  options: { random?: () => number } = {},
): PetAnimator | undefined {
  const nodes = {} as Partial<NodeMap>

  REQUIRED_NODE_NAMES.forEach((name) => {
    const object = root.getObjectByName(name)
    if (!object) return

    nodes[name] = {
      object,
      basePosition: object.position.clone(),
      baseQuaternion: object.quaternion.clone(),
      baseScale: object.scale.clone(),
    }
  })

  const missingNodeNames = REQUIRED_NODE_NAMES.filter(name => !nodes[name])
  if (missingNodeNames.length > 0) {
    console.warn('Pet animation is disabled because required nodes are missing.', {
      missingNodeNames,
    })
    return undefined
  }

  const mouseHandAnchor = targets.mouseGroup.getObjectByName('mouseHandAnchor')
  if (!mouseHandAnchor) {
    console.warn('Pet animation is disabled because the mouse hand anchor is missing.')
    return undefined
  }

  const animatedNodes = nodes as NodeMap
  REQUIRED_NODE_NAMES.forEach((name) => {
    animatedNodes[name].object.position.copy(animatedNodes[name].basePosition)
    animatedNodes[name].object.quaternion.copy(animatedNodes[name].baseQuaternion)
    animatedNodes[name].object.scale.copy(animatedNodes[name].baseScale)
  })
  root.updateWorldMatrix(true, true)

  const {
    inputMode,
    pose,
    keyboard,
    mouse,
    head,
    breathing,
  } = MODEL_3D_CONFIG.pet.animation
  const strikeLiftMs = keyboard.strikeRiseMs + keyboard.strikeFallMs
  const strikeDurationMs = keyboard.strikeContactMs + strikeLiftMs
  const strikeLiftPeakRatio = keyboard.strikeRiseMs / strikeLiftMs
  animatedNodes.Spine02.object.position.y += pose.upperBodyLift
  animatedNodes.L_Upperarm.object.position.x -= pose.shoulderInward
  animatedNodes.L_Upperarm.object.position.x *= pose.armSpacingScale
  animatedNodes.L_Upperarm.object.position.y -= pose.shoulderDown
  animatedNodes.L_Upperarm.object.position.z -= pose.shoulderBackward
  animatedNodes.R_Upperarm.object.position.x += pose.shoulderInward
  animatedNodes.R_Upperarm.object.position.x *= pose.armSpacingScale
  animatedNodes.R_Upperarm.object.position.y -= pose.shoulderDown
  animatedNodes.R_Upperarm.object.position.z -= pose.shoulderBackward
  root.updateWorldMatrix(true, true)

  const leftArm = makeArmChain(
    animatedNodes.L_Upperarm,
    animatedNodes.L_Forearm,
    animatedNodes.L_Hand,
  )
  const rightArm = makeArmChain(
    animatedNodes.R_Upperarm,
    animatedNodes.R_Forearm,
    animatedNodes.R_Hand,
  )
  const pressedKeys: PressedKey[] = []
  const typingTrance = createTypingTrance(options.random)
  const navigationTargets = new Set(targets.keyboardNavigationTargets)
  let navigationAmount = 0
  let rightHandLeftTurnAmount = 0
  let forwardLeanPeak = 0
  let forwardLeanHoldUntil = 0
  const headPoseQuaternion = animatedNodes.Head.object.quaternion.clone()
  const keyboardRestPosition = new Vector3()
    .fromArray(targets.keyboardRestTarget.position)
  const keyboardLeftRestPosition = new Vector3()
    .fromArray(targets.keyboardLeftRestTarget.position)
  const keyboardRightRestPosition = new Vector3()
    .fromArray((targets.keyboardRightRestTarget ?? targets.keyboardRestTarget).position)
  const bodyDefaultPosition = new Vector3()
    .fromArray(targets.keyboardBodyDefaultTarget.position)
  const bodyTurnThresholdX
    = targets.keyboardBodyTurnThresholdTarget.position[0]
  const combinedLeftContact = new Vector3()
  const keyboardLeftContact = new Vector3()
  const keyboardRightContact = new Vector3()
  const blendedLeftContact = new Vector3()
  const leftContactWorld = new Vector3()
  const rightKeyboardContactWorld = new Vector3()
  const rightMouseContactWorld = new Vector3()
  const rightMouseButtonOffsetWorld = new Vector3()
  const rightMouseContactLocal = new Vector3()
  const rightContactWorld = new Vector3()
  const bodyTurnLocalTarget = new Vector3()
  const bodyTurnTargetWorld = new Vector3()
  const bodyTurnDirection = new Vector3()
  const spineWorldPosition = new Vector3()
  const inverseRootWorldQuaternion = new Quaternion()
  // Each animator owns its workspace. Calls consume these targets synchronously;
  // neither arm nor a second desktop/thumbnail renderer retains their references.
  const armSolveScratch = createArmSolveScratch()
  const rotationScratch = { target: new Quaternion(), rotation: new Quaternion(), euler: new Euler() }
  const shoulderSpreadAxis = new Vector3()
  const deviceRotationMatrix = new Matrix4()
  const createTypingTrack = (): TypingTrack => ({
    lastKeyPressedAt: Number.NEGATIVE_INFINITY,
    strikeStartedAt: Number.NEGATIVE_INFINITY,
    returnStartedAt: 0,
  })
  const combinedTypingTrack = createTypingTrack()
  const leftTypingTrack = createTypingTrack()
  const rightTypingTrack = createTypingTrack()
  const lastSidePressAt: Record<KeyboardSide, number> = {
    Left: Number.NEGATIVE_INFINITY,
    Right: Number.NEGATIVE_INFINITY,
  }
  const pressedMouseButtons = new Set<'Left' | 'Right' | 'Middle'>()
  let mouseEnabled = true
  let armPoseSettings = { ...DEFAULT_PET_ARM_POSE_SETTINGS }
  let mode: InputMode = 'KeyboardOnly'
  let keyboardOnlyBlend = 1
  let modeBlendFrom = 1
  let modeTransitionStartedAt = 0
  let mouseReturnStartedAt: number | undefined
  const mouseReturnStartWorld = new Vector3()
  let lastMouseMovedAt = Number.NEGATIVE_INFINITY
  let hasMousePosition = false
  let mouseX = 0
  let mouseY = 0
  let gazeBlend = 0
  let mouseStrikeStartedAt = Number.NEGATIVE_INFINITY
  let mouseStrikeActive = false
  let mouseStrikeButton: 'Left' | 'Right' | 'Middle' = 'Left'
  let initialized = false
  let disposed = false

  const getModeBlend = (timestamp: number): number => {
    const targetBlend = mode === 'KeyboardOnly' ? 1 : 0
    if (modeTransitionStartedAt === 0) return targetBlend

    const progress = MathUtils.clamp(
      (timestamp - modeTransitionStartedAt) / inputMode.transitionMs,
      0,
      1,
    )
    const easedProgress = progress * progress * (3 - 2 * progress)
    const blend = MathUtils.lerp(modeBlendFrom, targetBlend, easedProgress)
    if (progress >= 1) modeTransitionStartedAt = 0
    return blend
  }

  const setMode = (nextMode: InputMode, timestamp: number): void => {
    if (mode === nextMode) return

    keyboardOnlyBlend = getModeBlend(timestamp)
    modeBlendFrom = keyboardOnlyBlend
    modeTransitionStartedAt = timestamp
    mouseReturnStartedAt = nextMode === 'KeyboardMouse' && rightArm.contactInitialized ? timestamp : undefined
    if (mouseReturnStartedAt !== undefined) mouseReturnStartWorld.copy(rightArm.smoothedContactWorld)
    mode = nextMode
  }

  const activateTrack = (
    track: TypingTrack,
    key: string,
    target: KeyboardKeyTarget,
    pressedAt: number,
  ): void => {
    // Distinct held keys in one short chord share a strike. Anchor the window
    // to its first key so rolling input cannot extend the group indefinitely.
    const chord = key !== track.chordKey
      && pressedAt - track.strikeStartedAt < keyboard.strikeChordWindowMs
      && pressedKeys.some(entry => entry.key === track.chordKey)
    if (!chord) {
      track.chordKey = key
      // Historical per-input timing: a new stroke restarts contact immediately.
      track.strikeStartedAt = pressedAt
    }
    track.lastTarget = target
    track.lastKeyPressedAt = pressedAt
    track.returnStartedAt = 0
  }

  const getLastPressedKey = (side?: KeyboardSide): PressedKey | undefined => {
    for (let index = pressedKeys.length - 1; index >= 0; index -= 1) {
      const entry = pressedKeys[index]
      if (!side || entry.side === side) return entry
    }
    return undefined
  }

  const resolveTypingPose = (
    track: TypingTrack,
    activeKey: PressedKey | undefined,
    restPosition: Vector3,
    output: Vector3,
    timestamp: number,
    restHoverHeight: number = keyboard.restHoverHeight,
  ): TypingPose => {
    const strikeAge = timestamp - track.strikeStartedAt
    const typingTarget = activeKey?.target ?? track.lastTarget
    const isTyping = Boolean(typingTarget)
      && (
        Boolean(activeKey)
        || timestamp - track.lastKeyPressedAt < keyboard.typingIdleDelayMs
        || strikeAge < strikeDurationMs
      )

    if (isTyping && typingTarget) {
      track.returnStartedAt = 0
      output.fromArray(typingTarget.position)
      output.y += keyboard.contactOffset

      const impacting = strikeAge >= 0
        && strikeAge < keyboard.strikeContactMs
      if (
        strikeAge >= keyboard.strikeContactMs
        && strikeAge < strikeDurationMs
      ) {
        const strikeProgress = (strikeAge - keyboard.strikeContactMs) / strikeLiftMs
        const liftProgress = strikeProgress < strikeLiftPeakRatio
          ? strikeProgress / strikeLiftPeakRatio
          : (1 - strikeProgress) / (1 - strikeLiftPeakRatio)
        output.y += Math.sin(Math.PI * 0.5 * liftProgress)
          * keyboard.strikeLiftHeight
      }

      return {
        target: typingTarget,
        isTyping: true,
        easedReturn: 0,
        impacting,
      }
    }

    const returnTarget = track.lastTarget
    if (returnTarget) {
      if (track.returnStartedAt === 0) track.returnStartedAt = timestamp

      const returnProgress = MathUtils.clamp(
        (timestamp - track.returnStartedAt) / keyboard.returnDurationMs,
        0,
        1,
      )
      const easedReturn = returnProgress
        * returnProgress
        * (3 - 2 * returnProgress)

      output.fromArray(returnTarget.position).lerp(restPosition, easedReturn)
      output.y += MathUtils.lerp(
        keyboard.contactOffset,
        restHoverHeight,
        easedReturn,
      )
      output.y += Math.sin(Math.PI * returnProgress)
        * keyboard.returnLiftHeight

      if (returnProgress >= 1) {
        track.lastTarget = undefined
        track.returnStartedAt = 0
      }

      return {
        target: returnTarget,
        isTyping: false,
        easedReturn,
        impacting: false,
      }
    }

    output.copy(restPosition)
    output.y += restHoverHeight
    return { isTyping: false, easedReturn: 1, impacting: false }
  }

  const calculateBodyTurn = (
    localTarget: Vector3,
    rangeScale: number,
  ): number => {
    bodyTurnTargetWorld.copy(localTarget)
    targets.keyboardGroup.localToWorld(bodyTurnTargetWorld)
    animatedNodes.Spine02.object.getWorldPosition(spineWorldPosition)
    bodyTurnDirection.copy(bodyTurnTargetWorld).sub(spineWorldPosition)
    root.getWorldQuaternion(inverseRootWorldQuaternion).invert()
    bodyTurnDirection.applyQuaternion(inverseRootWorldQuaternion)

    const targetYawDegrees = MathUtils.radToDeg(Math.atan2(
      bodyTurnDirection.x,
      bodyTurnDirection.z,
    ))
    return MathUtils.clamp(
      targetYawDegrees * keyboard.bodyTurnStrength,
      -keyboard.bodyMaxTurnDegrees,
      keyboard.bodyMaxTurnDegrees,
    ) * rangeScale
  }

  const calculateForwardLean = (pose: TypingPose): number => {
    if (!pose.target) return 0

    const distanceProgress = MathUtils.clamp(
      (keyboard.farLeanStartZ - pose.target.position[2])
      / (keyboard.farLeanStartZ - keyboard.farLeanEndZ),
      0,
      1,
    )
    const activityWeight = pose.isTyping ? 1 : 1 - pose.easedReturn
    return distanceProgress * keyboard.farLeanDegrees * activityWeight
  }

  const setKeyPressed: PetAnimator['setKeyPressed'] = (key, pressed, target) => {
    if (disposed || !target) return

    const existingIndex = pressedKeys.findIndex(entry => entry.key === key)
    // Native auto-repeat is still a hold: do not queue strikes or reorder targets.
    if (pressed && existingIndex >= 0) return
    if (existingIndex >= 0) pressedKeys.splice(existingIndex, 1)

    if (pressed) {
      const pressedAt = performance.now()
      typingTrance.press(pressedAt)
      const side: KeyboardSide = target.typingSide
        ?? (target.position[0] <= inputMode.keyboardSplitX ? 'Left' : 'Right')
      pressedKeys.push({ key, target, side })
      activateTrack(combinedTypingTrack, key, target, pressedAt)
      activateTrack(
        side === 'Left' ? leftTypingTrack : rightTypingTrack,
        key,
        target,
        pressedAt,
      )

      lastSidePressAt[side] = pressedAt
      const oppositeSide: KeyboardSide = side === 'Left' ? 'Right' : 'Left'
      if (
        pressedAt - lastSidePressAt[oppositeSide]
        <= inputMode.dualSideWindowMs
      ) {
        setMode('KeyboardOnly', pressedAt)
      }
    }
  }

  const setMousePosition: PetAnimator['setMousePosition'] = (xRatio, yRatio) => {
    if (disposed) return

    const nextMouseX = Math.max(-1, Math.min(1, (0.5 - xRatio) * 2))
    const nextMouseY = Math.max(-1, Math.min(1, (0.5 - yRatio) * 2))
    const moved = !hasMousePosition
      || nextMouseX !== mouseX
      || nextMouseY !== mouseY

    mouseX = nextMouseX
    mouseY = nextMouseY
    hasMousePosition = true

    if (moved) {
      const movedAt = performance.now()
      lastMouseMovedAt = movedAt
      if (mouseEnabled) setMode('KeyboardMouse', movedAt)
    }
  }

  const setMouseButtonPressed: PetAnimator['setMouseButtonPressed'] = (
    button,
    pressed,
  ) => {
    if (disposed || !mouseEnabled) return

    if (!pressed) {
      pressedMouseButtons.delete(button)
      return
    }
    if (pressedMouseButtons.has(button)) return

    pressedMouseButtons.add(button)
    mouseStrikeStartedAt = performance.now()
    typingTrance.press(mouseStrikeStartedAt)
    mouseStrikeActive = true
    mouseStrikeButton = button
  }

  const resetMouseInput = () => {
    pressedMouseButtons.clear()
    mouseStrikeActive = false
    mouseStrikeStartedAt = Number.NEGATIVE_INFINITY
  }

  const setMouseEnabled: PetAnimator['setMouseEnabled'] = (enabled) => {
    if (disposed || mouseEnabled === enabled) return
    mouseEnabled = enabled
    resetMouseInput()
    // Mouse visibility owns the hand rest, never the independent cursor gaze.
    setMode('KeyboardOnly', performance.now())
  }

  const resetInput = () => {
    pressedKeys.length = 0
    leftArm.contactTransition.reset()
    rightArm.contactTransition.reset()
    mouseReturnStartedAt = undefined
    navigationAmount = 0
    rightHandLeftTurnAmount = 0
    forwardLeanPeak = 0
    forwardLeanHoldUntil = 0
    for (const track of [combinedTypingTrack, leftTypingTrack, rightTypingTrack]) {
      track.lastTarget = undefined
      track.lastKeyPressedAt = Number.NEGATIVE_INFINITY
      track.chordKey = undefined
      track.strikeStartedAt = Number.NEGATIVE_INFINITY
      track.returnStartedAt = 0
    }
    lastSidePressAt.Left = Number.NEGATIVE_INFINITY
    lastSidePressAt.Right = Number.NEGATIVE_INFINITY
    lastMouseMovedAt = Number.NEGATIVE_INFINITY
    hasMousePosition = false
    mouseX = 0
    mouseY = 0
    gazeBlend = 0
    resetMouseInput()
    typingTrance.reset()
    setMode('KeyboardOnly', performance.now())
  }

  const setArmPoseSettings: PetAnimator['setArmPoseSettings'] = (settings) => {
    if (disposed) return
    armPoseSettings = normalizePetArmPoseSettings(settings, armPoseSettings)
  }

  const update: PetAnimator['update'] = (deltaMilliseconds, timestamp) => {
    if (disposed) return

    if (
      mode === 'KeyboardMouse'
      && timestamp - lastMouseMovedAt >= inputMode.mouseIdleMs
    ) {
      setMode('KeyboardOnly', timestamp)
    }

    keyboardOnlyBlend = getModeBlend(timestamp)
    const deltaSeconds = Math.min(deltaMilliseconds / 1000, 0.1)
    const trance = typingTrance.update(timestamp)
    gazeBlend = MathUtils.damp(gazeBlend, hasMousePosition && timestamp - lastMouseMovedAt < inputMode.mouseIdleMs ? 1 : 0, head.damping, deltaSeconds)
    targets.keyboardGroup.updateWorldMatrix(true, false)
    getTransformedDirection(targets.keyboardGroup, WORLD_UP_COMPONENTS, shoulderSpreadAxis, deviceRotationMatrix)
    mouseHandAnchor.updateWorldMatrix(true, false)
    mouseHandAnchor.getWorldPosition(rightMouseContactWorld)
    rightMouseContactLocal.copy(rightMouseContactWorld)
    targets.keyboardGroup.worldToLocal(rightMouseContactLocal)

    const combinedPose = resolveTypingPose(
      combinedTypingTrack,
      getLastPressedKey(),
      keyboardRestPosition,
      combinedLeftContact,
      timestamp,
    )
    const leftPose = resolveTypingPose(
      leftTypingTrack,
      getLastPressedKey('Left'),
      keyboardLeftRestPosition,
      keyboardLeftContact,
      timestamp,
    )
    const rightPose = resolveTypingPose(
      rightTypingTrack,
      getLastPressedKey('Right'),
      mouseEnabled ? rightMouseContactLocal : keyboardRightRestPosition,
      keyboardRightContact,
      timestamp,
      mouseEnabled ? 0 : keyboard.restHoverHeight,
    )
    let mouseStrikeLift = 0
    let mouseStrikeOffsetWeight = 0
    if (mouseStrikeActive) {
      const strikeProgress = (timestamp - mouseStrikeStartedAt)
        / mouse.clickStrikeMs
      if (strikeProgress >= 1) {
        mouseStrikeActive = false
      } else if (strikeProgress >= 0 && !rightPose.isTyping) {
        mouseStrikeOffsetWeight = Math.sin(Math.PI * strikeProgress)
        mouseStrikeLift = mouseStrikeOffsetWeight * mouse.clickLiftHeight
      }
    }
    const breathingPhase = Math.sin((timestamp / breathing.periodMs) * Math.PI * 2)
    const snap = !initialized

    // Turn around the authored waist pivot, keeping the model and hips in place.
    // Shared contact identities cover native input; reuse the hand's hold/return
    // envelope so repeats and adjacent navigation keys do not restart the motion.
    const requestedNavigation = rightPose.target && navigationTargets.has(rightPose.target)
      ? keyboardOnlyBlend * (rightPose.isTyping ? 1 : 1 - rightPose.easedReturn)
      : 0
    navigationAmount = MathUtils.damp(navigationAmount, requestedNavigation, keyboard.navigationDamping, deltaSeconds)

    // Follow the right hand across the keyboard center, with the same smooth
    // hold/return envelope as navigation and no reach while it holds the mouse.
    const requestedLeftTurn = rightPose.target && !navigationTargets.has(rightPose.target)
      ? MathUtils.clamp(MathUtils.inverseLerp(keyboard.rightHandLeftTurnStartX, keyboard.rightHandLeftTurnEndX, rightPose.target.position[0]), 0, 1)
      * keyboardOnlyBlend * (rightPose.isTyping ? 1 : 1 - rightPose.easedReturn)
      : 0
    rightHandLeftTurnAmount = MathUtils.damp(rightHandLeftTurnAmount, requestedLeftTurn, keyboard.navigationDamping, deltaSeconds)

    bodyTurnLocalTarget.copy(bodyDefaultPosition)
    let bodyTurnRangeScale: number = keyboard.bodyDefaultTurnScale
    if (
      combinedPose.target
      && combinedPose.target.position[0] > bodyTurnThresholdX
    ) {
      if (combinedPose.isTyping) {
        bodyTurnLocalTarget.fromArray(combinedPose.target.position)
        bodyTurnRangeScale = keyboard.bodyRightTurnScale
      } else if (combinedPose.easedReturn < 1) {
        bodyTurnLocalTarget.fromArray(combinedPose.target.position)
          .lerp(bodyDefaultPosition, combinedPose.easedReturn)
        bodyTurnRangeScale = MathUtils.lerp(
          keyboard.bodyRightTurnScale,
          keyboard.bodyDefaultTurnScale,
          combinedPose.easedReturn,
        )
      }
    }

    const combinedBodyTurnDegrees = calculateBodyTurn(
      bodyTurnLocalTarget,
      bodyTurnRangeScale,
    )
    const defaultBodyTurnDegrees = calculateBodyTurn(
      bodyDefaultPosition,
      keyboard.bodyDefaultTurnScale,
    )
    const bodyTurnDegrees = MathUtils.lerp(
      combinedBodyTurnDegrees,
      defaultBodyTurnDegrees,
      keyboardOnlyBlend,
    )
    const combinedForwardLean = calculateForwardLean(combinedPose)
    const keyboardForwardLean = Math.max(
      calculateForwardLean(leftPose),
      calculateForwardLean(rightPose),
    )
    const requestedForwardLean = MathUtils.lerp(
      combinedForwardLean,
      keyboardForwardLean,
      keyboardOnlyBlend,
    )
    // Let hands follow each key while the torso holds a deeper reach briefly.
    // Decay from a fixed peak using elapsed time, never a per-frame multiplier.
    const leanReturn = MathUtils.clamp((timestamp - forwardLeanHoldUntil) / keyboard.farLeanReturnMs, 0, 1)
    const retainedForwardLean = forwardLeanPeak * (1 - leanReturn * leanReturn * (3 - 2 * leanReturn))
    if (requestedForwardLean >= retainedForwardLean) {
      forwardLeanPeak = requestedForwardLean
      forwardLeanHoldUntil = timestamp + keyboard.farLeanHoldMs
    }
    const forwardLeanDegrees = Math.max(requestedForwardLean, retainedForwardLean)

    dampQuaternion(
      animatedNodes.Spine02.object,
      makeTargetQuaternion(
        animatedNodes.Spine02,
        breathingPhase * breathing.spineDegrees
        + forwardLeanDegrees * (1 - trance.amount) * (1 - navigationAmount)
        - keyboard.navigationBackLeanDegrees * navigationAmount,
        MathUtils.lerp(
          bodyTurnDegrees + keyboard.rightHandLeftTurnDegrees * rightHandLeftTurnAmount,
          -keyboard.navigationTurnDegrees,
          navigationAmount,
        ),
        0,
        rotationScratch,
      ),
      keyboard.bodyTurnDamping,
      deltaSeconds,
      snap,
    )
    animatedNodes.Spine02.object.updateWorldMatrix(true, true)

    blendedLeftContact.copy(combinedLeftContact)
      .lerp(keyboardLeftContact, keyboardOnlyBlend)
    leftContactWorld.copy(blendedLeftContact)
    targets.keyboardGroup.localToWorld(leftContactWorld)
    // Impact response belongs to a settled hand, not travel between devices.
    const leftArmDamping = modeTransitionStartedAt === 0 && (combinedPose.impacting || leftPose.impacting)
      ? keyboard.strikeImpactDamping
      : keyboard.damping
    solveArm(
      armSolveScratch,
      root,
      leftArm,
      leftContactWorld,
      keyboard.elbowPole,
      pose.armBendAmount * armPoseSettings.petLeftArmBendPercent / 100,
      armPoseSettings.petLeftArmSpreadDegrees,
      shoulderSpreadAxis,
      leftArmDamping,
      deltaSeconds,
      snap,
    )

    rightKeyboardContactWorld.copy(keyboardRightContact)
    targets.keyboardGroup.localToWorld(rightKeyboardContactWorld)
    rightContactWorld.copy(rightMouseContactWorld)
      .lerp(rightKeyboardContactWorld, keyboardOnlyBlend)
    const returningToMouse = mouseReturnStartedAt !== undefined
    if (mouseReturnStartedAt !== undefined) {
      // Leave from the contact currently followed by the hand, not a typing
      // target that can keep rising/falling or change keys during the transfer.
      const progress = MathUtils.clamp((timestamp - mouseReturnStartedAt) / inputMode.transitionMs, 0, 1)
      const eased = progress * progress * (3 - 2 * progress)
      rightContactWorld.copy(mouseReturnStartWorld).lerp(rightMouseContactWorld, eased)
      if (progress >= 1) mouseReturnStartedAt = undefined
    }
    rightContactWorld.y += mouseStrikeLift
    if (mouseStrikeOffsetWeight > 0) {
      rightMouseButtonOffsetWorld.set(
        mouseStrikeButton === 'Middle'
          ? 0
          : mouseStrikeButton === 'Left'
            ? mouse.clickButtonOffset
            : -mouse.clickButtonOffset,
        0,
        0,
      )
      mouseHandAnchor.localToWorld(rightMouseButtonOffsetWorld)
      rightMouseButtonOffsetWorld.sub(rightMouseContactWorld)
        .multiplyScalar(mouseStrikeOffsetWeight)
      rightContactWorld.add(rightMouseButtonOffsetWorld)
    }
    const rightArmDamping = mouseStrikeLift > 0
      ? mouse.clickDamping
      : rightPose.impacting && keyboardOnlyBlend === 1
        ? keyboard.strikeImpactDamping
        : MathUtils.lerp(mouse.damping, keyboard.damping, keyboardOnlyBlend)
    solveArm(
      armSolveScratch,
      root,
      rightArm,
      rightContactWorld,
      keyboard.rightElbowPole,
      pose.armBendAmount * armPoseSettings.petRightArmBendPercent / 100,
      armPoseSettings.petRightArmSpreadDegrees,
      shoulderSpreadAxis,
      rightArmDamping,
      deltaSeconds,
      snap,
      returningToMouse || keyboardOnlyBlend === 0,
    )
    const mouseTrackingBlend = gazeBlend * (1 - trance.amount)
    // Keep the damped pose independent from the per-strike additive shake.
    animatedNodes.Head.object.quaternion.copy(headPoseQuaternion)
    dampQuaternion(
      animatedNodes.Head.object,
      makeTargetQuaternion(
        animatedNodes.Head,
        head.basePitchDegrees
        - trance.amount * MODEL_3D_CONFIG.pet.animation.typingTrance.backPitchDegrees
        - mouseY * head.pitchDegrees * mouseTrackingBlend
        - breathingPhase * breathing.headDegrees,
        mouseX * head.yawDegrees * mouseTrackingBlend,
        0,
        rotationScratch,
      ),
      head.damping,
      deltaSeconds,
      snap,
    )
    headPoseQuaternion.copy(animatedNodes.Head.object.quaternion)
    animatedNodes.Head.object.quaternion.multiply(degreesToQuaternion(
      0,
      trance.yawDegrees,
      trance.rollDegrees,
      rotationScratch.rotation,
      rotationScratch.euler,
    ))

    initialized = true
  }

  const dispose = () => {
    if (disposed) return
    resetInput()
    disposed = true
    REQUIRED_NODE_NAMES.forEach((name) => {
      animatedNodes[name].object.position.copy(animatedNodes[name].basePosition)
      animatedNodes[name].object.quaternion.copy(animatedNodes[name].baseQuaternion)
      animatedNodes[name].object.scale.copy(animatedNodes[name].baseScale)
    })
  }

  function setHeadScalePercent(percent: number): void {
    if (!Number.isFinite(percent)) return
    const head = animatedNodes.Head
    head.object.scale.copy(head.baseScale).multiplyScalar(Math.min(200, Math.max(25, percent)) / 100)
    head.object.updateWorldMatrix(true, true)
  }

  return {
    setHeadScalePercent,
    setMouseEnabled,
    resetMouseInput,
    resetInput,
    setArmPoseSettings,
    setKeyPressed,
    setMousePosition,
    setMouseButtonPressed,
    update,
    dispose,
  }
}
