/* eslint-disable test/no-import-node-test */
import type { VNode } from 'vue'

import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createPinia } from 'pinia'
import ts from 'typescript'
import { compile, isRef, ref as vueRef, watch as vueWatch } from 'vue'

import type { PetSkinChangeRequest } from '@/features/petRuntime/types'
import type { PresetApplyResponse, PresetSnapshot } from '@/features/presets/types'
import type { BlockStore, Pet3dPresetSelectionPayload } from '@/stores/block'
import type { LoadedPetAssetState } from '@/utils/three3d'

import { DEFAULT_PREFERENCE_SIZE, MIN_PREFERENCE_SIZE } from '@/config/window'
import { LISTEN_KEY } from '@/constants'
import { isCurrentSemanticInput } from '@/features/input/types'
import { PET_RUNTIME_RESTART_REQUIRED, PET_SKIN_CHANGE } from '@/features/petRuntime/types'
import { capturePresetSnapshot, createDefaultPresetSnapshot } from '@/features/presets/model'
import { PRESET_APPLY_CANCEL, PRESET_APPLY_REQUEST, PRESET_APPLY_RESPONSE } from '@/features/presets/types'
import { SCENE_VIEWPORT_REQUEST, SCENE_VIEWPORT_RESPONSE } from '@/features/scene/types'
import { createWindowVisibilityQueue } from '@/plugins/windowVisibility'
import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'
import { RenderCadence } from '@/utils/three3d/renderCadence'

import type { ApplyMainViewportGeometryInput, WindowState } from './useWindowState'

const require = createRequire(import.meta.url)
const mainPageSource = readFileSync(new URL('../pages/main/index.vue', import.meta.url), 'utf8')
const renderMainPage = compile(mainPageSource.split('<template>')[1].split('</template>')[0])
const source = readFileSync(new URL('./useWindowState.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source.replace(/import\.meta\.hot/g, '__hot'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type NativeEventListener = (event: { payload: unknown }) => Promise<void>

interface SharedNativeWindow {
  size: { width: number, height: number }
  listeners: Set<NativeEventListener>
  writes: Array<{ owner: string, width: number, height: number }>
}

function createNativeHarness(options: {
  shared?: SharedNativeWindow
  owner?: string
  registration?: Promise<void>
  label?: string
  scaleFactor?: number
  monitors?: Array<{
    position: { x: number, y: number }
    size: { width: number, height: number }
    scaleFactor: number
    workArea: { position: { x: number, y: number }, size: { width: number, height: number } }
  }>
} = {}) {
  const calls: string[] = []
  const mounted: Array<() => void> = []
  const disposed: Array<() => void> = []
  const hotDisposed: Array<() => void> = []
  const released: string[] = []
  const timers: Array<() => Promise<void>> = []
  const listeners: Record<string, NativeEventListener> = {}
  const pauses: Partial<Record<'read' | 'sizeRead' | 'size' | 'position', Promise<void>>> = {}
  const blockStore = { window: { keepInScreen: false }, model: { mirror: false } }
  const appStore = { windowState: {} as WindowState }
  const register = (event: string, callback: NativeEventListener) => {
    listeners[event] = callback
    if (event === 'resized') options.shared?.listeners.add(callback)
    return Promise.resolve(options.registration).then(() => () => {
      released.push(event)
      if (listeners[event] === callback) delete listeners[event]
      if (event === 'resized') options.shared?.listeners.delete(callback)
    })
  }
  const appWindow = {
    label: options.label ?? 'main',
    isMinimized: async () => false,
    scaleFactor: async () => {
      await pauses.read
      return options.scaleFactor ?? 1
    },
    outerPosition: async () => ({ x: 20, y: 30 }),
    outerSize: async () => ({ ...options.shared?.size ?? { width: 200, height: 200 } }),
    innerSize: async () => {
      await pauses.sizeRead
      return { ...options.shared?.size ?? { width: 200, height: 200 } }
    },
    setSize: async (size: { width: number, height: number }) => {
      calls.push('size')
      if (options.shared) {
        options.shared.size = { width: size.width, height: size.height }
        options.shared.writes.push({ owner: options.owner ?? 'main', ...options.shared.size })
      }
      await pauses.size
    },
    setPosition: async () => {
      calls.push('position')
      await pauses.position
    },
    onMoved: (callback: NativeEventListener) => register('moved', callback),
    onResized: (callback: NativeEventListener) => register('resized', callback),
    onScaleChanged: (callback: NativeEventListener) => register('scale', callback),
  }
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => appWindow },
    '@tauri-apps/api/window': { availableMonitors: async () => options.monitors ?? [] },
    '@vueuse/core': {
      useDebounceFn: (callback: (...args: unknown[]) => Promise<void>) => (...args: unknown[]) => {
        timers.push(() => callback(...args))
      },
    },
    'vue': {
      onMounted: (callback: () => void) => mounted.push(callback),
      onScopeDispose: (callback: () => void) => disposed.push(callback),
      ref: (value: unknown) => ({ value }),
      watch: () => {},
    },
    '@/stores/app': { useAppStore: () => appStore },
    '@/stores/block': { useBlockStore: () => blockStore },
  }
  const exports = {} as typeof import('./useWindowState')
  runInNewContext(compiled, {
    exports,
    require: (id: string) => mocks[id] ?? require(id),
    console,
    setTimeout,
    clearTimeout,
    __hot: { dispose: (callback: () => void) => hotDisposed.push(callback) },
  })
  const lifecycle = exports.useWindowState()
  mounted.forEach(callback => callback())
  const input: ApplyMainViewportGeometryInput = {
    mirrored: false,
    sourceRect: { x: 0, y: 0, width: 200, height: 200 },
    virtualSize: { width: 400, height: 400 },
    windowScalePercent: 100,
  }
  return { api: exports, appStore, calls, input, listeners, pauses, timers, released, lifecycle, dispose: () => disposed.forEach(callback => callback()), hotDispose: () => hotDisposed.forEach(callback => callback()) }
}

async function flushMicrotasks() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve()
}

describe('preference default geometry', () => {
  it('restores unusable saved sizes to defaults instead of reopening a zero client area', async () => {
    for (const scaleFactor of [1, 1.5, 2]) {
      for (const invalid of [0, -1, Number.NaN, Infinity]) {
        const shared: SharedNativeWindow = { size: { width: 0, height: 0 }, listeners: new Set(), writes: [] }
        const h = createNativeHarness({ shared, label: 'preference', scaleFactor })
        h.appStore.windowState.preference = { width: invalid, height: invalid, x: 130, y: 130 }
        await h.lifecycle.restoreState()
        assert.deepEqual(shared.size, { width: 911 * scaleFactor, height: 692 * scaleFactor })
        assert.equal(h.lifecycle.isRestored.value, true)
        assert.equal(h.appStore.windowState.preference.width, shared.size.width)
        assert.equal(h.appStore.windowState.preference.height, shared.size.height)
        h.dispose()
      }
    }
  })

  it('does not persist empty resize events even if the window is no longer minimized when handled', async () => {
    const h = createNativeHarness({ label: 'preference' })
    h.appStore.windowState.preference = { width: 911, height: 692, x: 130, y: 130 }
    for (const size of [
      new PhysicalSize(0, 0),
      new PhysicalSize(0, 692),
      new PhysicalSize(911, 0),
      new PhysicalSize(-1, 692),
      new PhysicalSize(911, Number.NaN),
      new PhysicalSize(Infinity, 692),
    ]) {
      await h.listeners.resized({ payload: size })
      assert.equal(h.appStore.windowState.preference.width, 911)
      assert.equal(h.appStore.windowState.preference.height, 692)
    }
    await h.listeners.resized({ payload: new PhysicalSize(800, 600) })
    assert.equal(h.appStore.windowState.preference.width, 800)
    assert.equal(h.appStore.windowState.preference.height, 600)
    h.dispose()
  })

  it('keeps first-launch native defaults separate from the accepted minimum', () => {
    const config = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
    const window = config.app.windows.find((item: { label: string }) => item.label === 'preference')
    assert.deepEqual(DEFAULT_PREFERENCE_SIZE, { width: 911, height: 692 })
    assert.deepEqual({ width: window.width, height: window.height }, DEFAULT_PREFERENCE_SIZE)
    assert.deepEqual(MIN_PREFERENCE_SIZE, { width: 669, height: 458 })
    assert.deepEqual({ width: window.minWidth, height: window.minHeight }, MIN_PREFERENCE_SIZE)
  })

  it('scales missing-state defaults at the current DPI, including no-monitor fallback', async () => {
    for (const scaleFactor of [1, 1.5, 2]) {
      const shared: SharedNativeWindow = { size: { width: 200, height: 200 }, listeners: new Set(), writes: [] }
      const h = createNativeHarness({ shared, label: 'preference', scaleFactor })
      await h.lifecycle.restoreState()
      assert.deepEqual(shared.size, { width: 911 * scaleFactor, height: 692 * scaleFactor })
      assert.equal(h.appStore.windowState.preference?.width, shared.size.width)
      assert.equal(h.appStore.windowState.preference?.height, shared.size.height)
      h.dispose()
    }
  })

  it('preserves saved physical dimensions and clamps fresh defaults to the work area', async () => {
    for (const saved of [true, false]) {
      const shared: SharedNativeWindow = { size: { width: 200, height: 200 }, listeners: new Set(), writes: [] }
      const h = createNativeHarness({
        shared,
        label: 'preference',
        monitors: [{
          position: { x: 0, y: 0 },
          size: { width: 1920, height: 1080 },
          scaleFactor: 1.5,
          workArea: { position: { x: 0, y: 0 }, size: { width: 1200, height: 900 } },
        }],
      })
      if (saved) h.appStore.windowState.preference = { width: 1100, height: 800 }
      await h.lifecycle.restoreState()
      assert.deepEqual(shared.size, saved ? { width: 1100, height: 800 } : { width: 1200, height: 840 })
      h.dispose()
    }
  })
})

it('bounds undersized saved preference geometry by the DPI minimum and smaller work areas', async () => {
  for (const scaleFactor of [1, 1.5, 2]) {
    for (const compactWorkArea of [false, true]) {
      const shared: SharedNativeWindow = { size: { width: 0, height: 0 }, listeners: new Set(), writes: [] }
      const h = createNativeHarness({
        shared,
        label: 'preference',
        monitors: [{
          position: { x: 0, y: 0 },
          size: { width: 3840, height: 2160 },
          scaleFactor,
          workArea: { position: { x: 0, y: 0 }, size: compactWorkArea ? { width: 600, height: 400 } : { width: 3840, height: 2160 } },
        }],
      })
      h.appStore.windowState.preference = { width: 1, height: 1 }
      await h.lifecycle.restoreState()
      assert.deepEqual(shared.size, compactWorkArea
        ? { width: 600, height: 400 - 40 * scaleFactor }
        : { width: 669 * scaleFactor, height: 458 * scaleFactor })
      h.dispose()
    }
  }
})

