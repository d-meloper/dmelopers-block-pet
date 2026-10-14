/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import * as display from '@/components/default-snap-slider/displayValue'
import * as recoil from '@/config/headbuttRecoil'
import * as typing from '@/config/typingMotion'

function harness<T extends object>(name: string, defaults: T) {
  const props = Vue.reactive({ settings: { ...defaults }, disabled: false }) as { settings: T, disabled: boolean }
  const emitted: T[] = []
  const visibility = new Map<Vue.VNode, boolean>()
  const scope = Vue.effectScope()
  const { descriptor } = parse(readFileSync(new URL(`./${name}.vue`, import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: name, inlineTemplate: true })
  type Render = (context: object, cache: unknown[]) => Vue.VNode
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Render } } }
  // Exercise the real SFC's watchers, visibility predicates and update bindings.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)((id: string) => {
    if (id === 'vue') {
      return { ...Vue, withDirectives: (node: Vue.VNode, bindings: Array<[unknown, boolean]>) => {
        for (const [directive, visible] of bindings) {
          if (directive === Vue.vShow) visibility.set(node, visible)
        }
        return node
      } }
    }
    if (id === 'ant-design-vue') return { Flex: 'flex', Switch: 'switch' }
    if (id === '@/config/headbuttRecoil') return recoil
    if (id === '@/config/typingMotion') return typing
    if (id === '@/components/default-snap-slider/displayValue') return display
    if (id.startsWith('@/components/')) return { default: id }
    throw new Error(`Unexpected import: ${id}`)
  }, module, module.exports)
  const render = scope.run(() => module.exports.default.setup(props, {
    expose: () => {},
    emit: (event: string, settings: T) => {
      assert.equal(event, 'update:settings')
      emitted.push(settings)
      Object.assign(props.settings, settings)
    },
  }))!
  const flatten = (node: Vue.VNode): Vue.VNode[] => {
    const children = Array.isArray(node.children)
      ? node.children
      : typeof node.children === 'object' && typeof node.children?.default === 'function' ? node.children.default() : []
    return [node, ...children.flatMap((child: unknown) => Vue.isVNode(child) ? flatten(child) : [])]
  }
  const nodes = () => {
    visibility.clear()
    return flatten(render({ $t: (key: string) => key }, []))
  }
  const row = (label: string) => nodes().find(node => node.props?.title === `pages.preference.block.labels.${label}`)!
  const slider = (label: string) => flatten(row(label)).find(node => node.type === '@/components/default-snap-slider/index.vue')!
  return { props, emitted, nodes, row, slider, visibility, dispose: () => scope.stop() }
}

