import type { Material } from 'three'

import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
} from 'three'

import type { DeviceColorSettings } from '@/config/deviceColors'

import { normalizeDeviceColors } from '@/config/deviceColors'
import { MODEL_3D_CONFIG } from '@/config/model3d'

interface KeyDefinition {
  legend: string
  inputKeys: readonly string[]
  units?: number
}

export type KeyboardLegendLanguage = 'ko' | 'en'

export interface KeyboardContactAddress {
  row: number
  column: number
}

export interface KeyboardGroupResult {
  group: Group
  getContactTarget: (contact: KeyboardContactAddress) => KeyboardKeyTarget | undefined
  getKeyTarget: (key: string) => KeyboardKeyTarget | undefined
  setLegendLanguage: (language: KeyboardLegendLanguage) => void
  setColors: (colors: Pick<DeviceColorSettings, 'keyboardColor' | 'keyboardKeycapColor' | 'keyboardLegendColor' | 'keyboardPressedColor'>) => void
  setContactPressed: (contact: KeyboardContactAddress, pressed: boolean) => void
  setKeyPressed: (key: string, pressed: boolean) => void
  update: (deltaMilliseconds: number, timestamp: number) => void
  dispose: () => void
}

export interface KeyboardKeyTarget {
  position: [number, number, number]
}

interface KeyAnimationState {
  group: Group
  material: MeshStandardMaterial
  baseY: number
  held: boolean
  minimumPressUntil: number
  progress: number
}

const BOARD_WIDTH = 3.3
const BOARD_DEPTH = 1.16
const BOARD_HEIGHT = 0.1
const INNER_WIDTH = 3.08
const MAX_ROW_UNITS = 16
const UNIT_PITCH = INNER_WIDTH / MAX_ROW_UNITS
const KEY_GAP = 0.014
const KEY_DEPTH = 0.18
const KEY_HEIGHT = 0.105
const ROW_PITCH = 0.205
const LEGEND_WIDTH_RATIO = 0.82
const LEGEND_DEPTH_RATIO = 0.8
const LEGEND_TEXTURE_HEIGHT = 512
const LEGEND_MAX_ANISOTROPY = 8
const KEY_DISH_DEPTH = 0.0055
const LEGEND_SURFACE_OFFSET = 0.0006

type RoundedProfile = readonly [height: number, width: number, depth: number, radius: number]

function roundedOutline(width: number, depth: number, radius: number): Array<[number, number]> {
  const points: Array<[number, number]> = []
  const corners = [
    [width / 2 - radius, depth / 2 - radius],
    [-width / 2 + radius, depth / 2 - radius],
    [-width / 2 + radius, -depth / 2 + radius],
    [width / 2 - radius, -depth / 2 + radius],
  ]
  corners.forEach(([x, z], corner) => {
    for (let step = 0; step <= 6; step += 1) {
      const angle = (corner + step / 6) * Math.PI / 2
      // Positive winding around the existing +Y up axis.
      points.push([x + radius * Math.cos(angle), -(z + radius * Math.sin(angle))])
    }
  })
  return points
}

function geometryFromSurface(positions: number[], indices: number[]): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