describe('native viewport interaction cancellation', () => {
  it('persists regular window geometry without enumerable Tauri class metadata', async () => {
    const h = createNativeHarness({ label: 'preference' })
    const position = new PhysicalPosition(-130, 1)
    const size = new PhysicalSize(800, 680)
    assert.equal(Object.prototype.hasOwnProperty.call(position, 'type'), true)
    assert.equal(Object.prototype.hasOwnProperty.call(size, 'type'), true)
    h.appStore.windowState.preference = { viewportOriginX: 52, viewportOriginY: 52 }
    await h.listeners.moved({ payload: position })
    await h.listeners.resized({ payload: size })
    assert.deepEqual(JSON.parse(JSON.stringify(h.appStore.windowState.preference)), {
      viewportOriginX: 52,
      viewportOriginY: 52,
      x: -130,
      y: 1,
      width: 800,
      height: 680,
    })
    h.dispose()
  })

  it('releases scope and HMR listeners, including registrations that resolve after disposal', async () => {
    for (const delayed of [false, true]) {
      for (const viaHmr of [false, true]) {
        const registration = deferred()
        const h = createNativeHarness({ registration: delayed ? registration.promise : undefined })
        await flushMicrotasks()
        const queuedResize = h.listeners.resized
        if (viaHmr) h.hotDispose()
        else h.dispose()
        if (delayed) assert.equal(h.released.length, 0)
        registration.resolve()
        await flushMicrotasks()
        h.dispose()
        assert.deepEqual(h.released.sort(), ['moved', 'resized', 'scale'])
        await queuedResize({ payload: { width: 467, height: 404 } })
        await h.lifecycle.restoreState()
        assert.equal(await h.api.applyMainViewportGeometry({ ...h.input, isCurrent: () => true }), undefined)
        assert.equal(h.lifecycle.isRestored.value, false)
        assert.deepEqual(h.calls, [])
        assert.equal(h.timers.length, 0)
      }
    }
  })

  it('stops disposed native apply continuations even when the caller predicate stays true', async () => {
    for (const stage of ['read', 'size', 'position'] as const) {
      const h = createNativeHarness()
      const pause = deferred()
      h.pauses[stage] = pause.promise
      let published = 0
      h.api.subscribeMainViewportSnapshot(() => published++)
      const applying = h.api.applyMainViewportGeometry({ ...h.input, isCurrent: () => true })
      await flushMicrotasks()
      const sent = [...h.calls]
      h.dispose()
      pause.resolve()
      assert.equal(await applying, undefined)
      assert.deepEqual(h.calls, sent)
      assert.equal(published, 0)
      assert.equal(h.api.getMainViewportSnapshot(), undefined)
    }
  })

  it('settles a deferred apply and drops its queued reconciliation when disposed', async () => {
    const shared: SharedNativeWindow = { size: { width: 200, height: 200 }, listeners: new Set(), writes: [] }
    const h = createNativeHarness({ shared })
    await h.api.applyMainViewportGeometry(h.input)
    shared.size = { width: 467, height: 404 }
    await h.listeners.resized({ payload: shared.size })
    assert.equal(h.timers.length, 1)
    let settled = false
    const applying = h.api.applyMainViewportGeometry({ ...h.input, isCurrent: () => true })
      .then((snapshot) => {
        settled = true
        return snapshot
      })
    await flushMicrotasks()
    assert.equal(settled, false)
    h.dispose()
    assert.equal(await applying, undefined)
    const sent = [...h.calls]
    for (const callback of h.timers.splice(0)) await callback()
    assert.deepEqual(h.calls, sent)
    assert.equal(h.timers.length, 0)
  })

  it('does not revive reconciliation when a resize readback finishes after disposal', async () => {
    const shared: SharedNativeWindow = { size: { width: 200, height: 200 }, listeners: new Set(), writes: [] }
    const h = createNativeHarness({ shared })
    await h.api.applyMainViewportGeometry(h.input)
    const readback = deferred()
    h.pauses.sizeRead = readback.promise
    shared.size = { width: 467, height: 404 }
    const resizing = h.listeners.resized({ payload: shared.size })
    await flushMicrotasks()
    h.dispose()
    readback.resolve()
    await resizing
    assert.equal(h.timers.length, 0)
    // Reusing the module must not inherit instability from the retired callback.
    const replacement = h.api.useWindowState()
    assert.ok(await h.api.applyMainViewportGeometry(h.input))
    assert.equal(replacement.isRestored.value, false)
  })

  it('releases the previous owner when the same module is initialized again', async () => {
    const h = createNativeHarness()
    await flushMicrotasks()
    const replacement = h.api.useWindowState()
    assert.deepEqual(h.released.sort(), ['moved', 'resized', 'scale'])
    await h.lifecycle.restoreState()
    assert.deepEqual(h.calls, [])
    await replacement.restoreState()
    assert.equal(replacement.isRestored.value, true)
    assert.deepEqual(h.calls, ['size', 'position'])
    h.hotDispose()
  })

  it('cancels a late initial restore without creating a default-size orphan writer', async () => {
    const h = createNativeHarness()
    const read = deferred()
    h.pauses.read = read.promise
    const restoring = h.lifecycle.restoreState()
    await flushMicrotasks()
    h.hotDispose()
    read.resolve()
    await restoring
    assert.equal(h.lifecycle.isRestored.value, false)
    assert.deepEqual(h.calls, [])
    assert.equal(h.api.getMainViewportSnapshot(), undefined)
  })

  it('does not alternate 500x422 and 467x404 between retired and current module generations', async () => {
    for (const viaHmr of [false, true]) {
      const shared: SharedNativeWindow = { size: { width: 500, height: 422 }, listeners: new Set(), writes: [] }
      const old = createNativeHarness({ shared, owner: 'old' })
      // No main-page guard was ever installed before the old App was retired.
      await old.lifecycle.restoreState()
      shared.size = { width: 467, height: 404 }
      await old.listeners.resized({ payload: shared.size })
      assert.equal(old.timers.length, 1)
      if (viaHmr) old.hotDispose()
      else old.dispose()
      const current = createNativeHarness({ shared, owner: 'current' })
      current.api.setAutomaticViewportMutationGuard(() => true)
      await current.api.applyMainViewportGeometry({
        ...current.input,
        sourceRect: { x: 0, y: 0, width: 467, height: 404 },
      })
      for (let cycle = 0; cycle < 6; cycle++) {
        for (const callback of [...old.timers.splice(0), ...current.timers.splice(0)]) await callback()
        for (const callback of shared.listeners) await callback({ payload: shared.size })
      }
      assert.deepEqual(shared.writes, [
        { owner: 'old', width: 500, height: 422 },
        { owner: 'current', width: 467, height: 404 },
      ])
      assert.equal(old.timers.length + current.timers.length, 0)
      current.dispose()
    }
  })

  it('keeps initial geometry available without an interaction predicate', async () => {
    const h = createNativeHarness()
    assert.ok(await h.api.applyMainViewportGeometry(h.input))
    assert.deepEqual(h.calls, ['size', 'position'])
  })

  it('does not start a native mutation when repress/hide invalidates monitor readback', async () => {
    const h = createNativeHarness()
    const read = deferred()
    h.pauses.read = read.promise
    let current = true
    const apply = h.api.applyMainViewportGeometry({ ...h.input, isCurrent: () => current })
    current = false
    read.resolve()
    assert.equal(await apply, undefined)
    assert.deepEqual(h.calls, [])
    assert.equal(h.api.getMainViewportSnapshot(), undefined)
  })

  it('does not send position after an already issued size completes during a new hold', async () => {
    const h = createNativeHarness()
    const size = deferred()
    h.pauses.size = size.promise
    let current = true
    const apply = h.api.applyMainViewportGeometry({ ...h.input, isCurrent: () => current })
    await flushMicrotasks()
    assert.deepEqual(h.calls, ['size'])
    current = false
    size.resolve()
    assert.equal(await apply, undefined)
    assert.deepEqual(h.calls, ['size'])
    assert.equal(h.api.getMainViewportSnapshot(), undefined)
  })

  it('does not publish stale crop after an already issued position completes', async () => {
    const h = createNativeHarness()
    const position = deferred()
    h.pauses.position = position.promise
    let current = true
    let published = 0
    h.api.subscribeMainViewportSnapshot(() => {
      published += 1
    })
    const apply = h.api.applyMainViewportGeometry({ ...h.input, isCurrent: () => current })
    await flushMicrotasks()
    assert.deepEqual(h.calls, ['size', 'position'])
    current = false
    position.resolve()
    await apply
    assert.equal(published, 0)
  })

  it('drops a deferred native replay invalidated by a hold or hide', async () => {
    const h = createNativeHarness()
    await h.api.applyMainViewportGeometry(h.input)
    h.calls.length = 0
    await h.listeners.moved({ payload: { x: 80, y: 90 } })
    let current = true
    const apply = h.api.applyMainViewportGeometry({ ...h.input, isCurrent: () => current })
    current = false
    h.api.setAutomaticViewportMutationGuard(() => false)
    for (const callback of h.timers) await callback()
    assert.equal(await apply, undefined)
    assert.deepEqual(h.calls, [])
  })

  it('blocks automatic clamping and refresh while settings are held/debouncing', async () => {
    const h = createNativeHarness()
    await h.api.applyMainViewportGeometry(h.input)
    h.calls.length = 0
    h.api.setAutomaticViewportMutationGuard(() => false)
    assert.equal(await h.api.clampMainViewport(), undefined)
    assert.equal(await h.api.refreshMainViewportGeometry(), undefined)
    assert.deepEqual(h.calls, [])
  })
})

