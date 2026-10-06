/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import { useShortcutStore } from '@/stores/shortcut'
import { shortcutIdentity } from '@/utils/shortcutIdentity'

interface ShortcutEvent {
  shortcut: string
  state: 'Pressed' | 'Released'
}

interface Element {
  props: Record<string, unknown>
  children: Element[]
  parent: Element | null
  blur: () => void
  blurCount: number
}

function element(): Element {
  const node: Element = {
    props: {},
    children: [],
    parent: null,
    blurCount: 0,
    blur: () => {
      node.blurCount++
      ;(node.props.onBlur as () => void)?.()
    },
  }
  return node
}

function walk(node: Element): Element[] {
  return [node, ...node.children.flatMap(walk)]
}

const require = createRequire(import.meta.url)

function mountShortcuts() {
  setActivePinia(createPinia())
  const store = useShortcutStore()
  store.visibleBlock = 'Control+Shift+A'
  store.mirrorMode = 'Control+B'
  const wrapper = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('div', slots.default?.()) })
  let dataBridge: Record<string, unknown>
  let shortcut: Vue.Component
  let keyboard: Record<string, unknown>
  let keyPress: {
    useKeyPress: (key: Vue.Ref<string>, callback: (event: ShortcutEvent) => void) => void
    cancelShortcutRecording: () => void
  }
  const bindings = new Map<string, (event: ShortcutEvent) => void>()
  const calls: string[] = []
  function load(source: string) {
    const module = { exports: {} as Record<string, unknown> }
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    // Mount the real input and panel so persisted store updates follow actual keyboard handlers.
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', code)((id: string) => {
      if (id === 'vue') return Vue
      if (id === '@/features/stateSafety/bridge') return dataBridge
      if (id === 'es-toolkit/compat') return require(id)
      if (id === '@/utils/keyboard') return keyboard
      if (id === '@/composables/useKeyPress') return keyPress
      if (id === '@tauri-apps/plugin-global-shortcut') {
        return {
          isRegistered: async (key: string) => bindings.has(shortcutIdentity(key)),
          register: async (key: string, callback: (event: ShortcutEvent) => void) => {
            if (bindings.has(shortcutIdentity(key))) throw new Error('Shortcut is already registered.')
            bindings.set(shortcutIdentity(key), callback)
          },
          unregister: async (key: string) => {
            bindings.delete(shortcutIdentity(key))
          },
        }
      }
      if (id === '@/utils/shortcutIdentity') {
        return load(readFileSync(new URL('../../utils/shortcutIdentity.ts', import.meta.url), 'utf8'))
      }
      if (id === '@/components/shortcut/index.vue') return { default: shortcut }
      if (id.startsWith('@/components/pro-list')) return { default: wrapper }
      if (id === '@/stores/shortcut.ts') return { useShortcutStore: () => store }
      throw new Error(`Unexpected import: ${id}`)
    }, module, module.exports)
    return module.exports
  }
  function component(path: string) {
    const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
    return load(compileScript(descriptor, { id: path, inlineTemplate: true }).content).default as Vue.Component
  }
  dataBridge = load(readFileSync(new URL('../../features/stateSafety/bridge.ts', import.meta.url), 'utf8'))
  keyboard = load(readFileSync(new URL('../../utils/keyboard.ts', import.meta.url), 'utf8'))
  keyPress = load(readFileSync(new URL('../../composables/useKeyPress.ts', import.meta.url), 'utf8')) as typeof keyPress
  shortcut = component('./index.vue')
  const panel = component('../../pages/preference/components/shortcut/index.vue')
  const showPanel = Vue.ref(true)
  const owner = Vue.defineComponent({
    setup: () => {
      keyPress.useKeyPress(Vue.toRef(store, 'visibleBlock'), () => calls.push('visibleBlock'))
      keyPress.useKeyPress(Vue.toRef(store, 'mirrorMode'), () => calls.push('mirrorMode'))
      return () => showPanel.value ? Vue.h(panel) : null
    },
  })
  const renderer = Vue.createRenderer<Element, Element>({
    createElement: element,
    createText: element,
    createComment: element,
    setText: () => {},
    setElementText: () => {},
    patchProp: (node, name, _previous, value) => {
      node.props[name] = value
    },
    insert: (node, parent) => {
      node.parent = parent
      parent.children.push(node)
    },
    remove: (node) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = null
    },
    parentNode: node => node.parent,
    nextSibling: () => null,
  })
  const root = element()
  const app = renderer.createApp(owner)
  app.config.globalProperties.$t = (key: string) => key
  app.mount(root)
  const inputs = () => walk(root).filter(node => node.props.tabindex === 0)
  const focus = (index: number) => {
    const input = inputs()[index]
    assert.ok(input)
    ;(input.props.onFocus as () => void)()
  }
  const keyDown = (index: number, key: string, code: string) => {
    const event = { key, code, prevented: false, stopped: false, preventDefault() {
      this.prevented = true
    }, stopPropagation() {
      this.stopped = true
    } }
    ;(inputs()[index].props.onKeydown as (value: { key: string, code: string, preventDefault: () => void, stopPropagation: () => void }) => void)(event)
    return event
  }
  return {
    store,
    app,
    calls,
    showPanel,
    focus,
    inputs,
    rows: () => walk(root).filter(node => typeof node.props.description === 'string'),
    keyDown,
    cancelRecording: () => keyPress.cancelShortcutRecording(),
    fire: (key: string, state: ShortcutEvent['state'] = 'Pressed') => bindings.get(shortcutIdentity(key))?.({ shortcut: key, state }),
    errors: () => walk(root).filter(node => node.props.role === 'alert'),
    record: async (index: number, keys: Array<[string, string]>) => {
      focus(index)
      for (const [key, code] of keys) {
        keyDown(index, key, code)
      }
      await Vue.nextTick()
    },
  }
}

