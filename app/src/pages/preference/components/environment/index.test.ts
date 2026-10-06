/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import * as deskSettings from '@/config/desk'
import presetRanges from '@/config/presetRanges.json'
import { capturePresetSnapshot } from '@/features/presets/model'
import * as stateSafety from '@/features/stateSafety/bridge'
import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'

const colorKeys = ['keyboardColor', 'keyboardKeycapColor', 'keyboardLegendColor', 'keyboardPressedColor', 'mouseColor', 'mousePressedColor'] as const
type ColorKey = typeof colorKeys[number] | 'deskColor'

function harness(options: { mousePending?: boolean, mouseReady?: boolean } = {}) {
  setActivePinia(createPinia())
  const store = useBlockStore()
  const confirmations: Array<{ title: string, onOk: () => Promise<void> }> = []
  const mouseRequests: boolean[] = []
  let mouseAllowed = true
  const changes: Array<{ key: ColorKey, before: string }> = []
  let changingKey: ColorKey = 'keyboardColor'
  const visibility = new Map<Vue.VNode, boolean>()
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const compiled = compileScript(descriptor, { id: 'environment-color-controls-test', inlineTemplate: true })
  type Render = (context: { $t: (key: string) => string }, cache: unknown[]) => Vue.VNode
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Render } } }
  const translate = (key: string) => key
  // Exercise the component's actual event bindings against the persisted store.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)((id: string) => {
    if (id === 'vue') {
      return { ...Vue, withDirectives: (node: Vue.VNode, bindings: Array<[unknown, boolean]>) => {
        for (const [directive, value] of bindings) {
          if (directive === Vue.vShow) visibility.set(node, value)
        }
        return node
      } }
    }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: translate }) }
    if (id === 'ant-design-vue') return { Button: {}, Modal: { confirm: (options: typeof confirmations[number]) => confirmations.push(options) }, Select: { Option: {} }, Switch: {}, Flex: {}, TabPane: {}, Tabs: {} }
    if (id === '@/features/stateSafety/bridge') return stateSafety
    if (id === '@/config/desk') return deskSettings
    if (id === '@/config/presetRanges.json') return { default: presetRanges }
    if (id === '@/stores/block') return { createDefaultPet3dPreset, useBlockStore: () => store }
    if (id === '@/features/presets/editIntent') {
      return { markPresetUserEdit: () => changes.push({ key: changingKey, before: store.activePet3dPreset[changingKey] }) }
    }
    if (id.startsWith('@/components/')) return { default: {} }
    throw new Error(`Unexpected import: ${id}`)
  }, module, module.exports)
  const props = Vue.reactive({
    mousePending: options.mousePending ?? false,
    mouseReady: options.mouseReady ?? true,
    requestMouseEnabled: async (enabled: boolean) => {
      mouseRequests.push(enabled)
      return mouseAllowed
    },
    refreshMouseSetting: () => {},
  })
  const render = module.exports.default.setup(props, { expose: () => {} })
  const flatten = (node: Vue.VNode, visibleOnly = false): Vue.VNode[] => {
    if (visibleOnly && visibility.get(node) === false) return []
    const children = Array.isArray(node.children)
      ? node.children
      : typeof node.children === 'object' && typeof node.children?.default === 'function' ? node.children.default() : []
    return [node, ...children.flatMap((child: unknown) => Vue.isVNode(child) ? flatten(child, visibleOnly) : [])]
  }
  const inputs = () => flatten(render({ $t: translate }, [])).filter(node => node.props?.['onUpdate:value'] && node.props?.label)
  const input = (key: ColorKey) => inputs().find(node => node.props?.label === `pages.preference.environment.labels.${key}`)!
  return {
    store,
    props,
    changes,
    confirmations,
    mouseRequests,
    selectTab: (tab: 'desk' | 'keyboard' | 'mouse') => {
      const tabs = flatten(render({ $t: translate }, [])).find(node => node.props?.['onUpdate:activeKey'])!
      tabs.props!['onUpdate:activeKey'](tab)
    },
    rejectMouse: () => {
      mouseAllowed = false
    },
    resetButtons: () => flatten(render({ $t: translate }, [])).filter(node => node.props?.onClick && flatten(node).some(child => typeof child.children === 'string' && child.children.includes('environment.labels.reset'))),
    inputs,
    input,
    nodes: () => flatten(render({ $t: translate }, [])),
    visibleNodes: () => {
      visibility.clear()
      return flatten(render({ $t: translate }, []), true)
    },
    change: (key: ColorKey, color: string) => {
      changingKey = key
      input(key).props!['onUpdate:value'](color)
    },
  }
}