function createMainPageHarness(options: { automatic?: boolean, mouseEnabled?: boolean, allowInitialize?: boolean, loadingPaint?: boolean } = {}) {
  const source = mainPageSource
    .split('<script setup lang="ts">')[1]
    .split('</script>')[0]
    .split('import.meta.env')
    .join('({})')
  const mainRequire = createRequire(new URL('../pages/main/index.vue', import.meta.url))
  const events: Record<string, (event: { payload: unknown }) => void> = {}
  const unmounted: Array<() => void> = []
  const domEvents: Record<string, Array<(event: Pick<MouseEvent, 'type' | 'button' | 'buttons'>) => void>> = {}
  const general = { broadcast: { enabled: false, showOnDesktop: true } }
  let previewError = false
  let viewportWatch: (() => void) | undefined
  let now = 0
  const cadence = new RenderCadence()
  cadence.reset(now)
  cadence.setEnabled(true, now)
  let nextTimer = 0
  const timers = new Map<number, { due: number, callback: () => void, frame?: boolean }>()
  const calls = {
    native: [] as number[],
    nativeRects: [] as Array<{ x: number, y: number, width: number, height: number }>,
    pan: [] as number[][],
    shown: 0,
    crop: 0,
    preview: 0,
    measure: 0,
    center: 0,
    drag: 0,
    dragContainment: [] as boolean[],
    interactionHeld: [] as boolean[],
    padding: [] as number[],
    inputResumeStarted: 0,
    inputResumes: [] as boolean[],
  }
  const rect = { x: 0, y: 0, width: 200, height: 200 }
  let measuredRect = { ...rect }
  let snapshot = { sourceRect: rect, realizedSourceRect: rect, outputLogicalSize: rect, physicalSize: rect }
  let nativeWait = Promise.resolve()
  let centerWait = Promise.resolve()
  let inputResumeWait = Promise.resolve()
  let inputRequestGeneration = 0
  let pauseFramesWhenHidden = false
  let dragWait = Promise.resolve()
  let nativeFailure = false
  let nativeFailuresRemaining = 0
  let visibilityFailure: 'show' | 'hide' | undefined
  let nativeVisible = true
  let showWait = Promise.resolve()
  let hideWait = Promise.resolve()
  let initializationWait = Promise.resolve()
  let initializationFailures = 0
  let initializationErrorName = 'Error'
  let resourceFailure: 'skin' | 'model' | undefined
  const resourceWait = { skin: Promise.resolve(), model: Promise.resolve() }
  let skinFailure = false
  let skinWait = Promise.resolve()
  let skinApplications = 0
  let petPresentationVisible = true
  let health = true
  let automaticFrame = true
  let firstFrame: (() => void) | undefined
  let runtimeFailure: ((error: unknown) => void) | undefined
  let initializationCalls = 0
  let destructionCalls = 0
  const orderVisibility = createWindowVisibilityQueue()
  const recoveryNotices: unknown[] = []
  const editorGate = { value: false }
  let editorWatch: ((locked?: boolean) => void) | undefined
  let visibilityReadWait = Promise.resolve()
  let memoryWait = Promise.resolve()
  let nextTickWait = Promise.resolve()
  let visibilityReadResult: boolean | undefined
  let ignoreVisibility = false
  let inputFailure = false
  let scaleFactor = 1
  let monitorSize = { width: 1920, height: 1080 }
  let monitorWait = Promise.resolve()
  let mouseState = { mouseEnabled: options.mouseEnabled ?? true, mouseGeneration: 1 }
  let inputActive = true
  let mouseSettingWatch: (() => void) | undefined
  let mouseSettingWait = Promise.resolve()
  const mouseResponses: unknown[] = []
  const presetResponses: PresetApplyResponse[] = []
  const sceneResponses: Array<{ requestId: string, success: boolean, state: { automatic: boolean, revision: number, rect: typeof rect } }> = []
  let measurementWait = Promise.resolve()
  let loadedAssetState: LoadedPetAssetState = {
    modelId: 'dmeloper',
    dmeloperSkinModel: 'wide',
    dmeloperSkinUrl: options.allowInitialize ? 'data:image/png;base64,default' : undefined,
  }
  const store = {
    sanitizePet3dPreset: useBlockStore(createPinia()).sanitizePet3dPreset,
    window: { visible: true, keepInScreen: false, opacity: 100 },
    model: { mirror: false, eyebrowAnimationEnabled: true },
    customization3d: {
      ...createDefaultPresetSnapshot().appearance,
      preset: {
        ...createDefaultPet3dPreset(),
        // Geometry fixtures below deliberately start with 16px padding.
        autoViewportPaddingPixels: 16,
        autoViewportEnabled: options.automatic ?? true,
        mouseEnabled: mouseState.mouseEnabled,
        manualViewportRect: { ...rect },
      },
    },
    get activePet3dPreset() {
      return this.customization3d.preset
    },
    $patch(operation: () => void) {
      const mirror = this.model.mirror
      operation()
      if (this.model.mirror !== mirror) viewportWatch?.()
    },
  }
  const renderer = new Proxy<Record<string, unknown>>({
    init: async (_canvas: unknown, _url: unknown, _model: unknown, _skin: unknown, _preference: unknown, options: { onFrameRendered: () => void, onRuntimeFailure: (error: unknown) => void }) => {
      initializationCalls++
      runtimeFailure = options.onRuntimeFailure
      firstFrame = options.onFrameRendered
      await initializationWait
      if (initializationFailures > 0) {
        initializationFailures--
        const error = new Error('fixture initialization failure')
        error.name = initializationErrorName
        throw error
      }
      if (automaticFrame) firstFrame()
      return 'wide'
    },
    destroy: () => {
      destructionCalls++
    },
    renderHealthFrame: () => health,
    setPetPresentationVisible: (visible: boolean) => {
      petPresentationVisible = visible
    },
    getCompositionSize: () => ({ width: 400, height: 400 }),
    setInteractionHeld: (held: boolean) => {
      calls.interactionHeld.push(held)
      cadence.setInteractionHeld(held, now)
    },
    getLoadedPetAssetState: () => loadedAssetState,
    setDmeloperSkin: async (url: string, model: 'auto' | 'wide' | 'slim') => {
      skinApplications++
      await skinWait
      if (skinFailure) {
        skinFailure = false
        const error = new Error('fixture skin load failure')
        error.name = 'PetAssetLoadError'
        throw error
      }
      const resolved = model === 'slim' ? 'slim' : 'wide'
      loadedAssetState = { modelId: 'dmeloper', dmeloperSkinModel: resolved, dmeloperSkinUrl: url }
      return resolved
    },
    getPendingPetAssetState: () => undefined,
    getConservativeContentRect: () => ({ ...measuredRect }),
    setAutoViewportPadding: (pixels: number) => calls.padding.push(pixels),
    setCameraPan: (horizontal: number, vertical: number) => {
      calls.pan.push([horizontal, vertical])
    },
    setSceneRotation: () => {
      if (previewError) throw new Error('fixture preview failure')
      calls.preview += 1
    },
    setViewportCrop: () => {
      calls.crop += 1
    },
    measureVisibleContentRect: async () => {
      calls.measure += 1
      await measurementWait
      return { status: 'success', rect: { ...measuredRect } }
    },
  }, { get: (target, key: string) => target[key] ?? (() => {}) })
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/event': {
      listen: async (event: string, callback: typeof events[string]) => {
        events[event] = callback
        return () => {
          delete events[event]
        }
      },
      emitTo: async (_window: string, event: string, response: unknown) => {
        if (event === PET_RUNTIME_RESTART_REQUIRED) recoveryNotices.push(response)
        if (event === LISTEN_KEY.MOUSE_SETTING_RESPONSE) mouseResponses.push(response)
        if (event === SCENE_VIEWPORT_RESPONSE) sceneResponses.push(response as typeof sceneResponses[number])
        if (event === PRESET_APPLY_RESPONSE) presetResponses.push(response as PresetApplyResponse)
      },
    },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({ startDragging: () => dragWait, isVisible: async () => {
      const visible = visibilityReadResult ?? nativeVisible
      await visibilityReadWait
      return visible
    } }) },
    '@vueuse/core': {
      useEventListener: (_target: unknown, names: string | string[], callback: (event: Pick<MouseEvent, 'type' | 'button' | 'buttons'>) => void) => {
        if (typeof _target === 'string') return
        for (const name of typeof names === 'string' ? [names] : names) {
          (domEvents[name] ??= []).push(callback)
        }
      },
      useDebounceFn: (callback: unknown) => callback,
    },
    'vue': {
      computed: (get: () => unknown) => ({
        get value() {
          return get()
        },
      }),
      nextTick: () => nextTickWait,
      ref: vueRef,
      watch: (source: unknown, callback: (value?: boolean) => void, options?: { immediate?: boolean, flush?: 'sync' }) => {
        if (source === editorGate) editorWatch = callback
        if (Array.isArray(source)) viewportWatch = callback
        if (typeof source === 'function' && source.toString().includes('.mouseEnabled')) mouseSettingWatch = callback
        if (isRef(source)) unmounted.push(vueWatch(source, value => callback(value as boolean), options))
      },
      onMounted: () => {},
      onUnmounted: (callback: () => void) => unmounted.push(callback),
    },
    'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
    '@/stores/block': { useBlockStore: () => store },
    '@/stores/general': { useGeneralStore: () => general },
    '@/composables/useAppMenu': { useAppMenu: () => ({}) },
    '@/composables/useDevice': { useDevice: (options: { onMouseReset: () => void }) => ({
      getInputState: () => mouseState,
      acceptsInput: (event: Parameters<typeof isCurrentSemanticInput>[0]) => inputActive && isCurrentSemanticInput(event, mouseState),
      setInputActive: async (active: boolean, confirmNative = false) => {
        const request = ++inputRequestGeneration
        if (confirmNative && inputFailure) {
          inputFailure = false
          throw new Error('fixture native input failure')
        }
        if (active) {
          calls.inputResumeStarted++
          await inputResumeWait
        }
        if (request !== inputRequestGeneration) return
        inputActive = active
        if (active) calls.inputResumes.push(nativeVisible)
        if (!active) options.onMouseReset()
      },
      requestMouseSetting: async (enabled?: boolean) => {
        if (enabled !== undefined) {
          options.onMouseReset()
          await mouseSettingWait
          mouseState = { mouseEnabled: enabled, mouseGeneration: mouseState.mouseGeneration + 1 }
          store.activePet3dPreset.mouseEnabled = enabled
          mouseSettingWatch?.()
        }
        return mouseState
      },
    }), isMouseInputUnsupported: () => false },
    '@/composables/useTauriListen': {
      useTauriListen: (event: string, callback: typeof events[string]) => {
        events[event] = callback
      },
    },
    '@/composables/useWindowState': {
      setAutomaticViewportMutationGuard: () => {},
      getMainViewportSnapshot: () => snapshot,
      getMainViewportMonitorSize: async () => {
        await monitorWait
        return monitorSize
      },
      centerMainViewportGeometry: async (isCurrent?: () => boolean) => {
        calls.center += 1
        await centerWait
        if (isCurrent?.() === false) return undefined
        return snapshot
      },
      applyMainViewportGeometry: async (input: ApplyMainViewportGeometryInput) => {
        if (input.isCurrent?.() === false) return undefined
        calls.native.push(input.windowScalePercent)
        calls.nativeRects.push({ ...input.sourceRect })
        await nativeWait
        if (nativeFailuresRemaining > 0) {
          nativeFailuresRemaining--
          return undefined
        }
        if (nativeFailure || input.isCurrent?.() === false) return undefined
        const nextRect = { ...input.sourceRect }
        const physicalWidth = Math.ceil((nextRect.x + nextRect.width) * scaleFactor) - Math.floor(nextRect.x * scaleFactor)
        const physicalHeight = Math.ceil((nextRect.y + nextRect.height) * scaleFactor) - Math.floor(nextRect.y * scaleFactor)
        snapshot = {
          sourceRect: nextRect,
          realizedSourceRect: nextRect,
          outputLogicalSize: { ...nextRect, width: physicalWidth / scaleFactor, height: physicalHeight / scaleFactor },
          physicalSize: { ...nextRect, width: physicalWidth, height: physicalHeight },
        }
        return snapshot
      },
    },
    '@/plugins/window': {
      setPetCursorEvents: async () => {},
      hideWindow: () => orderVisibility(async () => {
        await hideWait
        if (visibilityFailure === 'hide') {
          visibilityFailure = undefined
          throw new Error('fixture native hide failure')
        }
        if (!ignoreVisibility) nativeVisible = false
      }),
      showWindow: () => orderVisibility(async () => {
        await showWait
        calls.shown++
        if (visibilityFailure === 'show') {
          visibilityFailure = undefined
          throw new Error('fixture native show failure')
        }
        if (!ignoreVisibility) nativeVisible = true
      }),
      setWindowMemoryActive: async () => memoryWait,
      dragMainWindow: (keepInScreen: boolean) => {
        calls.drag += 1
        calls.dragContainment.push(keepInScreen)
        return dragWait
      },
    },
    '@/features/stateSafety/bridge': { editorsLocked: editorGate },
    '@/features/stateSafety/runtime': {
      registerNativeDrain: () => {},
    },
    '@/utils/three3d': { default: renderer },
    './loadingPaint': { createLoadingPaintBarrier: () => ({ wait: async () => {}, cancel: () => {} }) },
  }
  if (options.allowInitialize) {
    mocks['@tauri-apps/api/core'] = { convertFileSrc: (path: string) => path }
    mocks['@tauri-apps/api/path'] = { resolveResource: async (path: string) => {
      await resourceWait.model
      if (resourceFailure === 'model') throw new Error('fixture resource resolution failed')
      return path
    } }
    mocks['@/services/dmeloperSkin'] = {
      getResolvedDmeloperSkinUrl: (url?: string) => url ?? 'data:image/png;base64,default',
      resolveDmeloperSkinUrl: async (url?: string) => {
        await resourceWait.skin
        if (resourceFailure === 'skin') throw new Error('fixture bundled skin read failed')
        return url ?? 'data:image/png;base64,default'
      },
    }
  }
  const context = {
    exports: {},
    require: (id: string) => mocks[id] ?? mainRequire(id),
    console,
    Error,
    window: {},
    Date: { now: () => now },
    document: {
      documentElement: { classList: { remove: () => {} } },
      createElement: () => ({ className: '', dataset: {}, remove() {} }),
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextTimer
      timers.set(id, { due: now + delay, callback })
      return id
    },
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: () => void) => {
      const id = ++nextTimer
      timers.set(id, { due: now + 16, callback, frame: true })
      return id
    },
    cancelAnimationFrame: (id: number) => timers.delete(id),
    initializeForTest: undefined as undefined | (() => Promise<boolean>),
    runtimeStateForTest: undefined as undefined | (() => { loading: boolean, error?: string, recoveryUsed: boolean, ready: boolean, recovering: boolean, pending: boolean }),
    hideForTest: undefined as undefined | (() => Promise<void>),
    resetForTest: undefined as undefined | (() => Promise<boolean>),
    hologramForTest: undefined as undefined | (() => boolean),
    dragForTest: undefined as undefined | ((event: { button: number }) => Promise<void>),
  }
  if (options.loadingPaint) {
    const paintExports = {}
    runInNewContext(ts.transpileModule(readFileSync(
      new URL('../pages/main/loadingPaint.ts', import.meta.url),
      'utf8',
    ), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { ...context, exports: paintExports })
    mocks['./loadingPaint'] = paintExports
  }
  const schedulerExports = {}
  runInNewContext(ts.transpileModule(readFileSync(
    new URL('../pages/main/contentBoundsRetry.ts', import.meta.url),
    'utf8',
  ), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { ...context, exports: schedulerExports })
  mocks['./contentBoundsRetry'] = schedulerExports
  // Start at the already-rendered state; startup/native restoration have separate tests.
  const fixture = `
    componentMounted = true;
    canvasHost.value = ${options.allowInitialize ? '{ replaceChildren: () => {} }' : 'undefined'};
    void registerInputListeners();
    rendererReady = true;
    viewportRevealPending = false;
    if (typeof presentationPending !== 'undefined') presentationPending = false;
    currentContentRect = { x: 0, y: 0, width: 200, height: 200 };
    desiredBoundsSignature = createVisibleBoundsSelectionSignature(getCurrentSelection());
    appliedBoundsSignature = desiredBoundsSignature;
    globalThis.initializeForTest = () => {
      rendererReady = false;
      viewportRevealPending = true;
      return ensureRendererInitialized();
    };
    globalThis.hideForTest = synchronizeWindowVisibility;
    globalThis.runtimeStateForTest = () => ({ loading: rendererLoading.value, error: rendererError.value, recoveryUsed, ready: rendererReady, recovering: !!runtimeRecovery, pending: !!pendingSelection });
    globalThis.resetForTest = settleAndCenterResetViewport;
    globalThis.hologramForTest = () => viewportHologramVisible.value;
    globalThis.dragForTest = handleMouseDown;
  `
  runInNewContext(ts.transpileModule(source + fixture, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  return {
    calls,
    store,
    initialize: () => context.initializeForTest!(),
    runtimeState: () => context.runtimeStateForTest!(),
    lockEditors: (locked: boolean) => {
      editorGate.value = locked
      editorWatch?.(locked)
    },
    waitForVisibilityRead: (wait: Promise<void>, result?: boolean) => {
      visibilityReadWait = wait
      visibilityReadResult = result
    },
    sync: () => context.hideForTest!(),
    waitForMemory: (wait: Promise<void>) => {
      memoryWait = wait
    },
    waitForTick: (wait: Promise<void>) => {
      nextTickWait = wait
    },
    waitForShow: (wait: Promise<void>) => {
      showWait = wait
    },
    waitForHide: (wait: Promise<void>) => {
      hideWait = wait
    },
    waitForCenter: (wait: Promise<void>) => {
      centerWait = wait
    },
    waitForInputResume: (wait: Promise<void>) => {
      inputResumeWait = wait
    },
    pauseHiddenFrames: () => {
      pauseFramesWhenHidden = true
    },
    waitForInitialization: (wait: Promise<void>) => {
      initializationWait = wait
    },
    failInitializations: (count: number, name = 'Error') => {
      initializationFailures = count
      initializationErrorName = name
    },
    setHealth: (healthy: boolean) => {
      health = healthy
    },
    holdFirstFrame: () => {
      automaticFrame = false
    },
    completeFirstFrame: () => firstFrame?.(),
    failRuntime: () => runtimeFailure?.(new Error('fixture unexpected frame failure')),
    captureRuntimeFailure: () => runtimeFailure,
    failResource: (resource: 'skin' | 'model') => {
      resourceFailure = resource
    },
    waitForResource: (resource: 'skin' | 'model', wait: Promise<void>) => {
      resourceWait[resource] = wait
    },
    skinApplications: () => skinApplications,
    waitForSkin: (wait: Promise<void>) => {
      skinWait = wait
    },
    failSkin: () => {
      skinFailure = true
    },
    initializationCalls: () => initializationCalls,
    destructionCalls: () => destructionCalls,
    recoveryNotices,
    nativeVisible: () => nativeVisible,
    inputActive: () => inputActive,
    async setBroadcast(enabled: boolean, showOnDesktop: boolean) {
      Object.assign(general.broadcast, { enabled, showOnDesktop })
      await context.hideForTest!()
    },
    sceneResponses,
    presetResponses,
    capturePreset: () => capturePresetSnapshot(store as unknown as BlockStore),
    applyPreset: (snapshot: PresetSnapshot, requestId = 'preset-test', restoreVisibility?: boolean) => events[PRESET_APPLY_REQUEST]({ payload: { requestId, snapshot, restoreVisibility } }),
    cancelPreset: (requestId = 'preset-test') => events[PRESET_APPLY_CANCEL]({ payload: { requestId } }),
    failVisibility: (operation: typeof visibilityFailure) => {
      visibilityFailure = operation
    },
    ignoreVisibility: (ignore = true) => {
      ignoreVisibility = ignore
    },
    failInput: () => {
      inputFailure = true
    },
    failNativeOnce: () => {
      nativeFailuresRemaining = 1
    },
    snapshot: () => snapshot,
    petPresentationVisible: () => petPresentationVisible,
    scenePresentation() {
      const root = Reflect.apply(renderMainPage, undefined, [{
        blockStore: store,
        viewportHologramVisible: context.hologramForTest!(),
        rendererError: context.runtimeStateForTest!().error,
        rendererLoading: context.runtimeStateForTest!().loading,
        handleMouseDown: context.dragForTest,
        handleContextmenu: () => {},
        t: (key: string) => key,
      }, []]) as VNode
      const children = root.children as VNode[]
      const scene = children[0]
      return {
        sceneVisible: !scene.dirs?.some(directive => directive.value === false),
        loadingVisible: children.some(child => child.props?.role === 'status'),
        opacity: (scene.props?.style as { opacity: number }).opacity,
        mirrored: String(scene.props?.class).includes('-scale-x-100'),
      }
    },
    hologram: () => context.hologramForTest!(),
    frameLimit: () => cadence.getFrameLimit(now, 60),
    hologramClass() {
      const root = Reflect.apply(renderMainPage, undefined, [{
        blockStore: store,
        viewportHologramVisible: context.hologramForTest!(),
        rendererError: undefined,
        rendererLoading: false,
        handleMouseDown: context.dragForTest,
        handleContextmenu: () => {},
      }, []]) as VNode
      return ((root.children as VNode[])[0].children as VNode[]).find(child => String(child.props?.class ?? '').split(/\s+/).includes('viewport-hologram'))?.props?.class as string
    },
    drag: () => context.dragForTest!({ button: 0 }),
    waitForDrag: (wait: Promise<void>) => {
      dragWait = wait
    },
    nativeButton: (active: boolean, mouseGeneration = mouseState.mouseGeneration) => events[LISTEN_KEY.SEMANTIC_INPUT]({ payload: { kind: 'mouse_primary', active, mouseGeneration } }),
    mouseResponses,
    setMouse(enabled: boolean) {
      events[LISTEN_KEY.MOUSE_SETTING_REQUEST]({ payload: { requestId: 'mouse-test', enabled } })
    },
    waitForMouse: (wait: Promise<void>) => {
      mouseSettingWait = wait
    },
    dom: (name: string, buttons = 0) => domEvents[name]?.forEach(callback => callback({ type: name, buttons, button: 0 })),
    failPreview: () => {
      previewError = true
    },
    mirror: () => {
      store.model.mirror = !store.model.mirror
      viewportWatch?.()
    },
    changePreset(patch: Partial<Pet3dPresetSelectionPayload['preset']>) {
      Object.assign(store.activePet3dPreset, patch)
      events[LISTEN_KEY.PET_PRESET_CHANGED]({ payload: {
        modelId: 'dmeloper',
        useDefaultDmeloperSkin: store.customization3d.useDefaultDmeloperSkin,
        dmeloperSkinDataUrl: store.customization3d.useDefaultDmeloperSkin ? undefined : store.customization3d.dmeloperSkinDataUrl,
        dmeloperSkinModel: 'wide',
        preset: { ...store.activePet3dPreset },
      } })
    },
    hold: (buttons: number) => events[LISTEN_KEY.VIEWPORT_INTERACTION_CHANGED]({ payload: { buttons } }),
    selection(rotation: number) {
      store.activePet3dPreset.petRotationDegrees = rotation
      const selection: Pet3dPresetSelectionPayload = {
        modelId: 'dmeloper',
        useDefaultDmeloperSkin: store.customization3d.useDefaultDmeloperSkin,
        dmeloperSkinDataUrl: store.customization3d.useDefaultDmeloperSkin ? undefined : store.customization3d.dmeloperSkinDataUrl,
        dmeloperSkinModel: 'wide',
        preset: { ...store.activePet3dPreset, petRotationDegrees: rotation },
      }
      events[LISTEN_KEY.PET_PRESET_CHANGED]({ payload: selection })
    },
    waitForMeasurement: (wait: Promise<void>) => {
      measurementWait = wait
    },
    skinChange: (request: PetSkinChangeRequest) => events[PET_SKIN_CHANGE]({ payload: request }),
    changeSkin(url: string) {
      store.customization3d.useDefaultDmeloperSkin = false
      store.customization3d.dmeloperSkinDataUrl = url
      events[LISTEN_KEY.PET_PRESET_CHANGED]({ payload: {
        modelId: 'dmeloper',
        useDefaultDmeloperSkin: false,
        dmeloperSkinDataUrl: url,
        dmeloperSkinModel: 'wide',
        preset: { ...store.activePet3dPreset },
      } })
    },
    measured: (value: typeof rect) => {
      measuredRect = { ...value }
    },
    waitForNative: (wait: Promise<void>) => {
      nativeWait = wait
    },
    failNative: (failed = true) => {
      nativeFailure = failed
    },
    monitor: (value: typeof monitorSize) => {
      monitorSize = value
    },
    scale: (value: number) => {
      scaleFactor = value
    },
    waitForMonitor: (wait: Promise<void>) => {
      monitorWait = wait
    },
    requestMode: (automatic?: boolean, requestId = 'scene-test') =>
      events[SCENE_VIEWPORT_REQUEST]({ payload: { requestId, automatic } }),
    packet: (preset: Pet3dPresetSelectionPayload['preset']) =>
      events[LISTEN_KEY.PET_PRESET_CHANGED]({ payload: {
        modelId: 'dmeloper',
        useDefaultDmeloperSkin: true,
        dmeloperSkinModel: 'wide',
        preset,
      } }),
    async advance(milliseconds: number) {
      now += milliseconds
      for (const [id, timer] of timers) {
        if (timer.due > now) continue
        if (timer.frame && pauseFramesWhenHidden && !nativeVisible) continue
        timers.delete(id)
        timer.callback()
      }
      await flushMicrotasks()
    },
    unmount: () => unmounted.forEach(callback => callback()),
    resetWhileHidden() {
      store.window.visible = false
      return context.resetForTest!()
    },
    reset: () => context.resetForTest!(),
    async hide() {
      store.window.visible = false
      await context.hideForTest?.()
    },
  }
}

async function settlePresetResponse(harness: ReturnType<typeof createMainPageHarness>, count = 1) {
  await flushMicrotasks()
  for (let attempt = 0; attempt < 20 && harness.presetResponses.length < count; attempt++) {
    await harness.advance(120)
  }
  assert.equal(harness.presetResponses.length, count, 'managed application must finish or report failure')
  return harness.presetResponses[count - 1]
}

describe('managed preset native acknowledgements', () => {
  it('keeps the desktop and its input hidden through preset loads while broadcasting', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.setBroadcast(true, false)
      const shown = h.calls.shown
      for (const basicVisible of [true, false]) {
        h.store.window.visible = basicVisible
        const snapshot = h.capturePreset()
        snapshot.opacity = 42
        h.applyPreset(snapshot, `broadcast-${basicVisible}`)
        const response = await settlePresetResponse(h, basicVisible ? 1 : 2)
        assert.equal(response.success, true)
        assert.equal(h.store.window.visible, true, 'preset loads retain the basic show behavior')
        assert.equal(h.nativeVisible(), false)
        assert.equal(h.inputActive(), false)
        assert.equal(h.calls.shown, shown, 'a preset must not briefly reveal the desktop pet')
      }
      await h.setBroadcast(false, false)
      assert.equal(h.nativeVisible(), true, 'broadcast hiding has no effect with output disabled')
      assert.equal(h.inputActive(), true)
    } finally {
      h.unmount()
    }
  })

  for (const stage of ['measurement', 'native viewport'] as const) {
    it(`waits for initializing scene ${stage} before acknowledging a preset`, async () => {
      const h = createMainPageHarness({ allowInitialize: true })
      const delayed = deferred()
      if (stage === 'measurement') h.waitForMeasurement(delayed.promise)
      else h.waitForNative(delayed.promise)
      const initializing = h.initialize()
      try {
        await flushMicrotasks()
        assert.equal(h.calls.measure, 1)
        if (stage === 'native viewport') assert.equal(h.calls.native.length, 1)
        const requested = h.capturePreset()
        requested.opacity = 42
        requested.preset.cameraZoomPercent = 125
        h.applyPreset(requested)
        await flushMicrotasks()
        await h.advance(1000)
        assert.deepEqual(h.presetResponses, [], 'renderer creation is not completed scene initialization')
        delayed.resolve()
        assert.equal(await initializing, true)
        const response = await settlePresetResponse(h)
        assert.equal(response.success, true)
        assert.equal(h.store.window.opacity, 42)
        assert.equal(response.snapshot?.preset.cameraZoomPercent, 125)
      } finally {
        delayed.resolve()
        h.unmount()
      }
    })
  }

  for (const operation of ['show', 'hide'] as const) {
    it(`rejects a native ${operation} failure and restores the previous preset`, async () => {
      const h = createMainPageHarness({ allowInitialize: true })
      const snapshot = h.capturePreset()
      snapshot.opacity = 42
      h.failVisibility(operation)
      h.applyPreset(snapshot, 'preset-test', operation === 'hide' ? false : undefined)
      const response = await settlePresetResponse(h)
      assert.equal(response.success, false)
      assert.equal(response.restored, true)
      assert.equal(h.store.window.visible, true)
      assert.equal(h.store.window.opacity, 100)
      h.unmount()
    })
  }

  it('requires actual native visibility after a resolved hide command', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    const snapshot = h.capturePreset()
    h.ignoreVisibility()
    h.applyPreset(snapshot, 'preset-test', false)
    const response = await settlePresetResponse(h)
    assert.equal(response.success, false)
    assert.equal(response.restored, true)
    h.unmount()
  })

  it('shows a hidden pet when loading a preset without saved visibility', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.hide()
      const snapshot = h.capturePreset()
      assert.equal('visible' in snapshot, false)
      h.applyPreset(snapshot)
      const response = await settlePresetResponse(h)
      assert.equal(response.success, true)
      assert.equal(h.store.window.visible, true)
      assert.equal('visible' in response.snapshot!, false)
    } finally {
      h.unmount()
    }
  })

  it('retains the surrounding canvas and saved styling while a preset waits for its skin', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    const skin = deferred()
    try {
      const snapshot = h.capturePreset()
      snapshot.appearance.dmeloperSkinDataUrl = 'data:image/png;base64,preset-loading'
      snapshot.opacity = 42
      snapshot.mirror = true
      h.waitForSkin(skin.promise)
      h.applyPreset(snapshot)
      await h.advance(1000)
      assert.equal(h.runtimeState().loading, true)
      assert.equal(h.petPresentationVisible(), false)
      assert.deepEqual(h.scenePresentation(), { sceneVisible: true, loadingVisible: true, opacity: 0.42, mirrored: true })
      skin.resolve()
      assert.equal((await settlePresetResponse(h)).success, true)
      assert.equal(h.petPresentationVisible(), true)
      assert.equal(h.scenePresentation().loadingVisible, false)
    } finally {
      skin.resolve()
      h.unmount()
    }
  })

  it('restores a previously hidden pet when showing the requested preset fails', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.hide()
      const snapshot = h.capturePreset()
      snapshot.opacity = 42
      h.failVisibility('show')
      h.applyPreset(snapshot)
      const response = await settlePresetResponse(h)
      assert.equal(response.success, false)
      assert.equal(response.restored, true)
      assert.equal(h.store.window.visible, false)
      assert.equal(h.store.window.opacity, 100)
    } finally {
      h.unmount()
    }
  })

  it('rejects a strict input resume failure after otherwise successful scene application', async () => {
    const h = createMainPageHarness()
    const snapshot = h.capturePreset()
    snapshot.opacity = 42
    h.failInput()
    h.applyPreset(snapshot)
    const response = await settlePresetResponse(h)
    assert.equal(response.success, false)
    assert.equal(response.restored, true)
    h.unmount()
  })

  it('does not acknowledge a mirror change whose native geometry failed', async () => {
    const h = createMainPageHarness()
    const snapshot = h.capturePreset()
    snapshot.mirror = true
    h.failNativeOnce()
    h.applyPreset(snapshot)
    const response = await settlePresetResponse(h)
    assert.equal(response.success, false)
    assert.equal(response.restored, true)
    assert.equal(h.store.model.mirror, false)
    h.unmount()
  })

  it('bounds live viewport failure and finishes the request instead of infinitely rescheduling', async () => {
    const h = createMainPageHarness()
    const snapshot = h.capturePreset()
    snapshot.preset.autoViewportPaddingPixels = 8
    h.failNative()
    h.applyPreset(snapshot)
    const response = await settlePresetResponse(h)
    assert.equal(response.success, false)
    assert.equal(response.restored, false)
    assert.ok(h.calls.native.length <= 6)
    const nativeCalls = h.calls.native.length
    await h.advance(1000)
    assert.equal(h.calls.native.length, nativeCalls)
    h.unmount()
  })

  it('cancels native readback, restores the old viewport, and accepts the next preset request', async () => {
    const h = createMainPageHarness()
    const previous = h.capturePreset()
    const next = h.capturePreset()
    next.preset.autoViewportPaddingPixels = 8
    const native = deferred()
    h.waitForNative(native.promise)
    h.applyPreset(next)
    await flushMicrotasks()
    await h.advance(16)
    assert.equal(h.calls.native.length, 1)
    h.cancelPreset()
    native.resolve()
    const cancelled = await settlePresetResponse(h)
    assert.equal(cancelled.success, false)
    assert.equal(cancelled.restored, true)
    assert.equal(h.store.activePet3dPreset.autoViewportPaddingPixels, previous.preset.autoViewportPaddingPixels)
    const replacement = h.capturePreset()
    replacement.opacity = 42
    h.applyPreset(replacement, 'replacement')
    const accepted = await settlePresetResponse(h, 2)
    assert.equal(accepted.success, true)
    assert.equal(accepted.requestId, 'replacement')
    assert.equal(h.store.window.opacity, 42)
    h.unmount()
  })
})

