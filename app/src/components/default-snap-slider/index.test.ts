/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { SliderSnapRange } from './snapValue'

import * as snapValue from './snapValue'

interface TestElement {
  type: string
  props: Record<string, unknown>
  children: TestElement[]
  parent: TestElement | null
}

function element(type: string): TestElement {
  return { type, props: {}, children: [], parent: null }
}

// Compile the actual wrapper and use a controlled slider stub so its input and
// attribute forwarding can be exercised without adding a browser/DOM dependency.
const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
const compiled = compileScript(descriptor, { id: 'default-snap-slider-test', inlineTemplate: true })
const transformed = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
})
const wrapperModule = { exports: {} as { default: Vue.Component } }
const sliderStub = Vue.defineComponent({
  inheritAttrs: false,
  props: ['value', 'min', 'max', 'step', 'disabled'],
  setup: (props, { attrs, expose }) => {
    expose({ focus: () => (attrs.onFocus as () => void)?.() })
    return () => Vue.h('slider', { ...attrs, ...props })
  },
})
// eslint-disable-next-line no-new-func
new Function('require', 'module', 'exports', transformed.outputText)((id: string) => {
  if (id === 'vue') return Vue
  if (id === 'ant-design-vue') return { Slider: sliderStub }
  if (id === './snapValue') return snapValue
  throw new Error(`Unexpected wrapper import: ${id}`)
}, wrapperModule, wrapperModule.exports)

function mountSlider(initialValue: number, options: Partial<SliderSnapRange> & { disabled?: boolean } = {}) {
  const renderer = Vue.createRenderer<TestElement, TestElement>({
    createElement: element,
    createText: () => element('text'),
    createComment: () => element('comment'),
    setText: () => {},
    setElementText: () => {},
    patchProp: (node, key, _previous, next) => {
      node.props[key] = next
    },
    insert: (node, parent, anchor) => {
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove: (node) => {
      const parent = node.parent
      if (parent) parent.children.splice(parent.children.indexOf(node), 1)
      node.parent = null
    },
    parentNode: node => node.parent,
    nextSibling: (node) => {
      const siblings = node.parent?.children ?? []
      return siblings[siblings.indexOf(node) + 1] ?? null
    },
  })
  const value = Vue.ref(initialValue)
  const changes: number[] = []
  const finishes: number[] = []
  const inputOrder: string[] = []
  const root = element('root')
  const app = renderer.createApp({
    setup: () => () => Vue.h(wrapperModule.exports.default, {
      'value': value.value,
      'min': -100,
      'max': 100,
      'defaultValue': 0,
      'step': 1,
      'class': 'existing-slider-class',
      'tipFormatter': (next?: number) => `${next}%`,
      ...options,
      'onUpdate:value': (next: number) => {
        value.value = next
      },
      'onFocus': () => inputOrder.push('focus'),
      'onChange': (next: number) => {
        changes.push(next)
        inputOrder.push('change')
      },
      'onAfterChange': (next: number) => finishes.push(next),
    }),
  })
  app.mount(root)
  const wrapper = root.children.find(node => node.type === 'div')!
  const slider = wrapper.children.find(node => node.type === 'slider')!
  const dispatch = (node: TestElement, event: string, payload?: number | ReturnType<typeof mouseDown>) => {
    const input = payload ?? (event === 'onMousedownCapture' ? mouseDown() : undefined)
    ;(node.props[event] as (payload: typeof input) => void)(input)
  }
  return { app, value, changes, finishes, inputOrder, wrapper, slider, dispatch }
}

function mouseDown(button = 0) {
  return {
    button,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
}

describe('default snap slider input contract', () => {
  it('focuses before pointer changes and prevents the default mousedown blur that ends track dragging', () => {
    const control = mountSlider(4)
    const event = mouseDown()
    control.dispatch(control.wrapper, 'onMousedownCapture', event)
    assert.equal(event.defaultPrevented, true)
    assert.deepEqual(control.inputOrder, ['focus', 'change'])
    assert.equal(control.value.value, 0)
    assert.deepEqual(control.finishes, [])
    control.app.unmount()
  })

  it('leaves non-primary mouse presses and disabled sliders untouched', () => {
    for (const options of [{ button: 1 }, { button: 2 }, { button: 0, disabled: true }]) {
      const control = mountSlider(4, { disabled: options.disabled })
      const event = mouseDown(options.button)
      control.dispatch(control.wrapper, 'onMousedownCapture', event)
      assert.equal(event.defaultPrevented, false)
      assert.deepEqual(control.inputOrder, [])
      assert.equal(control.value.value, 4)
      control.app.unmount()
    }
  })

  it('keeps the controlled display, tooltip and stored value snapped over repeated pointer inputs, then exits', async () => {
    const control = mountSlider(20)
    control.dispatch(control.wrapper, 'onMousedownCapture')
    for (const raw of [6, 5, 4, 2, -4, -5, -6]) {
      control.dispatch(control.slider, 'onUpdate:value', raw)
      await Vue.nextTick()
      const expected = Math.abs(raw) <= 5 ? 0 : raw
      assert.equal(control.value.value, expected)
      assert.equal(control.slider.props.value, expected)
      assert.equal((control.slider.props.tipFormatter as (value: number) => string)(control.slider.props.value as number), `${expected}%`)
    }
    control.dispatch(control.slider, 'onAfterChange', -6)
    assert.deepEqual(control.finishes, [-6])
    assert.equal(control.slider.props.class, 'existing-slider-class')
    assert.equal(control.slider.props.step, 1)
    control.app.unmount()
  })

  it('preserves keyboard step adjustments and restores snapping on mouse or touch input', async () => {
    const control = mountSlider(0)
    control.dispatch(control.wrapper, 'onKeydownCapture')
    for (const value of [1, 2]) {
      control.dispatch(control.slider, 'onUpdate:value', value)
      await Vue.nextTick()
      assert.equal(control.slider.props.value, value)
    }
    control.dispatch(control.wrapper, 'onTouchstartCapture')
    await Vue.nextTick()
    assert.equal(control.value.value, 0)
    control.dispatch(control.slider, 'onUpdate:value', 4)
    await Vue.nextTick()
    assert.equal(control.slider.props.value, 0)
    control.app.unmount()
  })

  it('does not snap restored values or external resets until pointer interaction starts', async () => {
    const control = mountSlider(4)
    assert.equal(control.slider.props.value, 4)
    assert.deepEqual(control.changes, [])
    control.value.value = -3
    await Vue.nextTick()
    assert.equal(control.slider.props.value, -3)
    assert.deepEqual(control.changes, [])
    control.value.value = 0
    await Vue.nextTick()
    assert.equal(control.slider.props.value, 0)
    assert.deepEqual(control.changes, [])
    control.app.unmount()
  })

  it('forwards disabled state and ignores attempted pointer updates', async () => {
    const control = mountSlider(4, { disabled: true })
    control.dispatch(control.wrapper, 'onMousedownCapture')
    control.dispatch(control.slider, 'onUpdate:value', 20)
    await Vue.nextTick()
    assert.equal(control.slider.props.disabled, true)
    assert.equal(control.slider.props.value, 4)
    assert.deepEqual(control.changes, [])
    control.app.unmount()
  })
})