describe('shortcut recording conflicts', () => {
  it('keeps the previous binding and reports a duplicate even when modifiers were pressed in a different order', async () => {
    const h = mountShortcuts()
    try {
      await h.record(5, [['Shift', 'ShiftLeft'], ['Control', 'ControlLeft'], ['a', 'KeyA']])
      assert.equal(h.store.mirrorMode, 'Control+B')
      assert.equal(h.store.visibleBlock, 'Control+Shift+A')
      assert.equal(h.errors().length, 1)
      await h.record(5, [['Control', 'ControlLeft'], ['c', 'KeyC']])
      assert.equal(h.store.mirrorMode, 'Control+C')
      assert.equal(h.errors().length, 0)
    } finally {
      h.app.unmount()
    }
  })

  it('allows recording the same binding for its own action without rewriting other stored shortcuts', async () => {
    const h = mountShortcuts()
    try {
      await h.record(5, [['Control', 'ControlLeft'], ['b', 'KeyB']])
      assert.equal(h.store.mirrorMode, 'Control+B')
      assert.equal(h.store.visibleBlock, 'Control+Shift+A')
      assert.equal(h.errors().length, 0)
    } finally {
      h.app.unmount()
    }
  })
})

async function flush() {
  for (let index = 0; index < 15; index++) await Vue.nextTick()
}