describe('scene viewport initialization acknowledgement', () => {
  for (const resource of ['skin', 'model'] as const) {
    for (const automatic of [undefined, false]) {
      it(`keeps the shared initialization pending when a preset arrives during ${resource} resolution (${automatic === undefined ? 'query' : 'manual'})`, async () => {
        const h = createMainPageHarness({ allowInitialize: true })
        const resolving = deferred()
        const creating = deferred()
        h.waitForResource(resource, resolving.promise)
        h.waitForInitialization(creating.promise)
        const initializing = h.initialize()
        try {
          await flushMicrotasks()
          h.requestMode(automatic)
          if (automatic === undefined) h.packet({ ...h.store.activePet3dPreset })
          else h.selection(10)
          resolving.resolve()
          await flushMicrotasks()
          assert.equal(h.sceneResponses.length, 0, 'superseded preparation is pending work, not native failure')
          creating.resolve()
          assert.equal(await initializing, true)
          for (let attempt = 0; attempt < 20 && !h.sceneResponses.length; attempt++) await h.advance(120)
          assert.equal(h.sceneResponses.length, 1)
          assert.equal(h.sceneResponses[0].success, true)
          assert.equal(h.sceneResponses[0].state.automatic, automatic ?? true)
          assert.equal(h.runtimeState().error, undefined)
        } finally {
          resolving.resolve()
          creating.resolve()
          h.unmount()
        }
      })
    }

    it(`cancels resource preparation when hidden during ${resource} resolution`, async () => {
      const h = createMainPageHarness({ allowInitialize: true })
      const resolving = deferred()
      h.waitForResource(resource, resolving.promise)
      const initializing = h.initialize()
      try {
        await flushMicrotasks()
        h.packet({ ...h.store.activePet3dPreset })
        await h.hide()
        resolving.resolve()
        assert.equal(await initializing, false)
        await h.advance(1000)
        assert.equal(h.initializationCalls(), 0)
        assert.equal(h.nativeVisible(), false)
        assert.equal(h.runtimeState().error, undefined)
      } finally {
        resolving.resolve()
        h.unmount()
      }
    })
  }

  it('reports an actual initialization failure instead of treating queue idleness as success', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      h.failPreview()
      const initializing = h.initialize()
      h.requestMode()
      assert.equal(await initializing, false)
      for (let attempt = 0; attempt < 20 && !h.sceneResponses.length; attempt++) await h.advance(120)
      assert.equal(h.sceneResponses.length, 1)
      assert.equal(h.sceneResponses[0].success, false)
    } finally {
      h.unmount()
    }
  })

  it('drops an initializing query after its component is unmounted', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    const delayed = deferred()
    h.waitForMeasurement(delayed.promise)
    const initializing = h.initialize()
    await flushMicrotasks()
    h.requestMode()
    await flushMicrotasks()
    h.unmount()
    delayed.resolve()
    assert.equal(await initializing, false)
    await flushMicrotasks()
    assert.deepEqual(h.sceneResponses, [])
  })

  for (const stage of ['measurement', 'native viewport'] as const) {
    for (const automatic of [undefined, false]) {
      it(`waits for initial ${stage} before a ${automatic === undefined ? 'query' : 'mode change'} response`, async () => {
        const h = createMainPageHarness({ allowInitialize: true })
        const delayed = deferred()
        if (stage === 'measurement') h.waitForMeasurement(delayed.promise)
        else h.waitForNative(delayed.promise)
        const initializing = h.initialize()
        try {
          await flushMicrotasks()
          assert.equal(h.calls.measure, 1)
          h.requestMode(automatic)
          await flushMicrotasks()
          assert.equal(h.sceneResponses.length, 0, 'an in-progress initial viewport must not be reported as failure')
          delayed.resolve()
          assert.equal(await initializing, true)
          for (let attempt = 0; attempt < 20 && !h.sceneResponses.length; attempt++) {
            await h.advance(120)
          }
          assert.equal(h.sceneResponses.length, 1)
          assert.equal(h.sceneResponses[0].success, true)
          assert.equal(h.sceneResponses[0].state.automatic, automatic ?? true)
        } finally {
          delayed.resolve()
          h.unmount()
        }
      })
    }
  }
})

