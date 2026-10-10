/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import type { DeviceInputState, SemanticInputEvent } from '@/features/input/types'

import * as constants from '@/constants'
import * as inputTypes from '@/features/input/types'
import * as presetEditIntent from '@/features/presets/editIntent'
import * as presetOperations from '@/features/presets/operations'

import type * as DeviceModule from './useDevice'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}
const compiled = ts.transpileModule(readFileSync(new URL('./useDevice.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
function loadDevice(mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
  const exports = {} as typeof DeviceModule
  const defaults: Record<string, unknown> = {
    '../constants': constants,
    '@/features/input/types': inputTypes,
    '@/plugins/window': {},
  }
  runInNewContext(compiled, {
    exports,
    console,
    setTimeout,
    clearTimeout,
    require: (name: string) => mocks[name] ?? defaults[name],
    ...globals,
  })
  return exports
}
function createSession(initial = true) {
  const saves: boolean[] = []
  const calls: string[] = []
  const gates: boolean[] = []
  let native: DeviceInputState = { mouseEnabled: true, mouseGeneration: 0 }
  let configure = async (enabled: boolean) => {
    native = { mouseEnabled: enabled, mouseGeneration: native.mouseGeneration + 1 }
    return native
  }
  let start = async (enabled: boolean) => configure(enabled)
  const session = loadDevice().createDeviceInputSession({
    readSetting: () => initial,
    start: (enabled) => {
      calls.push(`start:${enabled}`)
      return start(enabled)
    },
    configure: (enabled) => {
      calls.push(`set:${enabled}`)
      return configure(enabled)
    },
    stop: async () => {
      calls.push('stop')
    },
    onConfirmed: enabled => void saves.push(enabled),
    onGate: enabled => void gates.push(enabled),
  })
  return {
    session,
    saves,
    calls,
    gates,
    setConfigure: (value: typeof configure) => {
      configure = value
    },
    setStart: (value: typeof start) => {
      start = value
    },
  }
}
const typing: SemanticInputEvent = { kind: 'typing', active: true, intensity: 1 }
const click = (mouseGeneration: number): SemanticInputEvent => ({ kind: 'mouse_primary', active: true, mouseGeneration })
describe('native mouse confirmation and input lifecycle', () => {
  it('queries confirmed state without resetting held mouse input or changing its epoch', async () => {
    const h = createSession()
    await h.session.setActive(true)
    await h.session.start()
    const gateCount = h.gates.length
    const generation = h.session.generation()
    await h.session.request()
    assert.equal(h.gates.length, gateCount)
    assert.equal(h.session.generation(), generation)
    assert.deepEqual(h.calls, ['start:true'])
  })
  it('persists only after native acknowledgement while keyboard holds remain usable', async () => {
    const h = createSession()
    await h.session.setActive(true)
    await h.session.start()
    const ack = deferred<DeviceInputState>()
    h.setConfigure(() => ack.promise)
    const off = h.session.request(false)
    await flush()
    assert.deepEqual(h.saves, [true])
    assert.equal(h.session.accepts(click(1)), false)
    assert.equal(h.session.accepts(typing), true)
    ack.resolve({ mouseEnabled: false, mouseGeneration: 2 })
    await off
    assert.deepEqual(h.saves, [true, false])
    assert.equal(h.session.accepts(typing), true)
    assert.equal(h.session.accepts(click(2)), false)
    assert.equal(h.session.accepts({ kind: 'pointer_activity', x: 0.2, y: 0.4, mouseGeneration: 2 }), true)
    assert.equal(h.session.accepts({ kind: 'pointer_activity', x: 0.2, y: 0.4, mouseGeneration: 1 }), false)
  })

  it('serializes rapid OFF/ON and rejects old epochs after the final acknowledgement', async () => {
    const h = createSession()
    await h.session.setActive(true)
    await h.session.start()
    const offAck = deferred<DeviceInputState>()
    const onAck = deferred<DeviceInputState>()
    h.setConfigure(enabled => enabled ? onAck.promise : offAck.promise)
    const off = h.session.request(false)
    const on = h.session.request(true)
    await flush()
    assert.deepEqual(h.calls, ['start:true', 'set:false'])
    offAck.resolve({ mouseEnabled: false, mouseGeneration: 2 })
    await off
    assert.equal(h.session.accepts(click(1)), false)
    onAck.resolve({ mouseEnabled: true, mouseGeneration: 3 })
    await on
    assert.deepEqual(h.saves, [true, false, true])
    assert.equal(h.session.accepts(click(1)), false)
    assert.equal(h.session.accepts(click(3)), true)
  })

  it('retains the confirmed value when the native OFF request fails', async () => {
    const h = createSession()
    await h.session.setActive(true)
    await h.session.start()
    for (const message of ['hook failed', 'mouse acknowledgement timed out']) {
      h.setConfigure(async () => {
        throw new Error(message)
      })
      await assert.rejects(h.session.request(false), { message })
      assert.deepEqual(h.saves, [true])
      assert.equal(h.session.status().mouseEnabled, true)
      assert.equal(h.session.accepts(click(1)), true)
    }
  })

  it('keeps a saved OFF after startup failure and retries OFF without enabling collection', async () => {
    const h = createSession(false)
    h.setStart(async () => {
      throw new Error('hook failed')
    })
    await h.session.setActive(true)
    await assert.rejects(h.session.start(), /hook failed/)
    assert.deepEqual(h.calls, ['start:false'])
    assert.deepEqual(h.saves, [])
    assert.equal(h.session.accepts(typing), false)
    h.setStart(async enabled => ({ mouseEnabled: enabled, mouseGeneration: 1 }))
    await h.session.start()
    assert.deepEqual(h.calls, ['start:false', 'start:false'])
    assert.deepEqual(h.saves, [false])
    assert.equal(h.session.status().mouseEnabled, false)
  })

  it('suspends and resumes the hook without writing lifecycle state to settings', async () => {
    const h = createSession()
    await h.session.setActive(true)
    await h.session.start()
    await h.session.setActive(false)
    assert.equal(h.session.accepts(typing), false)
    assert.deepEqual(h.saves, [true])
    assert.equal(h.session.status().mouseEnabled, true)
    await h.session.setActive(true)
    assert.equal(h.session.accepts(click(1)), false)
    assert.equal(h.session.accepts(click(3)), true)
    assert.deepEqual(h.saves, [true])
  })

  it('strictly retries the same active value after a failed native resume', async () => {
    const h = createSession()
    await h.session.setActive(true)
    await h.session.start()
    await h.session.setActive(false)
    h.setConfigure(async () => {
      throw new Error('resume failed')
    })
    await assert.rejects(h.session.setActive(true), /resume failed/)
    assert.equal(h.session.accepts(click(2)), false)
    h.setConfigure(async enabled => ({ mouseEnabled: enabled, mouseGeneration: 3 }))
    await h.session.setActive(true, true)
    assert.equal(h.session.accepts(click(3)), true)
    assert.deepEqual(h.calls, ['start:true', 'set:false', 'set:true', 'set:true'])
    assert.deepEqual(h.saves, [true])
  })

  it('keeps failed suspension gated and reports failure for ordinary and strict requests', async () => {
    const h = createSession()
    await h.session.setActive(true)
    await h.session.start()
    h.setConfigure(async () => {
      throw new Error('suspension failed')
    })
    await assert.rejects(h.session.setActive(false), /suspension failed/)
    assert.equal(h.session.accepts(typing), false)
    await assert.rejects(h.session.setActive(false, true), /suspension failed/)
    assert.deepEqual(h.saves, [true])
  })

  it('reconciles a lifecycle change that arrives during native acknowledgement', async () => {
    const h = createSession(false)
    await h.session.setActive(true)
    await h.session.start()
    const onAck = deferred<DeviceInputState>()
    h.setConfigure(async enabled => enabled ? onAck.promise : { mouseEnabled: false, mouseGeneration: 3 })
    const on = h.session.request(true)
    await flush()
    const hidden = h.session.setActive(false)
    onAck.resolve({ mouseEnabled: true, mouseGeneration: 2 })
    await on
    await hidden
    assert.equal(h.session.status().mouseEnabled, true)
    assert.equal(h.session.accepts(click(3)), false)
    assert.deepEqual(h.calls, ['start:false', 'set:true', 'set:false'])
  })

  it('disposes after an in-flight call without accepting its setting or queued work', async () => {
    const h = createSession()
    await h.session.setActive(true)
    await h.session.start()
    const ack = deferred<DeviceInputState>()
    h.setConfigure(() => ack.promise)
    const request = h.session.request(false)
    await flush()
    const ended = h.session.dispose()
    ack.resolve({ mouseEnabled: false, mouseGeneration: 2 })
    await assert.rejects(request, /session has ended/)
    await ended
    assert.deepEqual(h.saves, [true])
    assert.equal(h.session.accepts(typing), false)
    assert.equal(h.calls.at(-1), 'stop')
  })
})
interface PreferenceTestAPI {
  request: (enabled?: boolean) => Promise<boolean>
  ready: () => boolean
  pending: () => boolean
  error: () => string | undefined
  pointer: (buttons: number) => void
  emitPreset: () => void
}
async function createPreferenceHarness() {
  const mounted: Array<() => Promise<void>> = []
  const beforeUnmount: Array<() => void> = []
  const listeners: Record<string, (event: { payload: unknown }) => void> = {}
  const timers = new Map<number, () => void>()
  const events: Array<{ event: string, payload: Record<string, unknown> }> = []
  let nextTimer = 0
  let close = () => { }
  let eventDelay: Promise<unknown> | undefined
  const store = {
    activePet3dPreset: {
      mouseEnabled: true,
      windowScalePercent: 100,
      sceneRotationOffsetDegrees: 0,
      dmeloperEyebrows: { color: '#ffffff' },
    },
    customization3d: {},
    model: {},
  }
  const source = readFileSync(new URL('../pages/preference/index.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
  const context = {
    exports: {},
    console,
    crypto: { randomUUID: () => 'preference-test' },
    window: {},
    document: {},
    setTimeout: (fn: () => void) => {
      timers.set(++nextTimer, fn)
      return nextTimer
    },
    clearTimeout: (id: number) => timers.delete(id),
    preferenceForTest: undefined as PreferenceTestAPI | undefined,
    require: (name: string): unknown => {
      const mocks: Record<string, unknown> = {
        'vue': {
          ref: (value: unknown) => ({ value }),
          computed: (fn: () => unknown) => ({
            get value() {
              return fn()
            },
          }),
          watch: () => { },
          provide: () => { },
          onMounted: (fn: () => Promise<void>) => mounted.push(fn),
          onBeforeUnmount: (fn: () => void) => beforeUnmount.push(fn),
        },
        '@tauri-apps/api/event': {
          emitTo: async (_window: string, event: string, payload: Record<string, unknown>) => {
            if (eventDelay) await eventDelay
            events.push({ event, payload })
          },
          listen: async (name: string, fn: typeof listeners[string]) => {
            listeners[name] = fn
            return () => {
              delete listeners[name]
            }
          },
        },
        '@tauri-apps/api/webviewWindow': {
          getCurrentWebviewWindow: () => ({
            onResized: async () => () => { },
            onFocusChanged: async () => () => { },
            onCloseRequested: async (fn: (event: { preventDefault: () => void }) => void) => {
              close = () => {
                let prevented = false
                fn({ preventDefault: () => {
                  prevented = true
                } })
                assert.equal(prevented, true, 'closing Preferences must retain its save owner')
              }
              return () => { }
            },
            isVisible: async () => true,
            isMinimized: async () => false,
          }),
        },
        '@vueuse/core': { useEventListener: () => { } },
        'pinia': { storeToRefs: () => ({}) },
        'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
        '@/composables/useAppLanguage': { useAppLanguage: () => ({ language: { value: 'ko-KR' } }) },
        '@/composables/useTauriListen': { useTauriListen: (event: string, handler: typeof listeners[string]) => {
          listeners[event] = handler
        } },
        '@/composables/useKeyPress': { useKeyPress: () => {}, cancelShortcutRecording: () => {} },
        '@/composables/usePreferenceTheme': { usePreferenceTheme: () => {} },
        '@/composables/useAntialiasSetting': { useAntialiasSetting: () => {} },
        '@/composables/usePetRuntimeRecovery': { usePetRuntimeRecovery: () => {} },
        '@/composables/usePreferenceUpdates': { providePreferenceUpdates: () => {} },
        '@/composables/useTray': { useTray: () => { } },
        '@/composables/useBroadcast': { BROADCAST_CONTROLLER: Symbol('broadcast'), useBroadcast: () => ({}) },
        '@/composables/usePresetManager': { usePresetManager: () => ({
          busy: { get value() {
            return presetOperations.presetOperationInProgress.value || presetOperations.presetResetInProgress.value
              || presetOperations.presetNativeEditPending.value > 0
          } },
          editorsBusy: { get value() {
            return presetOperations.presetOperationInProgress.value || presetOperations.presetResetInProgress.value
              || presetOperations.presetNativeMutationPending.value > 0
          } },
          ready: { value: true },
          markUserEdit: presetEditIntent.markPresetUserEdit,
          setListVisible: () => {},
        }) },
        '@/composables/useSceneViewport': { useSceneViewport: () => ({}) },
        '@/composables/useThemeVars': { useThemeVars: () => ({ generateColorVars: () => { } }) },
        '@/stores/block': { useBlockStore: () => store },
        '@/stores/shortcut': { useShortcutStore: () => ({}) },
        '@/stores/general': { useGeneralStore: () => ({ appearance: { language: 'ko' } }) },
        '@/stores/performance': { usePerformanceStore: () => ({ start: async () => { }, stop: async () => { } }) },
        '@/constants': constants,
        '@/features/input/types': inputTypes,
        '@/features/presets/editIntent': presetEditIntent,
        '@/features/presets/operations': presetOperations,
        '@/features/stateSafety/bridge': { editorsLocked: { value: false } },
        './navigation': { usePreferenceNavigation: () => ({ current: { value: 0 }, innerView: { value: undefined } }) },
        './performanceLifecycle': { shouldMonitorPreferencePerformance: () => false },
      }
      return mocks[name] ?? {}
    },
  }
  runInNewContext(ts.transpileModule(`${source}\n globalThis.preferenceForTest = {
    request: requestMouseEnabled, ready: () => mouseReady.value, pending: () => mousePending.value,
    error: () => mouseError.value, pointer: updateInteractionButtons, emitPreset: emitPet3dPresetSelection,
  };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  await Promise.all(mounted.map(fn => fn()))
  await flush()
  const api = context.preferenceForTest!
  const reply = (state: boolean, success = true, requestId = events.at(-1)!.payload.requestId, error?: string) => {
    listeners[constants.LISTEN_KEY.MOUSE_SETTING_RESPONSE]?.({
      payload: {
        requestId,
        success,
        state: { mouseEnabled: state, mouseGeneration: 2 },
        error,
      },
    })
  }
  reply(true)
  return {
    api,
    store,
    events,
    reply,
    delayEvents: (promise: Promise<unknown>) => {
      eventDelay = promise
    },
    close: () => close(),
    unmount: () => beforeUnmount.forEach(fn => fn()),
    timeout() {
      const entry = [...timers][0]
      if (entry) {
        timers.delete(entry[0])
        entry[1]()
      }
    },
  }
}
describe('actual preference request and persistence flow', () => {
  it('confirms a user mouse acknowledgement after an earlier synchronized write, but never a query', async () => {
    const h = await createPreferenceHarness()
    let confirmations = 0
    const stop = presetEditIntent.onPresetUserEditConfirmed(() => {
      confirmations++
    })
    try {
      const request = h.api.request(false)
      await flush()
      assert.equal(presetOperations.presetNativeEditPending.value, 1)
      h.store.activePet3dPreset.mouseEnabled = false
      h.reply(false)
      assert.equal(await request, true)
      assert.equal(confirmations, 1)
      assert.equal(presetOperations.presetNativeEditPending.value, 0)
      const query = h.api.request()
      await flush()
      h.reply(false)
      assert.equal(await query, true)
      assert.equal(confirmations, 1)
    } finally {
      stop()
      h.unmount()
    }
  })

  it('releases native ownership on selection cancellation and blocks requests while a preset is applying', async () => {
    const h = await createPreferenceHarness()
    try {
      const request = h.api.request(false)
      await flush()
      const staleId = h.events.at(-1)!.payload.requestId
      presetEditIntent.invalidatePresetSelection()
      assert.equal(await request, false)
      assert.equal(presetOperations.presetNativeEditPending.value, 0)
      h.reply(false, true, staleId)
      assert.equal(h.store.activePet3dPreset.mouseEnabled, true)
      const release = presetOperations.beginPresetOperation()
      try {
        assert.equal(await h.api.request(false), false)
      } finally {
        release()
      }
      assert.equal(presetOperations.presetNativeEditPending.value, 0)
    } finally {
      h.unmount()
    }
  })

  it('publishes current cloned preset values after older events finish, including while hidden', async () => {
    const h = await createPreferenceHarness()
    const delayedEvent = deferred<void>()
    h.delayEvents(delayedEvent.promise)
    h.close()
    h.api.pointer(1)
    h.api.emitPreset()
    h.store.activePet3dPreset.windowScalePercent = 60
    h.store.activePet3dPreset.sceneRotationOffsetDegrees = 360
    h.store.activePet3dPreset.dmeloperEyebrows.color = '#123456'
    h.api.emitPreset()
    await flush()
    assert.equal(h.events.some(event => event.event === constants.LISTEN_KEY.PET_PRESET_CHANGED), false)
    delayedEvent.resolve()
    await flush()
    const presets = h.events.filter(event => event.event === constants.LISTEN_KEY.PET_PRESET_CHANGED)
    assert.equal(presets.length, 2)
    h.store.activePet3dPreset.dmeloperEyebrows.color = '#ffffff'
    for (const { payload } of presets) {
      const preset = payload.preset as typeof h.store.activePet3dPreset
      assert.equal(preset.windowScalePercent, 60)
      assert.equal(preset.sceneRotationOffsetDegrees, 360)
      assert.equal(preset.dmeloperEyebrows.color, '#123456')
      assert.equal(preset.mouseEnabled, true)
    }
    h.unmount()
  })

  it('keeps down/request/release order and writes OFF only after a matching native acknowledgement', async () => {
    const h = await createPreferenceHarness()
    assert.equal(h.api.ready(), true)
    h.api.pointer(1)
    const off = h.api.request(false)
    h.api.pointer(0)
    await flush()
    assert.equal(h.store.activePet3dPreset.mouseEnabled, true)
    assert.equal(h.api.pending(), true)
    assert.deepEqual(h.events.slice(-3).map(event => event.event), [constants.LISTEN_KEY.VIEWPORT_INTERACTION_CHANGED, constants.LISTEN_KEY.MOUSE_SETTING_REQUEST, constants.LISTEN_KEY.VIEWPORT_INTERACTION_CHANGED])
    const request = h.events.at(-2)!.payload.requestId
    h.reply(false, true, 'old-response')
    assert.equal(h.store.activePet3dPreset.mouseEnabled, true)
    h.reply(false, true, request)
    assert.equal(await off, true)
    assert.equal(h.store.activePet3dPreset.mouseEnabled, false)
    h.unmount()
  })

  it('keeps the confirmed ON and reports unsupported OFF', async () => {
    const h = await createPreferenceHarness()
    const off = h.api.request(false)
    await flush()
    h.reply(true, false, undefined, 'unsupported')
    assert.equal(await off, false)
    assert.equal(h.store.activePet3dPreset.mouseEnabled, true)
    assert.equal(h.api.error(), 'unsupported')
    h.unmount()
  })

  it('requeries after a lost response and ignores the older acknowledgement', async () => {
    const h = await createPreferenceHarness()
    const off = h.api.request(false)
    await flush()
    const oldId = h.events.at(-1)!.payload.requestId
    h.timeout()
    await flush()
    assert.equal(h.events.at(-1)!.payload.enabled, undefined)
    h.reply(false, true, oldId)
    assert.equal(h.api.pending(), true)
    h.reply(false)
    assert.equal(await off, true)
    assert.equal(h.store.activePet3dPreset.mouseEnabled, false)
    h.unmount()
  })

  it('does not infer success on repeated timeout and retains accepted requests while hiding', async () => {
    const h = await createPreferenceHarness()
    const off = h.api.request(false)
    await flush()
    h.timeout()
    await flush()
    h.timeout()
    assert.equal(await off, false)
    assert.equal(h.store.activePet3dPreset.mouseEnabled, true)
    assert.equal(h.api.ready(), false)
    const retry = h.api.request(false)
    await flush()
    h.close()
    assert.equal(h.api.pending(), true)
    assert.equal(presetOperations.presetNativeEditPending.value, 1)
    h.reply(false)
    assert.equal(await retry, true)
    assert.equal(h.store.activePet3dPreset.mouseEnabled, false)
    assert.equal(presetOperations.presetNativeEditPending.value, 0)
    assert.equal(await h.api.request(true), false, 'hiding still rejects new interactive requests')
    h.unmount()
  })
})
function createComposableHarness(passThrough = false) {
  const mounted: Array<() => unknown> = []
  const unmounted: Array<() => void> = []
  const events: Record<string, (event: { payload: unknown }) => void> = {}
  const frames = new Map<number, () => void>()
  const dispatched: SemanticInputEvent[] = []
  const nativeCalls: string[] = []
  const listenerStops: string[] = []
  const cursorIgnores: boolean[] = []
  const styles = new Map<string, string>()
  const timers = new Map<number, { due: number, fn: () => void }>()
  const watchers: Array<() => void> = []
  let now = 0
  let timerId = 0
  let cursorReads = 0
  let cursor = async () => ({ x: 100, y: 25 })
  let nextFrame = 0
  let epoch = 0
  let commandWait = async (_command: string) => {}
  let monitor = async (_point: { x: number, y: number }) => ({ position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
  const store = { activePet3dPreset: { mouseEnabled: true }, window: { passThrough, visible: true, hideOnHover: false, hideOnHoverDelay: 0 } }
  const exports = loadDevice({
    'vue': { onMounted: (fn: () => unknown) => mounted.push(fn), onUnmounted: (fn: () => void) => unmounted.push(fn), watch: (sources: Array<() => boolean>, fn: (values: boolean[]) => void) => watchers.push(() => fn(sources.map(read => read()))) },
    '@tauri-apps/api/core': {
      invoke: async (command: string, args: { enabled?: boolean, mouseEnabled?: boolean, active?: boolean } = {}) => {
        nativeCalls.push(command)
        await commandWait(command)
        return { mouseEnabled: args.active === false ? false : args.enabled ?? args.mouseEnabled ?? true, mouseGeneration: ++epoch }
      },
    },
    '@tauri-apps/api/window': { cursorPosition: () => {
      cursorReads++
      return cursor()
    } },
    '@tauri-apps/api/dpi': {
      PhysicalPosition: class {
        constructor(public x: number, public y: number) { }
      },
    },
    '@tauri-apps/api/event': {
      listen: async (name: string, fn: typeof events[string]) => {
        events[name] = fn
        return () => {
          listenerStops.push(name)
          delete events[name]
        }
      },
    },
    '@/plugins/window': { setPetCursorEvents: async (enabled: boolean) => {
      cursorIgnores.push(enabled)
    } },
    'es-toolkit': { isNil: (value: unknown) => value == null },
    '@/stores/app': { useAppStore: () => ({ windowState: { main: { x: 0, y: 0, width: 200, height: 100 } } }) },
    '@/stores/block': { useBlockStore: () => store },
    '@/utils/is': { inBetween: (value: number, minimum: number, maximum: number) => value >= minimum && value <= maximum },
    '@/utils/monitor': { getCursorMonitor: (point: { x: number, y: number }) => monitor(point) },
    '@/utils/three3d': { default: { setMouseEnabled: () => { }, setMouseInputActive: () => { }, setInputActive: () => { }, handleSemanticInput: (event: SemanticInputEvent) => dispatched.push(event) } },
  }, {
    document: { body: { style: { setProperty: (name: string, value: string) => styles.set(name, value) } } },
    setTimeout: (fn: () => void, delay: number) => {
      timers.set(++timerId, { fn, due: now + delay })
      return timerId
    },
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (fn: () => void) => {
      frames.set(++nextFrame, fn)
      return nextFrame
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })
  const device = exports.useDevice()
  return {
    device,
    dispatched,
    nativeCalls,
    listenerStops,
    cursorIgnores,
    store,
    opacity: () => styles.get('opacity'),
    cursorReads: () => cursorReads,
    setCursor: (fn: typeof cursor) => {
      cursor = fn
    },
    hover(enabled: boolean, delay = 0, passThrough = false) {
      Object.assign(store.window, { hideOnHover: enabled, hideOnHoverDelay: delay, passThrough })
      watchers.forEach(run => run())
    },
    async advance(milliseconds: number) {
      await flush()
      const target = now + milliseconds
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0]
        if (timer.due > target) break
        now = timer.due
        timers.delete(id)
        timer.fn()
        await flush()
      }
      now = target
      await flush()
    },
    frames,
    setMonitor: (fn: typeof monitor) => {
      monitor = fn
    },
    setCommandWait: (fn: typeof commandWait) => {
      commandWait = fn
    },
    createDevice: () => exports.useDevice(),
    async mount(currentDevice = device) {
      await Promise.all(mounted.splice(0).map(fn => fn()))
      await currentDevice.setInputActive(true)
      await currentDevice.startListening()
    },
    unmount: () => unmounted.splice(0).forEach(fn => fn()),
    event: (event: SemanticInputEvent) => events[constants.LISTEN_KEY.SEMANTIC_INPUT]?.({ payload: event }),
    frame() {
      for (const [id, fn] of frames) {
        frames.delete(id)
        fn()
      }
    },
  }
}
describe('actual useDevice pointer dispatch', () => {
  it('hides and restores on hover with pet mouse input OFF without enabling mouse buttons', async () => {
    const h = createComposableHarness()
    h.store.activePet3dPreset.mouseEnabled = false
    h.hover(true)
    try {
      await h.mount()
      await h.advance(1000)
      assert.equal(h.device.getInputState().mouseEnabled, false)
      assert.equal(h.opacity(), '0')
      assert.equal(h.cursorIgnores.at(-1), true)
      assert.deepEqual(h.dispatched, [])
      h.setCursor(async () => ({ x: -10, y: -10 }))
      await h.advance(100)
      assert.equal(h.opacity(), 'unset')
      assert.equal(h.cursorIgnores.at(-1), false)
      assert.equal(h.device.getInputState().mouseEnabled, false)
    } finally {
      h.unmount()
      await flush()
    }
  })

  it('honors the hover delay and cancels it when the cursor leaves', async () => {
    const h = createComposableHarness()
    h.store.activePet3dPreset.mouseEnabled = false
    h.hover(true, 0.3)
    try {
      await h.mount()
      await h.advance(199)
      assert.equal(h.opacity(), 'unset')
      h.setCursor(async () => ({ x: 201, y: 25 }))
      await h.advance(101)
      assert.equal(h.opacity(), 'unset')
      h.setCursor(async () => ({ x: 100, y: 25 }))
      await h.advance(399)
      assert.equal(h.opacity(), 'unset')
      await h.advance(1)
      assert.equal(h.opacity(), '0')
    } finally {
      h.unmount()
      await flush()
    }
  })

  it('polls only with hover enabled and restores while rendering is paused', async () => {
    const h = createComposableHarness()
    try {
      await h.mount()
      await h.advance(1000)
      assert.equal(h.cursorReads(), 0)
      h.hover(true)
      await flush()
      await h.advance(0)
      assert.equal(h.opacity(), '0')
      await h.device.setInputActive(false)
      assert.equal(h.opacity(), 'unset')
      assert.equal(h.cursorIgnores.at(-1), false)
      const reads = h.cursorReads()
      await h.advance(1000)
      assert.equal(h.cursorReads(), reads)
      await h.device.setInputActive(true)
      await h.advance(0)
      assert.equal(h.opacity(), '0')
      h.hover(false)
      assert.equal(h.opacity(), 'unset')
      await h.advance(1000)
      assert.equal(h.cursorReads(), reads + 1)
    } finally {
      h.unmount()
      await flush()
    }
  })

  it('preserves click-through and suspends hover detection when it is enabled', async () => {
    const h = createComposableHarness()
    h.hover(true)
    try {
      await h.mount()
      await h.advance(0)
      assert.equal(h.opacity(), '0')
      h.hover(true, 0, true)
      assert.equal(h.opacity(), 'unset')
      assert.equal(h.cursorIgnores.at(-1), true)
      const reads = h.cursorReads()
      await h.advance(1000)
      assert.equal(h.cursorReads(), reads)
      h.hover(true, 0, false)
      await flush()
      await h.advance(0)
      assert.equal(h.opacity(), '0')
    } finally {
      h.unmount()
      await flush()
    }
  })

  it('keeps hover hiding independent across pet mouse OFF/ON changes', async () => {
    const h = createComposableHarness()
    h.hover(true)
    try {
      await h.mount()
      await h.advance(0)
      assert.equal(h.opacity(), '0')
      await h.device.requestMouseSetting(false)
      assert.equal(h.opacity(), '0')
      assert.equal(h.cursorIgnores.at(-1), true)
      h.event({ kind: 'pointer_activity', x: -10, y: -10, mouseGeneration: h.device.getInputState().mouseGeneration })
      assert.equal(h.opacity(), 'unset')
      h.frame()
      await flush()
      assert.equal(h.dispatched.length, 1)
      assert.equal(h.dispatched[0].kind, 'pointer_activity')
      await h.device.requestMouseSetting(true)
      assert.equal(h.opacity(), 'unset')
      h.setCursor(async () => ({ x: -10, y: -10 }))
      await h.advance(100)
      assert.equal(h.opacity(), 'unset')
    } finally {
      h.unmount()
      await flush()
    }
  })

  it('ignores pending cursor reads after disable, pause or disposal', async () => {
    for (const stop of ['disable', 'pause', 'dispose']) {
      const h = createComposableHarness()
      const cursor = deferred<{ x: number, y: number }>()
      h.setCursor(() => cursor.promise)
      h.hover(true)
      try {
        await h.mount()
        await h.advance(1000)
        assert.equal(h.cursorReads(), 1, 'only one cursor request may be in flight')
        if (stop === 'disable') h.hover(false)
        else if (stop === 'pause') await h.device.setInputActive(false)
        else h.unmount()
        const reads = h.cursorReads()
        cursor.resolve({ x: 100, y: 25 })
        await flush()
        await h.advance(1000)
        assert.equal(h.opacity(), 'unset', stop)
        assert.equal(h.cursorIgnores.at(-1), false, stop)
        assert.equal(h.cursorReads(), reads, stop)
      } finally {
        h.unmount()
        await flush()
      }
    }
  })

  it('ignores a cursor read from before reactivation and resumes with a fresh one', async () => {
    const h = createComposableHarness()
    const cursor = deferred<{ x: number, y: number }>()
    h.setCursor(() => cursor.promise)
    h.hover(true)
    try {
      await h.mount()
      await h.device.setInputActive(false)
      await h.device.setInputActive(true)
      assert.equal(h.cursorReads(), 1)
      h.setCursor(async () => ({ x: -10, y: -10 }))
      cursor.resolve({ x: 100, y: 25 })
      await flush()
      await h.advance(100)
      assert.equal(h.opacity(), 'unset')
      assert.equal(h.cursorReads(), 2)
    } finally {
      h.unmount()
      await flush()
    }
  })

  it('ignores a polled position older than a native pointer event', async () => {
    const h = createComposableHarness()
    const cursor = deferred<{ x: number, y: number }>()
    h.setCursor(() => cursor.promise)
    h.hover(true)
    try {
      await h.mount()
      const mouseGeneration = h.device.getInputState().mouseGeneration
      h.event({ kind: 'pointer_activity', x: 100, y: 25, mouseGeneration })
      await h.advance(0)
      assert.equal(h.opacity(), '0')
      h.event({ kind: 'pointer_activity', x: -10, y: -10, mouseGeneration })
      cursor.resolve({ x: 100, y: 25 })
      await flush()
      await h.advance(0)
      assert.equal(h.opacity(), 'unset')
      assert.equal(h.cursorIgnores.at(-1), false)
    } finally {
      h.unmount()
      await flush()
    }
  })

  it('retains right-button animations and the window click-through choice across mouse toggles', async () => {
    for (const passThrough of [false, true]) {
      const h = createComposableHarness(passThrough)
      await h.mount()
      const mouseGeneration = h.device.getInputState().mouseGeneration
      for (const active of [true, false]) {
        h.event({ kind: 'mouse_secondary', active, mouseGeneration })
      }
      assert.deepEqual(h.dispatched, [
        { kind: 'mouse_secondary', active: true, mouseGeneration },
        { kind: 'mouse_secondary', active: false, mouseGeneration },
      ])
      await h.device.requestMouseSetting(false)
      h.event({ kind: 'mouse_secondary', active: true, mouseGeneration })
      assert.equal(h.dispatched.length, 2)
      assert.ok(h.cursorIgnores.length > 0)
      assert.ok(h.cursorIgnores.every(enabled => enabled === passThrough))
      h.unmount()
      await flush()
    }
  })
  it('does not let an old component stop or gate a replacement input session', async () => {
    const h = createComposableHarness()
    await h.mount()
    const ack = deferred<void>()
    h.setCommandWait(command => command === constants.INVOKE_KEY.SET_DEVICE_INPUT_ACTIVE ? ack.promise : Promise.resolve())
    const oldRequest = h.device.requestMouseSetting(false)
    await flush()
    h.unmount()
    const replacement = h.createDevice()
    const mounted = h.mount(replacement)
    ack.resolve()
    await assert.rejects(oldRequest, /session has ended/)
    await mounted
    await flush()
    assert.equal(h.nativeCalls.at(-1), constants.INVOKE_KEY.SET_DEVICE_INPUT_ACTIVE)
    assert.equal(replacement.acceptsInput(typing), true)
    assert.equal(replacement.acceptsInput(click(replacement.getInputState().mouseGeneration)), true)
    h.unmount()
    await flush()
    assert.equal(h.nativeCalls.at(-1), constants.INVOKE_KEY.STOP_DEVICE_LISTENING)
  })
  it('keeps one pending monitor lookup across 30 RAFs and delivers only the latest point', async () => {
    const h = createComposableHarness()
    const oldMonitor = deferred<{ position: { x: number, y: number }, size: { width: number, height: number } }>()
    const points: Array<{ x: number, y: number }> = []
    let inFlight = 0
    let maximumInFlight = 0
    h.setMonitor(async (point) => {
      points.push({ ...point })
      maximumInFlight = Math.max(maximumInFlight, ++inFlight)
      try {
        return points.length === 1
          ? await oldMonitor.promise
          : { position: { x: 200, y: 0 }, size: { width: 200, height: 100 } }
      } finally {
        inFlight--
      }
    })
    try {
      await h.mount()
      const mouseGeneration = h.device.getInputState().mouseGeneration
      h.event({ kind: 'pointer_activity', x: 10, y: 25, mouseGeneration })
      h.frame()
      await flush()
      for (let index = 1; index <= 30; index++) {
        h.event({ kind: 'pointer_activity', x: 210 + index * 2, y: 50, mouseGeneration })
        h.frame()
        await flush()
      }
      assert.equal(points.length, 1, 'native lookup count must not grow while its reply is pending')
      assert.equal(h.frames.size, 0)
      h.event(typing)
      h.event({ kind: 'mouse_primary', active: true, mouseGeneration })
      h.event({ kind: 'mouse_primary', active: false, mouseGeneration })
      assert.deepEqual(h.dispatched.map(event => event.kind), ['typing', 'mouse_primary', 'mouse_primary'])
      oldMonitor.resolve({ position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
      await flush()
      assert.equal(h.frames.size, 1, 'the latest point gets one fresh frame after the old reply')
      h.frame()
      await flush()
      assert.deepEqual(points, [{ x: 10, y: 25 }, { x: 270, y: 50 }])
      assert.equal(maximumInFlight, 1)
      assert.deepEqual({ ...h.dispatched.at(-1) }, { kind: 'pointer_activity', x: 0.35, y: 0.5, mouseGeneration })
      assert.equal(h.frames.size, 0)
    } finally {
      oldMonitor.resolve({ position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
      h.unmount()
      await flush()
    }
  })

  it('retains the actual monitor cache TTL and rechecks the latest point across monitors', async () => {
    const h = createComposableHarness()
    const monitorSource = ts.transpileModule(readFileSync(new URL('../utils/monitor.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const nativePoints: Array<{ x: number, y: number }> = []
    const first = { position: { x: 0, y: 0 }, size: { width: 200, height: 100 } }
    const second = { position: { x: -200, y: 0 }, size: { width: 200, height: 100 } }
    const monitor = {} as { getCursorMonitor: (point: { x: number, y: number }) => Promise<typeof first> }
    let now = 1000
    let pending: ReturnType<typeof deferred<typeof first>> | undefined
    runInNewContext(monitorSource, {
      exports: monitor,
      Date: { now: () => now },
      require: () => ({ monitorFromPoint: async (x: number, y: number) => {
        nativePoints.push({ x, y })
        return pending ? pending.promise : x < 0 ? second : first
      } }),
    })
    h.setMonitor(point => monitor.getCursorMonitor(point))
    try {
      await h.mount()
      const mouseGeneration = h.device.getInputState().mouseGeneration
      const point = async (x: number, y = 25) => {
        h.event({ kind: 'pointer_activity', x, y, mouseGeneration })
        h.frame()
        await flush()
      }
      await point(50)
      await point(100)
      assert.equal(nativePoints.length, 1, 'warm same-monitor points reuse the real cache')
      now += 1001
      pending = deferred<typeof first>()
      for (let index = 1; index <= 30; index++) await point(100 + index)
      assert.equal(nativePoints.length, 2, 'TTL expiry still issues only one pending native lookup')
      const expired = pending
      pending = undefined
      expired.resolve(first)
      await flush()
      h.frame()
      await flush()
      assert.equal(nativePoints.length, 2, 'latest same-monitor point uses the refreshed cache')
      assert.equal((h.dispatched.at(-1) as { x: number }).x, 0.65)
      pending = deferred<typeof first>()
      await point(-190)
      await point(-60, 50)
      assert.equal(nativePoints.length, 3, 'cross-monitor movement owns one lookup')
      const crossed = pending
      pending = undefined
      crossed.resolve(second)
      await flush()
      h.frame()
      await flush()
      assert.deepEqual({ ...h.dispatched.at(-1) }, { kind: 'pointer_activity', x: 0.7, y: 0.5, mouseGeneration })
      assert.equal(nativePoints.length, 3)
    } finally {
      pending?.resolve(first)
      h.unmount()
      await flush()
    }
  })

  for (const queuedPoint of [false, true]) {
    it(`recovers from a rejected monitor reply without retrying stale input (queued latest: ${queuedPoint})`, async () => {
      const h = createComposableHarness()
      const failed = deferred<{ position: { x: number, y: number }, size: { width: number, height: number } }>()
      let reads = 0
      h.setMonitor(async () => ++reads === 1
        ? failed.promise
        : { position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
      try {
        await h.mount()
        const mouseGeneration = h.device.getInputState().mouseGeneration
        h.event({ kind: 'pointer_activity', x: 50, y: 25, mouseGeneration })
        h.frame()
        if (queuedPoint) h.event({ kind: 'pointer_activity', x: 150, y: 50, mouseGeneration })
        failed.reject(new Error('Native monitor lookup failed.'))
        await flush()
        assert.equal(h.frames.size, queuedPoint ? 1 : 0)
        if (!queuedPoint) h.event({ kind: 'pointer_activity', x: 150, y: 50, mouseGeneration })
        h.frame()
        await flush()
        assert.equal(reads, 2)
        assert.deepEqual(h.dispatched.map(event => ({ ...event })), [{ kind: 'pointer_activity', x: 0.75, y: 0.5, mouseGeneration }])
        assert.equal(h.frames.size, 0)
      } finally {
        h.unmount()
        await flush()
      }
    })
  }

  for (const boundary of ['off', 'pause', 'unmount'] as const) {
    it(`does not reschedule queued pointer input after ${boundary} retires a pending lookup`, async () => {
      const h = createComposableHarness()
      const delayed = deferred<{ position: { x: number, y: number }, size: { width: number, height: number } }>()
      let reads = 0
      h.setMonitor(async () => ++reads === 1
        ? delayed.promise
        : { position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
      try {
        await h.mount()
        const mouseGeneration = h.device.getInputState().mouseGeneration
        h.event({ kind: 'pointer_activity', x: 50, y: 25, mouseGeneration })
        h.frame()
        h.event({ kind: 'pointer_activity', x: 150, y: 50, mouseGeneration })
        if (boundary === 'off') await h.device.requestMouseSetting(false)
        else if (boundary === 'pause') await h.device.setInputActive(false)
        else h.unmount()
        delayed.resolve({ position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
        await flush()
        assert.equal(reads, 1)
        assert.equal(h.frames.size, 0)
        assert.deepEqual(h.dispatched, [])
        if (boundary !== 'unmount') {
          if (boundary === 'pause') await h.device.setInputActive(true)
          h.event({ kind: 'pointer_activity', x: 150, y: 50, mouseGeneration: h.device.getInputState().mouseGeneration })
          h.frame()
          await flush()
          assert.equal(reads, 2, 'fresh accepted input remains responsive, including mouse-button OFF')
          assert.equal(h.dispatched.length, 1)
        }
      } finally {
        delayed.resolve({ position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
        h.unmount()
        await flush()
      }
    })
  }

  it('does not let a retired lookup schedule work or disturb a remounted input owner', async () => {
    const h = createComposableHarness()
    const delayed = deferred<{ position: { x: number, y: number }, size: { width: number, height: number } }>()
    h.setMonitor(() => delayed.promise)
    await h.mount()
    h.event({ kind: 'pointer_activity', x: 50, y: 25, mouseGeneration: h.device.getInputState().mouseGeneration })
    h.frame()
    h.event({ kind: 'pointer_activity', x: 100, y: 50, mouseGeneration: h.device.getInputState().mouseGeneration })
    h.unmount()
    await flush()
    const replacement = h.createDevice()
    h.setMonitor(async () => ({ position: { x: 0, y: 0 }, size: { width: 200, height: 100 } }))
    try {
      await h.mount(replacement)
      const mouseGeneration = replacement.getInputState().mouseGeneration
      h.event({ kind: 'pointer_activity', x: 150, y: 50, mouseGeneration })
      h.frame()
      await flush()
      delayed.resolve({ position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
      await flush()
      assert.deepEqual(h.dispatched.map(event => ({ ...event })), [{ kind: 'pointer_activity', x: 0.75, y: 0.5, mouseGeneration }])
      assert.equal(h.frames.size, 0)
      assert.equal(replacement.acceptsInput(typing), true)
    } finally {
      delayed.resolve({ position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
      h.unmount()
      await flush()
    }
  })

  it('rejects monitor results from before OFF/ON and keeps keyboard events', async () => {
    const h = createComposableHarness()
    await h.mount()
    const monitor = deferred<{ position: { x: number, y: number }, size: { width: number, height: number } }>()
    h.setMonitor(() => monitor.promise)
    h.event({ kind: 'pointer_activity', x: 100, y: 25, mouseGeneration: 1 })
    h.frame()
    await h.device.requestMouseSetting(false)
    h.event(typing)
    await h.device.requestMouseSetting(true)
    monitor.resolve({ position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
    await flush()
    assert.equal(h.dispatched.length, 1)
    assert.equal(h.dispatched[0].kind, 'typing')
    h.event({ kind: 'pointer_activity', x: 100, y: 25, mouseGeneration: 3 })
    h.frame()
    await flush()
    assert.equal(h.dispatched[1].kind, 'pointer_activity')
    assert.equal(h.dispatched[1].mouseGeneration, 3)
    assert.equal((h.dispatched[1] as { x: number }).x, 0.5)
    h.unmount()
    await flush()
    assert.deepEqual(h.listenerStops, [constants.LISTEN_KEY.SEMANTIC_INPUT])
    assert.equal(h.nativeCalls.at(-1), constants.INVOKE_KEY.STOP_DEVICE_LISTENING)
  })

  it('cancels queued frames on hide and never dispatches after unmount', async () => {
    const h = createComposableHarness()
    await h.mount()
    h.event({ kind: 'pointer_activity', x: 100, y: 25, mouseGeneration: 1 })
    assert.equal(h.frames.size, 1)
    await h.device.setInputActive(false)
    assert.equal(h.frames.size, 0)
    await h.device.setInputActive(true)
    h.event({ kind: 'mouse_middle', active: true, mouseGeneration: 3 })
    assert.equal(h.dispatched.length, 1)
    h.unmount()
    h.event({ kind: 'scroll', deltaX: 0.1, deltaY: 2, mouseGeneration: 3 })
    await flush()
    assert.equal(h.dispatched.length, 1)
  })
})
