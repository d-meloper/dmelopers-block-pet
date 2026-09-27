/* eslint-disable test/no-import-node-test */
import type { Event } from '@tauri-apps/api/event'

import { Window } from '@tauri-apps/api/window'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { isMouseSettingResponse } from '@/features/input/types'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'
import { useShortcutStore } from '@/stores/shortcut'
import { shortcutIdentity } from '@/utils/shortcutIdentity'

interface TestElement {
  children: TestElement[]
  parent: TestElement | null
  props: Record<string, unknown>
  scrollTop: number
}

function element(): TestElement {
  return { children: [], parent: null, props: {}, scrollTop: 0 }
}

async function flush() {
  for (let index = 0; index < 60; index++) await Vue.nextTick()
}

function mountPreferences(theme: 'auto' | 'light' | 'dark' = 'light') {
  setActivePinia(createPinia())
  const catStore = useCatStore()
  const shortcutStore = useShortcutStore()
  const generalStore = useGeneralStore()
  generalStore.appearance.theme = theme
  generalStore.appearance.isDark = theme === 'dark'
  shortcutStore.$patch({
    visibleCat: 'Control+KeyA',
    visiblePreference: 'Control+KeyB',
    mirrorMode: 'Control+KeyC',
    cycleZoom: 'Control+KeyK',
    cycleRotation: 'Control+KeyL',
    penetrable: 'Control+KeyD',
    alwaysOnTop: 'Control+KeyE',
    toggleBroadcast: 'Control+KeyF',
    showDisplayArea: 'Control+KeyG',
    mouseEnabled: 'Control+KeyH',
    keepInScreen: 'Control+KeyI',
    hideOnHover: 'Control+KeyJ',
  })
  const active = new Map<string, (event: { state: string }) => void>()
  const current = Vue.ref(0)
  const innerView = Vue.ref<string>()
  const emitted: Array<{ label: string, event: string, payload: unknown }> = []
  let visible = true
  let queryWindowState: (() => Promise<boolean>) | undefined
  const diagnostics: Array<{ level: string, operation: string }> = []
  let toggledPreference = 0
  let systemTheme: 'light' | 'dark' = 'light'
  let closeRequested: ((event: Event<unknown>) => Promise<void>) | undefined
  let destroyRequests = 0
  const themeListeners = new Set<(event: { payload: 'light' | 'dark' }) => void>()
  const nativeThemes: Array<'light' | 'dark' | null> = []
  const classes = new Set<string>()
  const testWindow = {}
  const domListeners = new Map<string, Array<(event?: { target: object }) => void>>()
  const document = {
    hidden: false,
    documentElement: { classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
    } },
  }
  const wrapper = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('div', slots.default?.()) })
  const blank = Vue.defineComponent({ render: () => null })
  const nativeListeners = new Map<string, (event: { payload: unknown }) => void>()
  let presetEdits = 0
  const eventApi = {
    emitTo: async (label: string, event: string, payload: unknown) => {
      emitted.push({ label, event, payload })
    },
    listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
      nativeListeners.set(event, handler)
      return () => nativeListeners.delete(event)
    },
  }
  const mockVue = { ...Vue, onMounted: () => {} }
  let dataBridge: Record<string, unknown>
  let keyPressModule: Record<string, unknown>
  let shortcutComponent: Vue.Component
  let themeComponent: Vue.Component
  function load(source: string, mountedHooks = false): Record<string, unknown> {
    const module = { exports: {} as Record<string, unknown> }
    const transformed = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    // Actual SFCs and shortcut composable run with native registration stubbed.
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', 'window', 'document', transformed)(
      (id: string) => id === 'vue' && mountedHooks ? Vue : resolve(id),
      module,
      module.exports,
      testWindow,
      document,
    )
    return module.exports
  }
  function component(relativePath: string, mountedHooks = false) {
    const { descriptor } = parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
    return load(compileScript(descriptor, { id: relativePath, inlineTemplate: true }).content, mountedHooks).default as Vue.Component
  }
  function resolve(id: string): unknown {
    if (id === '@/services/diagnostics') return { reportDiagnostic: (level: string, operation: string) => diagnostics.push({ level, operation }) }
    if (id === '@/utils/shortcutIdentity') return { shortcutIdentity }
    if (id === 'vue') return mockVue
    if (id === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
    if (id === 'pinia') return { storeToRefs: (store: object) => Vue.toRefs(store) }
    if (id === '@tauri-apps/plugin-global-shortcut') {
      return {
        isRegistered: async (key: string) => active.has(key),
        register: async (key: string, handler: (event: { state: string }) => void) => {
          active.set(key, handler)
        },
        unregister: async (key: string) => {
          active.delete(key)
        },
      }
    }
    if (id === '@tauri-apps/api/event') return eventApi
    if (id === '@tauri-apps/api/webviewWindow') {
      return { getCurrentWebviewWindow: () => ({
        setTitle: async () => {},
        onResized: async () => () => {},
        onFocusChanged: async () => () => {},
        onCloseRequested: (handler: Parameters<Window['onCloseRequested']>[0]) => Window.prototype.onCloseRequested.call({
          listen: async (_event: string, callback: typeof closeRequested) => {
            closeRequested = callback
            return () => {
              closeRequested = undefined
            }
          },
          destroy: async () => {
            destroyRequests++
            throw new Error('Command plugin:window|destroy not allowed by ACL')
          },
        } as unknown as Window, handler),
        isVisible: () => queryWindowState ? queryWindowState() : Promise.resolve(visible),
        isMinimized: () => queryWindowState ? queryWindowState() : Promise.resolve(false),
        setTheme: async (value: 'light' | 'dark' | null) => {
          nativeThemes.push(value)
        },
        theme: async () => systemTheme,
        onThemeChanged: async (handler: (event: { payload: 'light' | 'dark' }) => void) => {
          themeListeners.add(handler)
          return () => {
            themeListeners.delete(handler)
          }
        },
      }) }
    }
    if (id === '@vueuse/core') {
      return { useEventListener: (_target: unknown, events: string | string[], handler: (event?: { target: object }) => void) => {
        for (const event of typeof events === 'string' ? [events] : events) {
          const handlers = domListeners.get(event) ?? []
          handlers.push(handler)
          domListeners.set(event, handlers)
        }
      } }
    }
    if (id === 'ant-design-vue') return { ConfigProvider: wrapper, Flex: wrapper, Select: wrapper, SelectOption: wrapper }
    if (id === '@/stores/cat') return { useCatStore: () => catStore }
    if (id === '@/stores/shortcut.ts' || id === '@/stores/shortcut') return { useShortcutStore: () => shortcutStore }
    if (id === '@/stores/general') return { useGeneralStore: () => generalStore }
    if (id === '@/stores/performance') return { usePerformanceStore: () => ({ start: async () => {}, stop: async () => {} }) }
    if (id === '@/composables/useKeyPress') return keyPressModule
    if (id === '@/features/stateSafety/bridge') return dataBridge
    if (id === '@/composables/usePreferenceTheme') {
      return load(readFileSync(new URL('../../composables/usePreferenceTheme.ts', import.meta.url), 'utf8'), true)
    }
    if (id === '@/composables/useTray') return { useTray: () => {} }
    if (id === '@/composables/useThemeVars') return { useThemeVars: () => ({ generateColorVars: () => {} }) }
    if (id === '@/composables/useBroadcast') return { BROADCAST_CONTROLLER: Symbol('broadcast'), useBroadcast: () => ({}) }
    if (id === '@/composables/usePresetManager') {
      return { usePresetManager: () => ({
        ready: Vue.ref(true),
        busy: Vue.ref(false),
        setListVisible: () => {},
        markUserEdit: () => {
          presetEdits++
        },
      }) }
    }
    if (id === '@/composables/useSceneViewport') {
      return { useSceneViewport: () => ({
        viewportState: Vue.ref(),
        viewportPending: Vue.ref(false),
        viewportError: Vue.ref(),
        requestViewportMode: async () => {},
        refreshViewport: () => {},
      }) }
    }
    if (id === '@/plugins/process') return { APP_PROCESS_FAILED: 'app-process-failed' }
    if (id === '@/plugins/window') {
      return { toggleWindowVisible: async (label: string) => {
        assert.equal(label, WINDOW_LABEL.PREFERENCE)
        toggledPreference++
      } }
    }
    if (id === '@/constants') return { LISTEN_KEY, WINDOW_LABEL }
    if (id === '@/constants/branding') return { APP_DISPLAY_NAME: 'Test Pet' }
    if (id === '@/config/performance') return {}
    if (id === '@/composables/useTauriListen') return { useTauriListen: () => {} }
    if (id === '@/composables/usePetRuntimeRecovery') return { usePetRuntimeRecovery: () => {} }
    if (id === '@/config/theme') return {}
    if (id === '@/locales/antd') return { getAntdLocale: () => ({}) }
    if (id === '@/utils/viewportInteraction') return { captureViewportPointer: () => {} }
    if (id === '@/features/input/types') return { isMouseSettingResponse }
    if (id === '@/features/presets/editIntent') return { onPresetSelectionChange: () => () => {}, confirmPresetUserEdit: () => {} }
    if (id === '@/features/presets/operations') {
      return {
        presetOperationInProgress: Vue.ref(false),
        presetResetInProgress: Vue.ref(false),
        beginPresetNativeEdit: () => () => {},
      }
    }
    if (id === '@/features/presets/types') return { PRESET_EDIT_REQUEST }
    if (id === '@/features/scene/types') return {}
    if (id === './navigation') return { usePreferenceNavigation: () => ({ current, innerView, closeInnerView: () => {}, openSkinLibrary: () => {} }) }
    if (id === './performanceLifecycle') return { shouldMonitorPreferencePerformance: () => false }
    if (id === './components/shortcut/index.vue') return { default: shortcutComponent }
    if (id === './components/general/index.vue') return { default: Vue.defineComponent({ render: () => Vue.h(themeComponent) }) }
    if (id.startsWith('./components/') || id.startsWith('@/components/')) return { default: blank }
    if (id.endsWith('.css')) return {}
    throw new Error(`Unexpected import: ${id}`)
  }
  dataBridge = load(readFileSync(new URL('../../features/stateSafety/bridge.ts', import.meta.url), 'utf8'))
  keyPressModule = load(readFileSync(new URL('../../composables/useKeyPress.ts', import.meta.url), 'utf8'))
  shortcutComponent = component('./components/shortcut/index.vue')
  themeComponent = component('./components/general/components/theme-mode/index.vue', true)
  const preferenceComponent = component('./index.vue', true)
  const renderer = Vue.createRenderer<TestElement, TestElement>({
    createElement: element,
    createText: element,
    createComment: element,
    setText: () => {},
    setElementText: () => {},
    patchProp: (node, key, _previous, value) => {
      node.props[key] = value
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
  const app = renderer.createApp(preferenceComponent)
  app.config.globalProperties.$t = (key: string) => key
  const root = element()
  app.mount(root)
  function scrollContainer() {
    const find = (node: TestElement): TestElement | undefined => {
      if (String(node.props.class).includes('overflow-auto')) return node
      for (const child of node.children) {
        const found = find(child)
        if (found) return found
      }
    }
    const container = find(root)
    assert.ok(container)
    return container
  }
  return {
    app,
    diagnostics,
    queryWindowState: (query?: () => Promise<boolean>) => {
      queryWindowState = query
    },
    active,
    current,
    innerView,
    scrollContainer,
    shortcutStore,
    catStore,
    emitted,
    generalStore,
    classes,
    nativeThemes,
    themeListeners,
    beginRecording: () => {
      const begin = keyPressModule.beginShortcutRecording as (cancel: () => void) => () => void
      const finish = begin(() => finish())
      return finish
    },
    blur: () => domListeners.get('blur')?.forEach(handler => handler({ target: testWindow })),
    blurChild: () => domListeners.get('blur')?.forEach(handler => handler({ target: {} })),
    changeSystemTheme: (value: 'light' | 'dark') => {
      systemTheme = value
      themeListeners.forEach(handler => handler({ payload: value }))
    },
    fire: (key: string, state = 'Pressed') => active.get(key)?.({ state }),
    hide: () => {
      visible = false
      document.hidden = true
      domListeners.get('visibilitychange')?.forEach(handler => handler())
    },
    close: () => closeRequested?.({ event: 'tauri://close-requested', id: 1, payload: null }),
    destroyRequests: () => destroyRequests,
    toggledPreference: () => toggledPreference,
    presetEdits: () => presetEdits,
    mouseRequests: () => emitted.filter(value => value.event === LISTEN_KEY.MOUSE_SETTING_REQUEST).map(value => value.payload as { requestId: string, enabled?: boolean }),
    respondMouse: (success: boolean, enabled?: boolean, requestId?: string) => {
      const latest = emitted.filter(value => value.event === LISTEN_KEY.MOUSE_SETTING_REQUEST).at(-1)?.payload as { requestId: string } | undefined
      assert.ok(latest)
      nativeListeners.get(LISTEN_KEY.MOUSE_SETTING_RESPONSE)?.({ payload: {
        requestId: requestId ?? latest.requestId,
        success,
        ...(enabled !== undefined ? { state: { mouseEnabled: enabled, mouseGeneration: 1 } } : {}),
        ...(!success ? { error: 'unavailable' } : {}),
      } })
    },
  }
}

describe('preference window query diagnostics', () => {
  it('cancels the actual Tauri close default so hiding never requests window destruction', async () => {
    const h = mountPreferences()
    try {
      await flush()
      await h.close()
      await flush()
      assert.equal(h.destroyRequests(), 0)
      assert.deepEqual(h.diagnostics, [])
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('reports current failures and stays silent for success, superseded queries and close', async () => {
    const h = mountPreferences()
    try {
      await flush()
      assert.deepEqual(h.diagnostics, [])
      h.queryWindowState(async () => {
        throw new Error('window query permission denied')
      })
      h.current.value = 4
      await flush()
      assert.deepEqual(h.diagnostics, [
        { level: 'warn', operation: 'preference.visibility_query' },
        { level: 'warn', operation: 'preference.minimized_query' },
      ])

      let rejectPending!: (reason: Error) => void
      const pending = new Promise<boolean>((_, reject) => {
        rejectPending = reject
      })
      h.queryWindowState(() => pending)
      h.current.value = 3
      await flush()
      h.queryWindowState()
      h.current.value = 2
      await flush()
      rejectPending(new Error('superseded query failed'))
      await flush()
      assert.equal(h.diagnostics.length, 2)

      h.queryWindowState(async () => {
        throw new Error('closing query failed')
      })
      h.close()
      await flush()
      assert.equal(h.diagnostics.length, 2)
    } finally {
      h.app.unmount()
      await flush()
    }
  })
})

describe('preference scroll lifetime', () => {
  it('starts each tab at the top and restores its own position across navigation and hide/show', async () => {
    const h = mountPreferences()
    try {
      await flush()
      for (let tab = 0; tab < 8; tab++) {
        h.current.value = tab
        await flush()
        assert.equal(h.scrollContainer().scrollTop, 0)
        h.scrollContainer().scrollTop = (tab + 1) * 100
      }
      h.hide()
      for (let tab = 0; tab < 8; tab++) {
        h.current.value = tab
        await flush()
        assert.equal(h.scrollContainer().scrollTop, (tab + 1) * 100)
      }
      // Returning to the top must replace the previously saved nonzero position.
      h.scrollContainer().scrollTop = 0
      h.current.value = 0
      await flush()
      h.current.value = 7
      await flush()
      assert.equal(h.scrollContainer().scrollTop, 0)
    } finally {
      h.app.unmount()
      await flush()
    }
    const restarted = mountPreferences()
    try {
      await flush()
      for (let tab = 0; tab < 8; tab++) {
        restarted.current.value = tab
        await flush()
        assert.equal(restarted.scrollContainer().scrollTop, 0)
      }
    } finally {
      restarted.app.unmount()
      await flush()
    }
  })

  it('restores a tab when its scroll container is recreated after the skin library closes', async () => {
    const h = mountPreferences()
    try {
      h.current.value = 1
      await flush()
      const original = h.scrollContainer()
      original.scrollTop = 420
      h.innerView.value = 'skin-library'
      await flush()
      h.innerView.value = undefined
      await flush()
      assert.notEqual(h.scrollContainer(), original)
      assert.equal(h.scrollContainer().scrollTop, 420)
      h.current.value = 2
      await flush()
      assert.equal(h.scrollContainer().scrollTop, 0)
      h.current.value = 1
      await flush()
      assert.equal(h.scrollContainer().scrollTop, 420)
    } finally {
      h.app.unmount()
      await flush()
    }
  })
})

describe('preference shortcut lifetime', () => {
  it('suppresses both cycle commands during recording and resumes each after release', async () => {
    const h = mountPreferences()
    try {
      await flush()
      const finish = h.beginRecording()
      h.fire('Control+KeyK')
      h.fire('Control+KeyL')
      assert.equal(h.emitted.filter(value => value.event === PRESET_EDIT_REQUEST).length, 0)
      finish()
      h.fire('Control+KeyK', 'Released')
      h.fire('Control+KeyL', 'Released')
      h.current.value = 1
      await flush()
      h.fire('Control+KeyK')
      h.fire('Control+KeyL')
      assert.deepEqual(h.emitted.filter(value => value.event === PRESET_EDIT_REQUEST).map(value => value.payload), [
        { cycle: 'cameraZoomPercent' },
        { cycle: 'sceneRotationOffsetDegrees' },
      ])
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('restores all saved shortcuts on the initial Presets tab and keeps their actions active while hidden', async () => {
    const h = mountPreferences()
    try {
      await flush()
      assert.equal(h.current.value, 0)
      assert.equal(h.active.size, 12)
      h.respondMouse(true, true)
      h.catStore.window.hideOnHoverDelay = 321
      const initialAlwaysOnTop = h.catStore.window.alwaysOnTop
      h.hide()
      h.fire('Control+KeyA')
      h.fire('Control+KeyB')
      h.fire('Control+KeyC')
      h.fire('Control+KeyD')
      h.fire('Control+KeyE')
      h.fire('Control+KeyF')
      h.fire('Control+KeyG')
      h.fire('Control+KeyH')
      h.fire('Control+KeyI')
      h.fire('Control+KeyJ')
      h.fire('Control+KeyK')
      h.fire('Control+KeyL')
      await flush()
      assert.ok(h.emitted.some(value => value.event === PRESET_EDIT_REQUEST && (value.payload as { visible?: boolean }).visible === false))
      assert.ok(h.emitted.some(value => value.event === PRESET_EDIT_REQUEST && (value.payload as { mirror?: boolean }).mirror === true))
      assert.ok(h.emitted.some(value => value.event === PRESET_EDIT_REQUEST && (value.payload as { cycle?: string }).cycle === 'cameraZoomPercent'))
      assert.ok(h.emitted.some(value => value.event === PRESET_EDIT_REQUEST && (value.payload as { cycle?: string }).cycle === 'sceneRotationOffsetDegrees'))
      assert.equal(h.toggledPreference(), 1)
      assert.equal(h.catStore.window.passThrough, true)
      assert.equal(h.catStore.window.alwaysOnTop, !initialAlwaysOnTop)
      assert.equal(h.generalStore.broadcast.enabled, true)
      assert.ok(h.emitted.some(value => value.event === PRESET_EDIT_REQUEST && (value.payload as { showDisplayArea?: boolean }).showDisplayArea === true))
      assert.equal(h.catStore.window.keepInScreen, false)
      assert.equal(h.catStore.window.hideOnHover, true)
      assert.equal(h.catStore.window.hideOnHoverDelay, 321)
      assert.equal(h.mouseRequests().at(-1)?.enabled, false)
      h.respondMouse(true, false)
      assert.equal(h.catStore.activePet3dPreset.mouseEnabled, false)
      assert.equal(h.presetEdits(), 1)
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('keeps bindings across tab and skin-library navigation and observes a whole-program shortcut reset', async () => {
    const h = mountPreferences()
    try {
      h.current.value = 5
      await flush()
      assert.equal(h.active.size, 12)
      h.current.value = 1
      await flush()
      assert.equal(h.active.size, 12)
      h.innerView.value = 'skin-library'
      await flush()
      assert.equal(h.active.size, 12)
      h.shortcutStore.reset()
      await flush()
      assert.equal(h.active.size, 0)
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('waits for confirmed mouse readiness, prevents duplicate requests, and does not commit failed changes', async () => {
    const h = mountPreferences()
    try {
      await flush()
      assert.equal(h.mouseRequests().length, 1)
      h.fire('Control+KeyH')
      await flush()
      assert.equal(h.mouseRequests().length, 1)
      h.respondMouse(true, true)
      h.fire('Control+KeyH')
      h.fire('Control+KeyH')
      await flush()
      assert.equal(h.mouseRequests().length, 2)
      assert.equal(h.catStore.activePet3dPreset.mouseEnabled, true)
      h.respondMouse(false)
      assert.equal(h.catStore.activePet3dPreset.mouseEnabled, true)
      assert.equal(h.presetEdits(), 0)
      h.fire('Control+KeyH')
      await flush()
      assert.equal(h.mouseRequests().length, 3)
      h.respondMouse(true, false, 'stale-request')
      assert.equal(h.catStore.activePet3dPreset.mouseEnabled, true)
      h.respondMouse(true, false)
      assert.equal(h.catStore.activePet3dPreset.mouseEnabled, false)
      assert.equal(h.presetEdits(), 1)
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('rechecks mouse state after the preference window closes and only toggles after a successful query', async () => {
    const h = mountPreferences()
    try {
      await flush()
      h.respondMouse(true, true)
      h.close()
      h.fire('Control+KeyH')
      h.fire('Control+KeyH')
      await flush()
      assert.equal(h.mouseRequests().length, 2)
      assert.equal(h.mouseRequests().at(-1)?.enabled, undefined)
      h.respondMouse(false)
      await flush()
      assert.equal(h.mouseRequests().length, 2)
      assert.equal(h.catStore.activePet3dPreset.mouseEnabled, true)
      h.fire('Control+KeyH')
      await flush()
      assert.equal(h.mouseRequests().length, 3)
      h.respondMouse(true, true)
      await flush()
      assert.equal(h.mouseRequests().length, 4)
      assert.equal(h.mouseRequests().at(-1)?.enabled, false)
      h.respondMouse(true, false)
      assert.equal(h.catStore.activePet3dPreset.mouseEnabled, false)
      assert.equal(h.presetEdits(), 1)
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  for (const boundary of ['blur', 'hide'] as const) {
    it(`ends shortcut recording on window ${boundary} so the preference shortcut can reopen it`, async () => {
      const h = mountPreferences()
      try {
        await flush()
        h.beginRecording()
        h[boundary]()
        h.fire('Control+KeyB')
        await flush()
        assert.equal(h.toggledPreference(), 1)
      } finally {
        h.app.unmount()
        await flush()
      }
    })
  }

  it('does not cancel recorder input when the root capture listener observes a child blur', async () => {
    const h = mountPreferences()
    try {
      await flush()
      const finish = h.beginRecording()
      h.blurChild()
      h.fire('Control+KeyB')
      await flush()
      assert.equal(h.toggledPreference(), 0)
      finish()
    } finally {
      h.app.unmount()
      await flush()
    }
  })
})

describe('preference theme lifetime', () => {
  it('applies a restored dark appearance to the initial Presets page before General is opened', async () => {
    const h = mountPreferences('dark')
    try {
      await flush()
      assert.equal(h.classes.has('dark'), true)
      assert.equal(h.nativeThemes.at(-1), 'dark')
      assert.equal(h.generalStore.appearance.isDark, true)
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('follows the OS in auto mode across tab changes without leaking listeners and resets the shared theme', async () => {
    const h = mountPreferences('auto')
    try {
      h.current.value = 6
      await flush()
      assert.equal(h.themeListeners.size, 1)
      h.current.value = 0
      await flush()
      h.changeSystemTheme('dark')
      await flush()
      assert.equal(h.classes.has('dark'), true)
      h.current.value = 6
      await flush()
      assert.equal(h.themeListeners.size, 1)
      h.generalStore.appearance.theme = 'light'
      await flush()
      h.changeSystemTheme('dark')
      await flush()
      assert.equal(h.classes.has('dark'), false)
      h.current.value = 7
      await flush()
      h.generalStore.reset()
      await flush()
      assert.equal(h.nativeThemes.at(-1), null)
      assert.equal(h.classes.has('dark'), true)
    } finally {
      h.app.unmount()
      await flush()
    }
    assert.equal(h.themeListeners.size, 0)
  })
})
