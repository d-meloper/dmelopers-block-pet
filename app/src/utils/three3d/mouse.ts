import {
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  MathUtils,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

import type { DeviceColorSettings } from '@/config/deviceColors'

import { normalizeDeviceColors } from '@/config/deviceColors'
import { MODEL_3D_CONFIG } from '@/config/model3d'

interface ShellProfile {
  z: number
  width: number
  centerY: number
  halfHeight: number
}

const SHELL_PROFILES: readonly ShellProfile[] = [
  { z: -0.41, width: 0.08, centerY: 0.095, halfHeight: 0.055 },
  { z: -0.36, width: 0.19, centerY: 0.12, halfHeight: 0.11 },
  { z: -0.28, width: 0.255, centerY: 0.135, halfHeight: 0.155 },
  { z: -0.16, width: 0.292, centerY: 0.14, halfHeight: 0.19 },
  { z: -0.03, width: 0.305, centerY: 0.135, halfHeight: 0.205 },
  { z: 0.1, width: 0.298, centerY: 0.125, halfHeight: 0.2 },
  { z: 0.22, width: 0.275, centerY: 0.11, halfHeight: 0.17 },
  { z: 0.32, width: 0.225, centerY: 0.09, halfHeight: 0.125 },
  { z: 0.39, width: 0.125, centerY: 0.07, halfHeight: 0.065 },
] as const

const SHELL_PROFILE_CURVE = new CatmullRomCurve3(
  SHELL_PROFILES.map(profile => new Vector3(
    profile.z,
    profile.width,
    profile.centerY,
  )),
  false,
  'catmullrom',
  0.35,
)
const SHELL_HEIGHT_CURVE = new CatmullRomCurve3(
  SHELL_PROFILES.map(profile => new Vector3(
    profile.z,
    profile.halfHeight,
    0,
  )),
  false,
  'catmullrom',
  0.35,
)
const BUTTON_START_PROGRESS = 0.52
const BUTTON_END_PROGRESS = 0.995

function getButtonRatios(progress: number) {
  return {
    inner: MathUtils.lerp(0.25, 0.035, progress),
    outer: MathUtils.lerp(0.93, 0.9, progress),
  }
}

function sampleShellSurface(progress: number, cosine: number): Vector3 {
  const profile = SHELL_PROFILE_CURVE.getPoint(progress)
  const halfHeight = SHELL_HEIGHT_CURVE.getPoint(progress).y
  const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine))
  const ergonomicOffset = 0.014
    * Math.sin(progress * Math.PI)
    * sine

  return new Vector3(
    cosine * profile.y + ergonomicOffset,
    profile.z + sine * halfHeight,
    profile.x,
  )
}

