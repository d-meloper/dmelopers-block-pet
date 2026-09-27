/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import * as deskSettings from '@/config/desk'
import { capturePresetSnapshot } from '@/features/presets/model'
import { createDefaultPet3dPreset, useCatStore } from '@/stores/cat'

const colorKeys = ['keyboardColor', 'keyboardKeycapColor', 'keyboardLegendColor', 'keyboardPressedColor', 'mouseColor', 'mousePressedColor'] as const
type ColorKey = typeof colorKeys[number] | 'deskColor'

function harness() {
  setActivePinia(createPinia())
  const store = useCatStore()
  const confirmations: Array<{ title: string, onOk: () => Promise<void> }> = []
  const mouseRequests: boolean[] = []
  let mouseAllowed = true
  const changes: Array<{ key: ColorKey, before: string }> = []
  let changingKey: ColorKey = 'keyboardColor'
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
    if (id === 'vue') return Vue
    if (id === 'vue-i18n') return { useI18n: () => ({ t: translate }) }
    if (id === 'ant-design-vue') return { Button: {}, Modal: { confirm: (options: typeof confirmations[number]) => confirmations.push(options) }, Select: { Option: {} }, Switch: {} }
    if (id === '@/config/desk') return deskSettings
    if (id === '@/stores/cat') return { createDefaultPet3dPreset, useCatStore: () => store }
    if (id === '@/features/presets/editIntent') {
      return { markPresetUserEdit: () => changes.push({ key: changingKey, before: store.activePet3dPreset[changingKey] }) }
    }
    if (id.startsWith('@/components/')) return { default: {} }
    throw new Error(`Unexpected import: ${id}`)
  }, module, module.exports)
  const render = module.exports.default.setup({
    mousePending: false,
    mouseReady: true,
    requestMouseEnabled: async (enabled: boolean) => {
      mouseRequests.push(enabled)
      return mouseAllowed
    },
    refreshMouseSetting: () => {},
  }, { expose: () => {} })
  const flatten = (node: Vue.VNode): Vue.VNode[] => {
    const children = Array.isArray(node.children)
      ? node.children
      : typeof node.children === 'object' && typeof node.children?.default === 'function' ? node.children.default() : []
    return [node, ...children.flatMap((child: unknown) => Vue.isVNode(child) ? flatten(child) : [])]
  }
  const inputs = () => flatten(render({ $t: translate }, [])).filter(node => node.props?.['onUpdate:value'] && node.props?.label)
  const input = (key: ColorKey) => inputs().find(node => node.props?.label === `pages.preference.environment.labels.${key}`)!
  return {
    store,
    changes,
    confirmations,
    mouseRequests,
    rejectMouse: () => {
      mouseAllowed = false
    },
    resetButtons: () => flatten(render({ $t: translate }, [])).filter(node => node.props?.onClick && flatten(node).some(child => typeof child.children === 'string' && child.children.includes('environment.labels.reset'))),
    inputs,
    input,
    nodes: () => flatten(render({ $t: translate }, [])),
    change: (key: ColorKey, color: string) => {
      changingKey = key
      input(key).props!['onUpdate:value'](color)
    },
  }
}

describe('object color preference controls', () => {
  it('places one reset at each section end and only asks native mouse state for mouse reset', async () => {
    const h = harness()
    const buttons = h.resetButtons()
    assert.equal(buttons.length, 3)
    for (const [index, title] of ['Desk', 'Keyboard', 'Mouse'].entries()) {
      buttons[index].props!.onClick()
      assert.equal(h.confirmations[index].title, `pages.preference.environment.confirm.reset${title}`)
      await h.confirmations[index].onOk()
      assert.deepEqual(h.mouseRequests, index === 2 ? [true] : [])
    }
    Object.assign(h.store.activePet3dPreset, { deskHeightOffset: 0.6, keyboardScalePercent: 150, mouseScalePercent: 175, mouseEnabled: false })
    const before = capturePresetSnapshot(h.store)
    h.rejectMouse()
    h.resetButtons()[2].props!.onClick()
    await assert.rejects(h.confirmations.at(-1)!.onOk(), /unavailable/)
    assert.deepEqual(capturePresetSnapshot(h.store), before)
  })

  it('keeps desk height available in both modes and preserves color while transparent', () => {
    const h = harness()
    const label = (key: string) => `pages.preference.environment.labels.${key}`
    const sections = h.nodes().filter(node => node.props?.title)
    assert.deepEqual(sections.slice(0, 4).map(node => node.props?.title), ['deskSettings', 'deskTransparent', 'deskHeightOffset', 'deskColor'].map(label))
    const toggle = () => h.nodes().find(node => node.props?.['onUpdate:checked'] && node.props.checked === h.store.activePet3dPreset.deskTransparent)!
    const height = () => h.nodes().find(node => node.props?.['onUpdate:value'] && node.props.min === -1 && node.props.max === 1)!
    assert.equal(toggle().props?.checked, true)
    assert.equal(h.input('deskColor').props?.disabled, true)
    h.change('deskColor', '#123456')
    assert.equal(h.store.activePet3dPreset.deskColor, '#D9D9D9')
    for (const transparent of [false, true]) {
      toggle().props!['onUpdate:checked'](transparent)
      assert.equal(h.input('deskColor').props?.disabled, transparent)
      assert.ok(!height().props?.disabled)
      height().props!['onUpdate:value'](transparent ? -1 : 1)
      assert.equal(h.store.activePet3dPreset.deskHeightOffset, transparent ? -1 : 1)
      h.change('deskColor', transparent ? '#ffffff' : '#123456')
      assert.equal(h.store.activePet3dPreset.deskColor, '#123456')
    }
    const snapshot = capturePresetSnapshot(h.store)
    assert.equal(snapshot.preset.deskTransparent, true)
    assert.equal(snapshot.preset.deskHeightOffset, -1)
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
