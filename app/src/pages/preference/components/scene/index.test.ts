/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { SceneViewportState } from '@/features/scene/types'

import * as viewportSettings from '@/features/scene/viewportSettings'
import { editorsLocked } from '@/features/stateSafety/bridge'
import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'

type SceneTab = 'view' | 'viewport' | 'lighting'

interface SceneTestControls {
  dimensionValue: (dimension: 'width' | 'height') => number
  dimensionMax: (dimension: 'width' | 'height') => number
  updateDimension: (dimension: 'width' | 'height', value: number | string | null) => void
  updateAutomaticPadding: (value: number | string | null) => void
  disabled: () => boolean
  reset: () => void
  selectTab: (tab: SceneTab) => void
  resetLabel: () => string
  resetDisabled: () => boolean
}

const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
// Also compile the real template, so controls and their event bindings must be valid.
const compiledScene = compileScript(descriptor, { id: 'scene-controls-test', inlineTemplate: true })
const source = `${descriptor.scriptSetup!.content}
globalThis.controls = {
  dimensionValue, dimensionMax, updateDimension, updateAutomaticPadding,
  disabled: () => manualDisabled.value, reset: () => confirmSceneReset(activeSceneTab.value),
  selectTab: (tab) => { activeSceneTab.value = tab },
  resetLabel: () => sceneResetLabel.value, resetDisabled: () => sceneResetDisabled.value,
}`

function controls(autoConfirm = true) {
  const confirmations: Array<{ title: string, onOk: () => void }> = []
  setActivePinia(createPinia())
  const store = useBlockStore()
  const props = Vue.reactive<{
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
      if (name === 'vue') return Vue
      if (name === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
      if (name === '@/stores/block') return { useBlockStore: () => store, createDefaultPet3dPreset }
      if (name === '@/features/scene/viewportSettings') return viewportSettings
      if (name === '@/features/stateSafety/bridge') return { editorsLocked }
      if (name === 'ant-design-vue') {
        return { Modal: { confirm: (options: typeof confirmations[number]) => {
          confirmations.push(options)
          if (autoConfirm) options.onOk()
        } } }
      }
      return {}
    },
  }
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  return { ...context.controls!, store, props, confirmations }
}