describe('native shortcut actions during recording', () => {
  for (const delivery of ['before blur', 'after blur', 'released before blur']) {
    it(`suppresses the recorded native press ${delivery} and restores its next normal use`, async () => {
      const h = mountShortcuts()
      try {
        await flush()
        h.focus(5)
        h.keyDown(5, 'Shift', 'ShiftLeft')
        h.keyDown(5, 'Control', 'ControlLeft')
        if (delivery !== 'after blur') h.fire('Control+Shift+A')
        if (delivery === 'released before blur') h.fire('Control+Shift+A', 'Released')
        h.keyDown(5, 'a', 'KeyA')
        if (delivery === 'after blur') h.fire('Control+Shift+A')
        await flush()
        assert.deepEqual(h.calls, [])
        assert.equal(h.store.mirrorMode, 'Control+B')
        assert.equal(h.errors().length, 1)
        if (delivery !== 'released before blur') h.fire('Control+Shift+A', 'Released')
        h.fire('Control+Shift+A')
        assert.deepEqual(h.calls, ['visibleBlock'])
      } finally {
        h.app.unmount()
        await flush()
      }
    })
  }

  it('does not suppress the first real press of a newly registered key', async () => {
    const h = mountShortcuts()
    try {
      await flush()
      await h.record(5, [['Control', 'ControlLeft'], ['c', 'KeyC']])
      await flush()
      assert.equal(h.store.mirrorMode, 'Control+C')
      h.fire('Control+C')
      assert.deepEqual(h.calls, ['mirrorMode'])
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('keeps suppression when its own key is recorded with the modifiers in another order', async () => {
    const h = mountShortcuts()
    try {
      await flush()
      await h.record(0, [['Shift', 'ShiftLeft'], ['Control', 'ControlLeft'], ['a', 'KeyA']])
      await flush()
      h.fire('Control+Shift+A')
      assert.deepEqual(h.calls, [])
      h.fire('Control+Shift+A', 'Released')
      h.fire('Control+Shift+A')
      assert.deepEqual(h.calls, ['visibleBlock'])
      assert.equal(h.store.visibleBlock, 'Control+Shift+A')
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('releases recording ownership when the focused recorder unmounts', async () => {
    const h = mountShortcuts()
    try {
      await flush()
      h.focus(5)
      h.keyDown(5, 'Control', 'ControlLeft')
      h.showPanel.value = false
      await flush()
      h.fire('Control+Shift+A')
      assert.deepEqual(h.calls, ['visibleBlock'])
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('cancels partial input on window focus loss without changing the saved key or suppressing its next press', async () => {
    const h = mountShortcuts()
    try {
      await flush()
      h.focus(5)
      h.keyDown(5, 'Control', 'ControlLeft')
      h.cancelRecording()
      h.fire('Control+Shift+A')
      assert.equal(h.store.mirrorMode, 'Control+B')
      assert.deepEqual(h.calls, ['visibleBlock'])
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('removes suppression with a cleared binding so reusing it cannot consume the first real press', async () => {
    const h = mountShortcuts()
    try {
      await flush()
      h.focus(5)
      h.fire('Control+Shift+A')
      h.store.visibleBlock = ''
      await flush()
      h.cancelRecording()
      h.store.visibleBlock = 'Control+Shift+A'
      await flush()
      h.fire('Control+Shift+A')
      assert.deepEqual(h.calls, ['visibleBlock'])
    } finally {
      h.app.unmount()
      await flush()
    }
  })
})

describe('shortcut cancellation and complete panel', () => {
  it('adds empty cycle defaults when restoring legacy shortcut state', () => {
    setActivePinia(createPinia())
    const store = useShortcutStore()
    store.$patch({ visibleBlock: 'Control+A', mirrorMode: 'F2' })
    assert.equal(store.cycleZoom, '')
    assert.equal(store.cycleRotation, '')
    assert.equal(store.visibleBlock, 'Control+A')
    assert.equal(store.mirrorMode, 'F2')
  })

  for (const existing of [false, true]) {
    it(`cancels ESC with modifiers and restores ${existing ? 'the saved binding' : 'the empty binding'}`, async () => {
      const h = mountShortcuts()
      try {
        if (!existing) h.store.mirrorMode = ''
        await flush()
        h.focus(5)
        h.keyDown(5, 'Control', 'ControlLeft')
        h.keyDown(5, 'Shift', 'ShiftLeft')
        const event = h.keyDown(5, 'Escape', 'Escape')
        await flush()
        assert.equal(event.prevented, true)
        assert.equal(event.stopped, true)
        assert.equal(h.inputs()[5].blurCount, 1)
        assert.equal(h.store.mirrorMode, existing ? 'Control+B' : '')
        assert.equal(h.errors().length, 0)
        h.fire('Control+Shift+A')
        assert.deepEqual(h.calls, ['visibleBlock'])
        if (existing) {
          h.fire('Control+B')
          assert.deepEqual(h.calls, ['visibleBlock', 'mirrorMode'])
        }
        await h.record(5, [['Control', 'ControlLeft'], ['c', 'KeyC']])
        await flush()
        assert.equal(h.store.mirrorMode, 'Control+C')
        h.fire('Control+C')
        assert.equal(h.calls.at(-1), 'mirrorMode')
      } finally {
        h.app.unmount()
        await flush()
      }
    })
  }

  it('labels all twelve recorder groups and checks new bindings against all other actions', async () => {
    const h = mountShortcuts()
    const keys = ['visibleBlock', 'toggleBroadcast', 'visiblePreference', 'showDisplayArea', 'mouseEnabled', 'mirrorMode', 'cycleZoom', 'cycleRotation', 'keepInScreen', 'penetrable', 'hideOnHover', 'alwaysOnTop'] as const
    try {
      assert.equal(h.inputs().length, keys.length)
      assert.ok(h.inputs().every(input => input.props.role === 'group'))
      assert.deepEqual(h.inputs().map(input => input.props['aria-label']), h.rows().map(row => row.props.title))
      assert.deepEqual(h.rows().map(row => row.props.description), [
        'pages.preference.shortcut.hints.toggleBlock',
        'pages.preference.shortcut.hints.toggleBroadcast',
        'pages.preference.shortcut.hints.togglePreferences',
        'pages.preference.scene.hints.showDisplayArea',
        'pages.preference.environment.hints.mouseEnabled',
        'pages.preference.shortcut.hints.mirrorMode',
        'pages.preference.shortcut.hints.cycleZoom',
        'pages.preference.shortcut.hints.cycleRotation',
        'pages.preference.general.hints.keepInScreen',
        'pages.preference.general.hints.passThrough',
        'pages.preference.general.hints.hideOnHover',
        'pages.preference.shortcut.hints.alwaysOnTop',
      ])
      for (const [index, key] of keys.entries()) {
        await h.record(index, [[`F${index + 1}`, `F${index + 1}`]])
        assert.equal(h.store[key], `F${index + 1}`)
        const clear = walk(h.inputs()[index]).find(node => node.props['aria-label'] === 'components.shortcut.buttons.clear')
        assert.equal(clear?.props.type, 'button')
      }
      await h.record(6, [['F8', 'F8']])
      assert.equal(h.store.cycleZoom, 'F7')
      assert.equal(h.errors().length, 1)
      await h.record(7, [['F7', 'F7']])
      assert.equal(h.store.cycleRotation, 'F8')
      assert.equal(h.errors().length, 2)
      await h.record(6, [['F7', 'F7']])
      await h.record(7, [['F8', 'F8']])
      await h.record(1, [['F5', 'F5']])
      assert.equal(h.store.toggleBroadcast, 'F2')
      assert.equal(h.errors().length, 1)
      h.store.reset()
      await flush()
      for (const key of keys) assert.equal(h.store[key], '')
    } finally {
      h.app.unmount()
      await flush()
    }
  })
})
