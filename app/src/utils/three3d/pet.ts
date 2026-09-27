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

export interface PetAnimator {
  setHeadScalePercent: (percent: number) => void
  setMouseEnabled: (enabled: boolean) => void
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
}

type InputMode = 'KeyboardMouse' | 'KeyboardOnly'
type KeyboardSide = 'Left' | 'Right'

interface PressedKey {
  key: string
  target: KeyboardKeyTarget
  side: KeyboardSide
  pressedAt: number
}

interface TypingTrack {
  lastTarget?: KeyboardKeyTarget
  lastKeyPressedAt: number
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
const EPSILON = 0.0001

function degreesToQuaternion(x: number, y: number, z: number): Quaternion {
  return new Quaternion().setFromEuler(new Euler(
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
): Quaternion {
  return node.baseQuaternion.clone().multiply(degreesToQuaternion(x, y, z))
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
  }
}

function pointBoneAt(
  node: AnimatedNode,
  worldDirection: Vector3,
  damping: number,
  deltaSeconds: number,
  snap: boolean,
  rotationWeight = 1,
): void {
  const parent = node.object.parent
  if (!parent || worldDirection.lengthSq() < EPSILON) return

  const parentWorldQuaternion = parent.getWorldQuaternion(new Quaternion())
  const directionInParent = worldDirection.clone()
    .normalize()
    .applyQuaternion(parentWorldQuaternion.invert())
  const restDirectionInParent = BONE_AXIS.clone()
    .applyQuaternion(node.baseQuaternion)
    .normalize()
  const rotationFromRest = new Quaternion().setFromUnitVectors(
    restDirectionInParent,
    directionInParent,
  )
  const targetQuaternion = node.baseQuaternion.clone().slerp(
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

function getTransformedDirection(root: Object3D, direction: readonly number[]): Vector3 {
  const rotationMatrix = new Matrix4().extractRotation(root.matrixWorld)
  return new Vector3(direction[0], direction[1], direction[2])
    .transformDirection(rotationMatrix)
}

function solveArm(
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
  if (snap || !chain.contactInitialized || trackContactExactly) {
    chain.smoothedContactWorld.copy(contactWorld)
    chain.contactInitialized = true
  } else {
    const contactAlpha = 1 - Math.exp(-damping * deltaSeconds)
    chain.smoothedContactWorld.lerp(contactWorld, contactAlpha)
  }

  // World-space joint queries refresh their ancestor chain below. Refreshing
  // every sibling mesh here repeats the same work once for each arm.
  root.updateWorldMatrix(true, false)

  const shoulder = chain.upperarm.object.getWorldPosition(new Vector3())
  const shoulderToContact = chain.smoothedContactWorld.clone().sub(shoulder)
  if (shoulderToContact.lengthSq() < EPSILON) return

  const handDirection = shoulderToContact.clone().normalize()
  const armLength = chain.upperarmLength + chain.forearmLength
  const desiredWristReach = shoulderToContact.length() - chain.handLength * 0.65
  const minimumReach = armLength * 0.55
  const maximumReach = armLength * 0.94
  const reach = MathUtils.clamp(
    desiredWristReach,
    minimumReach,
    maximumReach,
  )
  const wristTarget = shoulder.clone().addScaledVector(handDirection, reach)
  const reachDirection = handDirection

  const poleDirection = getTransformedDirection(root, elbowPole)
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
  const elbowTarget = shoulder.clone()
    .addScaledVector(reachDirection, upperarmProjection)
    .addScaledVector(bendDirection, elbowOffset * bendAmount)

  const upperarmDirection = elbowTarget.sub(shoulder)

  pointBoneAt(
    chain.upperarm,
    upperarmDirection,
    damping,
    deltaSeconds,
    true,
  )
  chain.upperarm.object.updateWorldMatrix(true, true)

  const currentElbow = chain.forearm.object.getWorldPosition(new Vector3())
  pointBoneAt(
    chain.forearm,
    wristTarget.clone().sub(currentElbow),
    damping,
    deltaSeconds,
    true,
  )
  chain.forearm.object.updateWorldMatrix(true, true)

  pointBoneAt(
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
    const axis = spreadAxisWorld.clone()
      .applyQuaternion(parent.getWorldQuaternion(new Quaternion()).invert())
    const rotation = new Quaternion().setFromAxisAngle(
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
  const createTypingTrack = (): TypingTrack => ({
    lastKeyPressedAt: Number.NEGATIVE_INFINITY,
    strikeStartedAt: 0,
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
  let lastMouseMovedAt = Number.NEGATIVE_INFINITY
  let hasMousePosition = false
  let mouseX = 0
  let mouseY = 0
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
    mode = nextMode
  }

  const activateTrack = (
    track: TypingTrack,
    target: KeyboardKeyTarget,
    pressedAt: number,
  ): void => {
    track.lastTarget = target
    track.lastKeyPressedAt = pressedAt
    track.strikeStartedAt = pressedAt
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
    const typingTarget = activeKey?.target ?? track.lastTarget
    const isTyping = Boolean(typingTarget)
      && (
        Boolean(activeKey)
        || timestamp - track.lastKeyPressedAt < keyboard.typingIdleDelayMs
      )

    if (isTyping && typingTarget) {
      track.returnStartedAt = 0
      output.fromArray(typingTarget.position)
      output.y += keyboard.contactOffset

      const strikeAge = timestamp - track.strikeStartedAt
      const impacting = strikeAge >= 0
        && strikeAge < keyboard.strikeContactMs
      if (
        strikeAge >= keyboard.strikeContactMs
        && strikeAge < keyboard.strikeArcMs
      ) {
        const strikeProgress = MathUtils.clamp(
          (strikeAge - keyboard.strikeContactMs)
          / (keyboard.strikeArcMs - keyboard.strikeContactMs),
          0,
          1,
        )
        output.y += Math.sin(Math.PI * strikeProgress)
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

    const eventAt = performance.now()
    const existingIndex = pressedKeys.findIndex(entry => entry.key === key)
    if (existingIndex >= 0) pressedKeys.splice(existingIndex, 1)

    if (pressed) {
      const pressedAt = eventAt
      const side: KeyboardSide = target.position[0] <= inputMode.keyboardSplitX
        ? 'Left'
        : 'Right'
      pressedKeys.push({ key, target, side, pressedAt })
      activateTrack(combinedTypingTrack, target, pressedAt)
      activateTrack(
        side === 'Left' ? leftTypingTrack : rightTypingTrack,
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
    if (disposed || !mouseEnabled) return

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
      setMode('KeyboardMouse', movedAt)
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
    mouseStrikeActive = true
    mouseStrikeButton = button
  }

  const setMouseEnabled: PetAnimator['setMouseEnabled'] = (enabled) => {
    if (disposed || mouseEnabled === enabled) return

    mouseEnabled = enabled
    pressedMouseButtons.clear()
    mouseStrikeActive = false
    mouseStrikeStartedAt = Number.NEGATIVE_INFINITY
    lastMouseMovedAt = Number.NEGATIVE_INFINITY
    hasMousePosition = false
    mouseX = 0
    mouseY = 0
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
    targets.keyboardGroup.updateWorldMatrix(true, false)
    const shoulderSpreadAxis = getTransformedDirection(targets.keyboardGroup, [0, 1, 0])
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
    const forwardLeanDegrees = MathUtils.lerp(
      combinedForwardLean,
      keyboardForwardLean,
      keyboardOnlyBlend,
    )

    dampQuaternion(
      animatedNodes.Spine02.object,
      makeTargetQuaternion(
        animatedNodes.Spine02,
        breathingPhase * breathing.spineDegrees + forwardLeanDegrees,
        bodyTurnDegrees,
        0,
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
    const leftArmDamping = combinedPose.impacting || leftPose.impacting
      ? keyboard.strikeImpactDamping
      : keyboard.damping
    solveArm(
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
      : rightPose.impacting && keyboardOnlyBlend > 0
        ? keyboard.strikeImpactDamping
        : MathUtils.lerp(mouse.damping, keyboard.damping, keyboardOnlyBlend)
    solveArm(
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
      keyboardOnlyBlend <= 0.001,
    )
    const mouseTrackingBlend = 1 - keyboardOnlyBlend
    dampQuaternion(
      animatedNodes.Head.object,
      makeTargetQuaternion(
        animatedNodes.Head,
        head.basePitchDegrees
        - mouseY * head.pitchDegrees * mouseTrackingBlend
        - breathingPhase * breathing.headDegrees,
        mouseX * head.yawDegrees * mouseTrackingBlend,
        0,
      ),
      head.damping,
      deltaSeconds,
      snap,
    )

    initialized = true
  }

  const dispose = () => {
    if (disposed) return
    disposed = true

    pressedKeys.length = 0
    for (const track of [
      combinedTypingTrack,
      leftTypingTrack,
      rightTypingTrack,
    ]) {
      track.lastTarget = undefined
      track.lastKeyPressedAt = Number.NEGATIVE_INFINITY
      track.strikeStartedAt = 0
      track.returnStartedAt = 0
    }
    lastSidePressAt.Left = Number.NEGATIVE_INFINITY
    lastSidePressAt.Right = Number.NEGATIVE_INFINITY
    pressedMouseButtons.clear()
    mouseStrikeActive = false
    mouseStrikeStartedAt = Number.NEGATIVE_INFINITY
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
    setArmPoseSettings,
    setKeyPressed,
    setMousePosition,
    setMouseButtonPressed,
    update,
    dispose,
  }
}