describe('manual viewport query precision', () => {
  it('preserves the exact center when preference focus refreshes a snapped native rectangle', async () => {
    const h = createMainPageHarness({ automatic: false })
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        for (const size of [201, 200]) {
          const current = h.store.activePet3dPreset.manualViewportRect
          h.changePreset({ manualViewportRect: {
            x: current.x + (current.width - size) / 2,
            y: current.y + (current.height - size) / 2,
            width: size,
            height: size,
          } })
          await h.advance(16)
          const native = h.snapshot().sourceRect
          assert.equal(native.x, Math.round(h.store.activePet3dPreset.manualViewportRect.x))
          assert.equal(native.y, Math.round(h.store.activePet3dPreset.manualViewportRect.y))
          h.requestMode(undefined, `focus-${cycle}-${size}`)
          await flushMicrotasks()
          const response = h.sceneResponses.at(-1)!
          assert.equal(response.success, true)
          // useSceneViewport adopts every successful manual query on focus.
          h.store.activePet3dPreset.manualViewportRect = { ...response.state.rect }
          const saved = h.store.activePet3dPreset.manualViewportRect
          assert.equal(saved.x + saved.width / 2, 100, 'native pixel snapping must not change the saved horizontal center')
          assert.equal(saved.y + saved.height / 2, 100, 'native pixel snapping must not change the saved vertical center')
        }
      }
    } finally {
      h.unmount()
    }
  })

  it('keeps integer manual dimensions across DPI rounding while still reporting monitor clamps', async () => {
    const h = createMainPageHarness({ automatic: false })
    try {
      h.scale(1.25)
      h.changePreset({ manualViewportRect: { x: -0.5, y: -0.5, width: 201, height: 201 } })
      await h.advance(16)
      assert.equal(h.snapshot().physicalSize.width, 252)
      assert.equal(h.snapshot().outputLogicalSize.width, 201.6)
      h.requestMode()
      await flushMicrotasks()
      assert.deepEqual({ ...h.sceneResponses.at(-1)!.state.rect }, { x: -0.5, y: -0.5, width: 201, height: 201 })
      h.monitor({ width: 150, height: 150 })
      h.selection(10)
      await h.advance(16)
      h.requestMode(undefined, 'after-monitor-change')
      await flushMicrotasks()
      const response = h.sceneResponses.at(-1)!
      assert.equal(response.success, true)
      assert.deepEqual({ ...response.state.rect }, { x: 25, y: 25, width: 150, height: 150 })
      assert.equal(h.snapshot().physicalSize.width, 188)
      assert.equal(h.store.activePet3dPreset.manualViewportRect.width, 150)
    } finally {
      h.unmount()
    }
  })

  it('reports the acknowledged native rectangle when a requested manual resize failed', async () => {
    const h = createMainPageHarness({ automatic: false })
    try {
      h.failNative()
      h.changePreset({ manualViewportRect: { x: -0.5, y: -0.5, width: 201, height: 201 } })
      await h.advance(16)
      await h.advance(100)
      h.requestMode()
      await flushMicrotasks()
      assert.equal(h.store.activePet3dPreset.manualViewportRect.width, 201)
      assert.equal(h.snapshot().physicalSize.width, 200)
      assert.deepEqual({ ...h.sceneResponses.at(-1)!.state.rect }, { x: 0, y: 0, width: 200, height: 200 })
    } finally {
      h.unmount()
    }
  })
})

