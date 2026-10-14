import type { Box3, Object3D } from 'three'

import {
  Euler,
  MathUtils,
  Matrix3,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three'

import type { HeadbuttRecoilSettings } from '@/config/headbuttRecoil'
import type { PetAnimationMode } from '@/config/petAnimation'
import type { PetArmPoseSettings } from '@/config/petArmPose'
import type { TypingMotionSettings } from '@/config/typingMotion'

import { DEFAULT_HEADBUTT_MAX_RADIUS_OFFSET, getHeadbuttReachRadius, normalizeHeadbuttMaxRadiusOffset } from '@/config/headbuttRadius'
import { MODEL_3D_CONFIG } from '@/config/model3d'
import { DEFAULT_PET_ARM_POSE_SETTINGS, normalizePetArmPoseSettings } from '@/config/petArmPose'
import { DEFAULT_TYPING_MOTION_SETTINGS, normalizeTypingMotionSettings } from '@/config/typingMotion'
import { getTypingReachAssistance, getTypingReachContractionScale, getTypingReachExtension, getTypingReachLeanScale, getTypingReachRadius } from '@/config/typingReach'

import type { HeadbuttTuning } from './headbutt'
import type { KeyboardKeyTarget } from './keyboard'

import { updateStretchCompensatedBoneMatrix } from './boneMatrix'
import { createHandContactTransition } from './handContactTransition'
import { createHeadbutt, getDeskBounds, getForeheadPoint, solveHeadbuttHit } from './headbutt'
import { createLegLift } from './legRig'
import { createShoulderConnection } from './shoulderConnection'
import { createTypingReachConstraint, solveReachStretch } from './typingReach'
import { createTypingTrance } from './typingTrance'

export interface PetAnimator {
  setAnimationMode: (mode: PetAnimationMode) => void
  setHeadbuttMaxRadiusOffset: (offset: number) => void
  setHeadbuttRecoilSettings: (settings: Partial<HeadbuttRecoilSettings>) => void
  setTypingMotionSettings: (settings: Partial<TypingMotionSettings>) => void
  setShoulderTorsoConnected: (enabled: boolean) => void
  setArmsDisabled: (right: boolean, left: boolean) => void
  isHeadbuttActive: () => boolean
  setHeadbuttTuning: (partial: Partial<HeadbuttTuning>) => void
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
  keyboardHeadbuttReachTarget?: KeyboardKeyTarget
  keyboardNavigationTargets?: readonly KeyboardKeyTarget[]
  keyboardGroup: Object3D
  keyboardLeftRestTarget: KeyboardKeyTarget
  keyboardRestTarget: KeyboardKeyTarget
  keyboardRightRestTarget?: KeyboardKeyTarget
  mouseGroup: Object3D
  desk?: Object3D
}

interface AnimatedNode {
  object: Object3D
  basePosition: Vector3
  baseQuaternion: Quaternion
  baseScale: Vector3
  baseMatrixAutoUpdate: boolean
  parentStretch?: number
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
  returnDelayStartedAt: number
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

// Inverse stretch precedes child rotation. Dividing local scale after rotation
// would shear the head/arms and change their thickness during a torso lean.
function updateNodeMatrix(node: AnimatedNode): void {
  updateStretchCompensatedBoneMatrix(node.object, node.baseMatrixAutoUpdate, node.parentStretch)
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
  if (node.parentStretch !== undefined) updateNodeMatrix(node)
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
  elbowPoleWorld?: Vector3,
  typingReachScale = 1,
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
  const maximumReach = armLength * MODEL_3D_CONFIG.pet.animation.keyboard.armReachRatio
  const ordinaryReach = MathUtils.clamp(
    desiredWristReach,
    minimumReach,
    maximumReach,
  )
  // Contract every ordinary typing pose, including those already below the
  // maximum or at the near-reach floor. Preserve rigid bones and elbow plane.
  const reach = Math.max(
    Math.abs(chain.upperarmLength - chain.forearmLength) + EPSILON,
    ordinaryReach * typingReachScale,
  )
  const wristTarget = scratch.wristTarget.copy(shoulder).addScaledVector(handDirection, reach)
  const reachDirection = handDirection

  const poleDirection = elbowPoleWorld
    ? scratch.poleDirection.copy(elbowPoleWorld)
    : getTransformedDirection(root, elbowPole, scratch.poleDirection, scratch.rotationMatrix)
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
    if (chain.upperarm.parentStretch !== undefined) updateNodeMatrix(chain.upperarm)
    chain.upperarm.object.updateWorldMatrix(true, true)
  }
}

function getRestingArmReach(chain: ArmChain, side: 1 | -1 = 1): number {
  const settings = MODEL_3D_CONFIG.pet.animation.headbuttBrace
  const bend = MathUtils.degToRad(MathUtils.clamp(side === 1 ? settings.leftRestBendDegrees : settings.rightRestBendDegrees, 0, 45))
  return Math.sqrt(chain.upperarmLength ** 2 + chain.forearmLength ** 2
    + 2 * chain.upperarmLength * chain.forearmLength * Math.cos(bend))
}

/** Exact two-bone contact for fixed tabletop grips. */
function solveArmAtContact(scratch: ArmSolveScratch, root: Object3D, chain: ArmChain, contact: Vector3, side: 1 | -1 = 1, elbowPoleWorld?: Vector3, recoveryAmount = 0): void {
  root.updateWorldMatrix(true, false)
  chain.upperarm.object.getWorldPosition(scratch.shoulder)
  const direction = scratch.shoulderToContact.copy(contact).sub(scratch.shoulder)
  if (direction.lengthSq() < EPSILON) return
  const distance = direction.length()
  direction.normalize()
  // A fixed desk point can exceed bent-arm reach as the torso rises. Release
  // that point progressively during final recovery instead of locking straight.
  const maximumReach = MathUtils.lerp(chain.upperarmLength + chain.forearmLength - EPSILON, getRestingArmReach(chain, side), MathUtils.clamp(recoveryAmount, 0, 1))
  const reach = MathUtils.clamp(distance, Math.abs(chain.upperarmLength - chain.forearmLength) + EPSILON, maximumReach)
  const wrist = scratch.wristTarget.copy(scratch.shoulder).addScaledVector(direction, reach)
  const settings = MODEL_3D_CONFIG.pet.animation.headbuttBrace
  const pole = elbowPoleWorld
    ? scratch.poleDirection.copy(elbowPoleWorld)
    : getTransformedDirection(root, side === 1 ? settings.leftElbowPole : settings.rightElbowPole, scratch.poleDirection, scratch.rotationMatrix)
  pole.addScaledVector(direction, -pole.dot(direction))
  if (pole.lengthSq() < EPSILON) pole.copy(WORLD_UP).addScaledVector(direction, -WORLD_UP.dot(direction))
  if (pole.lengthSq() < EPSILON) pole.set(1, 0, 0)
  pole.normalize()
  const projection = (chain.upperarmLength ** 2 - chain.forearmLength ** 2 + reach ** 2) / (2 * reach)
  const height = Math.sqrt(Math.max(0, chain.upperarmLength ** 2 - projection ** 2))
  const elbow = scratch.elbowTarget.copy(scratch.shoulder).addScaledVector(direction, projection).addScaledVector(pole, height)
  pointBoneAt(scratch.bone, chain.upperarm, elbow.sub(scratch.shoulder), 0, 0, true)
  chain.upperarm.object.updateWorldMatrix(true, true)
  chain.forearm.object.getWorldPosition(scratch.currentElbow)
  const forearmDirection = scratch.forearmDirection.copy(wrist).sub(scratch.currentElbow)
  pointBoneAt(scratch.bone, chain.forearm, forearmDirection, 0, 0, true)
  chain.forearm.object.updateWorldMatrix(true, true)
  pointBoneAt(scratch.bone, chain.hand, forearmDirection, 0, 0, true)
  chain.hand.object.getWorldPosition(chain.smoothedContactWorld)
  chain.contactInitialized = true
  chain.contactTransition.reset()
}

export function createPetAnimator(
  root: Object3D,
  targets: PetAnimatorTargets,
  options: { random?: () => number, now?: () => number } = {},
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
      baseMatrixAutoUpdate: object.matrixAutoUpdate,
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
  const now = options.now ?? (() => performance.now())
  const headbutt = createHeadbutt({}, options.random)
  let headbuttChordKey: string | undefined
  let headbuttChordStartedAt = Number.NEGATIVE_INFINITY
  const foreheadPoint = getForeheadPoint(root, animatedNodes.Head.object)
  const legLift = createLegLift(root, animatedNodes.Spine02)
  const shoulderConnection = createShoulderConnection(root)
  const legReachCenter = new Vector3()
  const legReachReference = new Vector3()
  const legReachTarget = new Vector3()
  const legReachNormal = new Vector3()
  const legReachNormalMatrix = new Matrix3()
  const legTurnQuaternion = new Quaternion()
  const legTurnEuler = new Euler(0, 0, 0, 'YXZ')
  const getLegReachRatio = (target: KeyboardKeyTarget): number => {
    const reference = targets.keyboardHeadbuttReachTarget ?? targets.keyboardBodyDefaultTarget
    root.getWorldPosition(legReachCenter)
    targets.keyboardGroup.worldToLocal(legReachCenter)
    legReachCenter.y = reference.position[1]
    targets.keyboardGroup.localToWorld(legReachCenter)
    legReachReference.fromArray(reference.position)
    targets.keyboardGroup.localToWorld(legReachReference)
    const radius = legReachCenter.distanceTo(legReachReference)
    legReachTarget.fromArray(target.position)
    targets.keyboardGroup.localToWorld(legReachTarget)
    legReachTarget.sub(legReachCenter)
    legReachNormal.set(0, 1, 0).applyMatrix3(legReachNormalMatrix.getNormalMatrix(targets.keyboardGroup.matrixWorld)).normalize()
    legReachTarget.addScaledVector(legReachNormal, -legReachTarget.dot(legReachNormal))
    return radius > EPSILON ? MathUtils.clamp(legReachTarget.length() / radius, 0, 1) : 0
  }
  let animationMode: PetAnimationMode = 'default'
  let rightArmDisabled = false
  let leftArmDisabled = false
  let braceSession = 0
  let rightRestEntryStartedAt = Number.NEGATIVE_INFINITY
  let hitCycle = -1
  let hitStretch = 1
  let headbuttApplied = false
  let recoilApplied = false
  const braceLeft = new Vector3()
  const braceRight = new Vector3()
  const braceLeftFrom = new Vector3()
  const braceRightFrom = new Vector3()
  const braceLeftLocal = new Vector3()
  const braceRightLocal = new Vector3()
  const braceDeskMatrix = new Matrix4()
  const braceKeyboardMatrix = new Matrix4()
  const braceParentMatrix = new Matrix4()
  const braceHeadScale = new Vector3()
  const hitSpineFrom = new Quaternion()
  const hitHeadFrom = new Quaternion()
  const hitSpineGoal = new Quaternion()
  const hitHeadGoal = new Quaternion()
  let hitStretchFrom = 1
  let hitStretchGoal = 1
  let hitRetargetAt = Number.NEGATIVE_INFINITY
  let hitRetargetMs = headbutt.tuning.gripMs
  const leftBraceQuaternions = [leftArm.upperarm, leftArm.forearm, leftArm.hand].map(node => node.object.quaternion.clone())
  const rightBraceQuaternions = [rightArm.upperarm, rightArm.forearm, rightArm.hand].map(node => node.object.quaternion.clone())
  const leftReturnQuaternions = leftBraceQuaternions.map(quaternion => quaternion.clone())
  const rightReturnQuaternions = rightBraceQuaternions.map(quaternion => quaternion.clone())
  const rightShoulderRecoveryQuaternions = rightBraceQuaternions.map(quaternion => quaternion.clone())
  let restoringRightShoulder = false
  let rightShoulderRecoveryStartedAt = 0
  let rightShoulderRecoveryFrom = 0
  let rightShoulderAttachment = 0
  let returningArms = false
  let returnGripStart = 1
  const restSpineQuaternion = animatedNodes.Spine02.object.quaternion.clone()
  const spinePoseQuaternion = restSpineQuaternion.clone()
  const braceRestQuaternion = restSpineQuaternion.clone()
  let braceRestStretch = 1
  const hitSpineQuaternion = new Quaternion()
  const hitHeadQuaternion = new Quaternion()
  const effectiveHitHeadQuaternion = new Quaternion()
  const spineAdditiveBaseQuaternion = new Quaternion()
  const holdBreathingAxis = new Vector3(1, 0, 0)
  const braceLeftElbowPole = new Vector3()
  const braceRightElbowPole = new Vector3()
  const braceClearanceElbowPole = new Vector3()
  const braceElbowPoleMatrix = new Matrix4()
  const recoveryDeltaQuaternion = new Quaternion()
  const recoverySpineAxis = new Vector3(1, 0, 0)
  const recoveryHeadAxis = new Vector3(1, 0, 0)
  let recoverySpineShare = 0
  let recoveryHeadShare = 0
  const candidateShoulder = new Vector3()
  const leftGripDirection = new Vector3()
  const relaxedLeftGripBase = new Vector3()
  const relaxedLeftGripTarget = new Vector3()
  let leftRestDeskBounds: Box3 | undefined
  const leftRestShoulderLocal = new Vector3()
  const leftRestSurfaceNormal = new Vector3()
  const leftRestHandDirection = new Vector3()
  const leftRestNormalMatrix = new Matrix3()
  const leftRestCandidateDirection = new Vector3()
  const leftRestOffsetDirection = new Vector3()
  let leftRestNormalReach = 0
  let leftRestPlanarReach = 0
  const fixedRestShoulderQuaternion = new Quaternion()
  const fixedRestBaseShoulder = new Vector3()
  const fixedRestReachLimits = [0, 0]
  const recoilCandidateQuaternion = new Quaternion()
  const desiredHitWorld = new Vector3()
  const desiredHitParent = new Vector3()
  const typingReach = createTypingReachConstraint(root, targets.keyboardGroup, targets.keyboardRestTarget.position[1])
  const headbuttReachNormal = typingReach.normal
  const headbuttReachPoint = new Vector3()
  const headbuttContactNormal = new Vector3()
  const headbuttContactMatrix = new Matrix3()
  let headbuttReachRadius = Number.POSITIVE_INFINITY
  let headbuttMaxRadiusOffset = DEFAULT_HEADBUTT_MAX_RADIUS_OFFSET
  let headbuttRadiusChanged = false
  const headOffset = animatedNodes.Head.basePosition.clone()
  const leftShoulderPosition = animatedNodes.L_Upperarm.object.position.clone()
  const rightShoulderPosition = animatedNodes.R_Upperarm.object.position.clone()
  const braceLeftShoulderPosition = leftShoulderPosition.clone()
  const braceRightShoulderPosition = rightShoulderPosition.clone()
  const braceSettings = MODEL_3D_CONFIG.pet.animation.headbuttBrace
  const braceShoulderSpacing = braceSettings.shoulderSpacingScale
  braceLeftShoulderPosition.x = (animatedNodes.L_Upperarm.basePosition.x - pose.shoulderInward) * braceShoulderSpacing
  braceLeftShoulderPosition.y -= braceSettings.shoulderDownOffset
  braceLeftShoulderPosition.z -= braceSettings.shoulderBackwardOffset
  // Keep the right shoulder close to the torso while the hands rest on the desk.
  braceRightShoulderPosition.x = (animatedNodes.R_Upperarm.basePosition.x + pose.shoulderInward) * braceSettings.rightShoulderSpacingScale
  braceRightShoulderPosition.y -= braceSettings.rightShoulderDownOffset
  braceRightShoulderPosition.z -= braceSettings.rightShoulderBackwardOffset

  const setTorsoStretch = (stretch: number, shoulderAmount = 0, rightShoulderAmount = shoulderAmount) => {
    const spine = animatedNodes.Spine02
    spine.object.scale.copy(spine.baseScale)
    spine.object.scale.y *= stretch
    legLift.setParentStretch(stretch)
    if (!leftArmDisabled) animatedNodes.L_Upperarm.object.position.copy(leftShoulderPosition).lerp(braceLeftShoulderPosition, shoulderAmount)
    if (!rightArmDisabled) animatedNodes.R_Upperarm.object.position.copy(rightShoulderPosition).lerp(braceRightShoulderPosition, rightShoulderAmount)
    rightShoulderAttachment = rightShoulderAmount
    for (const node of [animatedNodes.Head, animatedNodes.L_Upperarm, animatedNodes.R_Upperarm]) {
      if ((node === animatedNodes.L_Upperarm && leftArmDisabled) || (node === animatedNodes.R_Upperarm && rightArmDisabled)) continue
      node.parentStretch = stretch === 1 ? undefined : stretch
      updateNodeMatrix(node)
    }
    spine.object.updateWorldMatrix(true, true)
  }

  const getRestTarget = (chain: ArmChain, shoulderWorld: Vector3, output: Vector3, side: 1 | -1 = 1): boolean => {
    const desk = targets.desk
    const bounds = leftRestDeskBounds
    if (!desk || !bounds || bounds.isEmpty()) return false
    const settings = MODEL_3D_CONFIG.pet.animation.headbuttBrace
    const elements = desk.matrixWorld.elements
    const heightScale = Math.max(EPSILON, Math.hypot(elements[4], elements[5], elements[6]))
    const depthScale = Math.max(EPSILON, Math.hypot(elements[8], elements[9], elements[10]))
    const inset = Math.min(settings.leftSurfaceInset / depthScale, (bounds.max.z - bounds.min.z) / 2)
    const minZ = bounds.min.z + inset
    const maxZ = bounds.max.z - inset
    const restHeight = bounds.max.y + chain.forearmLength * settings.leftSurfaceLiftRatio / heightScale
    leftRestSurfaceNormal.set(0, 1, 0).applyMatrix3(leftRestNormalMatrix.getNormalMatrix(desk.matrixWorld)).normalize()
    relaxedLeftGripBase.set(0, restHeight, 0)
    desk.localToWorld(relaxedLeftGripBase)
    const armLength = getRestingArmReach(chain, side)
    leftRestNormalReach = MathUtils.clamp(relaxedLeftGripBase.sub(shoulderWorld).dot(leftRestSurfaceNormal), -armLength, armLength)
    leftRestPlanarReach = Math.sqrt(Math.max(0, armLength ** 2 - leftRestNormalReach ** 2))
    const diagonal = MathUtils.degToRad(side === 1 ? settings.leftRestDiagonalDegrees : settings.rightRestDiagonalDegrees)
    const sideOffset = side === 1 ? headbutt.tuning.leftGripSideOffset : settings.rightRestSideOffset
    leftRestHandDirection.set(0, 0, 1).transformDirection(root.matrixWorld).multiplyScalar(Math.cos(diagonal) * armLength).addScaledVector(leftGripDirection, side * (Math.sin(diagonal) * armLength + (side === 1 ? 0 : sideOffset)))
    leftRestHandDirection.addScaledVector(leftRestSurfaceNormal, -leftRestHandDirection.dot(leftRestSurfaceNormal))
    if (leftRestHandDirection.lengthSq() < EPSILON) leftRestHandDirection.set(0, 0, 1).transformDirection(desk.matrixWorld)
    leftRestHandDirection.normalize()
    let bestError = Infinity
    for (const angle of settings.leftRestSearchDegrees) {
      leftRestCandidateDirection.copy(leftRestHandDirection).applyAxisAngle(leftRestSurfaceNormal, MathUtils.degToRad(angle * side))
      relaxedLeftGripTarget.copy(shoulderWorld)
        .addScaledVector(leftRestSurfaceNormal, leftRestNormalReach)
        .addScaledVector(leftRestCandidateDirection, leftRestPlanarReach)
      leftRestShoulderLocal.copy(relaxedLeftGripTarget)
      desk.worldToLocal(leftRestShoulderLocal)
      const outsideX = leftRestShoulderLocal.x - MathUtils.clamp(leftRestShoulderLocal.x, bounds.min.x, bounds.max.x)
      const outsideZ = leftRestShoulderLocal.z - MathUtils.clamp(leftRestShoulderLocal.z, minZ, maxZ)
      const error = outsideX ** 2 + outsideZ ** 2
      if (error < bestError) {
        bestError = error
        output.copy(relaxedLeftGripTarget)
      }
      if (error <= EPSILON ** 2) break
    }
    if (side === 1) {
      // Move the baseline coordinate itself; the offset does not rotate or
      // renormalize the hand target onto the initial-bend reach circle.
      leftRestOffsetDirection.copy(leftGripDirection)
        .addScaledVector(leftRestSurfaceNormal, -leftGripDirection.dot(leftRestSurfaceNormal))
      if (leftRestOffsetDirection.lengthSq() >= EPSILON) {
        output.addScaledVector(leftRestOffsetDirection.normalize(), sideOffset)
      }
      desk.worldToLocal(output)
      output.set(MathUtils.clamp(output.x, bounds.min.x, bounds.max.x), restHeight, MathUtils.clamp(output.z, minZ, maxZ))
      desk.localToWorld(output)
      const maximumReach = chain.upperarmLength + chain.forearmLength - EPSILON
      if (shoulderWorld.distanceTo(output) > maximumReach) {
        relaxedLeftGripTarget.copy(output)
        relaxedLeftGripBase.copy(shoulderWorld)
        desk.worldToLocal(relaxedLeftGripBase)
        relaxedLeftGripBase.set(
          MathUtils.clamp(relaxedLeftGripBase.x, bounds.min.x, bounds.max.x),
          restHeight,
          MathUtils.clamp(relaxedLeftGripBase.z, minZ, maxZ),
        )
        desk.localToWorld(relaxedLeftGripBase)
        if (shoulderWorld.distanceTo(relaxedLeftGripBase) <= maximumReach) {
          // The segment stays on the desktop; shorten only an impossible offset.
          let low = 0
          let high = 1
          for (let step = 0; step < 12; step += 1) {
            const amount = (low + high) / 2
            output.copy(relaxedLeftGripBase).lerp(relaxedLeftGripTarget, amount)
            if (shoulderWorld.distanceTo(output) <= maximumReach) low = amount
            else high = amount
          }
          output.copy(relaxedLeftGripBase).lerp(relaxedLeftGripTarget, low)
        } else {
          output.copy(relaxedLeftGripBase)
        }
      }
    }
    return true
  }

  const getCompactShoulderWorld = (position: Vector3, output: Vector3) => {
    const spine = animatedNodes.Spine02.object
    output.copy(position).multiply(spine.scale).applyQuaternion(spine.quaternion).add(spine.position)
    spine.parent!.localToWorld(output)
  }

  const captureBrace = () => {
    const left = leftArm.hand.object.getWorldPosition(braceLeftFrom)
    const right = rightArm.hand.object.getWorldPosition(braceRightFrom)
    const desk = targets.desk
    leftRestDeskBounds = desk ? getDeskBounds(desk) : undefined
    // Rest on the desktop, retaining a gentle preference toward the pet's left.
    leftGripDirection.set(Math.sign(leftShoulderPosition.x - rightShoulderPosition.x) || 1, 0, 0)
      .transformDirection(root.matrixWorld)
    getCompactShoulderWorld(braceLeftShoulderPosition, candidateShoulder)
    if (!getRestTarget(leftArm, candidateShoulder, braceLeft)) braceLeft.copy(left)
    getCompactShoulderWorld(braceRightShoulderPosition, candidateShoulder)
    if (mouseEnabled || !getRestTarget(rightArm, candidateShoulder, braceRight, -1)) braceRight.copy(right)
    for (const [chain, grip] of [[leftArm, braceLeft], [rightArm, braceRight]] as const) {
      chain.upperarm.object.getWorldPosition(candidateShoulder)
      const distance = candidateShoulder.distanceTo(grip)
      const reach = chain.upperarmLength + chain.forearmLength - EPSILON
      // An impossible desk placement cannot be made into real contact by
      // deforming an arm. Retain the nearest safe point and the same fixed grip.
      if (distance > reach) grip.sub(candidateShoulder).multiplyScalar(reach / distance).add(candidateShoulder)
    }
    braceLeftLocal.copy(braceLeft)
    braceRightLocal.copy(braceRight)
    if (desk) {
      desk.worldToLocal(braceLeftLocal)
      desk.worldToLocal(braceRightLocal)
      braceDeskMatrix.copy(desk.matrixWorld)
    }
    targets.keyboardGroup.updateWorldMatrix(true, false)
    braceKeyboardMatrix.copy(targets.keyboardGroup.matrixWorld)
    animatedNodes.Spine02.object.parent!.updateWorldMatrix(true, false)
    braceParentMatrix.copy(animatedNodes.Spine02.object.parent!.matrixWorld)
    braceHeadScale.copy(animatedNodes.Head.object.scale)
    for (const [index, node] of [leftArm.upperarm, leftArm.forearm, leftArm.hand].entries()) leftBraceQuaternions[index].copy(node.object.quaternion)
    for (const [index, node] of [rightArm.upperarm, rightArm.forearm, rightArm.hand].entries()) rightBraceQuaternions[index].copy(node.object.quaternion)
    restSpineQuaternion.copy(recoilApplied ? spinePoseQuaternion : animatedNodes.Spine02.object.quaternion)
    braceRestQuaternion.copy(restSpineQuaternion)
    braceRestStretch = animatedNodes.Spine02.object.scale.y / animatedNodes.Spine02.baseScale.y
  }

  const updateBraceGeometry = (): boolean => {
    const desk = targets.desk
    desk?.updateWorldMatrix(true, false)
    const parent = animatedNodes.Spine02.object.parent!
    parent.updateWorldMatrix(true, false)
    const changed = Boolean(desk && !braceDeskMatrix.equals(desk.matrixWorld))
      || !braceKeyboardMatrix.equals(targets.keyboardGroup.matrixWorld)
      || !braceParentMatrix.equals(parent.matrixWorld)
      || !braceHeadScale.equals(animatedNodes.Head.object.scale)
    if (desk) {
      // The captured address belongs to the desk, never to a moving shoulder.
      for (const [local, world] of [[braceLeftLocal, braceLeft], [braceRightLocal, braceRight]] as const) {
        world.copy(local)
        desk.localToWorld(world)
      }
      braceDeskMatrix.copy(desk.matrixWorld)
    }
    braceKeyboardMatrix.copy(targets.keyboardGroup.matrixWorld)
    braceParentMatrix.copy(parent.matrixWorld)
    braceHeadScale.copy(animatedNodes.Head.object.scale)
    return changed
  }

  const blendBrace = (chain: ArmChain, from: Quaternion[], amount: number) => {
    for (const [index, node] of [chain.upperarm, chain.forearm, chain.hand].entries()) {
      node.object.quaternion.slerp(from[index], amount)
      if (node.parentStretch !== undefined) updateNodeMatrix(node)
      node.object.updateWorldMatrix(true, false)
    }
  }

  const canReachFixedRest = (spineQuaternion: Quaternion, stretch: number, attachmentAmount: number, reachLimits?: readonly number[]): boolean => {
    const spine = animatedNodes.Spine02
    for (let side = 0; side < (mouseEnabled ? 1 : 2); side += 1) {
      if (side === 0 ? leftArmDisabled : rightArmDisabled) continue
      const chain = side === 0 ? leftArm : rightArm
      const shoulderPosition = side === 0 ? braceLeftShoulderPosition : braceRightShoulderPosition
      const contact = side === 0 ? braceLeft : braceRight
      if (!reachLimits) chain.upperarm.object.getWorldPosition(fixedRestBaseShoulder)
      const reach = reachLimits?.[side] ?? Math.max(chain.upperarmLength + chain.forearmLength - EPSILON, fixedRestBaseShoulder.distanceTo(contact)) + EPSILON
      candidateShoulder.copy(chain.upperarm.object.position).lerp(shoulderPosition, attachmentAmount)
      candidateShoulder.y *= stretch
      candidateShoulder.multiply(spine.baseScale).applyQuaternion(spineQuaternion).add(spine.object.position)
      candidateShoulder.applyMatrix4(spine.object.parent!.matrixWorld)
      if (candidateShoulder.distanceTo(contact) > reach) return false
    }
    return true
  }

  const calculateHit = (target: KeyboardKeyTarget) => {
    const spine = animatedNodes.Spine02
    const parent = spine.object.parent!
    desiredHitWorld.fromArray(target.position)
    targets.keyboardGroup.localToWorld(desiredHitWorld)
    let reachDistanceRatio = 0
    let extendedReachAmount = 0
    let radialReachAmount = 0
    typingReach.update()
    headbuttReachRadius = getHeadbuttReachRadius(headbuttMaxRadiusOffset)
    {
      // Every direction uses the same character-centered circle. Key identity
      // and keyboard-local forward depth do not classify the reachable area.
      const distance = typingReach.projectedDistance(desiredHitWorld)
      extendedReachAmount = getTypingReachExtension(headbuttMaxRadiusOffset, distance)
      radialReachAmount = getTypingReachAssistance(headbuttMaxRadiusOffset, distance)
      if (headbuttReachRadius > EPSILON) {
        reachDistanceRatio = MathUtils.clamp(distance / headbuttReachRadius, 0, 1)
      }
      typingReach.clampWorldPoint(desiredHitWorld, headbuttReachRadius)
    }
    desiredHitParent.copy(desiredHitWorld)
    parent.worldToLocal(desiredHitParent).sub(spine.object.position)
    // Transform the plane's normal as a covector. Its length converts the
    // world-space height tolerance into the solver's parent-space units.
    headbuttContactNormal.copy(headbuttReachNormal).applyMatrix3(
      headbuttContactMatrix.setFromMatrix4(parent.matrixWorld).transpose(),
    )
    const contactHeightScale = Math.max(EPSILON, headbuttContactNormal.length())
    headbuttContactNormal.divideScalar(contactHeightScale)
    // These world-space limits do not change during the pose search. Cache
    // them once per hit instead of refreshing the same bone ancestors for
    // each candidate and each interpolated contact check.
    for (const [side, chain] of [leftArm, rightArm].entries()) {
      chain.upperarm.object.getWorldPosition(fixedRestBaseShoulder)
      fixedRestReachLimits[side] = Math.max(chain.upperarmLength + chain.forearmLength - EPSILON, fixedRestBaseShoulder.distanceTo(side === 0 ? braceLeft : braceRight)) + EPSILON
    }
    const result = solveHeadbuttHit({
      targetInSpineParent: desiredHitParent,
      reachDistanceRatio,
      extendedReachAmount,
      radialReachAmount,
      prioritizeContactHeight: reachDistanceRatio <= headbutt.tuning.nearContactDepthRatio,
      contactNormalInSpineParent: headbuttContactNormal,
      contactHeightTolerance: headbutt.tuning.contactHeightTolerance / contactHeightScale,
      forehead: foreheadPoint,
      headScale: animatedNodes.Head.object.scale,
      headOffset,
      spineScale: spine.baseScale,
      spineBaseQuaternion: spine.baseQuaternion,
      headBaseQuaternion: animatedNodes.Head.baseQuaternion,
      restSpineQuaternion,
    }, headbutt.tuning, (spineQuaternion, stretch, foreheadOffset) => {
      if (Number.isFinite(headbuttReachRadius)) {
        headbuttReachPoint.copy(foreheadOffset).add(spine.object.position)
        headbuttReachPoint.applyMatrix4(parent.matrixWorld)
        if (!typingReach.containsWorldPoint(headbuttReachPoint, headbuttReachRadius, EPSILON)) return false
      }
      for (let step = 1; step <= 4; step += 1) {
        const amount = step / 4
        fixedRestShoulderQuaternion.copy(restSpineQuaternion).slerp(spineQuaternion, amount)
        if (!canReachFixedRest(fixedRestShoulderQuaternion, MathUtils.lerp(braceRestStretch, stretch, amount), amount, fixedRestReachLimits)) return false
      }
      return true
    })
    hitSpineQuaternion.copy(result.spineQuaternion)
    hitHeadQuaternion.copy(result.headQuaternion)
    hitStretch = result.stretch
  }

  const measureRecoveryRotation = (rest: Quaternion, hit: Quaternion, axis?: Vector3) => {
    recoveryDeltaQuaternion.copy(rest).invert().multiply(hit).normalize()
    if (recoveryDeltaQuaternion.w < 0) {
      recoveryDeltaQuaternion.set(
        -recoveryDeltaQuaternion.x,
        -recoveryDeltaQuaternion.y,
        -recoveryDeltaQuaternion.z,
        -recoveryDeltaQuaternion.w,
      )
    }
    const angle = 2 * Math.acos(MathUtils.clamp(recoveryDeltaQuaternion.w, -1, 1))
    if (axis) {
      if (angle < EPSILON) axis.set(1, 0, 0)
      else axis.set(recoveryDeltaQuaternion.x, recoveryDeltaQuaternion.y, recoveryDeltaQuaternion.z).normalize()
    }
    return MathUtils.radToDeg(angle)
  }

  const updateRecoveryPath = (capture: boolean) => {
    const spineDegrees = measureRecoveryRotation(restSpineQuaternion, hitSpineQuaternion, capture ? recoverySpineAxis : undefined)
    const headDegrees = measureRecoveryRotation(headPoseQuaternion, effectiveHitHeadQuaternion, capture ? recoveryHeadAxis : undefined)
    const totalDegrees = spineDegrees + headDegrees
    headbutt.setRecoveryDistance(totalDegrees)
    // Freeze the previous spring's axes while new down/contact phases fade it;
    // the next rise has no old recoil and can capture its own actual motion.
    if (capture) {
      recoverySpineShare = totalDegrees > EPSILON ? spineDegrees / totalDegrees : 0
      recoveryHeadShare = totalDegrees > EPSILON ? headDegrees / totalDegrees : 0
    }
  }

  const applySpineRecoil = (degrees: number, axis = recoverySpineAxis) => {
    if (degrees === 0) return
    const spine = animatedNodes.Spine02.object
    spineAdditiveBaseQuaternion.copy(spine.quaternion)
    const canApply = (amount: number) => {
      recoilCandidateQuaternion.copy(spineAdditiveBaseQuaternion).multiply(rotationScratch.rotation.setFromAxisAngle(axis, MathUtils.degToRad(-degrees * amount)))
      return !headbuttApplied || canReachFixedRest(recoilCandidateQuaternion, spine.scale.y / animatedNodes.Spine02.baseScale.y, 0)
    }
    let amount = 1
    if (!canApply(amount)) {
      let low = 0
      let high = 1
      for (let step = 0; step < 6; step += 1) {
        const middle = (low + high) / 2
        if (canApply(middle)) low = middle
        else high = middle
      }
      amount = low
    }
    canApply(amount)
    spine.quaternion.copy(recoilCandidateQuaternion)
  }

  const pressedKeys: PressedKey[] = []
  const typingTrance = createTypingTrance(options.random)
  const navigationTargets = new Set(targets.keyboardNavigationTargets)
  let navigationAmount = 0
  let rightHandLeftTurnAmount = 0
  let forwardLeanPeak = 0
  let extendedForwardLeanPeak = 0
  let typingTorsoStretch = 1
  let leftTypingReachScale = 1
  let rightTypingReachScale = 1
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
  const extendedTypingTargetWorld = new Vector3()
  const typingStretchContact = new Vector3()
  const typingStretchShoulder = new Vector3()
  const typingStretchAxis = new Vector3()
  const typingReachPoseCandidate = new Quaternion()
  const typingReachPoseBest = new Quaternion()
  const typingMouseBaseQuaternion = new Quaternion()
  const typingMouseTargetQuaternion = new Quaternion()
  const typingMouseCandidateQuaternion = new Quaternion()
  const typingMouseShoulder = new Vector3()
  const typingMouseContact = new Vector3()
  const typingMouseDirection = new Vector3()
  const typingMousePole = new Vector3()
  const typingMouseElbow = new Vector3()
  const typingMouseWrist = new Vector3()
  const typingMouseForearm = new Vector3()
  const typingMouseMatrix = new Matrix4()
  const typingMouseSpreadQuaternion = new Quaternion()
  let typingStretchError = 0
  const heldHeadRotation = new Quaternion()
  const heldHeadEuler = new Euler()
  const spineWorldPosition = new Vector3()
  const inverseRootWorldQuaternion = new Quaternion()
  // Each animator owns its workspace. Calls consume these targets synchronously;
  // neither arm nor a second desktop/thumbnail renderer retains their references.
  const armSolveScratch = createArmSolveScratch()
  const rotationScratch = { target: new Quaternion(), rotation: new Quaternion(), euler: new Euler() }
  const shoulderSpreadAxis = new Vector3()
  const deviceRotationMatrix = new Matrix4()
  const createTypingTrack = (): TypingTrack => ({
    returnDelayStartedAt: Number.NEGATIVE_INFINITY,
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
  let typingMotionSettings = { ...DEFAULT_TYPING_MOTION_SETTINGS }
  let typingReachRadius = getTypingReachRadius(typingMotionSettings.petTypingMaxRadiusOffset)
  let typingReturnSpeed = DEFAULT_TYPING_MOTION_SETTINGS.petTypingReturnSpeedPercent / 100
  const typingMotionScale = (key: Exclude<keyof TypingMotionSettings, 'petTypingMaxRadiusOffset'>) =>
    animationMode === 'default' && !headbutt.active && !headbuttApplied && !recoilApplied ? typingMotionSettings[key] / 100 : 1
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
    track.returnDelayStartedAt = pressedAt
    track.returnStartedAt = 0
  }

  const getLastPressedKey = (side?: KeyboardSide): PressedKey | undefined => {
    if (animationMode === 'headbutt' || headbuttApplied) return undefined
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
    const returnSpeed = typingReturnSpeed
    const typingTarget = activeKey?.target ?? track.lastTarget
    const isTyping = Boolean(typingTarget)
      && (
        Boolean(activeKey)
        || (timestamp - track.returnDelayStartedAt) * returnSpeed < keyboard.typingIdleDelayMs
        || strikeAge < strikeDurationMs
      )

    if (isTyping && typingTarget) {
      track.returnStartedAt = 0
      output.fromArray(typingTarget.position)
      if (animationMode === 'default' && !headbuttApplied) typingReach.clampLocalPoint(output, typingReachRadius)
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
          * typingMotionScale('petTypingHandLiftPercent')
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
        (timestamp - track.returnStartedAt) * returnSpeed / keyboard.returnDurationMs,
        0,
        1,
      )
      const easedReturn = returnProgress
        * returnProgress
        * (3 - 2 * returnProgress)

      output.fromArray(returnTarget.position)
      if (animationMode === 'default' && !headbuttApplied) typingReach.clampLocalPoint(output, typingReachRadius)
      output.lerp(restPosition, easedReturn)
      output.y += MathUtils.lerp(
        keyboard.contactOffset,
        restHoverHeight,
        easedReturn,
      )
      output.y += Math.sin(Math.PI * returnProgress)
        * keyboard.returnLiftHeight
        * typingMotionScale('petTypingHandLiftPercent')

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

  const calculateBodyYaw = (localTarget: Vector3): number => {
    bodyTurnTargetWorld.copy(localTarget)
    targets.keyboardGroup.localToWorld(bodyTurnTargetWorld)
    animatedNodes.Spine02.object.getWorldPosition(spineWorldPosition)
    bodyTurnDirection.copy(bodyTurnTargetWorld).sub(spineWorldPosition)
    root.getWorldQuaternion(inverseRootWorldQuaternion).invert()
    bodyTurnDirection.applyQuaternion(inverseRootWorldQuaternion)

    return MathUtils.radToDeg(Math.atan2(
      bodyTurnDirection.x,
      bodyTurnDirection.z,
    ))
  }

  const calculateBodyTurn = (localTarget: Vector3, rangeScale: number): number => {
    return MathUtils.clamp(
      calculateBodyYaw(localTarget) * keyboard.bodyTurnStrength,
      -keyboard.bodyMaxTurnDegrees,
      keyboard.bodyMaxTurnDegrees,
    ) * rangeScale
  }

  const calculateReachAssistance = (pose: TypingPose): number => {
    if (!pose.target || typingMotionSettings.petTypingMaxRadiusOffset <= 0 || animationMode !== 'default' || headbutt.active || headbuttApplied) return 0
    extendedTypingTargetWorld.fromArray(pose.target.position)
    targets.keyboardGroup.localToWorld(extendedTypingTargetWorld)
    return getTypingReachAssistance(typingMotionSettings.petTypingMaxRadiusOffset, typingReach.projectedDistance(extendedTypingTargetWorld))
      * (pose.isTyping ? 1 : 1 - pose.easedReturn)
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

  const calculateTypingStretch = (chain: ArmChain, shoulderPosition: Vector3, typingPose: TypingPose, maxStretch: number, bodyQuaternion = animatedNodes.Spine02.object.quaternion): number => {
    typingStretchError = 0
    if (!typingPose.target || maxStretch <= 1) return 1
    const spine = animatedNodes.Spine02
    typingStretchContact.fromArray(typingPose.target.position)
    typingReach.clampLocalPoint(typingStretchContact, typingReachRadius)
    typingStretchContact.y += keyboard.contactOffset
    targets.keyboardGroup.localToWorld(typingStretchContact)
    typingStretchShoulder.copy(shoulderPosition).multiply(spine.baseScale).applyQuaternion(bodyQuaternion).add(spine.object.position).applyMatrix4(spine.object.parent!.matrixWorld)
    typingStretchAxis.copy(shoulderPosition)
    typingStretchAxis.y *= 2
    typingStretchAxis.multiply(spine.baseScale).applyQuaternion(bodyQuaternion).add(spine.object.position).applyMatrix4(spine.object.parent!.matrixWorld).sub(typingStretchShoulder)
    // Match the ordinary arm solver. Reach comes from the torso, not a new
    // elbow plane, larger arm reach or a second wrist solve.
    const armReach = (chain.upperarmLength + chain.forearmLength) * keyboard.armReachRatio + chain.handLength * 0.65
    const stretch = solveReachStretch(typingStretchContact, typingStretchShoulder, typingStretchAxis, armReach, maxStretch)
    typingStretchShoulder.addScaledVector(typingStretchAxis, stretch - 1)
    const activity = typingPose.isTyping ? 1 : 1 - typingPose.easedReturn
    typingStretchError = Math.max(0, typingStretchShoulder.distanceTo(typingStretchContact) - armReach) * activity
    return MathUtils.lerp(1, stretch, activity)
  }

  const calculateTypingReachError = (combinedPose: TypingPose, leftPose: TypingPose, rightPose: TypingPose, keyboardOnlyBlend: number, maxStretch: number, bodyQuaternion: Quaternion): number => {
    let leftError = 0
    let rightError = 0
    if (!leftArmDisabled) {
      calculateTypingStretch(leftArm, leftShoulderPosition, combinedPose, maxStretch, bodyQuaternion)
      const combinedError = typingStretchError
      calculateTypingStretch(leftArm, leftShoulderPosition, leftPose, maxStretch, bodyQuaternion)
      leftError = MathUtils.lerp(combinedError, typingStretchError, keyboardOnlyBlend)
    }
    if (!rightArmDisabled && keyboardOnlyBlend > 0) {
      calculateTypingStretch(rightArm, rightShoulderPosition, rightPose, maxStretch, bodyQuaternion)
      rightError = typingStretchError * keyboardOnlyBlend
    }
    return Math.max(leftError, rightError)
  }

  const calculateTypingStretchGoal = (combinedPose: TypingPose, leftPose: TypingPose, rightPose: TypingPose, keyboardOnlyBlend: number, maxStretch: number, bodyQuaternion = animatedNodes.Spine02.object.quaternion): number => {
    const leftStretch = leftArmDisabled
      ? 1
      : MathUtils.lerp(
          calculateTypingStretch(leftArm, leftShoulderPosition, combinedPose, maxStretch, bodyQuaternion),
          calculateTypingStretch(leftArm, leftShoulderPosition, leftPose, maxStretch, bodyQuaternion),
          keyboardOnlyBlend,
        )
    const rightStretch = rightArmDisabled
      ? 1
      : MathUtils.lerp(1, calculateTypingStretch(rightArm, rightShoulderPosition, rightPose, maxStretch, bodyQuaternion), keyboardOnlyBlend)
    return Math.max(leftStretch, rightStretch)
  }

  const calculateMouseReachError = (bodyQuaternion: Quaternion, stretch: number): number => {
    const spine = animatedNodes.Spine02
    typingMouseShoulder.copy(rightShoulderPosition)
    typingMouseShoulder.y *= stretch
    typingMouseShoulder.multiply(spine.baseScale).applyQuaternion(bodyQuaternion).add(spine.object.position).applyMatrix4(spine.object.parent!.matrixWorld)
    typingMouseDirection.copy(typingMouseContact).sub(typingMouseShoulder)
    const distance = typingMouseDirection.length()
    if (distance < EPSILON) return 0
    typingMouseDirection.multiplyScalar(1 / distance)
    const armLength = rightArm.upperarmLength + rightArm.forearmLength
    const reach = MathUtils.clamp(distance - rightArm.handLength * 0.65, armLength * 0.55, armLength * keyboard.armReachRatio)
    // Forecast the ordinary bend/spread solve, including its authored elbow
    // offset. Anatomical maximum reach alone does not predict this wrist.
    getTransformedDirection(root, keyboard.rightElbowPole, typingMousePole, typingMouseMatrix)
    typingMousePole.addScaledVector(typingMouseDirection, -typingMousePole.dot(typingMouseDirection))
    if (typingMousePole.lengthSq() < EPSILON) typingMousePole.copy(WORLD_UP).addScaledVector(typingMouseDirection, -WORLD_UP.dot(typingMouseDirection))
    typingMousePole.normalize()
    const projection = (rightArm.upperarmLength ** 2 - rightArm.forearmLength ** 2 + reach ** 2) / (2 * reach)
    const bend = pose.armBendAmount * armPoseSettings.petRightArmBendPercent / 100
    const elbowOffset = Math.sqrt(Math.max(0, rightArm.upperarmLength ** 2 - projection ** 2)) * bend
    typingMouseElbow.copy(typingMouseDirection).multiplyScalar(projection).addScaledVector(typingMousePole, elbowOffset).normalize().multiplyScalar(rightArm.upperarmLength)
    typingMouseForearm.copy(typingMouseDirection).multiplyScalar(reach).sub(typingMouseElbow).normalize().multiplyScalar(rightArm.forearmLength)
    typingMouseWrist.copy(typingMouseElbow).add(typingMouseForearm)
    if (armPoseSettings.petRightArmSpreadDegrees !== 0) {
      typingMouseSpreadQuaternion.setFromAxisAngle(shoulderSpreadAxis, MathUtils.degToRad(armPoseSettings.petRightArmSpreadDegrees) * Math.sign(keyboard.rightElbowPole[0]))
      typingMouseWrist.applyQuaternion(typingMouseSpreadQuaternion)
    }
    return typingMouseWrist.add(typingMouseShoulder).distanceTo(typingMouseContact)
  }

  const setKeyPressed: PetAnimator['setKeyPressed'] = (key, pressed, target) => {
    if (disposed || !target) return

    const existingIndex = pressedKeys.findIndex(entry => entry.key === key)
    // Native auto-repeat is still a hold: do not queue strikes or reorder targets.
    if (pressed && existingIndex >= 0) return
    if (existingIndex >= 0) pressedKeys.splice(existingIndex, 1)
    if (!pressed && animationMode === 'headbutt') {
      if (existingIndex >= 0) headbutt.setHeld(pressedKeys.length > 0, now(), pressedKeys[pressedKeys.length - 1]?.target)
      return
    }

    if (pressed) {
      const pressedAt = now()
      legLift.notePress(pressedAt)
      const side: KeyboardSide = target.typingSide
        ?? (target.position[0] <= inputMode.keyboardSplitX ? 'Left' : 'Right')
      pressedKeys.push({ key, target, side })
      if (animationMode === 'headbutt') {
        headbutt.setHeld(true, pressedAt, target)
        const chordAge = pressedAt - headbuttChordStartedAt
        const chord = key !== headbuttChordKey
          && chordAge >= 0
          && chordAge < headbutt.tuning.chordWindowMs
          && pressedKeys.some(entry => entry.key === headbuttChordKey)
        if (!chord) {
          headbuttChordKey = key
          headbuttChordStartedAt = pressedAt
        }
        headbutt.press(target, pressedAt, chord)
        const state = headbutt.update(pressedAt)
        if (braceSession !== state.session) {
          braceSession = state.session
          captureBrace()
        }
        return
      }
      typingTrance.press(pressedAt)
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
      const movedAt = now()
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
    mouseStrikeStartedAt = now()
    if (animationMode === 'default') typingTrance.press(mouseStrikeStartedAt)
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
    rightRestEntryStartedAt = Number.NEGATIVE_INFINITY
    if (!enabled && (headbutt.active || headbuttApplied)) {
      rightRestEntryStartedAt = now()
      rightArm.hand.object.getWorldPosition(braceRightFrom)
      braceRight.copy(braceRightFrom)
      if (targets.desk) {
        getCompactShoulderWorld(braceRightShoulderPosition, candidateShoulder)
        getRestTarget(rightArm, candidateShoulder, braceRight, -1)
        braceRightLocal.copy(braceRight)
        targets.desk.worldToLocal(braceRightLocal)
      }
      for (const [index, node] of [rightArm.upperarm, rightArm.forearm, rightArm.hand].entries()) rightBraceQuaternions[index].copy(node.object.quaternion)
    }
    // Mouse visibility owns the hand rest, never the independent cursor gaze.
    setMode(animationMode === 'headbutt' && enabled ? 'KeyboardMouse' : 'KeyboardOnly', now())
  }

  const resetInput = () => {
    headbutt.cancel(now())
    legLift.resetInput()
    headbuttChordKey = undefined
    headbuttChordStartedAt = Number.NEGATIVE_INFINITY
    pressedKeys.length = 0
    rightRestEntryStartedAt = Number.NEGATIVE_INFINITY
    leftArm.contactTransition.reset()
    rightArm.contactTransition.reset()
    mouseReturnStartedAt = undefined
    navigationAmount = 0
    rightHandLeftTurnAmount = 0
    forwardLeanPeak = 0
    extendedForwardLeanPeak = 0
    forwardLeanHoldUntil = 0
    for (const track of [combinedTypingTrack, leftTypingTrack, rightTypingTrack]) {
      track.lastTarget = undefined
      track.returnDelayStartedAt = Number.NEGATIVE_INFINITY
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
    setMode(animationMode === 'headbutt' && mouseEnabled ? 'KeyboardMouse' : 'KeyboardOnly', now())
  }

  const setAnimationMode: PetAnimator['setAnimationMode'] = (nextMode) => {
    if (disposed || animationMode === nextMode) return
    // Reset transient input, preserving the selected mode and all saved poses.
    // A live strike finishes its smooth rebound; no pending hit crosses modes.
    const heldKeys = pressedKeys.slice()
    resetInput()
    // Keep physical hold identities across selection changes. Native repeats
    // of those keys are not new presses in the newly selected animation.
    pressedKeys.push(...heldKeys)
    animationMode = nextMode
    setMode(nextMode === 'headbutt' && mouseEnabled ? 'KeyboardMouse' : 'KeyboardOnly', now())
    if (nextMode === 'headbutt') restSpineQuaternion.copy(recoilApplied ? spinePoseQuaternion : animatedNodes.Spine02.object.quaternion)
  }

  const syncTypingReturnSpeed = (timestamp: number) => {
    const previousSpeed = typingReturnSpeed
    const nextSpeed = typingMotionScale('petTypingReturnSpeedPercent')
    if (previousSpeed === nextSpeed) return
    typingReturnSpeed = nextSpeed
    // Preserve virtual clocks for slider edits and automatic resumption after
    // a headbutt has restored its base pose. Neither may reinterpret old age.
    for (const track of [combinedTypingTrack, leftTypingTrack, rightTypingTrack]) {
      if (Number.isFinite(track.returnDelayStartedAt)) {
        const age = Math.max(0, timestamp - track.returnDelayStartedAt)
        track.returnDelayStartedAt = timestamp - age * previousSpeed / nextSpeed
      }
      if (track.returnStartedAt !== 0) {
        const age = Math.max(0, timestamp - track.returnStartedAt)
        track.returnStartedAt = timestamp - age * previousSpeed / nextSpeed
      }
    }
    if (forwardLeanPeak > 0) {
      forwardLeanHoldUntil = timestamp + (forwardLeanHoldUntil - timestamp) * previousSpeed / nextSpeed
    }
  }

  const setTypingMotionSettings: PetAnimator['setTypingMotionSettings'] = (settings) => {
    if (disposed) return
    typingMotionSettings = normalizeTypingMotionSettings(settings, typingMotionSettings)
    typingReachRadius = getTypingReachRadius(typingMotionSettings.petTypingMaxRadiusOffset)
    syncTypingReturnSpeed(now())
  }

  const setArmPoseSettings: PetAnimator['setArmPoseSettings'] = (settings) => {
    if (disposed) return
    armPoseSettings = normalizePetArmPoseSettings(settings, armPoseSettings)
  }

  const setArmsDisabled: PetAnimator['setArmsDisabled'] = (right, left) => {
    if (disposed) return
    const nextRight = right === true
    const nextLeft = left === true
    for (const [chain, changed, disabled, shoulder] of [
      [leftArm, nextLeft !== leftArmDisabled, nextLeft, leftShoulderPosition],
      [rightArm, nextRight !== rightArmDisabled, nextRight, rightShoulderPosition],
    ] as const) {
      if (!changed) continue
      for (const node of [chain.upperarm, chain.forearm, chain.hand]) {
        node.object.position.copy(node.basePosition)
        node.object.quaternion.copy(node.baseQuaternion)
        node.object.scale.copy(node.baseScale)
        node.parentStretch = undefined
        updateNodeMatrix(node)
      }
      if (!disabled) chain.upperarm.object.position.copy(shoulder)
      updateNodeMatrix(chain.upperarm)
      chain.upperarm.object.updateWorldMatrix(true, true)
      chain.contactInitialized = false
      chain.contactTransition.reset()
    }
    rightArmDisabled = nextRight
    leftArmDisabled = nextLeft
  }

  const addMouseStrikeOffset = (contact: Vector3, lift: number, offsetWeight: number) => {
    contact.y += lift
    if (offsetWeight <= 0) return
    rightMouseButtonOffsetWorld.set(mouseStrikeButton === 'Middle' ? 0 : mouseStrikeButton === 'Left' ? mouse.clickButtonOffset : -mouse.clickButtonOffset, 0, 0)
    mouseHandAnchor.localToWorld(rightMouseButtonOffsetWorld)
    rightMouseButtonOffsetWorld.sub(rightMouseContactWorld).multiplyScalar(offsetWeight)
    contact.add(rightMouseButtonOffsetWorld)
  }

  const update: PetAnimator['update'] = (deltaMilliseconds, timestamp) => {
    if (disposed) return

    const headbuttPose = headbutt.update(timestamp)
    syncTypingReturnSpeed(timestamp)
    const bracing = headbuttPose.grip > 0 || headbuttPose.phase === 'grip'
    shoulderConnection.update()
    if (bracing && headbuttPose.recovering) {
      if (!restoringRightShoulder) {
        for (const [index, node] of [rightArm.upperarm, rightArm.forearm, rightArm.hand].entries()) rightShoulderRecoveryQuaternions[index].copy(node.object.quaternion)
        rightShoulderRecoveryStartedAt = timestamp
        rightShoulderRecoveryFrom = rightShoulderAttachment
        restoringRightShoulder = true
      }
    } else {
      restoringRightShoulder = false
    }
    if (bracing && headbuttPose.phase === 'return') {
      if (!returningArms) {
        for (const [index, node] of [leftArm.upperarm, leftArm.forearm, leftArm.hand].entries()) leftReturnQuaternions[index].copy(node.object.quaternion)
        for (const [index, node] of [rightArm.upperarm, rightArm.forearm, rightArm.hand].entries()) rightReturnQuaternions[index].copy(node.object.quaternion)
        returnGripStart = Math.max(EPSILON, headbuttPose.grip)
        returningArms = true
      }
    } else {
      returningArms = false
    }
    const armReturnBlend = MathUtils.clamp(headbuttPose.grip / returnGripStart, 0, 1)
    const armRecoveryAmount = headbuttPose.recovering ? 1 - headbuttPose.depth : 0
    if (animationMode === 'headbutt') {
      // Mouse preference owns this arm for the whole mode, including mouse idle
      // and simultaneous keyboard presses. It never switches into typing.
      mode = mouseEnabled ? 'KeyboardMouse' : 'KeyboardOnly'
      modeTransitionStartedAt = 0
      mouseReturnStartedAt = undefined
    }

    if (
      animationMode === 'default' && mode === 'KeyboardMouse'
      && timestamp - lastMouseMovedAt >= inputMode.mouseIdleMs
    ) {
      setMode('KeyboardOnly', timestamp)
    }

    keyboardOnlyBlend = getModeBlend(timestamp)
    const deltaSeconds = Math.min(deltaMilliseconds / 1000, 0.1)
    const trance = animationMode === 'headbutt' || bracing
      ? { amount: 0, yawDegrees: 0, rollDegrees: 0 }
      : typingTrance.update(timestamp)
    gazeBlend = MathUtils.damp(gazeBlend, hasMousePosition && timestamp - lastMouseMovedAt < inputMode.mouseIdleMs ? 1 : 0, head.damping, deltaSeconds)
    targets.keyboardGroup.updateWorldMatrix(true, false)
    if (animationMode === 'default' && !bracing) typingReach.update()
    getTransformedDirection(targets.keyboardGroup, WORLD_UP_COMPONENTS, shoulderSpreadAxis, deviceRotationMatrix)
    mouseHandAnchor.updateWorldMatrix(true, false)
    mouseHandAnchor.getWorldPosition(rightMouseContactWorld)
    rightMouseContactLocal.copy(rightMouseContactWorld)
    targets.keyboardGroup.worldToLocal(rightMouseContactLocal)
    const braceGeometryChanged = bracing && (updateBraceGeometry() || headbuttRadiusChanged)
    headbuttRadiusChanged = false

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
    typingMouseContact.copy(rightMouseContactWorld)
    addMouseStrikeOffset(typingMouseContact, mouseStrikeLift, mouseStrikeOffsetWeight)
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
    const combinedExtension = calculateReachAssistance(combinedPose)
    const leftExtension = calculateReachAssistance(leftPose)
    const rightExtension = calculateReachAssistance(rightPose)
    const reachExtension = MathUtils.lerp(combinedExtension, Math.max(leftExtension, rightExtension), keyboardOnlyBlend)
    const wideTypingSupport = animationMode === 'default' && !bracing && !headbuttApplied
      ? Math.max(0, typingMotionSettings.petTypingMaxRadiusOffset)
      : 0
    const contractionScale = animationMode === 'default' && !bracing && !headbuttApplied
      ? getTypingReachContractionScale(typingMotionSettings.petTypingMaxRadiusOffset)
      : 1
    const combinedTypingActivity = combinedPose.target ? combinedPose.isTyping ? 1 : 1 - combinedPose.easedReturn : 0
    const leftTypingActivity = leftPose.target ? leftPose.isTyping ? 1 : 1 - leftPose.easedReturn : 0
    const rightTypingActivity = rightPose.target ? rightPose.isTyping ? 1 : 1 - rightPose.easedReturn : 0
    const leftReachGoal = MathUtils.lerp(1, contractionScale, MathUtils.lerp(combinedTypingActivity, leftTypingActivity, keyboardOnlyBlend))
    const rightReachGoal = MathUtils.lerp(1, contractionScale, rightTypingActivity * keyboardOnlyBlend)
    leftTypingReachScale = snap ? leftReachGoal : MathUtils.damp(leftTypingReachScale, leftReachGoal, keyboard.damping, deltaSeconds)
    rightTypingReachScale = snap ? rightReachGoal : MathUtils.damp(rightTypingReachScale, rightReachGoal, keyboard.damping, deltaSeconds)
    const typingReachWeight = wideTypingSupport * Math.min(1, typingMotionScale('petTypingBodyMotionPercent')) * MathUtils.lerp(
      combinedTypingActivity,
      Math.max(leftTypingActivity, rightTypingActivity),
      keyboardOnlyBlend,
    )
    const keyboardForwardLean = Math.max(
      calculateForwardLean(leftPose),
      calculateForwardLean(rightPose),
    )
    const requestedExtendedLean = reachExtension * keyboard.extendedReachLeanDegrees
    const requestedForwardLean = MathUtils.lerp(
      combinedForwardLean,
      keyboardForwardLean,
      keyboardOnlyBlend,
    ) + requestedExtendedLean
    // Let hands follow each key while the torso holds a deeper reach briefly.
    // Decay from a fixed peak using elapsed time, never a per-frame multiplier.
    const returnSpeed = typingReturnSpeed
    const leanReturn = MathUtils.clamp((timestamp - forwardLeanHoldUntil) * returnSpeed / keyboard.farLeanReturnMs, 0, 1)
    const retainedForwardLean = forwardLeanPeak * (1 - leanReturn * leanReturn * (3 - 2 * leanReturn))
    if (requestedForwardLean >= retainedForwardLean) {
      forwardLeanPeak = requestedForwardLean
      extendedForwardLeanPeak = requestedExtendedLean
      forwardLeanHoldUntil = timestamp + keyboard.farLeanHoldMs / returnSpeed
    }
    const forwardLeanDegrees = Math.max(requestedForwardLean, retainedForwardLean)
    const extendedLeanDegrees = Math.max(requestedExtendedLean, extendedForwardLeanPeak * (1 - leanReturn * leanReturn * (3 - 2 * leanReturn)))
    const bodyMotionScale = typingMotionScale('petTypingBodyMotionPercent')
    // Preserve the default trance pose, but retain user-added waist bend in it.
    const ordinaryTypingForwardLean = (forwardLeanDegrees - extendedLeanDegrees) * (1 - navigationAmount)
      * (Math.min(1, bodyMotionScale) * (1 - trance.amount) + Math.max(0, bodyMotionScale - 1))
    const typingForwardLean = Math.min(keyboard.maxTypingLeanDegrees, ordinaryTypingForwardLean + extendedLeanDegrees * bodyMotionScale)
    let typingYaw = MathUtils.lerp(
      bodyTurnDegrees + keyboard.rightHandLeftTurnDegrees * rightHandLeftTurnAmount,
      -keyboard.navigationTurnDegrees,
      navigationAmount,
    )
    if (bodyMotionScale !== 1) {
      const limit = keyboard.bodyMaxTurnDegrees * keyboard.bodyRightTurnScale + keyboard.rightHandLeftTurnDegrees
      typingYaw = MathUtils.clamp(defaultBodyTurnDegrees + (typingYaw - defaultBodyTurnDegrees) * bodyMotionScale, -limit, limit)
    }
    if (headbuttApplied) animatedNodes.Spine02.object.quaternion.copy(restSpineQuaternion)
    else if (recoilApplied) animatedNodes.Spine02.object.quaternion.copy(spinePoseQuaternion)
    const typingLeanScale = animationMode === 'default' ? getTypingReachLeanScale(typingMotionSettings.petTypingMaxRadiusOffset) : 1
    // Apply after the hold/return peak so a retained far-key lean cannot
    // override the compact radius. Idle breathing stays independent.
    const navigationLean = keyboard.navigationBackLeanDegrees * navigationAmount * bodyMotionScale
    const typingPitch = typingLeanScale === 1
      ? breathingPhase * breathing.spineDegrees + typingForwardLean - navigationLean
      : breathingPhase * breathing.spineDegrees + (typingForwardLean - navigationLean) * typingLeanScale
    const typingSpineTarget = makeTargetQuaternion(animatedNodes.Spine02, typingPitch, typingYaw, 0, rotationScratch)
    let typingStretchLimit = MathUtils.lerp(1, keyboard.extendedReachMaxStretch, wideTypingSupport * Math.min(1, bodyMotionScale))
    if (typingReachWeight > 0 && reachExtension > 0) {
      let bestError = calculateTypingReachError(combinedPose, leftPose, rightPose, keyboardOnlyBlend, typingStretchLimit, typingSpineTarget)
      if (bestError > EPSILON) {
        typingReachPoseBest.copy(typingSpineTarget)
        // Keep the ordinary yaw, rotation order and arm pose. Add waist pitch
        // only when it reduces the remaining reach error with bounded stretch.
        for (let pitch = Math.min(typingPitch + 2, keyboard.maxTypingLeanDegrees); pitch <= keyboard.maxTypingLeanDegrees; pitch = Math.min(pitch + 2, keyboard.maxTypingLeanDegrees)) {
          typingReachPoseCandidate.copy(animatedNodes.Spine02.baseQuaternion).multiply(rotationScratch.rotation.setFromEuler(
            rotationScratch.euler.set(MathUtils.degToRad(pitch), MathUtils.degToRad(typingYaw), 0, 'XYZ'),
          ))
          const error = calculateTypingReachError(combinedPose, leftPose, rightPose, keyboardOnlyBlend, typingStretchLimit, typingReachPoseCandidate)
          if (error < bestError) {
            bestError = error
            typingReachPoseBest.copy(typingReachPoseCandidate)
          }
          if (bestError <= EPSILON || pitch === keyboard.maxTypingLeanDegrees) break
        }
        typingSpineTarget.slerp(typingReachPoseBest, typingReachWeight)
      }
    }
    if (wideTypingSupport > 0 && mouseEnabled && !rightArmDisabled && keyboardOnlyBlend === 0) {
      const basePitch = breathingPhase * breathing.spineDegrees + ordinaryTypingForwardLean - navigationLean
      typingMouseBaseQuaternion.copy(animatedNodes.Spine02.baseQuaternion).multiply(degreesToQuaternion(basePitch, typingYaw, 0, rotationScratch.rotation, rotationScratch.euler))
      const mouseReachBudget = calculateMouseReachError(typingMouseBaseQuaternion, 1) + EPSILON
      const targetStretch = calculateTypingStretchGoal(combinedPose, leftPose, rightPose, keyboardOnlyBlend, typingStretchLimit, typingSpineTarget)
      if (calculateMouseReachError(typingSpineTarget, targetStretch) > mouseReachBudget) {
        // Keep the mouse-owned arm's original solve. Limit only added waist
        // reach when rigid arms cannot serve the keyboard and mouse together.
        typingMouseTargetQuaternion.copy(typingSpineTarget)
        const requestedStretchLimit = typingStretchLimit
        let low = 0
        let high = 1
        for (let step = 0; step < 8; step++) {
          const amount = (low + high) / 2
          typingMouseCandidateQuaternion.copy(typingMouseBaseQuaternion).slerp(typingMouseTargetQuaternion, amount)
          const limit = MathUtils.lerp(1, requestedStretchLimit, amount)
          const stretch = calculateTypingStretchGoal(combinedPose, leftPose, rightPose, keyboardOnlyBlend, limit, typingMouseCandidateQuaternion)
          if (calculateMouseReachError(typingMouseCandidateQuaternion, stretch) <= mouseReachBudget) low = amount
          else high = amount
        }
        typingSpineTarget.copy(typingMouseBaseQuaternion).slerp(typingMouseTargetQuaternion, low)
        typingStretchLimit = MathUtils.lerp(1, requestedStretchLimit, low)
      }
    }
    dampQuaternion(
      animatedNodes.Spine02.object,
      typingSpineTarget,
      keyboard.bodyTurnDamping,
      deltaSeconds,
      snap,
    )
    restSpineQuaternion.copy(animatedNodes.Spine02.object.quaternion)
    const typingStretchGoal = calculateTypingStretchGoal(combinedPose, leftPose, rightPose, keyboardOnlyBlend, typingStretchLimit)
    if (bracing) {
      if (headbuttPose.phase !== 'return') restSpineQuaternion.copy(braceRestQuaternion)
      if (braceSession !== headbuttPose.session) {
        braceSession = headbuttPose.session
        captureBrace()
      }
      if (headbuttPose.target && hitCycle !== headbuttPose.cycle) {
        const continuing = headbuttApplied && hitCycle >= 0 && headbuttPose.depth > 0
        hitSpineFrom.copy(hitSpineQuaternion)
        hitHeadFrom.copy(hitHeadQuaternion)
        hitStretchFrom = hitStretch
        hitCycle = headbuttPose.cycle
        calculateHit(headbuttPose.target)
        if (continuing) {
          hitSpineGoal.copy(hitSpineQuaternion)
          hitHeadGoal.copy(hitHeadQuaternion)
          hitStretchGoal = hitStretch
          hitRetargetMs = headbutt.tuning.downMs
          hitRetargetAt = timestamp
        } else {
          hitRetargetAt = Number.NEGATIVE_INFINITY
        }
      } else if (headbuttPose.target && braceGeometryChanged) {
        hitSpineFrom.copy(hitSpineQuaternion)
        hitHeadFrom.copy(hitHeadQuaternion)
        hitStretchFrom = hitStretch
        calculateHit(headbuttPose.target)
        hitSpineGoal.copy(hitSpineQuaternion)
        hitHeadGoal.copy(hitHeadQuaternion)
        hitStretchGoal = hitStretch
        hitRetargetMs = headbutt.tuning.gripMs
        hitRetargetAt = timestamp
      }
      if (Number.isFinite(hitRetargetAt)) {
        const progress = MathUtils.clamp((timestamp - hitRetargetAt) / hitRetargetMs, 0, 1)
        const amount = progress * progress * (3 - 2 * progress)
        hitSpineQuaternion.copy(hitSpineFrom).slerp(hitSpineGoal, amount)
        hitHeadQuaternion.copy(hitHeadFrom).slerp(hitHeadGoal, amount)
        hitStretch = MathUtils.lerp(hitStretchFrom, hitStretchGoal, amount)
        if (progress === 1) hitRetargetAt = Number.NEGATIVE_INFINITY
      }
      animatedNodes.Spine02.object.quaternion.copy(restSpineQuaternion).slerp(hitSpineQuaternion, headbuttPose.depth)
      // The right shoulder returns on its own short timer; the left retains its grip envelope.
      const shoulderReturnProgress = MathUtils.clamp((timestamp - rightShoulderRecoveryStartedAt) / braceSettings.rightShoulderReturnMs, 0, 1)
      const shoulderReturnAmount = shoulderReturnProgress * shoulderReturnProgress * (3 - 2 * shoulderReturnProgress)
      const rightShoulderAmount = headbuttPose.recovering
        ? rightShoulderRecoveryFrom * (1 - shoulderReturnAmount)
        : headbuttPose.grip
      const restingStretch = headbuttPose.phase === 'return' ? MathUtils.lerp(1, braceRestStretch, armReturnBlend) : braceRestStretch
      typingTorsoStretch = MathUtils.lerp(restingStretch, hitStretch, headbuttPose.depth)
      setTorsoStretch(typingTorsoStretch, headbuttPose.grip, rightShoulderAmount)
    } else {
      // Headbutt's elapsed-time envelope has already completed. Retire its
      // applied stretch in this frame, including frames skipped during a hold.
      typingTorsoStretch = snap || headbuttApplied ? typingStretchGoal : MathUtils.damp(typingTorsoStretch, typingStretchGoal, keyboard.bodyTurnDamping, deltaSeconds)
      if (typingStretchGoal === 1 && Math.abs(typingTorsoStretch - 1) < EPSILON) typingTorsoStretch = 1
      if (headbuttApplied || typingTorsoStretch !== 1 || animatedNodes.Spine02.object.scale.y !== animatedNodes.Spine02.baseScale.y) setTorsoStretch(typingTorsoStretch)
    }
    headbuttApplied = bracing
    // Keep spring displacement out of the damped base pose so it cannot
    // accumulate or be absorbed by breathing and body-turn smoothing.
    spinePoseQuaternion.copy(animatedNodes.Spine02.object.quaternion)
    if (bracing && headbuttPose.holdBreathAmount > 0) {
      applySpineRecoil(
        -breathingPhase * breathing.spineDegrees * headbuttPose.holdBreathAmount * headbuttPose.depth,
        holdBreathingAxis,
      )
      // Breathing stays within reach of the captured tabletop contacts.
      spinePoseQuaternion.copy(animatedNodes.Spine02.object.quaternion)
    }
    applySpineRecoil(headbuttPose.recoilDegrees * recoverySpineShare)
    recoilApplied = headbuttPose.recoilDegrees !== 0
    animatedNodes.Spine02.object.updateWorldMatrix(true, true)

    if (bracing) {
      // Use the torso's outward/downward direction, independent of head shake.
      // Changing the elbow plane preserves the wrist target and segment lengths.
      root.updateWorldMatrix(true, false)
      const clearanceAmount = headbuttPose.depth * headbuttPose.grip
      for (const [output, restingPole, typingPole, clearancePole, mouseOwned] of [
        [braceLeftElbowPole, braceSettings.leftElbowPole, keyboard.elbowPole, braceSettings.leftClearanceElbowPole, false],
        [braceRightElbowPole, braceSettings.rightElbowPole, keyboard.rightElbowPole, braceSettings.rightClearanceElbowPole, mouseEnabled],
      ] as const) {
        getTransformedDirection(root, mouseOwned ? typingPole : restingPole, output, braceElbowPoleMatrix)
        getTransformedDirection(animatedNodes.Spine02.object, clearancePole, braceClearanceElbowPole, braceElbowPoleMatrix)
        output.lerp(braceClearanceElbowPole, clearanceAmount).normalize()
      }
    }

    blendedLeftContact.copy(combinedLeftContact)
      .lerp(keyboardLeftContact, keyboardOnlyBlend)
    leftContactWorld.copy(blendedLeftContact)
    targets.keyboardGroup.localToWorld(leftContactWorld)
    // Impact response belongs to a settled hand, not travel between devices.
    const leftArmDamping = modeTransitionStartedAt === 0 && (combinedPose.impacting || leftPose.impacting)
      ? keyboard.strikeImpactDamping
      : keyboard.damping
    if (bracing && !leftArmDisabled) {
      if (headbuttPose.phase === 'return') {
        solveArm(armSolveScratch, root, leftArm, leftContactWorld, keyboard.elbowPole, pose.armBendAmount * armPoseSettings.petLeftArmBendPercent / 100, armPoseSettings.petLeftArmSpreadDegrees, shoulderSpreadAxis, leftArmDamping, deltaSeconds, snap)
        blendBrace(leftArm, leftReturnQuaternions, armReturnBlend)
      } else {
        leftContactWorld.copy(braceLeftFrom).lerp(braceLeft, headbuttPose.grip)
        solveArmAtContact(armSolveScratch, root, leftArm, leftContactWorld, 1, braceLeftElbowPole, armRecoveryAmount)
        if (headbuttPose.phase === 'grip') blendBrace(leftArm, leftBraceQuaternions, 1 - headbuttPose.grip)
      }
    } else if (!leftArmDisabled) {
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
        false,
        undefined,
        animationMode === 'default' && !bracing ? leftTypingReachScale : 1,
      )
    }

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
    addMouseStrikeOffset(rightContactWorld, mouseStrikeLift, mouseStrikeOffsetWeight)
    const rightArmDamping = mouseStrikeLift > 0
      ? mouse.clickDamping
      : rightPose.impacting && keyboardOnlyBlend === 1
        ? keyboard.strikeImpactDamping
        : MathUtils.lerp(mouse.damping, keyboard.damping, keyboardOnlyBlend)
    if (bracing && !mouseEnabled && !rightArmDisabled) {
      if (headbuttPose.phase === 'return') {
        solveArm(armSolveScratch, root, rightArm, rightContactWorld, keyboard.rightElbowPole, pose.armBendAmount * armPoseSettings.petRightArmBendPercent / 100, armPoseSettings.petRightArmSpreadDegrees, shoulderSpreadAxis, rightArmDamping, deltaSeconds, snap, true)
        blendBrace(rightArm, rightReturnQuaternions, armReturnBlend)
      } else {
        rightContactWorld.copy(braceRightFrom).lerp(braceRight, headbuttPose.grip)
        solveArmAtContact(armSolveScratch, root, rightArm, rightContactWorld, -1, braceRightElbowPole, armRecoveryAmount)
        if (headbuttPose.recovering) blendBrace(rightArm, rightShoulderRecoveryQuaternions, headbuttPose.depth)
        if (Number.isFinite(rightRestEntryStartedAt)) {
          const progress = MathUtils.clamp((timestamp - rightRestEntryStartedAt) / inputMode.transitionMs, 0, 1)
          blendBrace(rightArm, rightBraceQuaternions, 1 - progress * progress * (3 - 2 * progress))
          if (progress === 1) rightRestEntryStartedAt = Number.NEGATIVE_INFINITY
        }
        if (headbuttPose.phase === 'grip') blendBrace(rightArm, rightBraceQuaternions, 1 - headbuttPose.grip)
      }
    } else if (!rightArmDisabled) {
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
        bracing ? braceRightElbowPole : undefined,
        animationMode === 'default' && !bracing && keyboardOnlyBlend > 0 ? rightTypingReachScale : 1,
      )
    }
    const mouseTrackingBlend = gazeBlend * (1 - trance.amount) * (1 - headbuttPose.grip)
    // Keep the damped pose independent from additive strike shake and recoil.
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
    effectiveHitHeadQuaternion.copy(hitHeadQuaternion)
    if (bracing) {
      if (headbuttPose.holdNeckAmount > 0) {
        // Keep the hit's lateral aim while the held neck bends farther down.
        heldHeadRotation.copy(animatedNodes.Head.baseQuaternion).invert().multiply(hitHeadQuaternion)
        heldHeadEuler.setFromQuaternion(heldHeadRotation, 'YXZ')
        heldHeadRotation.copy(animatedNodes.Head.baseQuaternion).multiply(rotationScratch.rotation.setFromEuler(
          heldHeadEuler.set(MathUtils.degToRad(headbutt.tuning.holdNeckPitchDegrees), heldHeadEuler.y, 0, 'YXZ'),
        ))
        effectiveHitHeadQuaternion.slerp(heldHeadRotation, headbuttPose.holdNeckAmount)
      }
      effectiveHitHeadQuaternion.multiply(degreesToQuaternion(
        -breathingPhase * breathing.headDegrees * headbuttPose.holdBreathAmount,
        headbuttPose.holdShakeDegrees,
        0,
        rotationScratch.rotation,
        rotationScratch.euler,
      ))
    }
    if (bracing && headbuttPose.phase !== 'return' && headbuttPose.phase !== 'quiet') {
      updateRecoveryPath(headbuttPose.phase === 'rebound')
    }
    if (bracing) animatedNodes.Head.object.quaternion.slerp(effectiveHitHeadQuaternion, headbuttPose.depth)
    if (headbuttPose.recoilDegrees !== 0 && recoveryHeadShare > 0) {
      animatedNodes.Head.object.quaternion.multiply(rotationScratch.rotation.setFromAxisAngle(
        recoveryHeadAxis,
        MathUtils.degToRad(-headbuttPose.recoilDegrees * recoveryHeadShare),
      ))
    }
    animatedNodes.Head.object.quaternion.multiply(degreesToQuaternion(
      0,
      trance.yawDegrees,
      trance.rollDegrees,
      rotationScratch.rotation,
      rotationScratch.euler,
    ))
    if (animatedNodes.Head.parentStretch !== undefined) updateNodeMatrix(animatedNodes.Head)

    const legTarget = bracing ? headbuttPose.target : combinedPose.target
    const legActivity = bracing
      ? headbuttPose.phase === 'grip' || headbuttPose.phase === 'down' || headbuttPose.phase === 'contact' || headbuttPose.phase === 'hold'
        ? 1
        : headbuttPose.depth
      : combinedPose.isTyping ? 1 : 1 - combinedPose.easedReturn
    legTurnQuaternion.copy(animatedNodes.Spine02.baseQuaternion).invert().multiply(animatedNodes.Spine02.object.quaternion)
    legTurnEuler.setFromQuaternion(legTurnQuaternion, 'YXZ')
    legLift.update(legTarget ? getLegReachRatio(legTarget) : 0, MathUtils.radToDeg(legTurnEuler.y), legActivity, timestamp)

    initialized = true
  }

  const dispose = () => {
    if (disposed) return
    resetInput()
    disposed = true
    shoulderConnection.dispose()
    legLift.dispose()
    setTorsoStretch(1)
    REQUIRED_NODE_NAMES.forEach((name) => {
      animatedNodes[name].object.position.copy(animatedNodes[name].basePosition)
      animatedNodes[name].object.quaternion.copy(animatedNodes[name].baseQuaternion)
      animatedNodes[name].object.scale.copy(animatedNodes[name].baseScale)
      animatedNodes[name].object.matrixAutoUpdate = animatedNodes[name].baseMatrixAutoUpdate
      animatedNodes[name].object.updateMatrix()
    })
  }

  function setHeadScalePercent(percent: number): void {
    if (!Number.isFinite(percent)) return
    const head = animatedNodes.Head
    head.object.scale.copy(head.baseScale).multiplyScalar(Math.min(200, Math.max(25, percent)) / 100)
    if (head.parentStretch !== undefined) updateNodeMatrix(head)
    head.object.updateWorldMatrix(true, true)
  }

  return {
    setAnimationMode,
    setHeadbuttMaxRadiusOffset: (offset) => {
      if (disposed) return
      const next = normalizeHeadbuttMaxRadiusOffset(offset, headbuttMaxRadiusOffset)
      if (next === headbuttMaxRadiusOffset) return
      headbuttMaxRadiusOffset = next
      headbuttRadiusChanged = true
    },
    setHeadbuttRecoilSettings: settings => headbutt.setRecoilSettings(settings, now()),
    setTypingMotionSettings,
    setShoulderTorsoConnected: enabled => shoulderConnection.setEnabled(enabled === true),
    setArmsDisabled,
    // Reading bounds must not advance input time. Keep a previously applied
    // pose active until update has actually restored its base transforms.
    isHeadbuttActive: () => !disposed && (headbutt.active || headbuttApplied || recoilApplied),
    setHeadbuttTuning: partial => headbutt.setTuning(partial),
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
