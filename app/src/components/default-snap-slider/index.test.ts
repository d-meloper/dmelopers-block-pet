/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { SliderSnapRange } from './snapValue'

import * as displayValue from './displayValue'
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
const locale = Vue.ref('ko-KR')
const messages = Object.fromEntries(['ko-KR', 'en-US'].map(language => [language, JSON.parse(readFileSync(new URL(`../../locales/${language}.json`, import.meta.url), 'utf8'))]))
class GestureWindow extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    if (callback) {
      const callbacks = this.listeners.get(type) ?? new Set()
      callbacks.add(callback)
      this.listeners.set(type, callbacks)
    }
    super.addEventListener(type, callback)
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    if (callback) this.listeners.get(type)?.delete(callback)
    super.removeEventListener(type, callback)
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0)
  }
}
const gestureWindow = new GestureWindow()
const sliderStub = Vue.defineComponent({
  inheritAttrs: false,
  props: ['value', 'min', 'max', 'step', 'disabled', 'tipFormatter'],
  setup: (props, { attrs, expose }) => {
    expose({ focus: () => (attrs.onFocus as () => void)?.() })
    return () => Vue.h('slider', {
      ...attrs,
      ...props,
      tooltipText: props.tipFormatter?.(props.value),
    })
  },
})
// eslint-disable-next-line no-new-func
new Function('require', 'module', 'exports', 'window', transformed.outputText)((id: string) => {
  if (id === 'vue') return Vue
  if (id === 'vue-i18n') {
    return { useI18n: () => ({ t: (key: string) => {
      assert.equal(key, 'components.defaultSnapSlider.defaultSuffix')
      return messages[locale.value].components.defaultSnapSlider.defaultSuffix
    } }) }
  }
  if (id === 'ant-design-vue') return { Slider: sliderStub }
  if (id === './snapValue') return snapValue
  if (id === './displayValue') return displayValue
  throw new Error(`Unexpected wrapper import: ${id}`)
}, wrapperModule, wrapperModule.exports, gestureWindow)