describe('main page interaction wiring', () => {
  it('resizes automatic padding on a frame while held without measuring or changing manual geometry', async () => {
    const automatic = createMainPageHarness()
    automatic.hold(1)
    automatic.changePreset({ autoViewportPaddingPixels: 12 })
    await flushMicrotasks()
    automatic.changePreset({ autoViewportPaddingPixels: 8 })
    await automatic.advance(15)
    assert.deepEqual(automatic.calls.native, [])
    await automatic.advance(1)
    assert.equal(automatic.calls.padding.at(-1), 8)
    assert.deepEqual(automatic.snapshot().sourceRect, { x: 8, y: 8, width: 184, height: 184 })
    assert.equal(automatic.hologram(), true)
    assert.equal(automatic.calls.measure, 0)
    automatic.hold(0)
    await automatic.advance(100)
    assert.equal(automatic.calls.measure, 0)
    assert.deepEqual(automatic.calls.native, [100])
    assert.equal(automatic.hologram(), false)

    const manual = createMainPageHarness({ automatic: false })
    manual.changePreset({ autoViewportPaddingPixels: 8 })
    await manual.advance(1000)
    assert.equal(manual.calls.padding.at(-1), 8)
    assert.equal(manual.calls.measure, 0)
    assert.deepEqual(manual.calls.native, [])
  })

  it('finishes intermediate padding readback then applies only the latest value without drift', async () => {
    const h = createMainPageHarness()
    const native = deferred()
    h.waitForNative(native.promise)
    h.hold(1)
    h.changePreset({ autoViewportPaddingPixels: 8 })
    await h.advance(16)
    assert.equal(h.hologram(), false)
    h.changePreset({ autoViewportPaddingPixels: 4 })
    h.changePreset({ autoViewportPaddingPixels: 0 })
    await h.advance(16)
    assert.deepEqual(h.calls.nativeRects.map(rect => rect.width), [184])
    native.resolve()
    await flushMicrotasks()
    assert.deepEqual(h.calls.nativeRects.map(rect => rect.width), [184, 168])
    assert.deepEqual(h.snapshot().sourceRect, { x: 16, y: 16, width: 168, height: 168 })
    assert.equal(h.hologram(), true)
    h.changePreset({ autoViewportPaddingPixels: 16 })
    await h.advance(16)
    assert.deepEqual(h.snapshot().sourceRect, { x: 0, y: 0, width: 200, height: 200 })
    assert.equal(h.calls.measure, 0)
    h.hold(0)
  })

  it('invalidates a live padding resize when zoom changes and measures the new composition after release', async () => {
    const h = createMainPageHarness()
    const native = deferred()
    h.waitForNative(native.promise)
    h.hold(1)
    h.changePreset({ autoViewportPaddingPixels: 8 })
    await h.advance(16)
    h.changePreset({ cameraZoomPercent: 150, autoViewportPaddingPixels: 4 })
    native.resolve()
    await flushMicrotasks()
    await h.advance(16)
    assert.equal(h.calls.crop, 0)
    assert.equal(h.calls.measure, 0)
    h.measured({ x: -100, y: -50, width: 500, height: 300 })
    h.hold(0)
    await h.advance(100)
    assert.equal(h.calls.measure, 1)
    assert.deepEqual(h.snapshot().sourceRect, { x: -100, y: -50, width: 500, height: 300 })
  })

  it('recovers failed live padding with a fresh automatic fit instead of accepting the old crop', async () => {
    const h = createMainPageHarness()
    h.failNative()
    h.hold(1)
    h.changePreset({ autoViewportPaddingPixels: 8 })
    await h.advance(16)
    assert.equal(h.calls.crop, 0)
    h.failNative(false)
    h.measured({ x: 8, y: 8, width: 184, height: 184 })
    h.hold(0)
    await h.advance(100)
    assert.equal(h.calls.measure, 1)
    assert.deepEqual(h.snapshot().sourceRect, { x: 8, y: 8, width: 184, height: 184 })
  })

  for (const action of ['hide', 'unmount'] as const) {
    it(`discards live padding readback after ${action}`, async () => {
      const h = createMainPageHarness()
      const native = deferred()
      h.waitForNative(native.promise)
      h.hold(1)
      h.changePreset({ autoViewportPaddingPixels: 8 })
      await h.advance(16)
      await h[action]()
      native.resolve()
      await flushMicrotasks()
      assert.equal(h.calls.crop, 0)
      assert.equal(h.hologram(), false)
    })
  }

  it('keeps the rendered persistent hologram through drag completion and resumes transient visibility when disabled', async () => {
    const h = createMainPageHarness()
    const visible = /viewport-hologram-visible/
    assert.doesNotMatch(h.hologramClass(), visible)
    h.changePreset({ showDisplayArea: true })
    h.dom('blur')
    assert.match(h.hologramClass(), visible)
    const nativeDrag = deferred()
    h.waitForDrag(nativeDrag.promise)
    h.dom('mousedown', 1)
    const drag = h.drag()
    await flushMicrotasks()
    await h.advance(16)
    await h.advance(16)
    h.changePreset({ showDisplayArea: false })
    assert.match(h.hologramClass(), visible)
    h.changePreset({ showDisplayArea: true })
    nativeDrag.resolve()
    await drag
    assert.equal(h.hologram(), false)
    h.dom('pointermove', 0)
    assert.match(h.hologramClass(), visible)
    h.changePreset({ showDisplayArea: false })
    assert.doesNotMatch(h.hologramClass(), visible)
    assert.equal(h.calls.measure, 0)
    assert.deepEqual(h.calls.native, [])
  })

  it('keeps the pet drag hologram through capture handoff but hides on physical release before native completion', async () => {
    const h = createMainPageHarness()
    const nativeDrag = deferred()
    h.waitForDrag(nativeDrag.promise)
    h.nativeButton(true)
    h.dom('mousedown', 1)
    const drag = h.drag()
    await flushMicrotasks()
    await h.advance(16)
    assert.equal(h.calls.drag, 0)
    await h.advance(16)
    assert.equal(h.calls.drag, 1)
    assert.equal(h.hologram(), true)
    h.dom('blur')
    assert.equal(h.hologram(), true)
    h.dom('pointercancel')
    h.dom('pointermove', 0)
    h.nativeButton(false)
    assert.equal(h.hologram(), false)
    assert.equal(h.calls.drag, 1)
    await h.drag()
    assert.equal(h.calls.drag, 1)
    nativeDrag.resolve()
    await drag
    assert.equal(h.hologram(), false)
    assert.deepEqual(h.calls.native, [])
  })

  for (const release of ['pointerup', 'mouseup', 'native'] as const) {
    it(`cancels a pet press released by ${release} before its overlay paint completes`, async () => {
      const h = createMainPageHarness({ mouseEnabled: release === 'native' })
      if (release === 'native') h.nativeButton(true)
      h.dom('mousedown', 1)
      const drag = h.drag()
      await flushMicrotasks()
      await h.advance(16)
      if (release === 'native') h.nativeButton(false)
      else h.dom(release)
      assert.equal(h.hologram(), false)
      await h.advance(16)
      await drag
      assert.equal(h.calls.drag, 0)
      assert.deepEqual(h.calls.native, [])
    })
  }

  it('accepts a new press after a quick release without the retired paint wait clearing its overlay', async () => {
    const h = createMainPageHarness({ mouseEnabled: false })
    const nativeDrag = deferred()
    h.waitForDrag(nativeDrag.promise)
    h.dom('mousedown', 1)
    const retiredDrag = h.drag()
    await flushMicrotasks()
    await h.advance(16)
    h.dom('pointerup')
    h.dom('mousedown', 1)
    const currentDrag = h.drag()
    await flushMicrotasks()
    await h.advance(16)
    await retiredDrag
    assert.equal(h.hologram(), true)
    assert.equal(h.calls.drag, 0)
    await h.advance(16)
    assert.equal(h.calls.drag, 1)
    assert.equal(h.hologram(), true)
    nativeDrag.resolve()
    await currentDrag
    assert.equal(h.hologram(), false)
  })

  for (const release of ['pointerup', 'mouseup'] as const) {
    it(`hides the pet drag overlay on explicit ${release} before delayed native completion`, async () => {
      const h = createMainPageHarness({ mouseEnabled: false })
      const nativeDrag = deferred()
      h.waitForDrag(nativeDrag.promise)
      h.dom('mousedown', 1)
      const drag = h.drag()
      await flushMicrotasks()
      await h.advance(16)
      await h.advance(16)
      assert.equal(h.hologram(), true)
      h.dom(release)
      assert.equal(h.hologram(), false)
      assert.equal(h.calls.interactionHeld.at(-1), false)
      await h.drag()
      assert.equal(h.calls.drag, 1)
      h.selection(110)
      await h.advance(1000)
      assert.equal(h.calls.measure, 0)
      assert.deepEqual(h.calls.native, [])
      await h.advance(4000)
      assert.equal(h.frameLimit(), 15, 'released input must permit idle cadence before the delayed native reply')
      nativeDrag.resolve()
      await drag
      await h.advance(100)
      assert.equal(h.hologram(), false)
      assert.equal(h.calls.measure, 1)
      assert.deepEqual(h.calls.native, [100])
    })
  }

  for (const keepInScreen of [true, false]) {
    it(`passes keep-in-screen ${keepInScreen} to the native drag`, async () => {
      const h = createMainPageHarness()
      h.store.window.keepInScreen = keepInScreen
      h.dom('mousedown', 1)
      const drag = h.drag()
      await flushMicrotasks()
      await h.advance(16)
      await h.advance(16)
      await drag
      assert.deepEqual(h.calls.dragContainment, [keepInScreen])
    })
  }

  it('restores the native drag bounds guard after a managed preset while the release reply is pending', async () => {
    const h = createMainPageHarness({ mouseEnabled: false })
    const nativeDrag = deferred()
    h.waitForDrag(nativeDrag.promise)
    h.dom('mousedown', 1)
    const drag = h.drag()
    await flushMicrotasks()
    await h.advance(16)
    await h.advance(16)
    h.dom('pointerup')
    h.applyPreset(h.capturePreset())
    assert.equal((await settlePresetResponse(h)).success, true)
    const beforeMeasure = h.calls.measure
    const beforeNative = h.calls.native.length
    h.selection(110)
    await h.advance(1000)
    assert.equal(h.calls.measure, beforeMeasure)
    assert.equal(h.calls.native.length, beforeNative)
    nativeDrag.resolve()
    await drag
    await h.advance(100)
    assert.equal(h.calls.measure, beforeMeasure + 1)
    assert.equal(h.calls.native.length, beforeNative + 1)
  })

  it('finishes a pet drag with mouse input off and no DOM mouseup', async () => {
    const h = createMainPageHarness({ mouseEnabled: false })
    const nativeDrag = deferred()
    h.waitForDrag(nativeDrag.promise)
    h.dom('mousedown', 1)
    const drag = h.drag()
    await flushMicrotasks()
    await h.advance(16)
    await h.advance(16)
    h.dom('blur')
    h.dom('pointercancel')
    h.dom('pointermove', 0)
    assert.equal(h.hologram(), true)
    nativeDrag.resolve()
    await drag
    assert.equal(h.hologram(), false)
    h.selection(110)
    await h.advance(100)
    assert.deepEqual(h.calls.native, [100])
  })

  for (const action of ['hide', 'unmount'] as const) {
    it(`clears the pet drag hologram on ${action} without reviving it on late completion`, async () => {
      const h = createMainPageHarness()
      const nativeDrag = deferred()
      h.waitForDrag(nativeDrag.promise)
      h.dom('mousedown', 1)
      const drag = h.drag()
      await flushMicrotasks()
      await h.advance(16)
      await h.advance(16)
      assert.equal(h.hologram(), true)
      await h[action]()
      assert.equal(h.hologram(), false)
      nativeDrag.resolve()
      await drag
      assert.equal(h.hologram(), false)
    })
  }

  it('clears the pet drag hologram if the native drag request fails', async () => {
    const h = createMainPageHarness()
    const nativeDrag = deferred()
    h.waitForDrag(nativeDrag.promise.then(() => {
      throw new Error('fixture drag failure')
    }))
    h.dom('mousedown', 1)
    const drag = h.drag()
    await flushMicrotasks()
    await h.advance(16)
    await h.advance(16)
    assert.equal(h.hologram(), true)
    nativeDrag.resolve()
    await drag
    assert.equal(h.hologram(), false)
  })

  it('preserves an explicit reset while the pet is hidden and a button is held', async () => {
    const h = createMainPageHarness()
    h.hold(1)
    const reset = h.resetWhileHidden()
    await flushMicrotasks()
    await h.advance(100)
    assert.equal(await reset, true)
    assert.equal(h.calls.center, 1)
    assert.equal(h.calls.measure, 1)
  })

  it('previews automatic scene edits during hold and fits once after the full release delay', async () => {
    const h = createMainPageHarness()
    h.hold(1)
    h.selection(110)
    await flushMicrotasks()
    h.selection(130)
    await h.advance(1000)
    assert.ok(h.calls.preview > 0)
    assert.equal(h.hologram(), false)
    assert.equal(h.calls.measure, 0)
    assert.deepEqual(h.calls.native, [])
    h.hold(0)
    await h.advance(99)
    assert.deepEqual(h.calls.native, [])
    await h.advance(1)
    assert.deepEqual(h.calls.native, [100])
    assert.equal(h.calls.measure, 1)
    assert.equal(h.hologram(), false)
  })

  it('debounces keyboard edits and post-mouseup changes with the window scale fixed at 100', async () => {
    const h = createMainPageHarness()
    h.hold(1)
    h.hold(0)
    h.selection(110)
    await h.advance(80)
    h.selection(120)
    await h.advance(40)
    h.selection(130)
    await h.advance(99)
    assert.deepEqual(h.calls.native, [])
    assert.equal(h.hologram(), false)
    await h.advance(1)
    assert.deepEqual(h.calls.native, [100])
    assert.equal(h.calls.measure, 1)
  })

  it('does not resize for the retired window scale or unrelated appearance fields', async () => {
    const h = createMainPageHarness()
    h.hold(1)
    h.changePreset({ windowScalePercent: 70, dmeloperPalmColor: '#abcdef' })
    await h.advance(1000)
    h.hold(0)
    await h.advance(100)
    assert.equal(h.hologram(), false)
    assert.equal(h.calls.measure, 0)
    assert.deepEqual(h.calls.native, [])
  })

  it('invalidates an automatic measurement immediately when hidden', async () => {
    const h = createMainPageHarness()
    const measurement = deferred()
    h.waitForMeasurement(measurement.promise)
    h.selection(120)
    await h.advance(100)
    await h.hide()
    measurement.resolve()
    await h.advance(1000)
    assert.equal(h.hologram(), false)
    assert.deepEqual(h.calls.native, [])
    assert.equal(h.calls.crop, 0)
  })

  it('rejects in-flight automatic measurement on repress and waits a fresh full delay', async () => {
    const h = createMainPageHarness()
    const measurement = deferred()
    h.waitForMeasurement(measurement.promise)
    h.hold(1)
    h.selection(120)
    h.hold(0)
    await h.advance(100)
    assert.equal(h.calls.measure, 1)
    h.hold(1)
    measurement.resolve()
    await h.advance(1000)
    assert.deepEqual(h.calls.native, [])
    h.hold(0)
    await h.advance(99)
    assert.deepEqual(h.calls.native, [])
    await h.advance(1)
    assert.deepEqual(h.calls.native, [100])
  })

  it('does not run a released viewport callback after unmount', async () => {
    const h = createMainPageHarness()
    h.hold(1)
    h.selection(120)
    h.hold(0)
    h.unmount()
    await h.advance(1000)
    assert.equal(h.hologram(), false)
    assert.deepEqual(h.calls.native, [])
    assert.equal(h.calls.crop, 0)
  })

  it('shows manual resize hologram only after the new native size is acknowledged', async () => {
    const h = createMainPageHarness({ automatic: false })
    const native = deferred()
    h.waitForNative(native.promise)
    h.hold(1)
    h.changePreset({ manualViewportRect: { x: 0, y: 0, width: 260, height: 220 } })
    assert.equal(h.hologram(), false)
    await h.advance(15)
    assert.deepEqual(h.calls.native, [])
    await h.advance(1)
    assert.deepEqual(h.calls.native, [100])
    assert.equal(h.hologram(), false)
    native.resolve()
    await flushMicrotasks()
    assert.equal(h.hologram(), true)
    assert.equal(h.snapshot().physicalSize.width, 260)
    assert.equal(h.calls.measure, 0)
    h.hold(0)
    assert.equal(h.hologram(), false)
  })

  it('keeps manual translation and same-size movement free of holograms', async () => {
    const h = createMainPageHarness({ automatic: false })
    h.hold(1)
    h.changePreset({ cameraHorizontalOffset: 0.5, cameraVerticalOffset: -0.5 })
    await h.advance(16)
    assert.deepEqual(h.calls.pan.at(-1), [-0.5, 0.5])
    assert.equal(h.hologram(), false)
    h.changePreset({ manualViewportRect: { x: 20, y: -30, width: 200, height: 200 } })
    await h.advance(16)
    assert.equal(h.hologram(), false)
    assert.equal(h.calls.measure, 0)
    assert.equal(h.snapshot().sourceRect.x, 20)
    h.hold(0)
  })

  for (const blurBeforePreferencePress of [true, false]) {
    it(`shows a preference resize after main blur ${blurBeforePreferencePress ? 'before' : 'after'} the preference press`, async () => {
      const h = createMainPageHarness({ automatic: false })
      h.nativeButton(true)
      if (blurBeforePreferencePress) h.dom('blur')
      h.hold(1)
      if (!blurBeforePreferencePress) h.dom('blur')
      h.changePreset({ manualViewportRect: { x: -30, y: 0, width: 260, height: 200 } })
      await h.advance(16)
      assert.equal(h.snapshot().physicalSize.width, 260)
      assert.equal(h.hologram(), true)
      h.dom('pointermove', 0)
      assert.equal(h.hologram(), true)
      h.hold(0)
      assert.equal(h.hologram(), false)
      h.nativeButton(false)
    })
  }

  it('does not show a hologram for rejected native geometry', async () => {
    const h = createMainPageHarness({ automatic: false })
    h.failNative()
    h.hold(1)
    h.changePreset({ manualViewportRect: { x: 0, y: 0, width: 260, height: 220 } })
    await h.advance(16)
    assert.deepEqual(h.calls.native, [100])
    assert.equal(h.hologram(), false)
    assert.equal(h.calls.crop, 0)
    assert.equal(h.snapshot().physicalSize.width, 200)
    h.unmount()
  })

  it('retains only the latest pending manual size while native readback is in flight', async () => {
    const h = createMainPageHarness({ automatic: false })
    const native = deferred()
    h.waitForNative(native.promise)
    h.hold(1)
    h.changePreset({ manualViewportRect: { x: 0, y: 0, width: 240, height: 200 } })
    await h.advance(16)
    h.changePreset({ manualViewportRect: { x: 0, y: 0, width: 270, height: 200 } })
    h.changePreset({ manualViewportRect: { x: 0, y: 0, width: 300, height: 200 } })
    native.resolve()
    await flushMicrotasks()
    await h.advance(16)
    assert.deepEqual(h.calls.nativeRects.map(rect => rect.width), [240, 300])
    assert.equal(h.snapshot().physicalSize.width, 300)
    assert.equal(h.calls.measure, 0)
    h.hold(0)
  })

  it('does not accumulate crop-origin drift when odd and even manual dimensions alternate', async () => {
    const h = createMainPageHarness({ automatic: false })
    h.hold(1)
    for (let repeat = 0; repeat < 10; repeat += 1) {
      for (const dimension of ['width', 'height'] as const) {
        const axis = dimension === 'width' ? 'x' : 'y'
        for (const size of [201, 200]) {
          const current = h.store.activePet3dPreset.manualViewportRect
          h.changePreset({ manualViewportRect: {
            ...current,
            [axis]: current[axis] + (current[dimension] - size) / 2,
            [dimension]: size,
          } })
          await h.advance(16)
          assert.equal(h.store.activePet3dPreset.manualViewportRect[axis] + size / 2, 100)
          assert.equal(h.snapshot().physicalSize[dimension], size)
        }
      }
    }
    assert.deepEqual({ ...h.store.activePet3dPreset.manualViewportRect }, { x: 0, y: 0, width: 200, height: 200 })
    h.hold(0)
  })

  it('does not re-show the manual hologram on a new hold without another size change', async () => {
    const h = createMainPageHarness({ automatic: false })
    const manualViewportRect = { x: 0, y: 0, width: 240, height: 200 }
    h.hold(1)
    h.changePreset({ manualViewportRect })
    await h.advance(16)
    assert.equal(h.hologram(), true)
    h.hold(0)
    h.hold(1)
    h.changePreset({ manualViewportRect, dmeloperPalmColor: '#abcdef' })
    await h.advance(100)
    assert.equal(h.hologram(), false)
    assert.equal(h.calls.native.length, 1)
    h.hold(0)
  })

  it('never shows a hologram for an unchanged mirror viewport', async () => {
    const h = createMainPageHarness()
    h.hold(1)
    h.mirror()
    await h.advance(1000)
    assert.equal(h.hologram(), false)
    assert.deepEqual(h.calls.native, [])
    h.hold(0)
    await h.advance(100)
    assert.deepEqual(h.calls.native, [100])
    assert.equal(h.hologram(), false)
  })

  for (const event of ['mouseup', 'pointercancel', 'blur', 'preference-cancel', 'native-release']) {
    it(`clears an acknowledged hologram on ${event} and ignores late changes`, async () => {
      const h = createMainPageHarness({ automatic: false })
      h.dom('mousedown', 1)
      h.nativeButton(true)
      if (event === 'preference-cancel' || event === 'native-release') h.hold(1)
      h.changePreset({ manualViewportRect: { x: 0, y: 0, width: 240, height: 200 } })
      await h.advance(16)
      assert.equal(h.hologram(), true)
      if (event === 'preference-cancel') h.hold(0)
      else if (event === 'native-release') h.nativeButton(false)
      else h.dom(event)
      assert.equal(h.hologram(), false)
      h.changePreset({ manualViewportRect: { x: 0, y: 0, width: 260, height: 200 } })
      await h.advance(16)
      assert.equal(h.hologram(), false)
      h.nativeButton(false)
      h.dom('mouseup')
      h.hold(0)
      await h.advance(100)
      assert.equal(h.hologram(), false)
    })
  }

  it('clears on hide and unmount without publishing an in-flight native crop', async () => {
    for (const action of ['hide', 'unmount'] as const) {
      const h = createMainPageHarness({ automatic: false })
      h.hold(1)
      h.changePreset({ manualViewportRect: { x: 0, y: 0, width: 240, height: 200 } })
      await h.advance(16)
      assert.equal(h.hologram(), true)
      const native = deferred()
      h.waitForNative(native.promise)
      h.changePreset({ manualViewportRect: { x: 0, y: 0, width: 260, height: 200 } })
      await h.advance(16)
      await h[action]()
      native.resolve()
      await h.advance(1000)
      assert.equal(h.hologram(), false)
      assert.equal(h.calls.crop, 1)
      assert.equal(h.snapshot().physicalSize.width, 240)
    }
  })

  it('waits for mouse acknowledgement and never starts a hologram after mouseup', async () => {
    const h = createMainPageHarness()
    const ack = deferred()
    h.waitForMouse(ack.promise)
    h.hold(1)
    h.setMouse(false)
    await flushMicrotasks()
    assert.equal(h.mouseResponses.length, 0)
    h.hold(0)
    ack.resolve()
    await flushMicrotasks()
    assert.equal(h.mouseResponses.length, 1)
    await h.advance(99)
    assert.deepEqual(h.calls.native, [])
    await h.advance(1)
    assert.deepEqual(h.calls.native, [100])
    assert.equal(h.hologram(), false)
  })

  it('preserves DOM holds through mouse OFF and rejects input from the old epoch', async () => {
    const h = createMainPageHarness()
    h.nativeButton(true, 1)
    h.hold(1)
    h.setMouse(false)
    await flushMicrotasks()
    await h.advance(1000)
    assert.deepEqual(h.calls.native, [])
    assert.equal(h.hologram(), false)
    h.hold(0)
    h.nativeButton(true, 1)
    await h.advance(100)
    assert.deepEqual(h.calls.native, [100])
    h.setMouse(true)
    await flushMicrotasks()
    h.nativeButton(true, 1)
    await h.advance(100)
    assert.deepEqual(h.calls.native, [100, 100])
    assert.equal(h.hologram(), false)
  })

  it('clears after a renderer failure and does not revive a queued hologram', async () => {
    const h = createMainPageHarness({ automatic: false })
    h.hold(1)
    h.changePreset({ manualViewportRect: { x: 0, y: 0, width: 240, height: 200 } })
    await h.advance(16)
    assert.equal(h.hologram(), true)
    h.failPreview()
    h.selection(120)
    await flushMicrotasks()
    assert.equal(h.hologram(), false)
    h.selection(130)
    await h.advance(1000)
    assert.equal(h.hologram(), false)
    h.unmount()
  })

  it('captures the current automatic rectangle and resets both pan values on each manual transition', async () => {
    const h = createMainPageHarness()
    h.measured({ x: -10, y: -20, width: 600, height: 500 })
    h.selection(10)
    await h.advance(100)
    h.changePreset({ cameraHorizontalOffset: 1, cameraVerticalOffset: -1 })
    await flushMicrotasks()
    h.requestMode(false, 'manual-first')
    await flushMicrotasks()
    await h.advance(16)
    await flushMicrotasks()
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, false)
    assert.deepEqual({ ...h.store.activePet3dPreset.manualViewportRect }, { x: -10, y: -20, width: 600, height: 500 })
    assert.equal(h.store.activePet3dPreset.cameraHorizontalOffset, 0)
    assert.equal(h.store.activePet3dPreset.cameraVerticalOffset, 0)
    assert.equal(h.sceneResponses.at(-1)?.success, true)
    assert.equal(h.sceneResponses.at(-1)?.state.revision, 1)

    h.measured({ x: -100, y: -80, width: 800, height: 650 })
    h.requestMode(true, 'automatic-again')
    await flushMicrotasks()
    await h.advance(100)
    await flushMicrotasks()
    h.requestMode(false, 'manual-again')
    await flushMicrotasks()
    await h.advance(16)
    await flushMicrotasks()
    assert.deepEqual({ ...h.store.activePet3dPreset.manualViewportRect }, { x: -100, y: -80, width: 800, height: 650 })
    assert.equal(h.sceneResponses.at(-1)?.state.revision, 3)
  })

  it('clamps manual dimensions to the current monitor without measuring automatic content', async () => {
    const h = createMainPageHarness({ automatic: false })
    h.monitor({ width: 350, height: 250 })
    h.changePreset({ manualViewportRect: { x: -10, y: -20, width: 600, height: 500 } })
    await h.advance(16)
    assert.deepEqual({ ...h.store.activePet3dPreset.manualViewportRect }, { x: 115, y: 105, width: 350, height: 250 })
    assert.equal(h.snapshot().physicalSize.width, 350)
    assert.equal(h.snapshot().physicalSize.height, 250)
    assert.equal(h.calls.measure, 0)
  })

  it('rejects a stale preset mode after an acknowledged automatic-to-manual transition', async () => {
    const h = createMainPageHarness()
    const oldPreset = { ...h.store.activePet3dPreset }
    h.requestMode(false, 'manual')
    await flushMicrotasks()
    await h.advance(16)
    await flushMicrotasks()
    assert.equal(h.sceneResponses.at(-1)?.state.revision, 1)
    h.changePreset({
      manualViewportRect: { x: 15, y: -20, width: 300, height: 240 },
      cameraHorizontalOffset: 0.5,
      cameraVerticalOffset: -0.25,
    })
    await h.advance(16)
    h.packet({ ...oldPreset, cameraZoomPercent: 150, cameraHorizontalOffset: 1, cameraVerticalOffset: 1 })
    await h.advance(16)
    assert.equal(h.calls.measure, 0)
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, false)
    assert.deepEqual(h.calls.pan.at(-1), [-0.5, 0.25])
    assert.equal(h.snapshot().physicalSize.width, 300)
    assert.equal(h.snapshot().physicalSize.height, 240)
  })

  for (const resetMethod of ['resetActivePet3dPreset', 'resetCustomization3d', 'resetAllSettings'] as const) {
    it(`keeps reset defaults newer than a late manual-mode packet (${resetMethod})`, async () => {
      const h = createMainPageHarness()
      try {
        h.requestMode(false, 'manual-before-reset')
        await flushMicrotasks()
        await h.advance(16)
        const oldPreset = { ...h.store.activePet3dPreset }
        assert.equal(oldPreset.viewportModeRevision, 1)
        const store = useBlockStore(createPinia())
        Object.assign(store.activePet3dPreset, oldPreset)
        store[resetMethod]()
        h.store.customization3d.preset = JSON.parse(JSON.stringify(store.activePet3dPreset))
        const resetting = h.reset()
        for (let index = 0; index < 10; index++) await h.advance(120)
        assert.equal(await resetting, true)
        h.requestMode(undefined, 'query-after-reset')
        await flushMicrotasks()
        const response = h.sceneResponses.at(-1)!
        assert.equal(response.success, true)
        assert.equal(response.state.automatic, true)
        assert.ok(response.state.revision > oldPreset.viewportModeRevision)
        h.packet(oldPreset)
        await h.advance(120)
        assert.equal(h.store.activePet3dPreset.autoViewportEnabled, true)
        assert.equal(h.store.activePet3dPreset.viewportModeRevision, response.state.revision)
      } finally {
        h.unmount()
      }
    })
  }

  it('discards a mode request superseded while waiting for monitor readback', async () => {
    const h = createMainPageHarness()
    const monitor = deferred()
    h.waitForMonitor(monitor.promise)
    h.requestMode(false, 'older')
    await flushMicrotasks()
    h.requestMode(undefined, 'latest')
    await flushMicrotasks()
    monitor.resolve()
    await flushMicrotasks()
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, true)
    assert.deepEqual(h.sceneResponses.map(response => response.requestId), ['latest'])
    assert.equal(h.sceneResponses[0].state.automatic, true)
  })
})