// Ring profiles are the selected rounded-sculpt preview's authored dimensions.
// Keep the original centered mesh origins so press animation and hand targets
// remain independent of the new shell and its shallow dish.
function createRoundedShell(profiles: readonly RoundedProfile[], dishDepth = 0) {
  const positions: number[] = []
  const indices: number[] = []
  for (const [y, width, depth, radius] of profiles) {
    for (const [x, z] of roundedOutline(width, depth, radius)) positions.push(x, y, z)
  }
  const ringSize = positions.length / 3 / profiles.length
  const connectRings = (first: number, second: number) => {
    for (let index = 0; index < ringSize; index += 1) {
      const next = (index + 1) % ringSize
      indices.push(first + index, first + next, second + next, first + index, second + next, second + index)
    }
  }
  for (let ring = 0; ring < profiles.length - 1; ring += 1) connectRings(ring * ringSize, (ring + 1) * ringSize)

  const topStart = (profiles.length - 1) * ringSize
  const topIndexStart = indices.length
  const [topY, topWidth, topDepth, topRadius] = profiles[profiles.length - 1]
  let lastRing = topStart
  if (dishDepth > 0) {
    const outline = roundedOutline(topWidth, topDepth, topRadius)
    for (const [fraction, drop] of [[0.8, 0.35], [0.47, 0.84], [0.13, 1]]) {
      const nextRing = positions.length / 3
      for (const [x, z] of outline) positions.push(x * fraction, topY - dishDepth * drop, z * fraction)
      connectRings(lastRing, nextRing)
      lastRing = nextRing
    }
  }
  const center = positions.length / 3
  positions.push(0, topY - dishDepth, 0)
  for (let index = 0; index < ringSize; index += 1) indices.push(center, lastRing + index, lastRing + (index + 1) % ringSize)
  // Reuse this exact triangulation for lettering; a flat decal would float over
  // the center or disappear into the rim when viewed from a low angle.
  const topPositions = positions.slice(topStart * 3)
  const topIndices = indices.slice(topIndexStart).map(index => index - topStart)

  // Split underside normals from the rounded walls without opening the shell.
  const bottomStart = positions.length / 3
  positions.push(...positions.slice(0, ringSize * 3))
  const bottomCenter = positions.length / 3
  positions.push(0, profiles[0][0], 0)
  for (let index = 0; index < ringSize; index += 1) indices.push(bottomCenter, bottomStart + (index + 1) % ringSize, bottomStart + index)
  return { geometry: geometryFromSurface(positions, indices), topPositions, topIndices }
}

function createKeyboardHousingGeometry(): BufferGeometry {
  return createRoundedShell([
    [-BOARD_HEIGHT / 2, BOARD_WIDTH - 0.038, BOARD_DEPTH - 0.038, 0.055],
    [0.018 - BOARD_HEIGHT / 2, BOARD_WIDTH, BOARD_DEPTH, 0.065],
    [0.073 - BOARD_HEIGHT / 2, BOARD_WIDTH, BOARD_DEPTH, 0.065],
    [0.092 - BOARD_HEIGHT / 2, BOARD_WIDTH - 0.008, BOARD_DEPTH - 0.008, 0.067],
    [BOARD_HEIGHT / 2, BOARD_WIDTH - 0.028, BOARD_DEPTH - 0.028, 0.062],
  ]).geometry
}

function createSculptedKeyGeometry(width: number) {
  const { geometry, topPositions, topIndices } = createRoundedShell([
    [-KEY_HEIGHT / 2, width, KEY_DEPTH, 0.026],
    [0.016 - KEY_HEIGHT / 2, width, KEY_DEPTH, 0.027],
    [0.066 - KEY_HEIGHT / 2, width - 0.016, KEY_DEPTH - 0.018, 0.032],
    [0.091 - KEY_HEIGHT / 2, width - 0.020, KEY_DEPTH - 0.025, 0.032],
    [KEY_HEIGHT / 2, width - 0.029, KEY_DEPTH - 0.032, 0.029],
  ], KEY_DISH_DEPTH)
  const uv: number[] = []
  for (let index = 0; index < topPositions.length; index += 3) {
    uv.push(
      topPositions[index] / (width * LEGEND_WIDTH_RATIO) + 0.5,
      0.5 - topPositions[index + 2] / (KEY_DEPTH * LEGEND_DEPTH_RATIO),
    )
    topPositions[index + 1] += LEGEND_SURFACE_OFFSET
  }
  const legend = geometryFromSurface(topPositions, topIndices)
  legend.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  return { keycap: geometry, legend }
}

