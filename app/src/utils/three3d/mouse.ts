import {
  Box3,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  MathUtils,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Vector3,
} from 'three'
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'

import type { DeviceColorSettings } from '@/config/deviceColors'

import { normalizeDeviceColors } from '@/config/deviceColors'
import { MODEL_3D_CONFIG } from '@/config/model3d'

// Local +Z is the button end. These dimensions retain the original device's
// envelope and desk clearance; scene placement and the hand anchor live in config.
const MOUSE_REAR_Z = -0.42
const MOUSE_FRONT_Z = 0.38795802
const MOUSE_BOTTOM_Y = -0.075231828
const MOUSE_WHEEL_TOP_Y = 0.42645224
const PANEL_THICKNESS = 0.016
const SHELL_COLUMNS = [-1, -0.98, -0.92, -0.8, -0.6, -0.32, 0, 0.32, 0.6, 0.8, 0.92, 0.98, 1]
// Width, crown, shoulder. A broad palm hump falls into a lower button nose;
// the same surface owns the housing, both button panels and their backing.
const SHELL_PROFILE = new CatmullRomCurve3([
  new Vector3(0.235, 0.175, 0.065),
  new Vector3(0.279, 0.318, 0.102),
  new Vector3(0.299, 0.365, 0.118),
  new Vector3(0.305, 0.384, 0.121),
  new Vector3(0.305, 0.371, 0.119),
  new Vector3(0.298, 0.344, 0.116),
  new Vector3(0.284, 0.311, 0.11),
  new Vector3(0.264, 0.266, 0.099),
  new Vector3(0.235, 0.222, 0.084),
], false, 'catmullrom', 0.35)

function sampleShellSurface(progress: number, lateral: number): Vector3 {
  const profile = SHELL_PROFILE.getPoint(progress)
  const shoulder = Math.max(0, Math.cos(lateral * Math.PI / 2)) ** 0.62
  return new Vector3(
    lateral * Math.min(0.305, profile.x),
    MathUtils.lerp(profile.z, profile.y, shoulder),
    MathUtils.lerp(
      MOUSE_REAR_Z + 0.095 * lateral * lateral,
      MOUSE_FRONT_Z - 0.06 * lateral * lateral,
      progress,
    ),
  )
}

// Closed surfaces with explicit side walls, never a perforated body hidden by
// overlapping button sheets. Separate crease normals keep the narrow seams crisp.
function createShellPatch(
  rows: readonly number[],
  columns: readonly number[],
  sample: (row: number, column: number) => Vector3,
  thickness: number,
  housing = false,
): BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  const rowSize = columns.length
  const count = rows.length * rowSize
  for (const row of rows) {
    for (const column of columns) {
      const point = sample(row, column)
      positions.push(point.x, point.y, point.z)
    }
  }
  for (let vertex = 0; vertex < count; vertex += 1) {
    positions.push(
      positions[vertex * 3] * (housing ? 0.91 : 1),
      housing ? MOUSE_BOTTOM_Y : positions[vertex * 3 + 1] - thickness,
      positions[vertex * 3 + 2] * (housing ? 0.91 : 1),
    )
  }
  for (let row = 0; row < rows.length - 1; row += 1) {
    for (let column = 0; column < rowSize - 1; column += 1) {
      const a = row * rowSize + column
      const b = a + 1
      const c = a + rowSize
      const d = c + 1
      indices.push(a, c, b, b, c, d)
      indices.push(a + count, b + count, c + count, b + count, d + count, c + count)
    }
  }
  // Clockwise viewed from above; the walls face away from this perimeter.
  const perimeter: number[] = []
  for (let column = 0; column < rowSize; column += 1) perimeter.push(column)
  for (let row = 1; row < rows.length; row += 1) perimeter.push(row * rowSize + rowSize - 1)
  for (let column = rowSize - 2; column >= 0; column -= 1) perimeter.push((rows.length - 1) * rowSize + column)
  for (let row = rows.length - 2; row > 0; row -= 1) perimeter.push(row * rowSize)

  const joinRings = (upper: number[], lower: number[]) => {
    for (let index = 0; index < upper.length; index += 1) {
      const next = (index + 1) % upper.length
      indices.push(upper[index], upper[next], lower[next], upper[index], lower[next], lower[index])
    }
  }
  let ring = perimeter
  if (housing) {
    // A real lower enclosure with a small base bevel, rather than an ellipsoid
    // that bulges below the desk. Keep the original lowest point for saved sizes.
    for (const [scale, height] of [[0.995, 0.005], [0.985, -0.052]]) {
      const next = perimeter.map((vertex) => {
        const index = positions.length / 3
        positions.push(positions[vertex * 3] * scale, height, positions[vertex * 3 + 2] * scale)
        return index
      })
      joinRings(ring, next)
      ring = next
    }
  }
  joinRings(ring, perimeter.map(vertex => vertex + count))
  const indexed = new BufferGeometry()
  indexed.setAttribute('position', new Float32BufferAttribute(positions, 3))
  indexed.setIndex(indices)
  const geometry = toCreasedNormals(indexed, Math.PI / 3)
  indexed.dispose()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