describe('retired pet selection ownership', () => {
  for (const packet of ['preset', 'skin'] as const) {
    it(`ignores a retained ${packet} callback after the main page unmounts`, async () => {
      const h = createMainPageHarness()
      h.unmount()
      const before = JSON.stringify(h.calls)
      // Native unsubscribe may fail; this deliberately retained callback must
      // have no authority over the replacement owner's shared window.
      if (packet === 'skin') h.changeSkin('data:image/png;base64,replacement')
      else h.packet({ ...h.store.activePet3dPreset })
      await flushMicrotasks()
      await h.advance(1000)
      assert.equal(h.store.window.visible, true)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.runtimeState().pending, false)
      assert.equal(JSON.stringify(h.calls), before)
    })
  }
})

describe('pet presentation survives superseded viewport work', () => {
  it('keeps pet loading through Java preparation and hands it directly to the supplied skin', async () => {
    const h = createMainPageHarness({ allowInitialize: true, loadingPaint: true })
    const skin = deferred()
    try {
      h.skinChange({ requestId: 'java-cold', phase: 'prepare' })
      await h.advance(1000)
      assert.equal(h.runtimeState().loading, true)
      assert.equal(h.inputActive(), false)
      assert.equal(h.skinApplications(), 0)
      assert.equal(h.petPresentationVisible(), false)
      assert.deepEqual(h.scenePresentation(), { sceneVisible: true, loadingVisible: true, opacity: 1, mirrored: false })
      h.changePreset({ petHeadScalePercent: 110 })
      await h.advance(1000)
      assert.equal(h.runtimeState().loading, true, 'ordinary packets must not end the nickname request')
      h.waitForSkin(skin.promise)
      h.skinChange({ requestId: 'java-cold', phase: 'finish', skin: {
        dataUrl: 'data:image/png;base64,cold-java',
        model: 'slim',
        palmColor: '#445566',
      } })
      await h.advance(16)
      await h.advance(16)
      await h.advance(1000)
      assert.equal(h.skinApplications(), 1, 'the finish packet must apply without waiting for a separate settings event')
      assert.equal(h.runtimeState().loading, true)
      assert.equal(h.petPresentationVisible(), false, 'new skin stays hidden while its bounds settle')
      skin.resolve()
      await flushMicrotasks()
      await h.advance(1000)
      assert.equal(h.runtimeState().loading, false)
      assert.equal(h.inputActive(), true)
      assert.equal(h.petPresentationVisible(), true)
      assert.equal(h.scenePresentation().loadingVisible, false)
    } finally {
      skin.resolve()
      h.unmount()
    }
  })

  it('ignores stale preparation completion and restores the original pet on lookup failure', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      h.skinChange({ requestId: 'old-java', phase: 'prepare' })
      h.skinChange({ requestId: 'new-java', phase: 'prepare' })
      h.skinChange({ requestId: 'old-java', phase: 'finish', skin: { dataUrl: 'data:image/png;base64,stale', model: 'wide', palmColor: '#445566' } })
      await h.advance(1000)
      assert.equal(h.runtimeState().loading, true)
      h.skinChange({ requestId: 'new-java', phase: 'finish' })
      await h.advance(1000)
      assert.equal(h.runtimeState().loading, false)
      assert.equal(h.skinApplications(), 0)
      assert.equal(h.petPresentationVisible(), true, 'cancellation restores the already loaded pet')
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.inputActive(), true)
    } finally {
      h.unmount()
    }
  })

  it('preserves hiding and saving during preparation without showing a stale loading window', async () => {
    const h = createMainPageHarness({ allowInitialize: true, loadingPaint: true })
    try {
      h.skinChange({ requestId: 'hide-java', phase: 'prepare' })
      h.lockEditors(true)
      await flushMicrotasks()
      await h.hide()
      h.skinChange({ requestId: 'hide-java', phase: 'finish' })
      h.lockEditors(false)
      await h.advance(1000)
      assert.equal(h.runtimeState().loading, false)
      assert.equal(h.skinApplications(), 0)
      assert.equal(h.nativeVisible(), false)
    } finally {
      h.unmount()
    }
  })

  it('gives the loading UI a paint opportunity before the cold first skin replacement', async () => {
    const h = createMainPageHarness({ allowInitialize: true, loadingPaint: true })
    try {
      h.changeSkin('data:image/png;base64,cold-first')
      await flushMicrotasks()
      assert.equal(h.runtimeState().loading, true)
      assert.equal(h.skinApplications(), 0, 'DOM flush alone must not start cold asset work before a paint opportunity')
      await h.advance(16)
      assert.equal(h.skinApplications(), 0, 'the first RAF callback still precedes its paint')
      await h.advance(16)
      assert.equal(h.skinApplications(), 1)
      await h.advance(1000)
      assert.equal(h.runtimeState().loading, false)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.inputActive(), true)
    } finally {
      h.unmount()
    }
  })

  it('does not start cold asset work after hiding during the loading paint wait', async () => {
    const h = createMainPageHarness({ allowInitialize: true, loadingPaint: true })
    try {
      h.changeSkin('data:image/png;base64,cancel-before-paint')
      await flushMicrotasks()
      await h.hide()
      await h.advance(1000)
      assert.equal(h.skinApplications(), 0)
      assert.equal(h.runtimeState().loading, false)
      assert.equal(h.nativeVisible(), false)
    } finally {
      h.unmount()
    }
  })

  it('releases the cold loading paint wait when saving locks editors', async () => {
    const h = createMainPageHarness({ allowInitialize: true, loadingPaint: true })
    try {
      h.changeSkin('data:image/png;base64,save-during-paint')
      await flushMicrotasks()
      assert.equal(h.skinApplications(), 0)
      h.lockEditors(true)
      await flushMicrotasks()
      assert.equal(h.skinApplications(), 1, 'native drain must not wait for suspended paint callbacks')
      h.lockEditors(false)
      await h.advance(1000)
    } finally {
      h.unmount()
    }
  })

  it('keeps the startup loading UI visible through a slow skin load and its bounds preparation', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    const skin = deferred()
    const bounds = deferred()
    try {
      h.store.window.opacity = 0
      h.store.model.mirror = true
      h.waitForSkin(skin.promise)
      h.waitForMeasurement(bounds.promise)
      h.changeSkin('data:image/png;base64,slow')
      await flushMicrotasks()
      assert.equal(h.runtimeState().loading, true)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.inputActive(), false)
      assert.equal(h.store.window.visible, true)
      assert.equal(h.store.window.opacity, 0)
      assert.equal(h.store.model.mirror, true)
      skin.resolve()
      await flushMicrotasks()
      await h.advance(100)
      assert.equal(h.runtimeState().loading, true, 'asset completion must not reveal before bounds are ready')
      h.changePreset({ dmeloperPalmColor: '#abcdef' })
      bounds.resolve()
      await flushMicrotasks()
      await h.advance(1000)
      assert.equal(h.runtimeState().loading, false)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.inputActive(), true)
      assert.equal(h.runtimeState().error, undefined)
    } finally {
      skin.resolve()
      bounds.resolve()
      h.unmount()
    }
  })

  it('does not show loading for ordinary preference edits while the pet can keep rendering', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    const bounds = deferred()
    try {
      h.waitForMeasurement(bounds.promise)
      h.changePreset({ cameraZoomPercent: 120, dmeloperPalmColor: '#abcdef' })
      await flushMicrotasks()
      await h.advance(100)
      assert.equal(h.runtimeState().loading, false)
      assert.equal(h.nativeVisible(), true)
      bounds.resolve()
      await flushMicrotasks()
      await h.advance(1000)
      assert.equal(h.runtimeState().loading, false)
    } finally {
      bounds.resolve()
      h.unmount()
    }
  })

  for (const action of ['hide', 'unmount'] as const) {
    it(`clears skin loading on ${action} and ignores its late completion`, async () => {
      const h = createMainPageHarness({ allowInitialize: true })
      const skin = deferred()
      try {
        h.waitForSkin(skin.promise)
        h.changeSkin('data:image/png;base64,slow')
        await flushMicrotasks()
        assert.equal(h.runtimeState().loading, true)
        if (action === 'hide') await h.hide()
        else h.unmount()
        assert.equal(h.runtimeState().loading, false)
        skin.resolve()
        await flushMicrotasks()
        await h.advance(1000)
        assert.equal(h.runtimeState().loading, false)
        if (action === 'hide') assert.equal(h.nativeVisible(), false)
        assert.deepEqual(h.recoveryNotices, [])
      } finally {
        skin.resolve()
        h.unmount()
      }
    })
  }

  it('shows the latest asset edit when another geometry packet arrives during input resume', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    const input = deferred()
    try {
      h.waitForInputResume(input.promise)
      h.changeSkin('data:image/png;base64,edited')
      await flushMicrotasks()
      await h.advance(100)
      for (let turn = 0; turn < 5; turn++) await flushMicrotasks()
      assert.equal(h.calls.inputResumeStarted, 1)
      h.selection(120)
      input.resolve()
      await flushMicrotasks()
      await h.advance(1000)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.inputActive(), true)
      assert.ok(h.calls.inputResumes.every(visible => visible), 'input may resume only after the native pet window is shown')
      assert.equal(h.store.activePet3dPreset.petRotationDegrees, 120)
    } finally {
      input.resolve()
      h.unmount()
    }
  })

  it('passes the reset presentation to a packet arriving during native centering', async () => {
    const h = createMainPageHarness()
    const center = deferred()
    try {
      h.waitForCenter(center.promise)
      const reset = h.reset()
      await flushMicrotasks()
      await h.advance(100)
      for (let turn = 0; turn < 5; turn++) await flushMicrotasks()
      assert.equal(h.calls.center, 1)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.runtimeState().loading, true)
      h.selection(120)
      center.resolve()
      assert.equal(await reset, false, 'the old centering result was superseded')
      await h.advance(1000)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.inputActive(), true)
      assert.equal(h.store.activePet3dPreset.petRotationDegrees, 120)
    } finally {
      center.resolve()
      h.unmount()
    }
  })

  it('does not wait for a hidden webview RAF to finish a padding packet during input resume', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    const input = deferred()
    try {
      h.pauseHiddenFrames()
      h.waitForInputResume(input.promise)
      h.changeSkin('data:image/png;base64,edited')
      await flushMicrotasks()
      await h.advance(100)
      for (let turn = 0; turn < 5; turn++) await flushMicrotasks()
      assert.equal(h.calls.inputResumeStarted, 1)
      h.measured({ x: 4, y: 4, width: 192, height: 192 })
      h.changePreset({ autoViewportPaddingPixels: 12 })
      input.resolve()
      await flushMicrotasks()
      await h.advance(1000)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.inputActive(), true)
      assert.equal(h.store.activePet3dPreset.autoViewportPaddingPixels, 12)
      assert.equal(h.snapshot().sourceRect.width, 192, 'the latest padding must reach the native viewport without a hidden RAF')
    } finally {
      input.resolve()
      h.unmount()
    }
  })

  it('requires the latest selection proof before an unrelated appearance edit can resume input', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    const proof = deferred()
    try {
      h.waitForVisibilityRead(proof.promise)
      h.changeSkin('data:image/png;base64,edited')
      await flushMicrotasks()
      await h.advance(100)
      for (let turn = 0; turn < 5; turn++) await flushMicrotasks()
      assert.equal(h.calls.shown, 1)
      assert.equal(h.calls.inputResumeStarted, 0)
      h.changePreset({ dmeloperPalmColor: '#abcdef' })
      await flushMicrotasks()
      assert.equal(h.calls.inputResumeStarted, 0, 'an old native show cannot acknowledge the latest selection')
      h.waitForVisibilityRead(Promise.resolve())
      proof.resolve()
      await flushMicrotasks()
      await h.advance(1000)
      assert.equal(h.calls.shown, 2)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.inputActive(), true)
    } finally {
      proof.resolve()
      h.unmount()
    }
  })

  for (const mode of ['pet', 'broadcast'] as const) {
    it(`keeps a ${mode} hide after the old asset presentation acknowledges late`, async () => {
      const h = createMainPageHarness({ allowInitialize: true })
      const proof = deferred()
      try {
        h.waitForVisibilityRead(proof.promise)
        h.changeSkin('data:image/png;base64,edited')
        await flushMicrotasks()
        await h.advance(100)
        for (let turn = 0; turn < 5; turn++) await flushMicrotasks()
        assert.equal(h.calls.shown, 1)
        const hiding = mode === 'pet' ? h.hide() : h.setBroadcast(true, false)
        await hiding
        proof.resolve()
        await flushMicrotasks()
        await h.advance(1000)
        assert.equal(h.nativeVisible(), false)
        assert.equal(h.inputActive(), false)
        assert.equal(h.calls.shown, 1)
        assert.equal(h.runtimeState().recoveryUsed, false)
        assert.deepEqual(h.recoveryNotices, [])
      } finally {
        proof.resolve()
        h.unmount()
      }
    })
  }

  it('shows a known asset error without input and presents the next healthy selection', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      h.failSkin()
      h.changeSkin('data:image/png;base64,failed')
      await flushMicrotasks()
      await h.advance(100)
      for (let turn = 0; turn < 5; turn++) await flushMicrotasks()
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.runtimeState().error, 'pages.main.errors.modelLoad')
      assert.equal(h.runtimeState().loading, false)
      assert.equal(h.inputActive(), false)
      assert.equal(h.calls.inputResumeStarted, 0)
      assert.equal(h.runtimeState().recoveryUsed, false)
      assert.deepEqual(h.recoveryNotices, [])
      h.changeSkin('data:image/png;base64,recovered')
      await flushMicrotasks()
      await h.advance(100)
      for (let turn = 0; turn < 5; turn++) await flushMicrotasks()
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.runtimeState().error, undefined)
      assert.equal(h.inputActive(), true)
      assert.equal(h.runtimeState().recoveryUsed, false)
      assert.deepEqual(h.recoveryNotices, [])
    } finally {
      h.unmount()
    }
  })
})