const ENGLISH_LEGENDS_BY_INPUT: Readonly<Record<string, string>> = {
  KeyQ: 'Q',
  KeyW: 'W',
  KeyE: 'E',
  KeyR: 'R',
  KeyT: 'T',
  KeyY: 'Y',
  KeyU: 'U',
  KeyI: 'I',
  KeyO: 'O',
  KeyP: 'P',
  KeyA: 'A',
  KeyS: 'S',
  KeyD: 'D',
  KeyF: 'F',
  KeyG: 'G',
  KeyH: 'H',
  KeyJ: 'J',
  KeyK: 'K',
  KeyL: 'L',
  KeyZ: 'Z',
  KeyX: 'X',
  KeyC: 'C',
  KeyV: 'V',
  KeyB: 'B',
  KeyN: 'N',
  KeyM: 'M',
}

const KEYBOARD_ROWS: readonly (readonly KeyDefinition[])[] = [
  [
    { legend: 'ESC', inputKeys: ['Escape'] },
    { legend: '1', inputKeys: ['Num1'] },
    { legend: '2', inputKeys: ['Num2'] },
    { legend: '3', inputKeys: ['Num3'] },
    { legend: '4', inputKeys: ['Num4'] },
    { legend: '5', inputKeys: ['Num5'] },
    { legend: '6', inputKeys: ['Num6'] },
    { legend: '7', inputKeys: ['Num7'] },
    { legend: '8', inputKeys: ['Num8'] },
    { legend: '9', inputKeys: ['Num9'] },
    { legend: '0', inputKeys: ['Num0'] },
    { legend: '-', inputKeys: ['Minus'] },
    { legend: '=', inputKeys: ['Equal'] },
    { legend: 'BACK', inputKeys: ['Backspace'], units: 1.75 },
    { legend: 'DEL', inputKeys: ['Delete'] },
  ],
  [
    { legend: 'TAB', inputKeys: ['Tab'], units: 1.5 },
    { legend: 'ㅂ', inputKeys: ['KeyQ'] },
    { legend: 'ㅈ', inputKeys: ['KeyW'] },
    { legend: 'ㄷ', inputKeys: ['KeyE'] },
    { legend: 'ㄱ', inputKeys: ['KeyR'] },
    { legend: 'ㅅ', inputKeys: ['KeyT'] },
    { legend: 'ㅛ', inputKeys: ['KeyY'] },
    { legend: 'ㅕ', inputKeys: ['KeyU'] },
    { legend: 'ㅑ', inputKeys: ['KeyI'] },
    { legend: 'ㅐ', inputKeys: ['KeyO'] },
    { legend: 'ㅔ', inputKeys: ['KeyP'] },
    { legend: '[', inputKeys: ['LeftBracket'] },
    { legend: ']', inputKeys: ['RightBracket'] },
    { legend: '\\', inputKeys: ['BackSlash'], units: 1.25 },
    { legend: 'HOME', inputKeys: ['Home'] },
  ],
  [
    { legend: 'CAPS', inputKeys: ['CapsLock'], units: 1.75 },
    { legend: 'ㅁ', inputKeys: ['KeyA'] },
    { legend: 'ㄴ', inputKeys: ['KeyS'] },
    { legend: 'ㅇ', inputKeys: ['KeyD'] },
    { legend: 'ㄹ', inputKeys: ['KeyF'] },
    { legend: 'ㅎ', inputKeys: ['KeyG'] },
    { legend: 'ㅗ', inputKeys: ['KeyH'] },
    { legend: 'ㅓ', inputKeys: ['KeyJ'] },
    { legend: 'ㅏ', inputKeys: ['KeyK'] },
    { legend: 'ㅣ', inputKeys: ['KeyL'] },
    { legend: ';', inputKeys: ['SemiColon'] },
    { legend: '\'', inputKeys: ['Quote'] },
    { legend: 'ENTER', inputKeys: ['Return'], units: 2 },
    { legend: 'PGUP', inputKeys: ['PageUp'] },
  ],
  [
    { legend: 'SHIFT', inputKeys: ['ShiftLeft'], units: 2.25 },
    { legend: 'ㅋ', inputKeys: ['KeyZ'] },
    { legend: 'ㅌ', inputKeys: ['KeyX'] },
    { legend: 'ㅊ', inputKeys: ['KeyC'] },
    { legend: 'ㅍ', inputKeys: ['KeyV'] },
    { legend: 'ㅠ', inputKeys: ['KeyB'] },
    { legend: 'ㅜ', inputKeys: ['KeyN'] },
    { legend: 'ㅡ', inputKeys: ['KeyM'] },
    { legend: ',', inputKeys: ['Comma'] },
    { legend: '.', inputKeys: ['Dot'] },
    { legend: '/', inputKeys: ['Slash'] },
    { legend: 'SHIFT', inputKeys: ['ShiftRight'], units: 1.5 },
    { legend: '↑', inputKeys: ['UpArrow'] },
    { legend: 'PGDN', inputKeys: ['PageDown'] },
  ],
  [
    { legend: 'CTRL', inputKeys: ['ControlLeft'], units: 1.25 },
    { legend: 'WIN', inputKeys: ['MetaLeft'], units: 1.25 },
    { legend: 'ALT', inputKeys: ['Alt'], units: 1.25 },
    { legend: 'SPACE', inputKeys: ['Space'], units: 6.25 },
    { legend: 'LANG', inputKeys: ['Lang1', 'Hangul', 'AltGr'], units: 1.25 },
    { legend: 'FN', inputKeys: ['Function'], units: 1.25 },
    { legend: '←', inputKeys: ['LeftArrow'] },
    { legend: '↓', inputKeys: ['DownArrow'] },
    { legend: '→', inputKeys: ['RightArrow'] },
  ],
]