const FULL_SHELL_ROWS = Array.from({ length: 25 }, (_, index) => index / 24)

function createMouseShellGeometry(): BufferGeometry {
  const lower = createShellPatch(FULL_SHELL_ROWS, SHELL_COLUMNS, (row, column) => {
    const point = sampleShellSurface(row, column)
    point.y -= 0.041
    return point
  }, 0, true)
  const palm = createShellPatch(
    Array.from({ length: 13 }, (_, index) => index / 12 * 0.495),
    SHELL_COLUMNS,
    sampleShellSurface,
    PANEL_THICKNESS,
  )
  const geometry = mergeGeometries([lower, palm])!
  lower.dispose()
  palm.dispose()
  return geometry
}

function createMouseButtonGeometry(side: -1 | 1): BufferGeometry {
  return createShellPatch(
    [0.505, 0.54, 0.57, 0.61, 0.67, 0.73, 0.77, 0.81, 0.87, 0.94, 1],
    [0, 0.24, 0.5, 0.74, 0.87, 0.94, 0.98, 1],
    (progress, column) => {
      const profile = SHELL_PROFILE.getPoint(progress)
      const wheelOpening = MathUtils.smoothstep(progress, 0.54, 0.57)
        * (1 - MathUtils.smoothstep(progress, 0.77, 0.81))
      const inner = (0.004 + 0.033 * wheelOpening) / Math.min(0.305, profile.x)
      const lateral = side === -1
        ? MathUtils.lerp(-1, -inner, column)
        : MathUtils.lerp(inner, 1, column)
      return sampleShellSurface(progress, lateral)
    },
    PANEL_THICKNESS,
  )
}

function createMouseTrimGeometry(): BufferGeometry {
  return createShellPatch(FULL_SHELL_ROWS, SHELL_COLUMNS, (row, column) => {
    const point = sampleShellSurface(row, column)
    // Clearance for the complete existing press travel + tilt, with no coplanar
    // backing or holes through the housing when a button is held.
    point.y -= 0.029
    return point
  }, 0.009)
}

function createMouseWheelGeometry(): BufferGeometry {
  const geometry = new CylinderGeometry(0.076, 0.076, 0.054, 64)
  const position = geometry.getAttribute('position')
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index)
    const z = position.getZ(index)
    if (Math.hypot(x, z) < 0.001) continue
    const segment = Math.round(Math.atan2(x, z) / (Math.PI * 2) * 64)
    const radius = segment % 2 === 0 ? 0.076 : 0.0738
    const angle = Math.atan2(x, z)
    position.setXYZ(index, Math.sin(angle) * radius, position.getY(index), Math.cos(angle) * radius)
  }
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
  const centerTrimGeometry = createMouseTrimGeometry()
  const wheelGeometry = createMouseWheelGeometry()

  const bodyMaterial = new MeshPhysicalMaterial({
    color: palette.body,
    metalness: 0.025,
    roughness: 0.46,
    clearcoat: 0.18,
    clearcoatRoughness: 0.72,
  })
  const createButtonMaterial = () => new MeshPhysicalMaterial({
    color: palette.button,
    metalness: 0.02,
    roughness: 0.4,
    clearcoat: 0.2,
    clearcoatRoughness: 0.68,
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
  shell.position.set(0, visualOffsetY, 0)
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
  centerTrim.position.set(0, visualOffsetY, 0)
  centerTrim.receiveShadow = true

  const wheel = new Mesh(wheelGeometry, wheelMaterial)
  wheel.name = 'mouseWheel'
  wheel.rotation.z = Math.PI / 2
  wheel.rotation.x = 0.08
  const wheelTop = new Box3().setFromObject(wheel).max.y
  wheel.position.set(0, MOUSE_WHEEL_TOP_Y - wheelTop + visualOffsetY, 0.105)
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
