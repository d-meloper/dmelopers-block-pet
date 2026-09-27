/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import { computed, reactive } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { SceneViewportState } from '@/features/scene/types'

import * as viewportSettings from '@/features/scene/viewportSettings'
import { createDefaultPet3dPreset, useCatStore } from '@/stores/cat'

interface SceneTestControls {
  dimensionValue: (dimension: 'width' | 'height') => number
  dimensionMax: (dimension: 'width' | 'height') => number
  updateDimension: (dimension: 'width' | 'height', value: number | string | null) => void
  updateAutomaticPadding: (value: number | string | null) => void
  disabled: () => boolean
  reset: () => void
}

const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
// Also compile the real template, so controls and their event bindings must be valid.
compileScript(descriptor, { id: 'scene-controls-test', inlineTemplate: true })
const source = `${descriptor.scriptSetup!.content}
globalThis.controls = {
  dimensionValue, dimensionMax, updateDimension, updateAutomaticPadding,
  disabled: () => manualDisabled.value, reset: confirmSceneReset,
}`

function controls() {
  setActivePinia(createPinia())
  const store = useCatStore()
  const props = reactive<{
    viewportState?: SceneViewportState
    viewportPending: boolean
  }>({
    viewportState: {
      automatic: true,
      revision: 0,
      rect: { x: -200, y: -100, width: 2300, height: 1400 },
      monitorSize: { width: 1920, height: 1080 },
    },
    viewportPending: false,
  })
  const context = {
    exports: {},
    defineProps: () => props,
    controls: undefined as SceneTestControls | undefined,
    require: (name: string) => {
      if (name === 'vue') return { computed }
      if (name === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
      if (name === '@/stores/cat') return { useCatStore: () => store, createDefaultPet3dPreset }
      if (name === '@/features/scene/viewportSettings') return viewportSettings
      if (name === 'ant-design-vue') return { Modal: { confirm: ({ onOk }: { onOk: () => void }) => onOk() } }
      return {}
    },
  }
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  return { ...context.controls!, store, props }
}

describe('3D scene dimension controls', () => {
  it('accepts bounded padding only in confirmed automatic mode', () => {
    const control = controls()
    const preset = control.store.activePet3dPreset
    for (const [value, expected] of [[0, 0], ['8.6', 9], [-10, 0], [16, 16], [17, 16], [64, 16], [999, 16]] as const) {
      control.updateAutomaticPadding(value)
      assert.equal(preset.autoViewportPaddingPixels, expected)
    }
    for (const value of [null, '', 'invalid', Number.NaN, Number.POSITIVE_INFINITY]) control.updateAutomaticPadding(value)
    assert.equal(preset.autoViewportPaddingPixels, 16)
    preset.autoViewportEnabled = false
    control.updateAutomaticPadding(8)
    assert.equal(preset.autoViewportPaddingPixels, 16)
    preset.autoViewportEnabled = true
    control.props.viewportPending = true
    control.updateAutomaticPadding(8)
    assert.equal(preset.autoViewportPaddingPixels, 16)
    control.props.viewportPending = false
    control.props.viewportState = undefined
    control.updateAutomaticPadding(8)
    assert.equal(preset.autoViewportPaddingPixels, 16)
  })

  it('shows the actual automatic area even when it exceeds the monitor and blocks manual changes', () => {
    const control = controls()
    assert.equal(control.dimensionValue('width'), 2300)
    assert.equal(control.dimensionValue('height'), 1400)
    assert.equal(control.dimensionMax('width'), 2300)
    assert.equal(control.disabled(), true)
    const before = { ...control.store.activePet3dPreset.manualViewportRect }
    control.updateDimension('width', 1200)
    assert.deepEqual(control.store.activePet3dPreset.manualViewportRect, before)
  })

  it('keeps the manual center fixed and accepts only bounded integer dimensions', () => {
    const control = controls()
    const preset = control.store.activePet3dPreset
    preset.autoViewportEnabled = false
    preset.manualViewportRect = { x: -70, y: -40, width: 700, height: 600 }
    control.updateDimension('width', 800.6)
    assert.deepEqual({ ...preset.manualViewportRect }, { x: -120.5, y: -40, width: 801, height: 600 })
    control.updateDimension('height', '99')
    assert.deepEqual({ ...preset.manualViewportRect }, { x: -120.5, y: 210, width: 801, height: 100 })
    control.updateDimension('width', 9999)
    assert.equal(preset.manualViewportRect.width, 1920)
    assert.equal(preset.manualViewportRect.x + preset.manualViewportRect.width / 2, 280)
    const before = { ...preset.manualViewportRect }
    for (const value of [null, '', 'invalid', Number.NaN, Number.POSITIVE_INFINITY]) {
      control.updateDimension('height', value)
    }
    assert.deepEqual({ ...preset.manualViewportRect }, before)
  })

  it('uses refreshed monitor limits and blocks edits without a confirmed state or during mode changes', () => {
    const control = controls()
    const preset = control.store.activePet3dPreset
    preset.autoViewportEnabled = false
    control.props.viewportState!.monitorSize = { width: 1280, height: 720 }
    assert.equal(control.dimensionMax('width'), 1280)
    control.updateDimension('height', 1080)
    assert.equal(preset.manualViewportRect.height, 720)
    control.props.viewportPending = true
    control.updateDimension('height', 500)
    assert.equal(preset.manualViewportRect.height, 720)
    control.props.viewportPending = false
    control.props.viewportState = undefined
    assert.equal(control.disabled(), true)
    control.updateDimension('height', 500)
    assert.equal(preset.manualViewportRect.height, 720)
  })

  it('resets scene controls without changing device placement or pet pose', () => {
    const control = controls()
    const preset = control.store.activePet3dPreset
    Object.assign(preset, { showDisplayArea: true, autoViewportEnabled: false, autoViewportPaddingPixels: 8, cameraZoomPercent: 180, cameraHorizontalOffset: 1, keyboardBaseXOffset: 1, petRotationDegrees: 60 })
    control.store.model.mirror = true
    control.store.window.opacity = 35
    control.reset()
    assert.equal(preset.showDisplayArea, false)
    assert.equal(preset.autoViewportEnabled, true)
    assert.equal(preset.autoViewportPaddingPixels, 16)
    assert.equal(preset.cameraZoomPercent, 100)
    assert.equal(preset.cameraHorizontalOffset, 0)
    assert.equal(control.store.model.mirror, false)
    assert.equal(control.store.window.opacity, 100)
    assert.equal(preset.keyboardBaseXOffset, 1)
    assert.equal(preset.petRotationDegrees, 60)
  })
})
