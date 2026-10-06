/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import * as constants from '@/constants'
import * as broadcastVisibility from '@/features/broadcast/visibility'
import * as petRuntime from '@/features/petRuntime/types'
import * as editRequests from '@/features/presets/editRequests'
import * as presetTypes from '@/features/presets/types'
import * as dataBridge from '@/features/stateSafety/bridge'
import * as windowNavigation from '@/plugins/windowNavigation'

import * as menuViewportSetting from './menuViewportSetting'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

function appHarness(label = 'preference') {
  const restored = deferred()
  const listeners = new Map<string, (event: { payload: unknown }) => void>()
  const mounted: Array<() => Promise<void>> = []
  const disposed: Array<() => void> = []
  let geometryRestores = 0
  const writes: Array<[string, number]> = []
  const errors: unknown[] = []
  let shown = 0
  let rendererShowRequests = 0
  const preset = new Proxy({ cameraZoomPercent: 100, sceneRotationOffsetDegrees: 0 }, {
    set(target, key, value: number) {
      writes.push([String(key), value])
      return Reflect.set(target, key, value)
    },
  })
  const block = {
    window: { visible: true },
    $tauri: { start: () => restored.promise },
    init: () => {
      preset.cameraZoomPercent = 78
    },
    activePet3dPreset: preset,
  }
  const startedStore = { $tauri: { start: async () => {} }, init: async () => {} }
  const general = { ...startedStore, broadcast: { enabled: false, showOnDesktop: true } }
  const mocks: Record<string, unknown> = {
    './features/broadcast/visibility': broadcastVisibility,
    './features/petRuntime/types': petRuntime,
    './features/stateSafety/bridge': dataBridge,
    './features/stateSafety/runtime': { registerStateSnapshots: () => {}, markStoresReady: () => {} },
    './features/presets/types': presetTypes,
    './features/presets/editRequests': editRequests,
    '@tauri-apps/api/core': { invoke: async () => {} },
    '@tauri-apps/api/event': { emitTo: async (_label: string, event: string, payload: unknown) => {
      if (event === petRuntime.PET_RUNTIME_SHOW) rendererShowRequests++
      listeners.get(event)?.({ payload })
    } },
    'vue': { onMounted: (fn: () => Promise<void>) => mounted.push(fn), onUnmounted: (fn: () => void) => disposed.push(fn), watch: () => {} },
    'vue-i18n': { useI18n: () => ({ locale: { value: 'ko-KR' } }) },
    'vue-router': { useRouter: () => ({ isReady: async () => {}, currentRoute: { value: { query: {} } }, replace: async () => {} }) },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({ label, setTitle: async () => {} }) },
    '@vueuse/core': { useEventListener: () => {} },
    './composables/useTauriListen': { useTauriListen: (event: string, fn: (event: { payload: unknown }) => void) => listeners.set(event, fn) },
    './composables/useWindowState': { useWindowState: () => ({ isRestored: { value: false }, restoreState: async () => {
      geometryRestores += 1
    } }) },
    './composables/menuViewportSetting': menuViewportSetting,
    './plugins/window': { showWindow: async () => {
      shown += 1
    } },
    './plugins/windowNavigation': windowNavigation,
    './constants': constants,
    './stores/app': { useAppStore: () => startedStore },
    './stores/block': { useBlockStore: () => block },
    './stores/general': { useGeneralStore: () => general },
    './stores/shortcut.ts': { useShortcutStore: () => startedStore },
  }
  const source = readFileSync(new URL('../App.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: {}, console: { error: (...args: unknown[]) => errors.push(args) }, require: (name: string) => mocks[name] ?? {} })
  return {
    start: () => Promise.all(mounted.map(fn => fn())),
    dispose: () => disposed.forEach(fn => fn()),
    geometryRestores: () => geometryRestores,
    send: (payload: unknown) => listeners.get(constants.LISTEN_KEY.MENU_VIEWPORT_SETTING_REQUEST)!({ payload }),
    restored,
    registerOwner: () => editRequests.registerPresetEditOwner((payload) => {
      if (menuViewportSetting.isMenuViewportSettingRequest(payload)) preset[payload.key] = payload.value
    }),
    writes,
    errors,
    preset,
    shown: () => shown,
    rendererShowRequests: () => rendererShowRequests,
    block,
    general,
    requestShow: () => listeners.get(constants.LISTEN_KEY.SHOW_WINDOW)!({ payload: label }),
  }
}

describe('menu viewport requests through the App listener', () => {
  it('applies desktop visibility to tray show requests while keeping Preferences accessible', async () => {
    for (const label of ['main', 'preference']) {
      const h = appHarness(label)
      const ready = h.start()
      h.restored.resolve()
      await ready
      for (const enabled of [false, true]) {
        for (const showOnDesktop of [false, true]) {
          for (const visible of [false, true]) {
            Object.assign(h.general.broadcast, { enabled, showOnDesktop })
            h.block.window.visible = visible
            const previous = label === 'main' ? h.rendererShowRequests() : h.shown()
            h.requestShow()
            await flush()
            const shouldShow = label === 'preference' || (visible && (!enabled || showOnDesktop))
            assert.equal((label === 'main' ? h.rendererShowRequests() : h.shown()) - previous, Number(shouldShow))
            if (label === 'main') assert.equal(h.shown(), 0, 'main visibility belongs to the renderer owner')
          }
        }
      }
      assert.deepEqual(h.errors, [])
    }
  })

  it('waits for persisted broadcast visibility before handling a startup tray show request', async () => {
    const h = appHarness('main')
    const ready = h.start()
    h.requestShow()
    await flush()
    assert.equal(h.shown(), 0)
    Object.assign(h.general.broadcast, { enabled: true, showOnDesktop: false })
    h.restored.resolve()
    await ready
    await flush()
    assert.equal(h.shown(), 0)
    assert.deepEqual(h.errors, [])
  })

  it('does not restore the default native size after App is disposed during settings startup', async () => {
    const h = appHarness('main')
    const started = h.start()
    await flush()
    h.dispose()
    h.restored.resolve()
    await started
    assert.equal(h.geometryRestores(), 0)

    const current = appHarness('main')
    const ready = current.start()
    current.restored.resolve()
    await ready
    assert.equal(current.geometryRestores(), 1)
  })

  it('retains requests during restore and applies them in order in the hidden preference window', async () => {
    const h = appHarness()
    const started = h.start()
    h.send({ key: 'cameraZoomPercent', value: 50 })
    h.send({ key: 'sceneRotationOffsetDegrees', value: 290 })
    h.send({ key: 'cameraZoomPercent', value: 125 })
    h.send({ key: 'sceneRotationOffsetDegrees', value: 0 })
    await flush()
    assert.deepEqual(h.writes, [])
    h.restored.resolve()
    await started
    await flush()
    assert.deepEqual(h.writes, [['cameraZoomPercent', 78]])
    const stopOwner = h.registerOwner()
    assert.deepEqual(h.writes, [
      ['cameraZoomPercent', 78],
      ['cameraZoomPercent', 50],
      ['sceneRotationOffsetDegrees', 290],
      ['cameraZoomPercent', 125],
      ['sceneRotationOffsetDegrees', 0],
    ])
    assert.equal(h.preset.sceneRotationOffsetDegrees, 0)
    assert.equal(h.shown(), 0)
    assert.deepEqual(h.errors, [])
    stopOwner()
  })

  it('lets only Preferences apply menu requests and ignores invalid settings', async () => {
    for (const label of ['main', 'preference']) {
      const h = appHarness(label)
      const started = h.start()
      h.restored.resolve()
      await started
      h.writes.length = 0
      for (const payload of [
        null,
        'cameraZoomPercent',
        { key: 'mouseEnabled', value: 50 },
        { key: 'cameraZoomPercent', value: 24 },
        ...[24, 70].map(value => ({ key: 'cameraZoomPercent', value })),
        ...[270, 315, 360].map(value => ({ key: 'sceneRotationOffsetDegrees', value })),
      ]) {
        h.send(payload)
      }
      if (label === 'main') h.send({ key: 'cameraZoomPercent', value: 50 })
      await flush()
      assert.deepEqual(h.writes, [])
    }
  })

  it('reports a failed request and still processes the next one', async () => {
    const applied: number[] = []
    const handler = menuViewportSetting.createMenuViewportSettingHandler({
      ready: async () => {},
      apply: ({ value }) => {
        if (value === 50) throw new Error('setting failed')
        applied.push(value)
      },
    })
    const first = handler({ key: 'cameraZoomPercent', value: 50 })
    const second = handler({ key: 'cameraZoomPercent', value: 100 })
    await assert.rejects(first, /setting failed/)
    await second
    assert.deepEqual(applied, [100])
  })
})