function createMouseShellGeometry(): BufferGeometry {
  const ringCount = 37
  const radialSegments = 36
  const positions: number[] = []
  const indices: number[] = []

  for (let ring = 0; ring < ringCount; ring += 1) {
    const progress = ring / (ringCount - 1)
    const profile = SHELL_PROFILE_CURVE.getPoint(progress)
    const halfHeight = SHELL_HEIGHT_CURVE.getPoint(progress).y

    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = (segment / radialSegments) * Math.PI * 2
      const topWeight = Math.max(0, Math.sin(angle))
      const ergonomicOffset = 0.014
        * Math.sin(progress * Math.PI)
        * topWeight

      positions.push(
        Math.cos(angle) * profile.y + ergonomicOffset,
        profile.z + Math.sin(angle) * halfHeight,
        profile.x,
      )
    }
  }

  const rearProfile = SHELL_PROFILE_CURVE.getPoint(0)
  const frontProfile = SHELL_PROFILE_CURVE.getPoint(1)
  const rearCenterIndex = positions.length / 3
  positions.push(0, rearProfile.z, rearProfile.x)
  const frontCenterIndex = positions.length / 3
  positions.push(0, frontProfile.z, frontProfile.x)

  for (let ring = 0; ring < ringCount - 1; ring += 1) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const surfaceProgress = (ring + 0.5) / (ringCount - 1)
      const angle = ((segment + 0.5) / radialSegments) * Math.PI * 2
      const isTopSurface = Math.sin(angle) > 0
      const buttonProgress = MathUtils.clamp(
        (surfaceProgress - BUTTON_START_PROGRESS)
        / (BUTTON_END_PROGRESS - BUTTON_START_PROGRESS),
        0,
        1,
      )
      const ratios = getButtonRatios(buttonProgress)
      const absoluteCosine = Math.abs(Math.cos(angle))
      const isBelowButton = surfaceProgress >= BUTTON_START_PROGRESS
        && surfaceProgress <= BUTTON_END_PROGRESS
        && isTopSurface
        && absoluteCosine > ratios.inner + 0.018
        && absoluteCosine < ratios.outer - 0.018
      if (isBelowButton) continue

      const nextSegment = (segment + 1) % radialSegments
      const current = ring * radialSegments + segment
      const next = ring * radialSegments + nextSegment
      const upper = (ring + 1) * radialSegments + segment
      const upperNext = (ring + 1) * radialSegments + nextSegment

      indices.push(current, upper, next)
      indices.push(next, upper, upperNext)
    }
  }

  const frontRingOffset = (ringCount - 1) * radialSegments
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const nextSegment = (segment + 1) % radialSegments
    indices.push(rearCenterIndex, nextSegment, segment)
    indices.push(
      frontCenterIndex,
      frontRingOffset + segment,
      frontRingOffset + nextSegment,
    )
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function createMouseButtonGeometry(side: -1 | 1): BufferGeometry {
  const longitudinalSegments = 14
  const lateralSegments = 7
  const thickness = 0.018
  const surfaceOffset = 0.004
  const positions: number[] = []
  const indices: number[] = []
  const rowLength = lateralSegments + 1
  const addTriangle = (first: number, second: number, third: number) => {
    if (side === -1) {
      indices.push(first, second, third)
    } else {
      indices.push(first, third, second)
    }
  }

  for (let row = 0; row <= longitudinalSegments; row += 1) {
    const progress = row / longitudinalSegments
    const shellProgress = MathUtils.lerp(
      BUTTON_START_PROGRESS,
      BUTTON_END_PROGRESS,
      progress,
    )
    const ratios = getButtonRatios(progress)

    for (let column = 0; column <= lateralSegments; column += 1) {
      const lateralProgress = column / lateralSegments
      const cosine = side * MathUtils.lerp(
        ratios.inner,
        ratios.outer,
        lateralProgress,
      )
      const position = sampleShellSurface(shellProgress, cosine)
      positions.push(position.x, position.y + surfaceOffset, position.z)
    }
  }

  const topVertexCount = positions.length / 3
  for (let index = 0; index < topVertexCount; index += 1) {
    positions.push(
      positions[index * 3],
      positions[index * 3 + 1] - thickness,
      positions[index * 3 + 2],
    )
  }

  for (let row = 0; row < longitudinalSegments; row += 1) {
    for (let column = 0; column < lateralSegments; column += 1) {
      const current = row * rowLength + column
      const next = current + 1
      const forward = current + rowLength
      const forwardNext = forward + 1

      addTriangle(current, forwardNext, forward)
      addTriangle(current, next, forwardNext)
      addTriangle(
        topVertexCount + current,
        topVertexCount + forward,
        topVertexCount + forwardNext,
      )
      addTriangle(
        topVertexCount + current,
        topVertexCount + forwardNext,
        topVertexCount + next,
      )
    }
  }

  const addEdgeFaces = (edgeColumn: number) => {
    for (let row = 0; row < longitudinalSegments; row += 1) {
      const current = row * rowLength + edgeColumn
      const forward = current + rowLength
      addTriangle(
        current,
        topVertexCount + forward,
        topVertexCount + current,
      )
      addTriangle(current, forward, topVertexCount + forward)
    }
  }
  addEdgeFaces(0)
  addEdgeFaces(lateralSegments)

  for (const row of [0, longitudinalSegments]) {
    for (let column = 0; column < lateralSegments; column += 1) {
      const current = row * rowLength + column
      const next = current + 1
      addTriangle(current, topVertexCount + current, topVertexCount + next)
      addTriangle(current, topVertexCount + next, next)
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export interface MouseGroupResult {
  group: Group
  setColors: (colors: Pick<DeviceColorSettings, 'mouseColor' | 'mousePressedColor'>) => void
  setMouseEnabled: (enabled: boolean) => void
  resetInput: () => void
  setMousePosition: (xRatio: number, yRatio: number) => void
  setMouseButtonPressed: (button: 'Left' | 'Right' | 'Middle', pressed: boolean) => void
  pulseWheelScroll: (deltaX: number, deltaY: number) => void
  update: (deltaMilliseconds: number, timestamp: number) => void
  dispose: () => void
}

interface MouseButtonState {
  mesh: Mesh
  material: MeshStandardMaterial
  baseColor: Color
  baseY: number
  baseRotationX: number
  pressed: boolean
  minimumPressedUntil: number
  progress: number
}

export function createMouseGroup(): MouseGroupResult {
  const { interaction, palette } = MODEL_3D_CONFIG.mouse
  const visualOffsetY = -MODEL_3D_CONFIG.objectVerticalGap
    / MODEL_3D_CONFIG.mouse.scale
  const group = new Group()
  group.name = 'mouseGroup'
  const mouseDevice = new Group()
  mouseDevice.name = 'mouseDevice'
  const handAnchor = new Group()
  handAnchor.name = 'mouseHandAnchor'
  handAnchor.position.set(...MODEL_3D_CONFIG.mouse.handAnchorPosition)

  const shellGeometry = createMouseShellGeometry()
  const leftButtonGeometry = createMouseButtonGeometry(-1)
  const rightButtonGeometry = createMouseButtonGeometry(1)
  const centerTrimGeometry = new RoundedBoxGeometry(
    0.045,
    0.018,
    0.32,
    5,
    0.01,
  )
  const wheelGeometry = new CylinderGeometry(0.045, 0.045, 0.095, 20)

  const bodyMaterial = new MeshPhysicalMaterial({
    color: palette.body,
    metalness: 0.025,
    roughness: 0.46,
    clearcoat: 0.18,
    clearcoatRoughness: 0.72,
    side: DoubleSide,
  })
  const createButtonMaterial = () => new MeshPhysicalMaterial({
    color: palette.button,
    metalness: 0.02,
    roughness: 0.4,
    clearcoat: 0.2,
    clearcoatRoughness: 0.68,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  })
  const leftButtonMaterial = createButtonMaterial()
  const rightButtonMaterial = createButtonMaterial()
  const trimMaterial = new MeshStandardMaterial({
    color: palette.trim,
    metalness: 0.12,
    roughness: 0.62,
  })
  const wheelMaterial = new MeshStandardMaterial({
    color: palette.wheel,
    metalness: 0.04,
    roughness: 0.76,
  })

  const shell = new Mesh(shellGeometry, bodyMaterial)
  shell.name = 'mouseBody'
  shell.position.set(0, visualOffsetY, -0.01)
  shell.castShadow = true
  shell.receiveShadow = true

  const leftButton = new Mesh(leftButtonGeometry, leftButtonMaterial)
  leftButton.name = 'mouseLeftButton'
  leftButton.position.set(0, visualOffsetY, 0)
  leftButton.castShadow = true
  leftButton.receiveShadow = true

  const rightButton = new Mesh(rightButtonGeometry, rightButtonMaterial)
  rightButton.name = 'mouseRightButton'
  rightButton.position.set(0, visualOffsetY, 0)
  rightButton.castShadow = true
  rightButton.receiveShadow = true

  const centerTrim = new Mesh(centerTrimGeometry, trimMaterial)
  centerTrim.name = 'mouseCenterTrim'
  centerTrim.position.set(0, 0.344 + visualOffsetY, 0.075)
  centerTrim.rotation.x = 0.21
  centerTrim.receiveShadow = true

  const wheel = new Mesh(wheelGeometry, wheelMaterial)
  wheel.name = 'mouseWheel'
  wheel.position.set(0, 0.378 + visualOffsetY, 0.105)
  wheel.rotation.z = Math.PI / 2
  wheel.rotation.x = 0.08
  wheel.castShadow = true

  mouseDevice.add(
    shell,
    leftButton,
    rightButton,
    centerTrim,
    wheel,
    handAnchor,
  )
  group.add(mouseDevice)

  const pressedButtonColor = new Color(interaction.pressedColor)
  const baseButtonEmissive = new Color(0x000000)
  const originalBodyColor = bodyMaterial.color.clone()
  const originalButtonColor = leftButtonMaterial.color.clone()
  const bodyTint = new Color()
  const buttonStates: Record<'Left' | 'Right' | 'Middle', MouseButtonState> = {
    Left: {
      mesh: leftButton,
      material: leftButtonMaterial,
      baseColor: leftButtonMaterial.color.clone(),
      baseY: leftButton.position.y,
      baseRotationX: leftButton.rotation.x,
      pressed: false,
      minimumPressedUntil: 0,
      progress: 0,
    },
    Right: {
      mesh: rightButton,
      material: rightButtonMaterial,
      baseColor: rightButtonMaterial.color.clone(),
      baseY: rightButton.position.y,
      baseRotationX: rightButton.rotation.x,
      pressed: false,
      minimumPressedUntil: 0,
      progress: 0,
    },
    Middle: {
      mesh: wheel,
      material: wheelMaterial,
      baseColor: wheelMaterial.color.clone(),
      baseY: wheel.position.y,
      baseRotationX: wheel.rotation.x,
      pressed: false,
      minimumPressedUntil: 0,
      progress: 0,
    },
  }
  let targetX = 0
  let targetZ = 0
  let mouseEnabled = true

  const geometries = [
    shellGeometry,
    leftButtonGeometry,
    rightButtonGeometry,
    centerTrimGeometry,
    wheelGeometry,
  ]
  const materials = [
    bodyMaterial,
    leftButtonMaterial,
    rightButtonMaterial,
    trimMaterial,
    wheelMaterial,
  ]
  let disposed = false

  const applyButtonAppearance = (state: MouseButtonState) => {
    const easedProgress = MathUtils.smoothstep(state.progress, 0, 1)
    const visibleTravel = Math.min(interaction.buttonTravel, 0.0035)
    const pressTilt = Math.min(interaction.buttonTravel * 0.8, 0.018)
    // Wheel feedback shares the button color/timing without inventing wheel motion.
    if (state !== buttonStates.Middle) {
      state.mesh.position.y = state.baseY - visibleTravel * easedProgress
      state.mesh.rotation.x = state.baseRotationX + pressTilt * easedProgress
    }
    state.material.color.lerpColors(state.baseColor, pressedButtonColor, easedProgress)
    state.material.emissive.lerpColors(baseButtonEmissive, pressedButtonColor, easedProgress)
    state.material.emissiveIntensity = 0.18 * easedProgress
  }

  const resetInput = () => {
    if (disposed) return
    targetX = 0
    targetZ = 0
    mouseDevice.position.set(0, 0, 0)
    for (const state of Object.values(buttonStates)) {
      state.pressed = false
      state.minimumPressedUntil = 0
      state.progress = 0
      state.mesh.position.y = state.baseY
      state.mesh.rotation.x = state.baseRotationX
      state.material.color.copy(state.baseColor)
      state.material.emissive.copy(baseButtonEmissive)
      state.material.emissiveIntensity = 0
    }
  }

  return {
    group,
    resetInput,
    setColors: (colors) => {
      if (disposed) return
      const normalized = normalizeDeviceColors(colors)
      bodyTint.set(normalized.mouseColor)
      bodyMaterial.color.copy(originalBodyColor).multiply(bodyTint)
      buttonStates.Left.baseColor.copy(originalButtonColor).multiply(bodyTint)
      buttonStates.Right.baseColor.copy(originalButtonColor).multiply(bodyTint)
      pressedButtonColor.set(normalized.mousePressedColor)
      Object.values(buttonStates).forEach(applyButtonAppearance)
    },
    setMouseEnabled: (enabled) => {
      if (disposed || mouseEnabled === enabled) return
      mouseEnabled = enabled
      group.visible = enabled
      resetInput()
    },
    setMousePosition: (xRatio, yRatio) => {
      if (disposed || !mouseEnabled) return
      const horizontalPosition = MathUtils.lerp(
        -1,
        1,
        1 - MathUtils.clamp(xRatio, 0, 1),
      )
      targetX = horizontalPosition * interaction.xRange
      const linearTargetZ = MathUtils.lerp(
        -interaction.zRange,
        interaction.zRange,
        1 - MathUtils.clamp(yRatio, 0, 1),
      )
      targetZ = linearTargetZ
        - horizontalPosition * horizontalPosition * interaction.curveDepth
    },
    setMouseButtonPressed: (button, pressed) => {
      if (disposed || !mouseEnabled) return
      const state = buttonStates[button === 'Middle' ? 'Middle' : button === 'Left' ? 'Right' : 'Left']
      if (state.pressed === pressed) return

      state.pressed = pressed
      if (pressed) {
        state.minimumPressedUntil = performance.now() + interaction.minimumPressMs
      }
    },
    pulseWheelScroll: (deltaX, deltaY) => {
      if (disposed || !mouseEnabled || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return
      if (deltaX === 0 && deltaY === 0) return
      buttonStates.Middle.minimumPressedUntil = performance.now() + interaction.minimumPressMs
    },
    update: (deltaMilliseconds, timestamp) => {
      if (disposed || !mouseEnabled) return
      const deltaSeconds = deltaMilliseconds / 1000
      mouseDevice.position.x = MathUtils.damp(
        mouseDevice.position.x,
        targetX,
        interaction.followDamping,
        deltaSeconds,
      )
      mouseDevice.position.z = MathUtils.damp(
        mouseDevice.position.z,
        targetZ,
        interaction.followDamping,
        deltaSeconds,
      )

      Object.values(buttonStates).forEach((state) => {
        const shouldPress = state.pressed || timestamp < state.minimumPressedUntil
        const duration = shouldPress
          ? interaction.pressDurationMs
          : interaction.releaseDurationMs
        const direction = shouldPress ? 1 : -1
        state.progress = MathUtils.clamp(
          state.progress + direction * deltaMilliseconds / duration,
          0,
          1,
        )

        applyButtonAppearance(state)
      })
    },
    dispose: () => {
      if (disposed) return

      resetInput()
      disposed = true
      group.clear()
      geometries.forEach(geometry => geometry.dispose())
      materials.forEach(material => material.dispose())
    },
  }
}