describe('object color preference controls', () => {
  it('matches the footer to the selected tab, captures reset scope and only requests native mouse state for Mouse', async () => {
    const h = harness()
    const defaults = createDefaultPet3dPreset()
    const keys = {
      desk: ['deskHeightOffset', 'deskWidthOffset', 'deskDepthOffset', 'deskTransparent', 'deskColor'],
      keyboard: ['keyboardColor', 'keyboardKeycapColor', 'keyboardLegendColor', 'keyboardPressedColor', 'keyboardBaseXOffset', 'keyboardBaseZOffset', 'keyboardScalePercent', 'keyboardLegendLanguage'],
      mouse: ['mouseEnabled', 'mouseColor', 'mousePressedColor', 'mouseBaseXOffset', 'mouseBaseZOffset', 'mouseScalePercent'],
    } as const
    for (const [index, object] of ['desk', 'keyboard', 'mouse'].entries()) {
      const tab = object as keyof typeof keys
      Object.assign(h.store.activePet3dPreset, {
        deskHeightOffset: 0.6,
        deskWidthOffset: 0.7,
        deskDepthOffset: -0.4,
        deskTransparent: false,
        deskColor: '#123456',
        keyboardScalePercent: 150,
        keyboardColor: '#234567',
        keyboardBaseXOffset: 0.4,
        mouseScalePercent: 175,
        mouseEnabled: false,
        mouseColor: '#345678',
        mouseBaseZOffset: 0.4,
        petHeadScalePercent: 180,
        dmeloperPalmColor: '#ABCDEF',
      })
      const before = capturePresetSnapshot(h.store)
      h.selectTab(tab)
      assert.equal(h.resetButtons().length, 1)
      const title = object[0].toUpperCase() + object.slice(1)
      assert.ok(h.nodes().some(node => node.children === `pages.preference.environment.labels.reset${title}`))
      h.resetButtons()[0].props!.onClick()
      assert.equal(h.confirmations[index].title, `pages.preference.environment.confirm.reset${title}`)
      h.selectTab(tab === 'desk' ? 'keyboard' : 'desk')
      await h.confirmations[index].onOk()
      const expected = { ...before, preset: { ...before.preset } }
      Object.assign(expected.preset, Object.fromEntries(keys[tab].map(key => [key, defaults[key]])))
      assert.deepEqual(capturePresetSnapshot(h.store), expected)
      assert.deepEqual(h.mouseRequests, index === 2 ? [true] : [])
    }
    Object.assign(h.store.activePet3dPreset, { deskHeightOffset: 0.6, keyboardScalePercent: 150, mouseScalePercent: 175, mouseEnabled: false })
    const before = capturePresetSnapshot(h.store)
    h.rejectMouse()
    h.selectTab('mouse')
    h.resetButtons()[0].props!.onClick()
    await assert.rejects(h.confirmations.at(-1)!.onOk(), /unavailable/)
    assert.deepEqual(capturePresetSnapshot(h.store), before)
  })

  it('blocks the selected reset before opening confirmation and while saving after confirmation', async () => {
    const h = harness()
    h.selectTab('mouse')
    h.store.activePet3dPreset.mouseScalePercent = 175
    const before = capturePresetSnapshot(h.store)
    try {
      stateSafety.editorsLocked.value = true
      assert.equal(h.resetButtons()[0].props?.disabled, true)
      h.resetButtons()[0].props!.onClick()
      assert.equal(h.confirmations.length, 0)
      stateSafety.editorsLocked.value = false
      h.resetButtons()[0].props!.onClick()
      assert.equal(h.confirmations.length, 1)
      stateSafety.editorsLocked.value = true
      await h.confirmations[0].onOk()
      assert.deepEqual(h.mouseRequests, [])
      assert.deepEqual(capturePresetSnapshot(h.store), before)
    } finally {
      stateSafety.editorsLocked.value = false
    }
  })

  it('gates width/depth on opacity, keeps height available and retains disabled values and color', () => {
    const h = harness()
    const label = (key: string) => `pages.preference.environment.labels.${key}`
    const sections = h.nodes().filter(node => node.props?.title === label('objectSettings') || String(node.props?.title).startsWith(label('desk')))
    assert.deepEqual(sections.map(node => node.props?.title), ['objectSettings', 'deskTransparent', 'deskColor', 'deskHeightOffset', 'deskWidthOffset', 'deskDepthOffset'].map(label))
    const dimensions = ['deskWidthOffset', 'deskDepthOffset', 'deskHeightOffset'] as const
    const slider = (key: typeof dimensions[number]) => h.nodes().find(node => node.props?.title === label(key))!.children as { default: () => Vue.VNode[] }
    const input = (key: typeof dimensions[number]) => slider(key).default()[0]
    const toggle = () => (h.nodes().find(node => node.props?.title === label('deskTransparent'))!.children as { default: () => Vue.VNode[] }).default()[0]
    const visibleDeskRows = () => h.visibleNodes().map(node => node.props?.title).filter(title => String(title).startsWith(label('desk')))
    assert.deepEqual(visibleDeskRows(), ['deskTransparent', 'deskHeightOffset'].map(label))
    assert.equal(toggle().props?.checked, true)
    assert.equal(input('deskWidthOffset').props?.value, -0.28)
    assert.equal(input('deskWidthOffset').props?.['default-value'], -0.28)
    assert.equal(input('deskDepthOffset').props?.value, 0.1)
    assert.equal(input('deskDepthOffset').props?.['default-value'], 0.1)
    for (const key of dimensions) {
      assert.equal(input(key).props?.min, -1)
      assert.equal(input(key).props?.max, 1)
      assert.equal(input(key).props?.step, 0.01)
      assert.equal(input(key).props?.['display-mode'], key === 'deskHeightOffset' ? 'raw' : 'centered')
      assert.equal(input(key).props?.disabled, key !== 'deskHeightOffset')
      const before = h.store.activePet3dPreset[key]
      input(key).props!['onUpdate:value'](0.6)
      assert.equal(h.store.activePet3dPreset[key], key === 'deskHeightOffset' ? 0.6 : before)
    }
    assert.equal(h.input('deskColor').props?.disabled, true)
    h.change('deskColor', '#123456')
    assert.equal(h.store.activePet3dPreset.deskColor, '#D9D9D9')
    toggle().props!['onUpdate:checked'](false)
    assert.deepEqual(visibleDeskRows(), ['deskTransparent', 'deskColor', 'deskHeightOffset', 'deskWidthOffset', 'deskDepthOffset'].map(label))
    for (const key of dimensions) {
      assert.equal(input(key).props?.disabled, false)
      input(key).props!['onUpdate:value'](0.6)
      assert.equal(h.store.activePet3dPreset[key], 0.6)
    }
    h.change('deskColor', '#123456')
    toggle().props!['onUpdate:checked'](true)
    assert.deepEqual(visibleDeskRows(), ['deskTransparent', 'deskHeightOffset'].map(label))
    for (const key of dimensions) {
      assert.equal(input(key).props?.disabled, key !== 'deskHeightOffset')
      input(key).props!['onUpdate:value'](-1)
      assert.equal(h.store.activePet3dPreset[key], key === 'deskHeightOffset' ? -1 : 0.6)
    }
    h.change('deskColor', '#ffffff')
    assert.equal(h.store.activePet3dPreset.deskColor, '#123456')
    try {
      stateSafety.editorsLocked.value = true
      for (const key of dimensions) {
        assert.equal(input(key).props?.disabled, true)
        input(key).props!['onUpdate:value'](1)
        assert.equal(h.store.activePet3dPreset[key], key === 'deskHeightOffset' ? -1 : 0.6)
      }
    } finally {
      stateSafety.editorsLocked.value = false
    }
    const snapshot = capturePresetSnapshot(h.store)
    assert.equal(snapshot.preset.deskWidthOffset, 0.6)
    assert.equal(snapshot.preset.deskDepthOffset, 0.6)
    assert.equal(snapshot.preset.deskHeightOffset, -1)
    assert.equal(snapshot.preset.deskTransparent, true)
    assert.equal(snapshot.preset.deskColor, '#123456')
  })

  it('marks the user edit before each color change and captures it in the active preset', () => {
    const h = harness()
    const defaults = createDefaultPet3dPreset()
    const colors = ['#112233', '#334455', '#556677', '#778899', '#99aabb', '#bbccdd']
    for (const [index, key] of colorKeys.entries()) {
      h.change(key, colors[index])
      assert.equal(h.store.activePet3dPreset[key], colors[index])
      assert.deepEqual(h.changes[index], { key, before: defaults[key] })
      assert.equal(capturePresetSnapshot(h.store).preset[key], colors[index])
      assert.equal(h.input(key).props?.value, colors[index])
      h.change(key, colors[index])
      assert.equal(h.changes.length, index + 1)
    }
  })

  it('hides every mouse detail only on confirmed OFF, preserves values and rejects late or pending edits', async () => {
    const h = harness()
    const label = (key: string) => `pages.preference.environment.labels.${key}`
    const input = (key: string) => (h.nodes().find(node => node.props?.title === label(key))!.children as { default: () => Vue.VNode[] }).default()[0]
    const detailNames = ['mouseColor', 'mousePressedColor', 'mouseX', 'mouseZ', 'mouseScale']
    const visibleDetails = () => h.visibleNodes().filter(node => detailNames.some(key => node.props?.title === label(key))).length
    const dimensions = [['mouseX', 'mouseBaseXOffset', 0.3], ['mouseZ', 'mouseBaseZOffset', -0.2], ['mouseScale', 'mouseScalePercent', 130]] as const
    for (const [name, key, value] of dimensions) {
      input(name).props!['onUpdate:value'](value)
      assert.equal(h.store.activePet3dPreset[key], value)
    }
    h.change('mouseColor', '#123456')
    h.change('mousePressedColor', '#abcdef')
    for (const reason of ['off', 'pending', 'notReady', 'locked'] as const) {
      h.store.activePet3dPreset.mouseEnabled = reason !== 'off'
      h.props.mousePending = reason === 'pending'
      h.props.mouseReady = reason !== 'notReady'
      stateSafety.editorsLocked.value = reason === 'locked'
      try {
        assert.equal(visibleDetails(), reason === 'off' ? 0 : 5)
        const before = capturePresetSnapshot(h.store)
        for (const [name] of dimensions) {
          assert.equal(input(name).props?.disabled, true)
          input(name).props!['onUpdate:value'](1)
        }
        for (const key of ['mouseColor', 'mousePressedColor'] as const) {
          assert.equal(h.input(key).props?.disabled, true)
          h.change(key, '#ffffff')
        }
        assert.deepEqual(capturePresetSnapshot(h.store), before)
        assert.equal(h.resetButtons().length, 1)
      } finally {
        stateSafety.editorsLocked.value = false
      }
    }
    h.props.mousePending = false
    h.props.mouseReady = true
    h.store.activePet3dPreset.mouseEnabled = false
    h.rejectMouse()
    assert.equal(await input('mouseEnabled').props!['onUpdate:checked'](true), false)
    assert.equal(visibleDetails(), 0, 'a rejected native request must not reveal controls')
    // Only the confirmed value delivered by the native owner reveals controls.
    h.store.activePet3dPreset.mouseEnabled = true
    assert.equal(visibleDetails(), 5)
    for (const [name, key, value] of dimensions) {
      assert.equal(input(name).props?.disabled, false)
      assert.equal(h.store.activePet3dPreset[key], value)
    }
    assert.equal(h.input('mouseColor').props?.value, '#123456')
    assert.equal(h.input('mousePressedColor').props?.value, '#abcdef')
  })

  it('disables and guards mouse color edits while retaining colors across OFF and ON', () => {
    const h = harness()
    h.change('mouseColor', '#123456')
    h.change('mousePressedColor', '#abcdef')
    h.store.activePet3dPreset.mouseEnabled = false
    for (const key of ['mouseColor', 'mousePressedColor'] as const) {
      assert.equal(h.input(key).props?.disabled, true)
      h.change(key, '#ff0000')
    }
    assert.equal(h.changes.length, 2)
    assert.equal(h.store.activePet3dPreset.mouseColor, '#123456')
    assert.equal(h.store.activePet3dPreset.mousePressedColor, '#abcdef')
    assert.ok(h.inputs().filter(node => String(node.props?.label).includes('.keyboard')).every(node => !node.props?.disabled))
    h.change('keyboardColor', '#667788')
    assert.equal(h.store.activePet3dPreset.keyboardColor, '#667788')
    h.store.activePet3dPreset.mouseEnabled = true
    assert.equal(h.input('mouseColor').props?.disabled, false)
    assert.equal(h.input('mouseColor').props?.value, '#123456')
    assert.equal(h.input('mousePressedColor').props?.value, '#abcdef')
  })
})
