import type { BufferGeometry, Material } from 'three'

import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Sphere,
} from 'three'

import type { DeviceColorSettings } from '@/config/deviceColors'
import type { ResolvedKeyboardLanguage } from '@/config/keyboardLanguage'

import { normalizeDeviceColors } from '@/config/deviceColors'
import { ENGLISH_LEGENDS_BY_INPUT, JAPANESE_LEGENDS_BY_INPUT, KEYBOARD_ROWS } from '@/config/keyboardLayout'
import { MODEL_3D_CONFIG } from '@/config/model3d'

import { createLegendBatch } from './legendBatch'

export type KeyboardLegendLanguage = ResolvedKeyboardLanguage

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
  setKeycapInputEnabled: (enabled: boolean) => void
  setKeycapInputFilter: (mode: 'all' | 'selected', selectedKeys: readonly string[]) => void
  update: (deltaMilliseconds: number, timestamp: number) => void
  dispose: () => void
}

export interface KeyboardKeyTarget {
  position: [number, number, number]
  typingSide?: 'Left' | 'Right'
}

interface KeyAnimationState {
  id: string
  inputAllowed: boolean
  group: Group
  batch: InstancedMesh<BufferGeometry, MeshStandardMaterial>
  legendBatch: ReturnType<typeof createLegendBatch>['mesh']
  instanceIndex: number
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
const KEY_EDGE_INSET = 0.01
const KEY_DEPTH = 0.18
const KEY_HEIGHT = 0.105
const ROW_PITCH = 0.205
const LEGEND_WIDTH_RATIO = 0.82
const LEGEND_DEPTH_RATIO = 0.8
const LEGEND_TEXTURE_HEIGHT = 256
const LEGEND_MAX_ANISOTROPY = 8
const LEGEND_SURFACE_OFFSET = 0.0006
// Vite removes inspection metadata from production; direct Node tests have no env.
const EXPOSE_INSPECTION = import.meta.env?.DEV !== false

function createKeyGeometry(width: number) {
  const keycap = new BoxGeometry(width - KEY_EDGE_INSET * 2, KEY_HEIGHT, KEY_DEPTH - KEY_EDGE_INSET * 2)
  const legend = new PlaneGeometry(width * LEGEND_WIDTH_RATIO, KEY_DEPTH * LEGEND_DEPTH_RATIO)
  legend.rotateX(-Math.PI / 2)
  legend.translate(0, KEY_HEIGHT / 2 + LEGEND_SURFACE_OFFSET, 0)
  return { keycap, legend }
}

function createLegendCanvas(
  legend: string,
  physicalWidth: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.height = LEGEND_TEXTURE_HEIGHT
  canvas.width = Math.min(
    1024,
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
  const isJapaneseLegend = legend.length === 1 && legendCodePoint >= 0x3040 && legendCodePoint <= 0x30FF
  do {
    const fontFamily = isKoreanLegend
      ? '"Malgun Gothic", "Segoe UI", sans-serif'
      : isJapaneseLegend
        ? '"Yu Gothic", Meiryo, sans-serif'
        : '"Arial Black", "Segoe UI", sans-serif'
    context.font = `900 ${fontSize}px ${fontFamily}`
    if (context.measureText(legend).width <= maximumTextWidth) break
    fontSize -= 4
  } while (fontSize > 32)
  context.fillText(legend, canvas.width / 2, canvas.height / 2)

  return canvas
}

export function createKeyboardGroup(): KeyboardGroupResult {
  const { interaction, palette } = MODEL_3D_CONFIG.keyboard
  const visualOffsetY = -MODEL_3D_CONFIG.objectVerticalGap
    / MODEL_3D_CONFIG.keyboard.scale
  const group = new Group()
  group.name = 'keyboardGroup'

  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const keyGeometries = new Map<number, ReturnType<typeof createKeyGeometry>>()
  const keycapBatches = new Map<number, InstancedMesh<BufferGeometry, MeshStandardMaterial>>()
  const batchCounts = new Map<number, number>()
  const nextInstanceIndices = new Map<number, number>()
  KEYBOARD_ROWS.flat().forEach(({ units = 1 }) => {
    batchCounts.set(units, (batchCounts.get(units) ?? 0) + 1)
  })
  const legendBatches = new Map<number, ReturnType<typeof createLegendBatch>>()
  const switchableLegends: Array<{
    batch: ReturnType<typeof createLegendBatch>
    instanceIndex: number
    korean: string
    english: string
    japanese: string
  }> = []
  const keyAnimations: KeyAnimationState[] = []
  const keyAnimationsByContact = new Map<string, KeyAnimationState>()
  const keyAnimationsByInput = new Map<string, KeyAnimationState>()
  const keyTargetsByContact = new Map<string, KeyboardKeyTarget>()
  const keyTargetsByInput = new Map<string, KeyboardKeyTarget>()
  const baseKeycapColor = new Color(palette.keycap)
  const pressedKeycapColor = new Color(interaction.pressedColor)
  const legendColor = new Color(palette.legend)
  const instanceColor = new Color()
  // White preserves the original absolute per-key palette through instanceColor.
  const keycapMaterial = new MeshStandardMaterial({
    color: 0xFFFFFF,
    metalness: 0,
    roughness: 0.9,
  })
  materials.add(keycapMaterial)

  const housingGeometry = new BoxGeometry(BOARD_WIDTH, BOARD_HEIGHT, BOARD_DEPTH)
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
    const geometry = createKeyGeometry(width)
    keyGeometries.set(units, geometry)
    geometries.add(geometry.keycap)
    geometries.add(geometry.legend)
    return geometry
  }

  const getLegendBatch = (units: number, geometry: BufferGeometry) => {
    const cached = legendBatches.get(units)
    if (cached) return cached
    const batch = createLegendBatch(geometry, batchCounts.get(units)!, legendColor, `keyboard-legend-batch-${units}`, text => createLegendCanvas(text, units * UNIT_PITCH - KEY_GAP), LEGEND_MAX_ANISOTROPY)
    legendBatches.set(units, batch)
    materials.add(batch.mesh.material)
    group.add(batch.mesh)
    return batch
  }

  const getKeycapBatch = (units: number, geometry: BufferGeometry) => {
    const cached = keycapBatches.get(units)
    if (cached) return cached
    const batch = new InstancedMesh(geometry, keycapMaterial, batchCounts.get(units)!)
    batch.name = `keyboard-key-batch-${units}`
    if (EXPOSE_INSPECTION) batch.userData.units = units
    batch.castShadow = true
    batch.receiveShadow = true
    batch.instanceMatrix.setUsage(DynamicDrawUsage)
    keycapBatches.set(units, batch)
    group.add(batch)
    return batch
  }

  KEYBOARD_ROWS.forEach((row, rowIndex) => {
    const rightHandStartKey = MODEL_3D_CONFIG.pet.animation.inputMode.rightHandStartKeys[rowIndex]
    const rightHandStartColumn = rightHandStartKey ? row.findIndex(key => key.inputKeys.includes(rightHandStartKey)) : -1
    const rowUnits = row.reduce((sum, key) => sum + (key.units ?? 1), 0)
    let cursorX = (-rowUnits * UNIT_PITCH) / 2
    const z = (rowIndex - (KEYBOARD_ROWS.length - 1) / 2) * ROW_PITCH

    row.forEach((key, columnIndex) => {
      const units = key.units ?? 1
      const keyName = `keyboard-key-r${rowIndex}-c${columnIndex}`
      const keyTargetY = BOARD_HEIGHT + 0.012 + KEY_HEIGHT / 2
      const keyGroup = new Group()
      const keyGeometry = getKeyGeometry(units)
      const batch = getKeycapBatch(units, keyGeometry.keycap)
      const instanceIndex = nextInstanceIndices.get(units) ?? 0
      nextInstanceIndices.set(units, instanceIndex + 1)

      keyGroup.name = `${keyName}-group`
      keyGroup.position.set(
        cursorX + (units * UNIT_PITCH) / 2,
        keyTargetY + visualOffsetY,
        z,
      )
      if (EXPOSE_INSPECTION) {
        keyGroup.userData.inputKeys = key.inputKeys
        keyGroup.userData.keycapBatchName = batch.name
        keyGroup.userData.keycapInstanceIndex = instanceIndex
      }
      keyGroup.updateMatrix()
      batch.setMatrixAt(instanceIndex, keyGroup.matrix)
      batch.setColorAt(instanceIndex, baseKeycapColor)

      const legend = getLegendBatch(units, keyGeometry.legend)
      legend.mesh.setMatrixAt(instanceIndex, keyGroup.matrix)
      legend.setText(instanceIndex, key.legend)
      if (EXPOSE_INSPECTION) {
        keyGroup.userData.legendBatchName = legend.mesh.name
        keyGroup.userData.legendInstanceIndex = instanceIndex
      }
      group.add(keyGroup)

      const englishLegend = key.inputKeys
        .map(inputKey => ENGLISH_LEGENDS_BY_INPUT[inputKey])
        .find(Boolean)
      const japaneseLegend = key.inputKeys.map(inputKey => JAPANESE_LEGENDS_BY_INPUT[inputKey]).find(Boolean)
      if (japaneseLegend) {
        switchableLegends.push({
          batch: legend,
          instanceIndex,
          korean: key.legend,
          english: englishLegend ?? key.legend,
          japanese: japaneseLegend,
        })
      }

      const animationState: KeyAnimationState = {
        id: key.inputKeys[0]!,
        inputAllowed: true,
        group: keyGroup,
        batch,
        legendBatch: legend.mesh,
        instanceIndex,
        baseY: keyGroup.position.y,
        held: false,
        minimumPressUntil: 0,
        progress: 0,
      }

      keyAnimations.push(animationState)
      const target: KeyboardKeyTarget = {
        position: [
          keyGroup.position.x,
          keyTargetY + KEY_HEIGHT / 2,
          keyGroup.position.z,
        ],
      }
      if (rightHandStartColumn >= 0) {
        target.typingSide = columnIndex >= rightHandStartColumn ? 'Right' : 'Left'
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

  legendBatches.forEach(batch => batch.flush())
  for (const batch of [...keycapBatches.values(), ...[...legendBatches.values()].map(batch => batch.mesh)]) {
    batch.instanceMatrix.needsUpdate = true
    if (batch.instanceColor) {
      batch.instanceColor.setUsage(DynamicDrawUsage)
      batch.instanceColor.needsUpdate = true
    }
    // Local key movement is only downward; keep both main and shadow culling
    // conservative throughout a press without rebuilding bounds every frame.
    batch.computeBoundingBox()
    batch.boundingBox!.min.y -= interaction.pressTravel
    batch.boundingBox!.expandByScalar(1e-6)
    batch.boundingSphere = batch.boundingBox!.getBoundingSphere(new Sphere())
  }

  let disposed = false
  let keycapInputEnabled = true
  let keycapInputMode: 'all' | 'selected' = 'all'
  let keycapSelectedKeys = new Set<string>()
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
    animationState.group.updateMatrix()
    animationState.batch.setMatrixAt(animationState.instanceIndex, animationState.group.matrix)
    animationState.legendBatch.setMatrixAt(animationState.instanceIndex, animationState.group.matrix)
    animationState.legendBatch.instanceMatrix.needsUpdate = true
    instanceColor.lerpColors(
      baseKeycapColor,
      pressedKeycapColor,
      easedProgress,
    )
    animationState.batch.setColorAt(animationState.instanceIndex, instanceColor)
    animationState.batch.instanceMatrix.needsUpdate = true
    animationState.batch.instanceColor!.needsUpdate = true
  }

  const setColors: KeyboardGroupResult['setColors'] = (colors) => {
    if (disposed) return
    const normalized = normalizeDeviceColors(colors)
    housingMaterial.color.set(normalized.keyboardColor)
    baseKeycapColor.set(normalized.keyboardKeycapColor)
    pressedKeycapColor.set(normalized.keyboardPressedColor)
    legendColor.set(normalized.keyboardLegendColor)
    legendBatches.forEach(batch => batch.mesh.material.color.copy(legendColor))
    keyAnimations.forEach(applyKeyAppearance)
  }

  const setLegendLanguage = (language: KeyboardLegendLanguage) => {
    if (disposed) return

    switchableLegends.forEach((legend) => {
      const text = language === 'ja' ? legend.japanese : language === 'en' ? legend.english : legend.korean
      legend.batch.setText(legend.instanceIndex, text)
    })
    legendBatches.forEach(batch => batch.flush())
  }

  const setKeycapInputEnabled = (enabled: boolean) => {
    if (disposed || enabled === keycapInputEnabled) return
    keycapInputEnabled = enabled
    if (enabled) return

    keyAnimations.forEach((animationState) => {
      animationState.minimumPressUntil = 0
      if (animationState.progress === 0) return
      animationState.progress = 0
      applyKeyAppearance(animationState)
    })
  }

  const setKeycapInputFilter: KeyboardGroupResult['setKeycapInputFilter'] = (mode, selectedKeys) => {
    if (disposed) return
    const nextSelectedKeys = new Set(selectedKeys)
    if (mode === keycapInputMode && nextSelectedKeys.size === keycapSelectedKeys.size
      && [...nextSelectedKeys].every(key => keycapSelectedKeys.has(key))) {
      return
    }
    keycapInputMode = mode
    keycapSelectedKeys = nextSelectedKeys

    keyAnimations.forEach((animationState) => {
      const inputAllowed = mode === 'all' || nextSelectedKeys.has(animationState.id)
      if (inputAllowed === animationState.inputAllowed) return
      animationState.inputAllowed = inputAllowed
      animationState.minimumPressUntil = 0
      if (inputAllowed || animationState.progress === 0) return
      animationState.progress = 0
      applyKeyAppearance(animationState)
    })
  }

  const setKeyPressed = (key: string, pressed: boolean) => {
    if (disposed) return

    const animationState = keyAnimationsByInput.get(key)
    if (!animationState || animationState.held === pressed) return

    animationState.held = pressed
    if (pressed && keycapInputEnabled && animationState.inputAllowed) {
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
    if (pressed && keycapInputEnabled && animationState.inputAllowed) {
      animationState.minimumPressUntil = performance.now() + interaction.minimumPressMs
    }
  }

  const update = (deltaMilliseconds: number, timestamp: number) => {
    if (disposed || !keycapInputEnabled) return

    keyAnimations.forEach((animationState) => {
      if (!animationState.inputAllowed) return
      const targetPressed = animationState.held
        || timestamp < animationState.minimumPressUntil
      const duration = targetPressed
        ? interaction.pressDurationMs
        : interaction.releaseDurationMs
      const direction = targetPressed ? 1 : -1

      const progress = Math.min(
        1,
        Math.max(0, animationState.progress + (direction * deltaMilliseconds) / duration),
      )
      if (progress === animationState.progress) return
      animationState.progress = progress
      applyKeyAppearance(animationState)
    })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true

    group.clear()
    keycapBatches.forEach(batch => batch.dispose())
    legendBatches.forEach(batch => batch.dispose())
    materials.forEach(material => material.dispose())
    geometries.forEach(geometry => geometry.dispose())

    legendBatches.clear()
    keyGeometries.clear()
    keycapBatches.clear()
    batchCounts.clear()
    nextInstanceIndices.clear()
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
    setKeycapInputEnabled,
    setKeycapInputFilter,
    update,
    dispose,
  }
}