function createLegendTexture(
  legend: string,
  physicalWidth: number,
): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.height = LEGEND_TEXTURE_HEIGHT
  canvas.width = Math.min(
    2048,
    Math.max(
      LEGEND_TEXTURE_HEIGHT,
      Math.round(LEGEND_TEXTURE_HEIGHT * physicalWidth / KEY_DEPTH),
    ),
  )

  const context = canvas.getContext('2d')
  if (!context) throw new Error('Unable to create the keyboard legend canvas.')

  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#ffffff'
  context.textAlign = 'center'
  context.textBaseline = 'middle'

  let fontSize = Math.round(canvas.height * 0.82)
  const maximumTextWidth = canvas.width * 0.84
  const legendCodePoint = legend.codePointAt(0) ?? 0
  const isKoreanLegend = legend.length === 1
    && legendCodePoint >= 0x3131
    && legendCodePoint <= 0x3163
  do {
    const fontFamily = isKoreanLegend
      ? '"Malgun Gothic", "Segoe UI", sans-serif'
      : '"Arial Black", "Segoe UI", sans-serif'
    context.font = `900 ${fontSize}px ${fontFamily}`
    if (context.measureText(legend).width <= maximumTextWidth) break
    fontSize -= 8
  } while (fontSize > 64)
  context.fillText(legend, canvas.width / 2, canvas.height / 2)

  const texture = new CanvasTexture(canvas)
  texture.name = `keyboard-legend-${legend.replace(/\s+/g, '-')}`
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = LEGEND_MAX_ANISOTROPY
  texture.needsUpdate = true
  return texture
}