describe('3D scene dimension controls', () => {
  it('accepts bounded padding only in confirmed automatic mode', () => {
    const control = controls()
    const preset = control.store.activePet3dPreset
    for (const [value, expected] of [[0, 0], ['8.6', 9], [-10, 0], [10, 10], [11, 11], [16, 16], [20, 20], ['30', 30], [31, 30], [64, 30], [999, 30]] as const) {
      control.updateAutomaticPadding(value)
      assert.equal(preset.autoViewportPaddingPixels, expected)
    }
    for (const value of [null, '', 'invalid', Number.NaN, Number.POSITIVE_INFINITY]) control.updateAutomaticPadding(value)
    assert.equal(preset.autoViewportPaddingPixels, 30)
    preset.autoViewportEnabled = false
    control.updateAutomaticPadding(8)
    assert.equal(preset.autoViewportPaddingPixels, 30)
    preset.autoViewportEnabled = true
    control.props.viewportPending = true
    control.updateAutomaticPadding(8)
    assert.equal(preset.autoViewportPaddingPixels, 30)
    control.props.viewportPending = false
    control.props.viewportState = undefined
    control.updateAutomaticPadding(8)
    assert.equal(preset.autoViewportPaddingPixels, 30)
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
})

function seedScene(control: ReturnType<typeof controls>) {
  const preset = control.store.activePet3dPreset
  Object.assign(preset, {
    windowScalePercent: 125,
    showDisplayArea: true,
    viewportModeRevision: 11,
    autoViewportEnabled: false,
    autoViewportPaddingPixels: 8,
    manualViewportRect: { x: -80, y: 40, width: 700, height: 600 },
    cameraHorizontalOffset: 1,
    cameraVerticalOffset: -1,
    cameraZoomPercent: 180,
    sceneRotationOffsetDegrees: 60,
    keyboardBaseXOffset: 1,
    petRotationDegrees: 60,
  })
  Object.assign(preset.lighting.key, { color: '#123456', strengthPercent: 175, azimuthDegrees: 70, elevationDegrees: 10 })
  control.store.model.mirror = true
  control.store.window.opacity = 35
}

describe('scene category reset controls', () => {
  const viewportKeys = ['windowScalePercent', 'showDisplayArea', 'autoViewportEnabled', 'autoViewportPaddingPixels', 'manualViewportRect', 'cameraHorizontalOffset', 'cameraVerticalOffset'] as const
  const viewKeys = ['cameraZoomPercent', 'sceneRotationOffsetDegrees'] as const
  const resetLabels = {
    view: 'pages.preference.scene.labels.resetView',
    viewport: 'pages.preference.scene.labels.resetViewport',
    lighting: 'pages.preference.scene.lighting.reset',
  }
  const confirmLabels = {
    view: 'pages.preference.scene.confirm.resetView',
    viewport: 'pages.preference.scene.confirm.resetViewport',
    lighting: 'pages.preference.scene.lighting.confirmReset',
  }

  it('matches the selected category and retains the confirmed reset scope after switching tabs', () => {
    const tabs: SceneTab[] = ['view', 'viewport', 'lighting']
    for (const [index, tab] of tabs.entries()) {
      const control = controls(false)
      seedScene(control)
      const preset = control.store.activePet3dPreset
      const defaults = createDefaultPet3dPreset()
      const expected = JSON.parse(JSON.stringify(preset))
      if (tab === 'lighting') {
        expected.lighting = defaults.lighting
      } else if (tab === 'view') {
        for (const key of viewKeys) expected[key] = defaults[key]
      } else {
        for (const key of viewportKeys) expected[key] = defaults[key]
        expected.viewportModeRevision++
      }
      control.selectTab(tab)
      assert.equal(control.resetLabel(), resetLabels[tab])
      assert.equal(control.resetDisabled(), false)
      control.reset()
      assert.equal(control.confirmations.length, 1)
      assert.equal(control.confirmations[0].title, confirmLabels[tab])
      control.selectTab(tabs[(index + 1) % tabs.length])
      control.confirmations[0].onOk()
      assert.deepEqual(JSON.parse(JSON.stringify(preset)), expected)
      assert.equal(control.store.model.mirror, tab !== 'view')
      assert.equal(control.store.window.opacity, tab === 'view' ? 100 : 35)
    }
  })

  it('rejects resets before confirmation and before mutation while the shared save lock is held', () => {
    for (const tab of ['view', 'viewport', 'lighting'] as const) {
      const control = controls(false)
      seedScene(control)
      control.selectTab(tab)
      const before = JSON.stringify(control.store.$state)
      try {
        editorsLocked.value = true
        assert.equal(control.resetDisabled(), true)
        control.reset()
        assert.equal(control.confirmations.length, 0)
        editorsLocked.value = false
        control.reset()
        assert.equal(control.confirmations.length, 1)
        editorsLocked.value = true
        control.confirmations[0].onOk()
        assert.equal(JSON.stringify(control.store.$state), before)
      } finally {
        editorsLocked.value = false
      }
    }
  })

  it('blocks display-area reset during a native mode request, including requests started after confirmation', () => {
    const control = controls(false)
    seedScene(control)
    control.selectTab('viewport')
    const before = JSON.stringify(control.store.$state)
    control.props.viewportPending = true
    assert.equal(control.resetDisabled(), true)
    control.reset()
    assert.equal(control.confirmations.length, 0)
    control.props.viewportPending = false
    control.reset()
    control.props.viewportPending = true
    control.confirmations[0].onOk()
    assert.equal(JSON.stringify(control.store.$state), before)
    for (const tab of ['view', 'lighting'] as const) {
      control.selectTab(tab)
      assert.equal(control.resetDisabled(), false)
    }
  })

  it('keeps aggregate scene reset compatible and increments the viewport revision once', () => {
    const control = controls()
    seedScene(control)
    const defaults = createDefaultPet3dPreset()
    const expected = JSON.parse(JSON.stringify(control.store.activePet3dPreset))
    for (const key of [...viewportKeys, ...viewKeys, 'lighting'] as const) expected[key] = defaults[key]
    expected.viewportModeRevision++
    control.store.resetScene3d()
    assert.deepEqual(JSON.parse(JSON.stringify(control.store.activePet3dPreset)), expected)
    assert.equal(control.store.model.mirror, false)
    assert.equal(control.store.window.opacity, 100)
  })

  it('provides matching Korean and English category, reset and confirmation strings', () => {
    for (const language of ['ko-KR', 'en-US']) {
      const locale = JSON.parse(readFileSync(new URL(`../../../../locales/${language}.json`, import.meta.url), 'utf8'))
      for (const tab of ['view', 'viewport', 'lighting'] as const) {
        for (const path of [`pages.preference.scene.detailTabs.${tab}`, resetLabels[tab], confirmLabels[tab]]) {
          const label = path.split('.').reduce((value, key) => value?.[key], locale)
          assert.equal(typeof label, 'string', path)
          assert.ok(label.length > 0)
        }
      }
    }
  })
})

it('shows the confirmed mode controls while retaining hidden values and native errors', async () => {
  const control = controls(false)
  const preset = control.store.activePet3dPreset
  Object.assign(preset, { autoViewportPaddingPixels: 9, cameraHorizontalOffset: 0.4, cameraVerticalOffset: -0.7 })
  preset.manualViewportRect = { x: -40, y: 80, width: 700, height: 600 }
  const before = JSON.stringify(preset)
  const visibility = new Map<Vue.VNode, boolean>()
  const requests: boolean[] = []
  const props = {
    ...control.props,
    viewportError: 'native failure',
    requestViewportMode: async (automatic: boolean) => {
      requests.push(automatic)
      props.viewportPending = true
      return true
    },
    refreshViewport: () => {},
  }
  type Render = (context: { $t: (key: string) => string }, cache: unknown[]) => Vue.VNode
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Render } } }
  const translate = (key: string) => key
  // Exercise actual v-show expressions and the existing acknowledged-mode callback.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', ts.transpileModule(compiledScene.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)((name: string) => {
    if (name === 'vue') {
      return { ...Vue, withDirectives: (node: Vue.VNode, bindings: Array<[unknown, boolean]>) => {
        for (const [directive, value] of bindings) {
          if (directive === Vue.vShow) visibility.set(node, value)
        }
        return node
      } }
    }
    if (name === 'vue-i18n') return { useI18n: () => ({ t: translate }) }
    if (name === 'ant-design-vue') return { Button: {}, Flex: {}, InputNumber: {}, Modal: {}, Switch: {}, TabPane: {}, Tabs: {} }
    if (name === '@/features/stateSafety/bridge') return { editorsLocked }
    if (name === '@/features/scene/viewportSettings') return viewportSettings
    if (name === '@/stores/block') return { useBlockStore: () => control.store, createDefaultPet3dPreset }
    return { default: {} }
  }, module, module.exports)
  const render = module.exports.default.setup(props, { expose: () => {} })
  const flatten = (node: Vue.VNode): Vue.VNode[] => {
    const children = Array.isArray(node.children)
      ? node.children
      : typeof node.children === 'object' && typeof node.children?.default === 'function' ? node.children.default() : []
    return [node, ...children.flatMap((child: unknown) => Vue.isVNode(child) ? flatten(child) : [])]
  }
  const nodes = () => {
    visibility.clear()
    return flatten(render({ $t: translate }, []))
  }
  const assertMode = (automatic: boolean) => {
    const rendered = nodes()
    const padding = rendered.find(node => node.props?.title === 'pages.preference.scene.labels.automaticPadding')!
    const manual = [...visibility.keys()].find(node => flatten(node).some(child => child.props?.title === 'pages.preference.scene.labels.viewport'))!
    assert.equal(visibility.get(padding), automatic)
    assert.equal(visibility.get(manual), !automatic)
    assert.ok(rendered.some(node => node.props?.role === 'alert'))
    assert.ok(rendered.some(node => node.props?.onClick === props.refreshViewport))
    assert.equal(JSON.stringify(preset), before.replace('"autoViewportEnabled":true', `"autoViewportEnabled":${automatic}`))
    return rendered
  }
  const automaticSwitch = assertMode(true).find(node => node.props?.['aria-label'] === 'pages.preference.scene.labels.automatic')!
  await automaticSwitch.props!['onUpdate:checked'](false)
  assert.deepEqual(requests, [false])
  assertMode(true) // Pending request does not replace the confirmed mode.
  props.viewportPending = false
  preset.autoViewportEnabled = false
  assertMode(false)
  preset.autoViewportEnabled = true
  assertMode(true)
})
