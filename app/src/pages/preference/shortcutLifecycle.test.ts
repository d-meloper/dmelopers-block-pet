/* eslint-disable test/no-import-node-test */
import type { Event } from '@tauri-apps/api/event'
import type { TrayIconOptions } from '@tauri-apps/api/tray'

import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { Window } from '@tauri-apps/api/window'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import * as performanceConfig from '@/config/performance'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { isMouseSettingResponse } from '@/features/input/types'
import { createAntialiasSettingOwner } from '@/features/performance/antialiasSetting'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'
import { createPreferenceUpdates } from '@/features/updates/preferenceUpdates'
import { useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'
import { useShortcutStore } from '@/stores/shortcut'
import { createLatestAsyncTaskQueue } from '@/utils/latestAsyncTask'
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

// Windows branch of tauri 2.11.1 src/window/scripts/drag.js, with upstream license.
const TAURI_WINDOWS_DRAG_SCRIPT = [
  '// Copyright 2019-2024 Tauri Programme within The Commons Conservancy',
  '// SPDX-License-Identifier: Apache-2.0',
  '// SPDX-License-Identifier: MIT',
  '',
  ';(function () {',
  '  const TAURI_DRAG_REGION_ATTR = \'data-tauri-drag-region\'',
  '  const CLICKABLE_TAGS = new Set([',
  '    \'A\',',
  '    \'BUTTON\',',
  '    \'INPUT\',',
  '    \'SELECT\',',
  '    \'TEXTAREA\',',
  '    \'LABEL\',',
  '    \'SUMMARY\'',
  '  ])',
  '  const INTERACTIVE_ROLES = new Set([',
  '    \'button\',',
  '    \'link\',',
  '    \'menuitem\',',
  '    \'tab\',',
  '    \'checkbox\',',
  '    \'radio\',',
  '    \'switch\',',
  '    \'option\'',
  '  ])',
  '',
  '  function isClickableElement(el) {',
  '    return (',
  '      CLICKABLE_TAGS.has(el.tagName)',
  '      || (el.hasAttribute(\'contenteditable\')',
  '        && el.getAttribute(\'contenteditable\') !== \'false\')',
  '      || (el.hasAttribute(\'tabindex\') && el.getAttribute(\'tabindex\') !== \'-1\')',
  '      || INTERACTIVE_ROLES.has(el.getAttribute(\'role\'))',
  '    )',
  '  }',
  '',
  '  // Walk the composed path from target upward.',
  '  //',
  '  // Supported values for data-tauri-drag-region:',
  '  //   (bare / no value / "true") -> self: only direct clicks on this element trigger drag',
  '  //   "deep"                   -> deep: clicks anywhere in the subtree trigger drag',
  '  //   "false"                  -> disabled: drag is blocked here (and for ancestors)',
  '  //',
  '  // Clickable elements (buttons, links, etc.) normally block dragging,',
  '  // but if they themselves carry data-tauri-drag-region they act as drag regions.',
  '  function isDragRegion(composedPath) {',
  '    for (const el of composedPath) {',
  '      if (!(el instanceof HTMLElement)) continue',
  '',
  '      const attr = el.getAttribute(TAURI_DRAG_REGION_ATTR)',
  '',
  '      // clickable without explicit drag region → blocks drag',
  '      if (isClickableElement(el) && attr === null) return false',
  '      // no attr → keep walking up',
  '      if (attr === null) continue',
  '      // explicitly disabled',
  '      if (attr === \'false\') return false',
  '      // subtree drag — any descendant triggers',
  '      if (attr === \'deep\') return true',
  '      // bare or "true" attr — only direct clicks on this element',
  '      if (attr === \'\' || attr === \'true\') return el === composedPath[0]',
  '    }',
  '',
  '    return false',
  '  }',
  '',
  '  document.addEventListener(\'mousedown\', (e) => {',
  '    if (',
  '      // was left mouse button',
  '      e.button === 0',
  '      // and was normal click to drag or double click to maximize',
  '      && (e.detail === 1 || e.detail === 2)',
  '      // and is drag region',
  '      && isDragRegion(e.composedPath())',
  '    ) {',
  '      // prevents text cursor',
  '      e.preventDefault()',
  '',
  '      // fix #2549: double click on drag region edge causes content to maximize without window sizing change',
  '      // https://github.com/tauri-apps/tauri/issues/2549#issuecomment-1250036908',
  '      e.stopImmediatePropagation()',
  '',
  '      // start dragging if the element has a `tauri-drag-region` data attribute and maximize on double-clicking it',
  '      const cmd = e.detail === 2 ? \'internal_toggle_maximize\' : \'start_dragging\'',
  '      window.__TAURI_INTERNALS__.invoke(\'plugin:window|\' + cmd)',
  '    }',
  '  })',
  '',
  '})()',
  '',
].join('\n')

class DragElement {
  constructor(readonly tagName = 'DIV', readonly dragRegion: string | null = null) {}
  getAttribute(name: string) {
    return name === 'data-tauri-drag-region' ? this.dragRegion : null
  }

  hasAttribute(name: string) {
    return this.getAttribute(name) !== null
  }
}

async function flush() {
  for (let index = 0; index < 60; index++) await Vue.nextTick()
}

function mountPreferences(theme: 'auto' | 'light' | 'dark' = 'light', delayedAntialiasSubscription = false, existingTray = false) {
  setActivePinia(createPinia())
  const blockStore = useBlockStore()
  const shortcutStore = useShortcutStore()
  const generalStore = useGeneralStore()
  generalStore.appearance.theme = theme
  generalStore.appearance.isDark = theme === 'dark'
  shortcutStore.$patch({
    visibleBlock: 'Control+KeyA',
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
  let trayAction: TrayIconOptions['action']
  let trayExists = existingTray
  const nativeTray = { setVisible: async () => {}, setMenu: async () => {} }
  let preferenceUpdates: ReturnType<typeof createPreferenceUpdates>
  let preferenceShows = 0
  const current = Vue.ref(0)
  const innerView = Vue.ref<string>()
  const presetBusy = Vue.ref(false)
  const emitted: Array<{ label: string, event: string, payload: unknown }> = []
  let visible = true
  let queryWindowState: (() => Promise<boolean>) | undefined
  const diagnostics: Array<{ level: string, operation: string }> = []
  const warnings: string[] = []
  let skinLibraryOpens = 0
  const dragCommands: string[] = []
  const nativeMouseListeners: Array<(event: MouseEvent) => void> = []
  const capturedMouseListeners: Array<(event: MouseEvent) => void> = []
  const errors: string[] = []
  const performanceCalls = { start: 0, stop: 0, reset: 0 }
  let toggledPreference = 0
  let systemTheme: 'light' | 'dark' = 'light'
  let closeRequested: ((event: Event<unknown>) => Promise<void>) | undefined
  let destroyRequests = 0
  const themeListeners = new Set<(event: { payload: 'light' | 'dark' }) => void>()
  const nativeThemes: Array<'light' | 'dark' | null> = []
  const nativeCaptionColors: boolean[] = []
  let nativeThemeRequest: () => Promise<void> = async () => {}
  const classes = new Set<string>()
  const testWindow = {}
  const domListeners = new Map<string, Array<(event?: { target: object }) => void>>()
  const document = {
    addEventListener: (name: string, handler: (event: MouseEvent) => void) => {
      if (name === 'mousedown') nativeMouseListeners.push(handler)
    },
    hidden: false,
    documentElement: { classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
    } },
  }
  const wrapper = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('div', slots.default?.()) })
  const blank = Vue.defineComponent({ render: () => null })
  const blockPage = Vue.defineComponent({
    emits: ['openSkinLibrary'],
    setup: (_, { emit }) => () => Vue.h('button', {
      'data-open-library': true,
      'onClick': () => emit('openSkinLibrary'),
    }),
  })
  // About has a section plus two modal roots, so it cannot inherit listeners.
  const aboutPage = Vue.defineComponent({ render: () => [Vue.h('section'), Vue.h('dialog')] })
  // Retained Windows dispatch path from the Cargo.lock Tauri dependency.
  runInNewContext(TAURI_WINDOWS_DRAG_SCRIPT, {
    document,
    HTMLElement: DragElement,
    window: { __TAURI_INTERNALS__: { invoke: async (command: string) => {
      dragCommands.push(command)
    } } },
  })
  const page = (name: string) => Vue.defineComponent({
    inheritAttrs: false,
    setup: (_, { attrs }) => () => Vue.h('section', { ...attrs, 'data-preference-page': name }),
  })
  const scenePage = page('scene')
  const environmentPage = page('environment')
  const nativeListeners = new Map<string, (event: { payload: unknown }) => void>()
  const selectionListeners = new Set<() => void>()
  const nativeEdits = Vue.ref(0)
  let automaticAntialiasReply = true
  let finishAntialiasSubscription: (() => void) | undefined
  let presetEdits = 0
  const eventApi = {
    emitTo: async (label: string, event: string, payload: unknown) => {
      emitted.push({ label, event, payload })
      if (automaticAntialiasReply && event === performanceConfig.ANTIALIAS_SETTING_REQUEST) {
        const request = payload as performanceConfig.AntialiasSettingRequest
        nativeListeners.get(performanceConfig.ANTIALIAS_SETTING_RESPONSE)?.({ payload: { ...request, actual: request.requested, success: true } })
      }
    },
    listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
      if (delayedAntialiasSubscription && event === performanceConfig.ANTIALIAS_SETTING_RESPONSE) {
        await new Promise<void>((resolve) => {
          finishAntialiasSubscription = resolve
        })
      }
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
    new Function('require', 'module', 'exports', 'window', 'document', 'HTMLElement', transformed)(
      (id: string) => id === 'vue' && mountedHooks ? Vue : resolve(id),
      module,
      module.exports,
      testWindow,
      document,
      DragElement,
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
    if (id === '@tauri-apps/api/app') return { getVersion: async () => '1.0.0' }
    if (id === '@tauri-apps/api/core') {
      return { invoke: async (command: string, args: { dark: boolean }) => {
        assert.equal(command, 'plugin:custom-window|set_preference_caption_color')
        nativeCaptionColors.push(args.dark)
      } }
    }
    if (id === '@tauri-apps/api/path') return { resolveResource: async (path: string) => path }
    if (id === '@tauri-apps/api/tray') {
      return { TrayIcon: {
        getById: async () => trayExists ? nativeTray : null,
        removeById: async () => {
          trayExists = false
          trayAction = undefined
        },
        new: async (options: TrayIconOptions) => {
          assert.equal(trayExists, false)
          trayExists = true
          trayAction = options.action
          return nativeTray
        },
      } }
    }
    if (id === './useAppMenu') return { useAppMenu: () => ({ getAppMenu: async () => ({ close: async () => {} }) }) }
    if (id === '@/utils/latestAsyncTask') return { createLatestAsyncTaskQueue }
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
          await nativeThemeRequest()
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
      return { useEventListener: (target: unknown, events: string | string[], handler: (event?: { target: object }) => void, options?: { capture?: boolean }) => {
        for (const event of typeof events === 'string' ? [events] : events) {
          if (target === document && event === 'mousedown' && options?.capture) {
            capturedMouseListeners.push(handler as (event: MouseEvent) => void)
          }
          const handlers = domListeners.get(event) ?? []
          handlers.push(handler)
          domListeners.set(event, handlers)
        }
      } }
    }
    if (id === 'ant-design-vue') return { ConfigProvider: wrapper, Flex: wrapper, Modal: page('broadcast-prompt'), Select: wrapper, SelectOption: wrapper, message: { error: (text: string) => errors.push(text) } }
    if (id === '@/stores/block') return { useBlockStore: () => blockStore }
    if (id === '@/stores/shortcut.ts' || id === '@/stores/shortcut') return { useShortcutStore: () => shortcutStore }
    if (id === '@/stores/general') return { useGeneralStore: () => generalStore }
    if (id === '@/stores/performance') {
      return { usePerformanceStore: () => ({
        start: async () => {
          performanceCalls.start++
        },
        stop: async () => {
          performanceCalls.stop++
        },
        reset: async () => {
          performanceCalls.reset++
        },
      }) }
    }
    if (id === '@/composables/useKeyPress') return keyPressModule
    if (id === '@/composables/usePreferenceUpdates') {
      // Keep the live controller's complete reactive API without native update I/O.
      const unexpectedUpdate = async () => assert.fail('Shortcut lifecycle tests must not invoke native updates.')
      return { providePreferenceUpdates: () => preferenceUpdates = createPreferenceUpdates({
        channel: async () => 'development',
        checkApp: unexpectedUpdate,
        install: unexpectedUpdate,
        cancel: unexpectedUpdate,
        hiddenUntil: () => generalStore.app.updateReminderHiddenUntil,
        hideUntil: (deadline) => {
          generalStore.app.updateReminderHiddenUntil = deadline
        },
        report: (_operation, error) => {
          throw error
        },
      }) }
    }
    if (id === '@/features/stateSafety/bridge' || id === '@/features/stateSafety') return dataBridge
    if (id === '@/composables/usePreferenceTheme') {
      return load(readFileSync(new URL('../../composables/usePreferenceTheme.ts', import.meta.url), 'utf8'), true)
    }
    if (id === '@/composables/useTray') return load(readFileSync(new URL('../../composables/useTray.ts', import.meta.url), 'utf8'), true)
    if (id === '@/composables/useThemeVars') return { useThemeVars: () => ({ generateColorVars: () => {} }) }
    if (id === '@/composables/useBroadcast') return { BROADCAST_CONTROLLER: Symbol('broadcast'), useBroadcast: () => ({}) }
    if (id === '@/composables/usePresetManager') {
      return { usePresetManager: () => ({
        ready: Vue.ref(true),
        busy: presetBusy,
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
      return { showWindow: async () => {
        preferenceShows++
      }, toggleWindowVisible: async (label: string) => {
        assert.equal(label, WINDOW_LABEL.PREFERENCE)
        toggledPreference++
      } }
    }
    if (id === '@/constants') return { LISTEN_KEY, WINDOW_LABEL, APP_DISPLAY_NAME: 'Test Pet' }
    if (id === '@/constants/branding') return { APP_DISPLAY_NAME: 'Test Pet' }
    if (id === '@/config/performance') return performanceConfig
    if (id === '@/composables/useTauriListen') {
      return load(readFileSync(new URL('../../composables/useTauriListen.ts', import.meta.url), 'utf8'), true)
    }
    if (id === '@/composables/useAntialiasSetting') {
      return load(readFileSync(new URL('../../composables/useAntialiasSetting.ts', import.meta.url), 'utf8'), true)
    }
    if (id === '@/features/performance/antialiasSetting') return { createAntialiasSettingOwner }
    if (id === '@/composables/usePetRuntimeRecovery') return { usePetRuntimeRecovery: () => {} }
    if (id === '@/config/theme') return {}
    if (id === '@/locales/antd') return { getAntdLocale: () => ({}) }
    if (id === '@/utils/viewportInteraction') return { captureViewportPointer: () => {} }
    if (id === '@/features/input/types') return { isMouseSettingResponse }
    if (id === '@/features/presets/editIntent') {
      return {
        onPresetSelectionChange: (handler: () => void) => {
          selectionListeners.add(handler)
          return () => selectionListeners.delete(handler)
        },
        confirmPresetUserEdit: () => {},
      }
    }
    if (id === '@/features/presets/operations') {
      return {
        presetOperationInProgress: Vue.ref(false),
        presetResetInProgress: Vue.ref(false),
        beginPresetNativeEdit: () => {
          nativeEdits.value++
          let released = false
          return () => {
            if (released) return
            released = true
            nativeEdits.value--
          }
        },
      }
    }
    if (id === '@/features/presets/types') return { PRESET_EDIT_REQUEST }
    if (id === '@/features/scene/types') return {}
    if (id === './navigation') {
      return { usePreferenceNavigation: () => ({ current, innerView, closeInnerView: () => {}, openSkinLibrary: () => {
        skinLibraryOpens++
      } }) }
    }
    if (id === './performanceLifecycle') return { shouldMonitorPreferencePerformance: () => false }
    if (id === './components/shortcut/index.vue') return { default: shortcutComponent }
    if (id === './components/block/index.vue') return { default: blockPage }
    if (id === './components/about/index.vue') return { default: aboutPage }
    if (id === './components/general/index.vue') return { default: Vue.defineComponent({ render: () => Vue.h(themeComponent) }) }
    if (id === './components/scene/index.vue') return { default: scenePage }
    if (id === './components/environment/index.vue') return { default: environmentPage }
    if (id === './components/UpdateReminder.vue') return { default: page('update-reminder') }
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
    insert: (node, parent, anchor) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const position = anchor ? parent.children.indexOf(anchor) : parent.children.length
      parent.children.splice(position, 0, node)
    },
    remove: (node) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = null
    },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  })
  const app = renderer.createApp(preferenceComponent)
  app.config.warnHandler = warning => warnings.push(warning)
  app.config.globalProperties.$t = (key: string) => key
  const root = element()
  app.mount(root)
  const flatten = (node: TestElement): TestElement[] => [node, ...node.children.flatMap(flatten)]
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
    warnings,
    skinLibraryOpens: () => skinLibraryOpens,
    dragClick: (detail: number, target: DragElement, ancestors: DragElement[] = [], button = 0) => {
      let stopped = false
      let prevented = false
      const event = {
        detail,
        button,
        target,
        composedPath: () => [target, ...ancestors],
        preventDefault: () => {
          prevented = true
        },
        stopPropagation: () => {
          stopped = true
        },
        stopImmediatePropagation: () => {
          stopped = true
        },
      } as unknown as MouseEvent
      capturedMouseListeners.forEach(handler => handler(event))
      if (!stopped) nativeMouseListeners.forEach(handler => handler(event))
      return { prevented, commands: dragCommands.splice(0) }
    },
    updates: () => preferenceUpdates,
    preferenceShows: () => preferenceShows,
    clickTray: () => trayAction?.({
      type: 'Click',
      id: 'DMELOPERS_BLOCK_PET_TRAY',
      button: 'Left',
      buttonState: 'Up',
      position: new PhysicalPosition(0, 0),
      rect: { position: new PhysicalPosition(0, 0), size: new PhysicalSize(16, 16) },
    }),
    diagnostics,
    errors,
    performanceCalls,
    nativeEdits,
    invalidatePresetSelection: () => selectionListeners.forEach(handler => handler()),
    emitNative: (event: string, payload: unknown) => nativeListeners.get(event)?.({ payload }),
    hasNativeListener: (event: string) => nativeListeners.has(event),
    finishAntialiasSubscription: () => finishAntialiasSubscription?.(),
    holdAntialiasReplies: () => {
      automaticAntialiasReply = false
    },
    antialiasRequests: () => emitted.filter(message => message.event === performanceConfig.ANTIALIAS_SETTING_REQUEST)
      .map(message => message.payload as performanceConfig.AntialiasSettingRequest),
    queryWindowState: (query?: () => Promise<boolean>) => {
      queryWindowState = query
    },
    active,
    current,
    innerView,
    presetBusy,
    nodes: () => flatten(root),
    scrollContainer,
    shortcutStore,
    blockStore,
    emitted,
    generalStore,
    classes,
    nativeThemes,
    nativeCaptionColors,
    holdNextTheme: () => {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      nativeThemeRequest = () => {
        nativeThemeRequest = async () => {}
        return held
      }
      return release
    },
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

describe('preference tab identities', () => {
  it('places Objects below Screen with separate input owners while retaining tab identities and scroll', async () => {
    const h = mountPreferences()
    try {
      await flush()
      const tabs = () => h.nodes().filter(node => node.props.role === 'tab')
      const tabNames = ['block', 'scene', 'environment', 'presets', 'performance', 'general', 'shortcut', 'about']
      tabs().forEach((tab, index) => {
        const label = `pages.preference.${tabNames[index]}.title`
        assert.equal(tab.props['aria-label'], label)
        assert.equal(tab.props.title, label)
      })
      const selectedIds: number[] = []
      for (const tab of tabs()) {
        ;(tab.props.onClick as () => void)()
        await flush()
        selectedIds.push(h.current.value)
        assert.equal(tab.props['aria-selected'], true)
        assert.equal(tabs().filter(node => node.props['aria-selected']).length, 1)
      }
      assert.deepEqual(selectedIds, [1, 2, 3, 0, 4, 6, 5, 7])
      h.current.value = 2
      await flush()
      const content = h.nodes().find(node => node.props['data-preference-page'] === 'scene')!
      assert.equal(typeof content.props.requestViewportMode, 'function')
      assert.equal(content.props.requestMouseEnabled, undefined)
      assert.equal(content.props.refreshMouseSetting, undefined)
      h.current.value = 3
      await flush()
      const objects = h.nodes().find(node => node.props['data-preference-page'] === 'environment')!
      assert.equal(typeof objects.props.requestMouseEnabled, 'function')
      assert.equal(typeof objects.props.refreshMouseSetting, 'function')
      assert.equal(objects.props.requestViewportMode, undefined)
      assert.equal(tabs().length, 8)
      h.current.value = 2
      await flush()
      h.scrollContainer().scrollTop = 240
      ;(tabs()[0].props.onClick as () => void)()
      await flush()
      h.scrollContainer().scrollTop = 360
      ;(tabs()[1].props.onClick as () => void)()
      await flush()
      assert.equal(h.current.value, 2)
      assert.equal(h.scrollContainer().scrollTop, 240)
      ;(tabs()[0].props.onClick as () => void)()
      await flush()
      assert.equal(h.current.value, 1)
      assert.equal(h.scrollContainer().scrollTop, 360)
      h.presetBusy.value = true
      await flush()
      for (const id of [1, 2, 3, 4, 6]) {
        h.current.value = id
        await flush()
        const gate = h.nodes().find(node => typeof node.props.onInputCapture === 'function')!
        assert.equal(gate.props.inert, id >= 1 && id <= 3)
      }
    } finally {
      h.app.unmount()
      await flush()
    }
  })
})

describe('preference window query diagnostics', () => {
  it('routes the library event only to Block without fragment listener warnings in About', async () => {
    const h = mountPreferences()
    try {
      h.current.value = 7
      await flush()
      assert.deepEqual(h.warnings, [])
      h.current.value = 1
      await flush()
      const button = h.nodes().find(node => node.props['data-open-library'])!
      ;(button.props.onClick as () => void)()
      assert.equal(h.skinLibraryOpens(), 1)
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('keeps native dragging but never sends denied maximization from preference drag regions', async () => {
    const h = mountPreferences()
    try {
      await flush()
      for (const value of ['', 'true']) {
        const region = new DragElement('DIV', value)
        assert.deepEqual(h.dragClick(1, region), { prevented: true, commands: ['plugin:window|start_dragging'] })
        assert.deepEqual(h.dragClick(2, region), { prevented: true, commands: [] })
        assert.deepEqual(h.dragClick(2, new DragElement('BUTTON'), [region]), { prevented: false, commands: [] })
        assert.deepEqual(h.dragClick(2, new DragElement(), [region]), { prevented: false, commands: [] })
        assert.deepEqual(h.dragClick(2, region, [], 2), { prevented: false, commands: [] })
      }
      assert.deepEqual(h.dragClick(2, new DragElement('DIV', 'false')), { prevented: false, commands: [] })
    } finally {
      h.app.unmount()
      await flush()
    }
  })

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
      h.current.value = 1
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
      h.blockStore.window.hideOnHoverDelay = 321
      const initialAlwaysOnTop = h.blockStore.window.alwaysOnTop
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
      assert.equal(h.blockStore.window.passThrough, true)
      assert.equal(h.blockStore.window.alwaysOnTop, !initialAlwaysOnTop)
      assert.equal(h.generalStore.broadcast.enabled, true)
      assert.ok(h.emitted.some(value => value.event === PRESET_EDIT_REQUEST && (value.payload as { showDisplayArea?: boolean }).showDisplayArea === true))
      assert.equal(h.blockStore.window.keepInScreen, false)
      assert.equal(h.blockStore.window.hideOnHover, true)
      assert.equal(h.blockStore.window.hideOnHoverDelay, 321)
      assert.equal(h.mouseRequests().at(-1)?.enabled, false)
      h.respondMouse(true, false)
      assert.equal(h.blockStore.activePet3dPreset.mouseEnabled, false)
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
      assert.equal(h.blockStore.activePet3dPreset.mouseEnabled, true)
      h.respondMouse(false)
      assert.equal(h.blockStore.activePet3dPreset.mouseEnabled, true)
      assert.equal(h.presetEdits(), 0)
      h.fire('Control+KeyH')
      await flush()
      assert.equal(h.mouseRequests().length, 3)
      h.respondMouse(true, false, 'stale-request')
      assert.equal(h.blockStore.activePet3dPreset.mouseEnabled, true)
      h.respondMouse(true, false)
      assert.equal(h.blockStore.activePet3dPreset.mouseEnabled, false)
      assert.equal(h.presetEdits(), 1)
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  for (const closingBeforeDelivery of [true, false]) {
    it(`retains an accepted mouse setting and its save lease when closing ${closingBeforeDelivery ? 'before' : 'after'} delivery`, async () => {
      const h = mountPreferences()
      try {
        await flush()
        h.respondMouse(true, true)
        h.current.value = 3
        await flush()
        const page = h.nodes().find(node => node.props['data-preference-page'] === 'environment')!
        const requestMouse = page.props.requestMouseEnabled as (enabled: boolean) => Promise<boolean>
        const request = requestMouse(false)
        assert.equal(h.nativeEdits.value, 1)
        if (!closingBeforeDelivery) await flush()
        await h.close()
        h.hide()
        await flush()
        assert.equal(h.mouseRequests().at(-1)?.enabled, false)
        assert.equal(h.nativeEdits.value, 1)
        assert.equal(h.blockStore.activePet3dPreset.mouseEnabled, true)
        assert.equal(await requestMouse(true), false, 'a new ordinary request stays blocked while closing')
        assert.equal(h.mouseRequests().length, 2)
        h.respondMouse(true, false)
        assert.equal(await request, true)
        assert.equal(h.blockStore.activePet3dPreset.mouseEnabled, false)
        assert.equal(h.nativeEdits.value, 0)
        assert.equal(h.presetEdits(), 1)
        h.respondMouse(true, false)
        assert.equal(h.nativeEdits.value, 0)
        assert.equal(h.presetEdits(), 1)
      } finally {
        h.app.unmount()
        await flush()
      }
    })
  }

  for (const boundary of ['selection', 'unmount'] as const) {
    it(`still cancels a pending mouse request on ${boundary} and ignores its late reply`, async () => {
      const h = mountPreferences()
      try {
        await flush()
        h.respondMouse(true, true)
        h.current.value = 3
        await flush()
        const page = h.nodes().find(node => node.props['data-preference-page'] === 'environment')!
        const request = (page.props.requestMouseEnabled as (enabled: boolean) => Promise<boolean>)(false)
        await flush()
        assert.equal(h.nativeEdits.value, 1)
        if (boundary === 'selection') h.invalidatePresetSelection()
        else h.app.unmount()
        assert.equal(await request, false)
        assert.equal(h.nativeEdits.value, 0)
        h.respondMouse(true, false)
        assert.equal(h.blockStore.activePet3dPreset.mouseEnabled, true)
        assert.equal(h.presetEdits(), 0)
      } finally {
        if (boundary !== 'unmount') h.app.unmount()
        await flush()
      }
    })
  }

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
      assert.equal(h.blockStore.activePet3dPreset.mouseEnabled, true)
      h.fire('Control+KeyH')
      await flush()
      assert.equal(h.mouseRequests().length, 3)
      h.respondMouse(true, true)
      await flush()
      assert.equal(h.mouseRequests().length, 4)
      assert.equal(h.mouseRequests().at(-1)?.enabled, false)
      h.respondMouse(true, false)
      assert.equal(h.blockStore.activePet3dPreset.mouseEnabled, false)
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

describe('antialias failure ownership', () => {
  it('rolls back the latest failed request once across tabs and hidden preferences', async () => {
    const h = mountPreferences()
    try {
      await flush()
      h.holdAntialiasReplies()
      h.current.value = 6
      h.blockStore.model.antialiasEnabled = false
      h.hide()
      await flush()
      const starts = h.performanceCalls.start
      const failure = { ...h.antialiasRequests().at(-1)!, actual: true, success: false }
      h.emitNative(performanceConfig.ANTIALIAS_SETTING_RESPONSE, failure)
      assert.equal(h.blockStore.model.antialiasEnabled, true)
      assert.equal(h.performanceCalls.reset, 1)
      assert.equal(h.performanceCalls.start, starts)
      assert.deepEqual(h.errors, ['pages.preference.performance.errors.antialiasFailed'])
      h.emitNative(performanceConfig.ANTIALIAS_SETTING_RESPONSE, failure)
      assert.equal(h.performanceCalls.reset, 1)
      assert.equal(h.errors.length, 1)
    } finally {
      h.app.unmount()
      await flush()
    }
  })

  it('ignores stale, invalid and unmounted failure replies without resetting measurements', async () => {
    const h = mountPreferences()
    try {
      await flush()
      h.holdAntialiasReplies()
      h.blockStore.model.antialiasEnabled = false
      await flush()
      const stale = h.antialiasRequests().at(-1)!
      h.blockStore.model.antialiasEnabled = true
      await flush()
      for (const payload of [null, {}, { ...stale, actual: 'true', success: false }, { ...stale, actual: true, success: false }]) {
        h.emitNative(performanceConfig.ANTIALIAS_SETTING_RESPONSE, payload)
      }
      assert.equal(h.blockStore.model.antialiasEnabled, true)
      assert.equal(h.performanceCalls.reset, 0)
      assert.deepEqual(h.errors, [])
    } finally {
      h.app.unmount()
      await flush()
    }
    h.emitNative(performanceConfig.ANTIALIAS_SETTING_RESPONSE, { ...h.antialiasRequests().at(-1)!, actual: false, success: false })
    assert.equal(h.blockStore.model.antialiasEnabled, true)
    assert.equal(h.performanceCalls.reset, 0)
    assert.deepEqual(h.errors, [])
  })

  it('holds the startup lease until response subscription is ready and disposes a late subscription', async () => {
    for (const disposeBeforeReady of [false, true]) {
      const h = mountPreferences('light', true)
      let disposed = false
      try {
        await flush()
        h.respondMouse(true, true)
        assert.equal(h.nativeEdits.value, 1)
        assert.equal(h.antialiasRequests().length, 0)
        if (disposeBeforeReady) {
          h.app.unmount()
          disposed = true
          assert.equal(h.nativeEdits.value, 0)
        }
        h.finishAntialiasSubscription()
        await flush()
        assert.equal(h.antialiasRequests().length, disposeBeforeReady ? 0 : 1)
        assert.equal(h.nativeEdits.value, 0)
        assert.equal(h.hasNativeListener(performanceConfig.ANTIALIAS_SETTING_RESPONSE), !disposeBeforeReady)
      } finally {
        if (!disposed) h.app.unmount()
        await flush()
      }
      assert.equal(h.hasNativeListener(performanceConfig.ANTIALIAS_SETTING_RESPONSE), false)
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
      assert.equal(h.nativeCaptionColors.at(-1), true)
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
      assert.equal(h.nativeCaptionColors.at(-1), true)
      h.current.value = 6
      await flush()
      assert.equal(h.themeListeners.size, 1)
      h.generalStore.appearance.theme = 'light'
      await flush()
      h.changeSystemTheme('dark')
      await flush()
      assert.equal(h.classes.has('dark'), false)
      assert.equal(h.nativeCaptionColors.at(-1), false)
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

  it('retains the queued return to auto mode when an earlier native request emits a late theme event', async () => {
    const h = mountPreferences('light')
    await flush()
    const release = h.holdNextTheme()
    try {
      h.generalStore.appearance.theme = 'dark'
      await flush()
      h.generalStore.appearance.theme = 'auto'
      await flush()
      h.changeSystemTheme('light')
      release()
      await flush()
      assert.equal(h.nativeThemes.at(-1), null)
      assert.equal(h.nativeCaptionColors.at(-1), false)
      assert.equal(h.classes.has('dark'), false)
    } finally {
      release()
      h.app.unmount()
      await flush()
    }
  })

  it('serializes theme changes and skips obsolete or disposed caption continuations', async () => {
    const h = mountPreferences('light')
    await flush()
    let release = h.holdNextTheme()
    try {
      h.generalStore.appearance.theme = 'dark'
      await flush()
      h.generalStore.appearance.theme = 'light'
      await flush()
      assert.equal(h.nativeThemes.at(-1), 'dark', 'the second native theme waits for the first request')
      const colors = h.nativeCaptionColors.length
      release()
      await flush()
      assert.equal(h.nativeThemes.at(-1), 'light')
      assert.deepEqual(h.nativeCaptionColors.slice(colors), [false])
      release = h.holdNextTheme()
      h.generalStore.appearance.theme = 'dark'
      await flush()
      const beforeDispose = h.nativeCaptionColors.length
      h.app.unmount()
      release()
      await flush()
      assert.equal(h.nativeCaptionColors.length, beforeDispose)
    } finally {
      release()
      if (h.themeListeners.size) h.app.unmount()
      await flush()
    }
  })
})

describe('tray broadcast prompt in the mounted preference window', () => {
  it('rebinds a retained tray, retains the tab, blocks restore during preset work, and defers update reminders through modal closure', async () => {
    const h = mountPreferences('light', false, true)
    try {
      await flush()
      h.current.value = 2
      h.hide()
      h.generalStore.broadcast.enabled = true
      h.generalStore.broadcast.showOnDesktop = false
      h.blockStore.window.visible = false
      const before = JSON.stringify(h.blockStore.activePet3dPreset)
      h.clickTray()
      await flush()
      h.updates().reminderVersion.value = '1.0.2'
      await flush()
      const prompt = () => h.nodes().find(node => node.props['data-preference-page'] === 'broadcast-prompt')!
      const reminder = () => h.nodes().find(node => node.props['data-preference-page'] === 'update-reminder')!
      assert.equal(h.preferenceShows(), 1)
      assert.equal(h.current.value, 2)
      assert.equal(prompt().props.open, true)
      assert.equal(prompt().props['ok-text'], 'pages.preference.broadcastRestore.enable')
      assert.equal(prompt().props['cancel-text'], 'pages.preference.broadcastRestore.cancel')
      assert.equal(reminder().props.version, undefined)
      h.presetBusy.value = true
      await flush()
      assert.equal((prompt().props['ok-button-props'] as { disabled: boolean }).disabled, true)
      ;(prompt().props.onOk as () => void)()
      assert.equal(h.blockStore.window.visible, false)
      assert.equal(h.generalStore.broadcast.showOnDesktop, false)
      h.presetBusy.value = false
      await flush()
      ;(prompt().props.onOk as () => void)()
      await flush()
      assert.equal(h.blockStore.window.visible, true)
      assert.equal(h.generalStore.broadcast.showOnDesktop, true)
      assert.equal(h.generalStore.broadcast.enabled, true)
      assert.equal(JSON.stringify(h.blockStore.activePet3dPreset), before)
      assert.equal(prompt().props.open, false)
      assert.equal(reminder().props.version, undefined)
      ;(prompt().props['after-close'] as () => void)()
      await flush()
      assert.equal(reminder().props.version, '1.0.2')
      assert.equal(h.updates().reminderVersion.value, '1.0.2')
      assert.equal(h.current.value, 2)
    } finally {
      h.app.unmount()
      await flush()
    }
  })
})