export function createKeyboardGroup(): KeyboardGroupResult {
  const { interaction, palette } = MODEL_3D_CONFIG.keyboard
  const visualOffsetY = -MODEL_3D_CONFIG.objectVerticalGap
    / MODEL_3D_CONFIG.keyboard.scale
  const group = new Group()
  group.name = 'keyboardGroup'

  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const keyGeometries = new Map<number, ReturnType<typeof createSculptedKeyGeometry>>()
  const legendTextures = new Map<string, CanvasTexture>()
  const legendMaterials = new Map<string, MeshBasicMaterial>()
  const switchableLegends: Array<{
    mesh: Mesh
    keyWidth: number
    korean: string
    english: string
  }> = []
  const keyAnimations: KeyAnimationState[] = []
  const keyAnimationsByContact = new Map<string, KeyAnimationState>()
  const keyAnimationsByInput = new Map<string, KeyAnimationState>()
  const keyTargetsByContact = new Map<string, KeyboardKeyTarget>()
  const keyTargetsByInput = new Map<string, KeyboardKeyTarget>()
  const baseKeycapColor = new Color(palette.keycap)
  const pressedKeycapColor = new Color(interaction.pressedColor)
  const legendColor = new Color(palette.legend)

  const housingGeometry = createKeyboardHousingGeometry()
  const housingMaterial = new MeshStandardMaterial({
    color: palette.housing,
    metalness: 0,
    roughness: 0.9,
  })

  geometries.add(housingGeometry)
  materials.add(housingMaterial)

  const housing = new Mesh(housingGeometry, housingMaterial)
  housing.name = 'keyboard-housing'
  housing.position.y = BOARD_HEIGHT / 2 + visualOffsetY
  housing.castShadow = true
  housing.receiveShadow = true
  group.add(housing)

  const getKeyGeometry = (units: number) => {
    const cached = keyGeometries.get(units)
    if (cached) return cached

    const width = units * UNIT_PITCH - KEY_GAP
    const geometry = createSculptedKeyGeometry(width)
    keyGeometries.set(units, geometry)
    geometries.add(geometry.keycap)
    geometries.add(geometry.legend)
    return geometry
  }

  const getLegendMaterial = (legend: string, keyWidth: number) => {
    const cacheKey = `${legend}:${keyWidth.toFixed(4)}`
    const cached = legendMaterials.get(cacheKey)
    if (cached) return cached

    const texture = createLegendTexture(legend, keyWidth)
    const material = new MeshBasicMaterial({
      color: legendColor,
      map: texture,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      transparent: true,
    })

    legendTextures.set(cacheKey, texture)
    legendMaterials.set(cacheKey, material)
    materials.add(material)
    return material
  }

  KEYBOARD_ROWS.forEach((row, rowIndex) => {
    const rowUnits = row.reduce((sum, key) => sum + (key.units ?? 1), 0)
    let cursorX = (-rowUnits * UNIT_PITCH) / 2
    const z = (rowIndex - (KEYBOARD_ROWS.length - 1) / 2) * ROW_PITCH

    row.forEach((key, columnIndex) => {
      const units = key.units ?? 1
      const keyWidth = units * UNIT_PITCH - KEY_GAP
      const keyName = `keyboard-key-r${rowIndex}-c${columnIndex}`
      const keyTargetY = BOARD_HEIGHT + 0.012 + KEY_HEIGHT / 2
      const keyGroup = new Group()
      const keycapMaterial = new MeshStandardMaterial({
        color: palette.keycap,
        metalness: 0,
        roughness: 0.9,
      })
      const keyGeometry = getKeyGeometry(units)
      const keycap = new Mesh(keyGeometry.keycap, keycapMaterial)

      materials.add(keycapMaterial)
      keyGroup.name = `${keyName}-group`
      keyGroup.position.set(
        cursorX + (units * UNIT_PITCH) / 2,
        keyTargetY + visualOffsetY,
        z,
      )
      keyGroup.userData.inputKeys = key.inputKeys

      keycap.name = keyName
      keycap.castShadow = true
      keycap.receiveShadow = true
      keycap.userData.legend = key.legend
      keycap.userData.units = units
      keyGroup.add(keycap)

      const legend = new Mesh(keyGeometry.legend, getLegendMaterial(key.legend, keyWidth))
      legend.name = `${keyName}-legend`
      legend.renderOrder = 1
      keyGroup.add(legend)
      group.add(keyGroup)

      const englishLegend = key.inputKeys
        .map(inputKey => ENGLISH_LEGENDS_BY_INPUT[inputKey])
        .find(Boolean)
      if (englishLegend) {
        switchableLegends.push({
          mesh: legend,
          keyWidth,
          korean: key.legend,
          english: englishLegend,
        })
      }

      const animationState: KeyAnimationState = {
        group: keyGroup,
        material: keycapMaterial,
        baseY: keyGroup.position.y,
        held: false,
        minimumPressUntil: 0,
        progress: 0,
      }

      keyAnimations.push(animationState)
      const target = {
        position: [
          keyGroup.position.x,
          keyTargetY + KEY_HEIGHT / 2,
          keyGroup.position.z,
        ] as [number, number, number],
      }
      key.inputKeys.forEach((inputKey) => {
        keyAnimationsByInput.set(inputKey, animationState)
        keyTargetsByInput.set(inputKey, target)
      })
      const contactId = `${rowIndex}:${columnIndex}`
      keyAnimationsByContact.set(contactId, animationState)
      keyTargetsByContact.set(contactId, target)

      cursorX += units * UNIT_PITCH
    })
  })

  let disposed = false
  const getContactId = (contact: KeyboardContactAddress) => (
    `${contact.row}:${contact.column}`
  )
  const getContactTarget = (contact: KeyboardContactAddress) => (
    keyTargetsByContact.get(getContactId(contact))
  )
  const getKeyTarget = (key: string) => keyTargetsByInput.get(key)

  const applyKeyAppearance = (animationState: KeyAnimationState) => {
    const easedProgress = animationState.progress
      * animationState.progress
      * (3 - 2 * animationState.progress)

    animationState.group.position.y = animationState.baseY
      - interaction.pressTravel * easedProgress
    animationState.material.color.lerpColors(
      baseKeycapColor,
      pressedKeycapColor,
      easedProgress,
    )
  }

  const setColors: KeyboardGroupResult['setColors'] = (colors) => {
    if (disposed) return
    const normalized = normalizeDeviceColors(colors)
    housingMaterial.color.set(normalized.keyboardColor)
    baseKeycapColor.set(normalized.keyboardKeycapColor)
    pressedKeycapColor.set(normalized.keyboardPressedColor)
    legendColor.set(normalized.keyboardLegendColor)
    legendMaterials.forEach(material => material.color.copy(legendColor))
    keyAnimations.forEach(applyKeyAppearance)
  }

  const setLegendLanguage = (language: KeyboardLegendLanguage) => {
    if (disposed) return

    switchableLegends.forEach((legend) => {
      const text = language === 'en' ? legend.english : legend.korean
      legend.mesh.material = getLegendMaterial(text, legend.keyWidth)
    })
  }

  const setKeyPressed = (key: string, pressed: boolean) => {
    if (disposed) return

    const animationState = keyAnimationsByInput.get(key)
    if (!animationState || animationState.held === pressed) return

    animationState.held = pressed
    if (pressed) {
      animationState.minimumPressUntil = performance.now() + interaction.minimumPressMs
    }
  }

  const setContactPressed = (
    contact: KeyboardContactAddress,
    pressed: boolean,
  ) => {
    if (disposed) return

    const animationState = keyAnimationsByContact.get(getContactId(contact))
    if (!animationState || animationState.held === pressed) return

    animationState.held = pressed
    if (pressed) {
      animationState.minimumPressUntil = performance.now() + interaction.minimumPressMs
    }
  }

  const update = (deltaMilliseconds: number, timestamp: number) => {
    if (disposed) return

    keyAnimations.forEach((animationState) => {
      const targetPressed = animationState.held
        || timestamp < animationState.minimumPressUntil
      const duration = targetPressed
        ? interaction.pressDurationMs
        : interaction.releaseDurationMs
      const direction = targetPressed ? 1 : -1

      animationState.progress = Math.min(
        1,
        Math.max(0, animationState.progress + (direction * deltaMilliseconds) / duration),
      )

      applyKeyAppearance(animationState)
    })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true

    group.clear()
    legendTextures.forEach(texture => texture.dispose())
    materials.forEach(material => material.dispose())
    geometries.forEach(geometry => geometry.dispose())

    legendTextures.clear()
    legendMaterials.clear()
    keyGeometries.clear()
    keyAnimations.length = 0
    keyAnimationsByContact.clear()
    switchableLegends.length = 0
    keyAnimationsByInput.clear()
    keyTargetsByContact.clear()
    keyTargetsByInput.clear()
    materials.clear()
    geometries.clear()
  }

  return {
    group,
    getContactTarget,
    getKeyTarget,
    setColors,
    setLegendLanguage,
    setContactPressed,
    setKeyPressed,
    update,
    dispose,
  }
}