describe('pet presentation lifecycle and recovery', () => {
  async function drain() {
    for (let index = 0; index < 10; index++) await flushMicrotasks()
  }

  for (const stage of ['measurement', 'native'] as const) {
    for (const mode of ['pet', 'broadcast'] as const) {
      it(`replaces cancelled initialization during ${stage} when ${mode} returns before native hide finishes`, async () => {
        const h = createMainPageHarness({ allowInitialize: true })
        const work = deferred()
        const hide = deferred()
        try {
          if (stage === 'measurement') h.waitForMeasurement(work.promise)
          else h.waitForNative(work.promise)
          const initializing = h.initialize()
          await drain()
          assert.equal(h.calls.measure, 1)
          h.waitForHide(hide.promise)
          const hiding = mode === 'pet' ? h.hide() : h.setBroadcast(true, false)
          if (mode === 'pet') h.store.window.visible = true
          const showing = mode === 'pet' ? h.sync() : h.setBroadcast(false, false)
          await drain()
          work.resolve()
          hide.resolve()
          await Promise.all([initializing, hiding, showing])
          await drain()
          assert.equal(h.nativeVisible(), true)
          assert.equal(h.runtimeState().ready, true)
          assert.equal(h.runtimeState().error, undefined)
          assert.equal(h.runtimeState().recoveryUsed, false)
          assert.deepEqual(h.recoveryNotices, [])
          assert.equal(h.initializationCalls(), 2)
        } finally {
          work.resolve()
          hide.resolve()
          h.unmount()
        }
      })
    }
  }

  it('keeps the final hide after an already-issued show completes late', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    const gate = deferred()
    try {
      h.waitForShow(gate.promise)
      const showing = h.sync()
      await drain()
      const hiding = h.hide()
      gate.resolve()
      await Promise.all([showing, hiding])
      assert.equal(h.store.window.visible, false)
      assert.equal(h.nativeVisible(), false)
      assert.equal(h.runtimeState().ready, false)
      assert.deepEqual(h.recoveryNotices, [])
    } finally {
      gate.resolve()
      h.unmount()
    }
  })

  it('shows loading until a normal frame is proved without changing persisted visibility or opacity', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.hide()
      h.store.window.visible = true
      h.store.window.opacity = 0
      h.store.model.mirror = true
      h.holdFirstFrame()
      const showing = h.sync()
      await drain()
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.runtimeState().loading, true)
      assert.equal(h.petPresentationVisible(), false)
      assert.deepEqual(h.scenePresentation(), { sceneVisible: true, loadingVisible: true, opacity: 0, mirrored: true })
      assert.equal(h.store.window.visible, true)
      assert.equal(h.store.window.opacity, 0)
      assert.equal(h.store.model.mirror, true)
      h.completeFirstFrame()
      await showing
      assert.equal(h.runtimeState().loading, false)
      assert.equal(h.runtimeState().error, undefined)
      assert.equal(h.petPresentationVisible(), true)
    } finally {
      h.unmount()
    }
  })

  it('releases a first-frame waiter when the user hides or the component unmounts', async () => {
    for (const action of ['hide', 'unmount']) {
      const h = createMainPageHarness({ allowInitialize: true })
      await h.hide()
      h.holdFirstFrame()
      h.store.window.visible = true
      const showing = h.sync()
      await drain()
      if (action === 'hide') await h.hide()
      else h.unmount()
      await showing
      h.completeFirstFrame()
      await drain()
      assert.deepEqual(h.recoveryNotices, [])
      h.unmount()
    }
  })

  it('recovers once, ignores old callbacks, and grants a new budget only after a healthy presentation', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.initialize()
      await h.sync()
      const oldFailure = h.captureRuntimeFailure()!
      h.holdFirstFrame()
      oldFailure(new Error('first incident'))
      await drain()
      assert.equal(h.initializationCalls(), 2)
      assert.equal(h.runtimeState().recoveryUsed, true)
      assert.equal(h.runtimeState().loading, true)
      oldFailure(new Error('duplicate old incident'))
      await drain()
      assert.equal(h.initializationCalls(), 2)
      assert.deepEqual(h.recoveryNotices, [])
      h.completeFirstFrame()
      await drain()
      assert.equal(h.runtimeState().recoveryUsed, false)
      h.failRuntime()
      await drain()
      assert.equal(h.initializationCalls(), 3)
      h.completeFirstFrame()
      await drain()
      assert.equal(h.runtimeState().recoveryUsed, false)
      assert.deepEqual(h.recoveryNotices, [])
      assert.equal(h.store.window.visible, true)
    } finally {
      h.unmount()
    }
  })

  it('reports one restart after failed recovery and cannot reset its budget with repeated faults or toggles', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.initialize()
      await h.sync()
      h.failInitializations(1)
      h.failRuntime()
      await drain()
      assert.equal(h.initializationCalls(), 2)
      assert.equal(h.runtimeState().recoveryUsed, true)
      assert.equal(h.recoveryNotices.length, 1)
      h.failRuntime()
      h.failRuntime()
      await drain()
      assert.equal(h.initializationCalls(), 2)
      assert.equal(h.recoveryNotices.length, 1)
      h.failInitializations(1)
      await h.hide()
      h.store.window.visible = true
      await h.sync()
      await drain()
      assert.equal(h.initializationCalls(), 3, 'explicit show is allowed; no extra automatic retry')
      assert.equal(h.recoveryNotices.length, 1)
      assert.equal(h.runtimeState().recoveryUsed, true)
    } finally {
      h.unmount()
    }
  })

  it('ignores an old rejected show or false visibility readback after the latest hide', async () => {
    for (const stage of ['show', 'readback']) {
      const h = createMainPageHarness({ allowInitialize: true })
      const gate = deferred()
      try {
        if (stage === 'show') {
          h.waitForShow(gate.promise)
          h.failVisibility('show')
        } else {
          h.waitForVisibilityRead(gate.promise, false)
        }
        const showing = h.sync()
        await drain()
        const hiding = h.hide()
        gate.resolve()
        await Promise.all([showing, hiding])
        await drain()
        assert.equal(h.runtimeState().recoveryUsed, false)
        assert.equal(h.runtimeState().error, undefined)
        assert.equal(h.nativeVisible(), false)
        assert.deepEqual(h.recoveryNotices, [])
      } finally {
        gate.resolve()
        h.unmount()
      }
    }
  })

  it('does not let the old initialization finally consume a replacement pending selection', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    const oldRead = deferred()
    const currentRead = deferred()
    try {
      h.waitForMeasurement(oldRead.promise)
      const obsolete = h.initialize()
      await drain()
      await h.hide()
      h.waitForMeasurement(currentRead.promise)
      h.store.window.visible = true
      const current = h.sync()
      await drain()
      h.selection(25)
      assert.equal(h.runtimeState().pending, true)
      oldRead.resolve()
      assert.equal(await obsolete, false)
      assert.equal(h.runtimeState().pending, true)
      currentRead.resolve()
      await current
      assert.equal(h.runtimeState().error, undefined)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.store.activePet3dPreset.petRotationDegrees, 25)
    } finally {
      oldRead.resolve()
      currentRead.resolve()
      h.unmount()
    }
  })

  it('releases a recovery frame waiter for saving and resumes the same proof after unlock', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.initialize()
      await h.sync()
      h.holdFirstFrame()
      h.failRuntime()
      await drain()
      assert.equal(h.runtimeState().recovering, true)
      assert.equal(h.runtimeState().recoveryUsed, true)
      h.lockEditors(true)
      await drain()
      assert.equal(h.runtimeState().recovering, false)
      assert.equal(h.runtimeState().recoveryUsed, true)
      assert.equal(h.runtimeState().loading, true)
      h.lockEditors(false)
      await drain()
      assert.equal(h.initializationCalls(), 2)
      h.completeFirstFrame()
      await drain()
      assert.equal(h.runtimeState().loading, false)
      assert.equal(h.runtimeState().recoveryUsed, false)
      assert.deepEqual(h.recoveryNotices, [])
    } finally {
      h.unmount()
    }
  })

  it('does not resume a suspended presentation if the pet is hidden before editors unlock', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.hide()
      h.holdFirstFrame()
      h.store.window.visible = true
      const showing = h.sync()
      await drain()
      h.lockEditors(true)
      await showing
      await h.hide()
      const shown = h.calls.shown
      h.lockEditors(false)
      h.completeFirstFrame()
      await drain()
      assert.equal(h.calls.shown, shown)
      assert.equal(h.nativeVisible(), false)
      assert.deepEqual(h.recoveryNotices, [])
    } finally {
      h.unmount()
    }
  })

  it('cannot show or initialize from stale memory activation or a stale loading tick', async () => {
    for (const stage of ['memory', 'tick']) {
      const h = createMainPageHarness({ allowInitialize: true })
      const gate = deferred()
      try {
        if (stage === 'memory') {
          h.waitForMemory(gate.promise)
        } else {
          await h.hide()
          h.store.window.visible = true
          h.waitForTick(gate.promise)
        }
        const showing = h.sync()
        await drain()
        const hidden = h.hide()
        gate.resolve()
        await Promise.all([showing, hidden])
        await drain()
        assert.equal(h.initializationCalls(), 0)
        assert.equal(h.nativeVisible(), false)
        assert.equal(h.runtimeState().loading, false)
        assert.equal(h.runtimeState().recoveryUsed, false)
        assert.deepEqual(h.recoveryNotices, [])
      } finally {
        gate.resolve()
        h.unmount()
      }
    }
  })

  it('cancels a managed first-frame waiter and acknowledges rollback without consuming recovery', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.hide()
      h.holdFirstFrame()
      const requested = h.capturePreset()
      requested.opacity = 37
      h.applyPreset(requested)
      await drain()
      assert.equal(h.runtimeState().loading, true)
      assert.deepEqual(h.presetResponses, [])
      h.cancelPreset()
      const response = await settlePresetResponse(h)
      assert.equal(response.success, false)
      assert.equal(response.restored, true)
      assert.equal(h.store.window.visible, false)
      assert.equal(h.store.window.opacity, 100)
      assert.equal(h.runtimeState().recoveryUsed, false)
      h.completeFirstFrame()
      await drain()
      assert.equal(h.nativeVisible(), false)
      assert.deepEqual(h.recoveryNotices, [])
    } finally {
      h.unmount()
    }
  })

  it('allows an authorized managed apply under editor lock after its normal frame was already proved', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.initialize()
      await h.sync()
      assert.equal(h.runtimeState().loading, false)
      h.lockEditors(true)
      const requested = h.capturePreset()
      requested.opacity = 37
      h.applyPreset(requested)
      const response = await settlePresetResponse(h)
      assert.equal(response.success, true)
      assert.equal(response.restored, false)
      assert.equal(h.store.window.opacity, 37)
      assert.equal(h.nativeVisible(), true)
      assert.equal(h.initializationCalls(), 1)
      assert.equal(h.runtimeState().recoveryUsed, false)
      assert.deepEqual(h.recoveryNotices, [])
    } finally {
      h.unmount()
    }
  })

  it('does not acknowledge a managed presentation when saving cancels its first-frame proof', async () => {
    const h = createMainPageHarness({ allowInitialize: true })
    try {
      await h.hide()
      h.holdFirstFrame()
      const requested = h.capturePreset()
      requested.opacity = 37
      h.applyPreset(requested)
      await drain()
      h.lockEditors(true)
      const response = await settlePresetResponse(h)
      assert.equal(response.success, false)
      assert.equal(response.restored, true)
      assert.equal(h.store.window.visible, false)
      assert.equal(h.store.window.opacity, 100)
      assert.equal(h.runtimeState().recoveryUsed, false)
      assert.deepEqual(h.recoveryNotices, [])
    } finally {
      h.unmount()
    }
  })

  it('keeps bundled skin/model resolution failures out of unexpected recovery', async () => {
    for (const resource of ['skin', 'model'] as const) {
      const h = createMainPageHarness({ allowInitialize: true })
      try {
        h.failResource(resource)
        assert.equal(await h.initialize(), false)
        await drain()
        assert.equal(h.initializationCalls(), 0)
        assert.equal(h.runtimeState().error, 'pages.main.errors.modelLoad')
        assert.equal(h.runtimeState().recoveryUsed, false)
        assert.deepEqual(h.recoveryNotices, [])
      } finally {
        h.unmount()
      }
    }
  })

  for (const name of ['PetAssetLoadError', 'PetModelLoadCancelledError']) {
    it(`does not retry or request restart for known ${name}`, async () => {
      const h = createMainPageHarness({ allowInitialize: true })
      try {
        h.failInitializations(1, name)
        await h.initialize()
        await drain()
        assert.equal(h.initializationCalls(), 1)
        assert.equal(h.runtimeState().recoveryUsed, false)
        assert.deepEqual(h.recoveryNotices, [])
      } finally {
        h.unmount()
      }
    })
  }
})