function mountSlider(initialValue: number, options: Partial<SliderSnapRange> & {
  displayMode?: displayValue.SliderDisplayMode
  disabled?: boolean
  tipFormatter?: ((value?: number) => Vue.VNodeChild) | null
} = {}) {
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
  const disabled = Vue.ref(options.disabled ?? false)
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
      'displayMode': 'raw',
      'class': 'existing-slider-class',
      'tipFormatter': (next?: number) => `${next}%`,
      ...options,
      'disabled': disabled.value,
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
  const dispatch = (node: TestElement, event: string, payload?: number | ReturnType<typeof mouseDown> | { key: string }) => {
    const input = payload ?? (event === 'onMousedownCapture' ? mouseDown() : event === 'onKeydownCapture' ? { key: 'ArrowRight' } : undefined)
    ;(node.props[event] as (payload: typeof input) => void)(input)
  }
  const tooltip = () => slider.props.tooltipText
  return { app, value, disabled, changes, finishes, inputOrder, wrapper, slider, dispatch, tooltip }
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
      assert.equal(control.tooltip(), `${expected}%${expected === 0 ? '(기본값)' : ''}`)
    }
    control.dispatch(control.slider, 'onAfterChange', -6)
    assert.deepEqual(control.finishes, [])
    gestureWindow.dispatchEvent(new Event('mouseup'))
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

  it('annotates only active default values, preserving formatter units and locale', async () => {
    for (const language of ['ko-KR', 'en-US']) {
      locale.value = language
      const suffix = language === 'ko-KR' ? '(기본값)' : '(Default)'
      for (const [initial, formatter, expected] of [
        [100, (value?: number) => `${value}%`, '100%'],
        [-39, (value?: number) => `${value}°`, '-39°'],
        [0, (value?: number) => value?.toFixed(2), '0.00'],
        [120, (value?: number) => `${value}px`, '120px'],
        [60, undefined, '60'],
      ] as const) {
        const control = mountSlider(initial, { defaultValue: initial, tipFormatter: formatter })
        assert.equal(control.tooltip(), expected)
        control.dispatch(control.wrapper, 'onMousedownCapture')
        await Vue.nextTick()
        assert.equal(control.tooltip(), `${expected}${suffix}`)
        control.dispatch(control.slider, 'onAfterChange', initial)
        gestureWindow.dispatchEvent(new Event('mouseup'))
        await Vue.nextTick()
        assert.equal(control.tooltip(), expected)
        control.dispatch(control.wrapper, 'onKeydownCapture')
        assert.equal(control.tooltip(), expected)
        control.app.unmount()
      }
    }
    locale.value = 'ko-KR'
  })

  it('clears hints and gesture listeners on outside release, cancellation, blur and unmount', async () => {
    for (const event of ['mouseup', 'touchend', 'touchcancel', 'pointercancel', 'blur']) {
      const control = mountSlider(0)
      control.dispatch(control.wrapper, 'onTouchstartCapture')
      await Vue.nextTick()
      assert.equal(control.tooltip(), '0%(기본값)')
      assert.equal(gestureWindow.listenerCount, 5)
      gestureWindow.dispatchEvent(new Event(event))
      await Vue.nextTick()
      assert.equal(control.tooltip(), '0%')
      assert.equal(gestureWindow.listenerCount, 0)
      control.dispatch(control.wrapper, 'onMousedownCapture')
      control.app.unmount()
      assert.equal(gestureWindow.listenerCount, 0)
    }
  })

  it('clears hints when disabled or focus leaves and does not resume them when reenabled', async () => {
    const control = mountSlider(0)
    control.dispatch(control.wrapper, 'onMousedownCapture')
    await Vue.nextTick()
    assert.equal(control.tooltip(), '0%(기본값)')
    control.disabled.value = true
    await Vue.nextTick()
    assert.equal(control.tooltip(), '0%')
    assert.equal(gestureWindow.listenerCount, 0)
    control.disabled.value = false
    await Vue.nextTick()
    assert.equal(control.tooltip(), '0%')
    control.dispatch(control.wrapper, 'onMousedownCapture')
    control.dispatch(control.wrapper, 'onFocusout')
    await Vue.nextTick()
    assert.equal(control.tooltip(), '0%')
    assert.equal(gestureWindow.listenerCount, 0)
    control.app.unmount()
  })

  it('preserves explicitly disabled tooltips', async () => {
    const control = mountSlider(0, { tipFormatter: null })
    control.dispatch(control.wrapper, 'onTouchstartCapture')
    await Vue.nextTick()
    assert.equal(control.slider.props.tipFormatter, null)
    control.app.unmount()
  })

  it('keeps normalized handles, tooltips and actual model values together without writing restored values', async () => {
    const control = mountSlider(102.375, { min: 0, max: 400, defaultValue: 100, displayMode: 'centered', tipFormatter: undefined })
    assert.equal(control.value.value, 102.375)
    assert.equal(control.slider.props.min, -1)
    assert.equal(control.slider.props.max, 1)
    assert.equal(control.slider.props.step, 0.01)
    assert.deepEqual(control.changes, [])
    control.dispatch(control.wrapper, 'onMousedownCapture')
    await Vue.nextTick()
    assert.equal(control.value.value, 100)
    assert.equal(control.slider.props.value, 0)
    assert.equal(control.tooltip(), '0(기본값)')
    control.dispatch(control.slider, 'onUpdate:value', 0.34)
    await Vue.nextTick()
    assert.equal(control.value.value, 202)
    assert.equal(control.tooltip(), '0.34')
    control.dispatch(control.slider, 'onAfterChange', 0.34)
    assert.deepEqual(control.finishes, [])
    gestureWindow.dispatchEvent(new Event('mouseup'))
    assert.deepEqual(control.finishes, [202])
    control.app.unmount()
  })

  it('finishes held keyboard adjustments once on keyup and allows leaving the default magnet', async () => {
    const control = mountSlider(100, { min: 0, max: 400, defaultValue: 100, displayMode: 'centered', tipFormatter: undefined })
    for (const displayed of [0.01, 0.02, 0.03]) {
      control.dispatch(control.wrapper, 'onKeydownCapture')
      control.dispatch(control.slider, 'onUpdate:value', displayed)
      control.dispatch(control.slider, 'onAfterChange', displayed)
      await Vue.nextTick()
    }
    assert.equal(control.value.value, 109)
    assert.equal(control.tooltip(), '0.03')
    assert.deepEqual(control.finishes, [])
    control.dispatch(control.wrapper, 'onKeyupCapture', { key: 'ArrowRight' })
    control.dispatch(control.slider, 'onAfterChange', 0.03)
    control.dispatch(control.wrapper, 'onFocusout')
    assert.deepEqual(control.finishes, [109])
    assert.equal(gestureWindow.listenerCount, 0)
    control.app.unmount()
  })

  it('repeats track gestures without early completion and deduplicates outside release and blur', async () => {
    const control = mountSlider(20)
    for (const next of [40, 70]) {
      control.dispatch(control.wrapper, 'onMousedownCapture')
      control.dispatch(control.slider, 'onUpdate:value', next)
      control.dispatch(control.slider, 'onAfterChange', next)
      await Vue.nextTick()
      assert.equal(control.finishes.length, next === 40 ? 0 : 1)
      gestureWindow.dispatchEvent(new Event('mouseup'))
      control.dispatch(control.wrapper, 'onFocusout')
      control.dispatch(control.slider, 'onAfterChange', next)
    }
    assert.deepEqual(control.finishes, [40, 70])
    assert.equal(control.inputOrder.filter(value => value === 'focus').length, 2)
    control.app.unmount()
  })

  it('skips unchanged clicks but completes changed cancellation once in actual opacity units', async () => {
    const control = mountSlider(55, { min: 10, max: 100, defaultValue: 100, displayMode: 'unit', tipFormatter: undefined })
    assert.equal(control.slider.props.value, 0.5)
    control.dispatch(control.wrapper, 'onMousedownCapture')
    control.dispatch(control.slider, 'onUpdate:value', 0.5)
    gestureWindow.dispatchEvent(new Event('mouseup'))
    assert.deepEqual(control.finishes, [])
    control.dispatch(control.wrapper, 'onTouchstartCapture')
    control.dispatch(control.slider, 'onUpdate:value', 0.2)
    await Vue.nextTick()
    gestureWindow.dispatchEvent(new Event('touchcancel'))
    gestureWindow.dispatchEvent(new Event('pointercancel'))
    assert.deepEqual(control.finishes, [28])
    control.app.unmount()
  })
})