describe('motion preference controls', () => {
  it('keeps typing reach first and gives each default-motion setting its own option box', () => {
    const h = harness('typing-motion-options', typing.DEFAULT_TYPING_MOTION_SETTINGS)
    try {
      const nodes = h.nodes()
      const rows = nodes.filter(node => node.props?.title?.startsWith('pages.preference.block.labels.'))
      assert.deepEqual(rows.map(node => node.props!.title), ['petTypingRadius', 'petTypingHandLift', 'petTypingBodyMotion', 'petTypingReturnSpeed'].map(label => `pages.preference.block.labels.${label}`))
      for (const row of rows) assert.equal(row.props?.plain, undefined)
      assert.equal(nodes[0].props?.class, undefined)
      h.slider('petTypingRadius').props!['onUpdate:value'](-1)
      assert.equal(h.props.settings.petTypingMaxRadiusOffset, -1)
    } finally {
      h.dispose()
    }
  })

  it('maps both modes to default-zero tenth steps without editing restored values', () => {
    for (const [name, defaults, labels, maxima] of [
      ['headbutt-recoil-options', recoil.DEFAULT_HEADBUTT_RECOIL_SETTINGS, ['petHeadbuttRecoilStrength', 'petHeadbuttRecoilWobble'], [200, 100]],
      ['typing-motion-options', typing.DEFAULT_TYPING_MOTION_SETTINGS, ['petTypingRadius', 'petTypingHandLift', 'petTypingBodyMotion', 'petTypingReturnSpeed'], [1, 300, 300, 400]],
    ] as const) {
      const h = harness(name, defaults)
      try {
        for (const [index, label] of labels.entries()) {
          const props = h.slider(label).props!
          assert.equal(props['display-step'], 0.1)
          const range = { min: props.min, max: props.max, defaultValue: props['default-value'] }
          assert.deepEqual(display.sliderDisplayRange({ ...range, displayStep: props['display-step'] }), { min: -1, max: 1, defaultValue: 0, step: 0.1 })
          assert.equal(display.fromSliderDisplayValue(1, range), maxima[index])
          assert.equal(display.toSliderDisplayValue(props.value, range), 0)
        }
        assert.deepEqual(h.emitted, [])
      } finally {
        h.dispose()
      }
    }
  })

  it('retains wobble during a strength gesture, collapses on completion and rejects hidden/OFF/locked input', async () => {
    const h = harness('headbutt-recoil-options', { ...recoil.DEFAULT_HEADBUTT_RECOIL_SETTINGS })
    try {
      const wobbleVisible = () => h.visibility.get(h.row('petHeadbuttRecoilWobble'))
      const staleWobble = h.slider('petHeadbuttRecoilWobble')
      h.slider('petHeadbuttRecoilStrength').props!['onUpdate:value'](15)
      await Vue.nextTick()
      assert.equal(wobbleVisible(), true, 'live strength must not shift layout')
      h.slider('petHeadbuttRecoilStrength').props!.onAfterChange(15)
      assert.equal(wobbleVisible(), false, 'display -0.7 is the inclusive collapse threshold')
      staleWobble.props!['onUpdate:value'](90)
      assert.equal(h.props.settings.petHeadbuttRecoilWobblePercent, 50)
      h.slider('petHeadbuttRecoilStrength').props!['onUpdate:value'](20)
      await Vue.nextTick()
      assert.equal(wobbleVisible(), false)
      h.slider('petHeadbuttRecoilStrength').props!.onAfterChange(20)
      assert.equal(wobbleVisible(), true)
      h.props.settings.petHeadbuttRecoilEnabled = false
      await Vue.nextTick()
      const before = { ...h.props.settings }
      staleWobble.props!['onUpdate:value'](90)
      h.slider('petHeadbuttRecoilStrength').props!['onUpdate:value'](90)
      assert.deepEqual(h.props.settings, before)
      h.props.settings.petHeadbuttRecoilStrengthPercent = 5
      h.props.settings.petHeadbuttRecoilEnabled = true
      await Vue.nextTick()
      assert.equal(wobbleVisible(), false, 'reopening synchronizes the retained strength')
      h.props.disabled = true
      await Vue.nextTick()
      const locked = { ...h.props.settings }
      h.nodes().find(node => node.type === 'switch')!.props!['onUpdate:checked'](false)
      h.slider('petHeadbuttRecoilStrength').props!['onUpdate:value'](100)
      assert.deepEqual(h.props.settings, locked)
    } finally {
      h.dispose()
    }
  })

  it('synchronizes wobble after external settings restoration without waiting for a new gesture', async () => {
    const h = harness('headbutt-recoil-options', { ...recoil.DEFAULT_HEADBUTT_RECOIL_SETTINGS, petHeadbuttRecoilStrengthPercent: 5 })
    try {
      assert.equal(h.visibility.get(h.row('petHeadbuttRecoilWobble')), false)
      h.props.settings = { ...recoil.DEFAULT_HEADBUTT_RECOIL_SETTINGS }
      await Vue.nextTick()
      assert.equal(h.visibility.get(h.row('petHeadbuttRecoilWobble')), true)
      assert.deepEqual(h.emitted, [], 'restoring settings must not write them back')
    } finally {
      h.dispose()
    }
  })

  it('refreshes a replaced preset even at the live gesture value and ignores obsolete completion values', async () => {
    const h = harness('headbutt-recoil-options', { ...recoil.DEFAULT_HEADBUTT_RECOIL_SETTINGS })
    try {
      const strength = h.slider('petHeadbuttRecoilStrength')
      strength.props!['onUpdate:value'](15)
      await Vue.nextTick()
      assert.equal(h.visibility.get(h.row('petHeadbuttRecoilWobble')), true)
      h.props.settings = { ...h.props.settings }
      await Vue.nextTick()
      assert.equal(h.visibility.get(h.row('petHeadbuttRecoilWobble')), false, 'preset identity replacement is not a continuing drag')
      h.props.settings = { ...recoil.DEFAULT_HEADBUTT_RECOIL_SETTINGS }
      await Vue.nextTick()
      strength.props!.onAfterChange(15)
      assert.equal(h.visibility.get(h.row('petHeadbuttRecoilWobble')), true, 'a stale release uses the currently restored strength')
    } finally {
      h.dispose()
    }
  })

  it('bounds typing changes and rejects delayed updates while its mode is hidden or locked', () => {
    const h = harness('typing-motion-options', typing.DEFAULT_TYPING_MOTION_SETTINGS)
    try {
      const lift = h.slider('petTypingHandLift')
      lift.props!['onUpdate:value'](999)
      assert.equal(h.props.settings.petTypingHandLiftPercent, 300)
      lift.props!['onUpdate:value'](Number.NaN)
      assert.equal(h.props.settings.petTypingHandLiftPercent, 300)
      h.props.disabled = true
      lift.props!['onUpdate:value'](0)
      assert.equal(h.props.settings.petTypingHandLiftPercent, 300)
    } finally {
      h.dispose()
    }
  })
})
