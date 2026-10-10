/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

import * as presetOperations from '@/features/presets/operations'
import { createQuiescenceOwner } from '@/features/stateSafety/quiescence'
import { saveSynchronizedSettings } from '@/utils/settingsPersistence'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

function quitHarness(ownerSubscriptionFailures = 0, actualRuntime = false) {
  type Api = typeof import('./process')
  type Handler = (event: { payload: any }) => unknown
  const handlers = new Map<string, Set<Handler>>()
  const timers = new Map<number, { callback: () => void, delay: number }>()
  const calls: string[] = []
  const errors: unknown[] = []
  const locked = vue.ref(false)
  const runtimes: Array<typeof import('@/features/stateSafety/runtime')> = []
  let nativeLease: string | undefined
  let beginReplyHold: ReturnType<typeof deferred> | undefined
  let timerId = 0
  let now = 1000
  let ready = true
  let failure: 'read' | 'save' | 'verify' | 'exit' | 'restart' | undefined
  let backendHold: ReturnType<typeof deferred> | undefined
  let subscribeHold: ReturnType<typeof deferred> | undefined
  const frontend = { opacity: 75, presetCollection: { activeId: 'edited', opacity: 75 } }
  let backend = structuredClone(frontend)
  let disk = structuredClone(frontend)
  const nativeExit = () => {
    if (failure === 'exit') throw new Error('exit permission denied')
    calls.push('exit')
    disk = structuredClone(backend)
  }
  const source = ts.transpileModule(readFileSync(new URL('./process.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  function window(label: string) {
    const exports = {} as Api
    const mocks: Record<string, unknown> = {
      '@/features/presets/operations': presetOperations,
      '@/services/diagnostics': { reportDiagnostic: () => {} },
      '@tauri-apps/api/core': { invoke: async (command: string, args?: { requestId: string }) => {
        calls.push(command)
        if (command === 'restart_application') {
          if (failure === 'restart') throw new Error('restart unavailable')
          disk = structuredClone(backend)
        }
        if (command === 'begin_state_quiescence') {
          if (nativeLease) throw new Error('OPERATION_BUSY')
          nativeLease = args!.requestId
          await beginReplyHold?.promise
        }
        if (command === 'acknowledge_state_quiescence' && nativeLease !== args!.requestId) throw new Error('QUIESCE_CANCELLED')
        if (command === 'release_state_quiescence' && nativeLease === args!.requestId) nativeLease = undefined
        if (command === 'verify_state_quiescence') {
          if (failure === 'verify') throw new Error('SAVE_VERIFICATION_FAILED')
          assert.equal(nativeLease, args!.requestId)
          assert.deepEqual(disk, backend)
        }
      } },
      '@tauri-apps/api/event': {
        emit: async (event: string, payload: unknown) => {
          for (const [key, callbacks] of handlers) {
            if (key.endsWith(`:${event}`)) {
              for (const callback of [...callbacks]) Promise.resolve(callback({ payload })).catch(error => errors.push(error))
            }
          }
        },
        listen: async (event: string, handler: Handler) => {
          if (event === 'app-process-request' && ownerSubscriptionFailures > 0) {
            ownerSubscriptionFailures--
            throw new Error('owner subscription failed')
          }
          await subscribeHold?.promise
          const key = `${label}:${event}`
          const listeners = handlers.get(key) ?? new Set()
          listeners.add(handler)
          handlers.set(key, listeners)
          return () => {
            listeners.delete(handler)
          }
        },
        emitTo: async (target: string, event: string, payload: unknown) => {
          for (const handler of [...(handlers.get(`${target}:${event}`) ?? [])]) {
            Promise.resolve(handler({ payload })).catch(error => errors.push(error))
          }
        },
      },
      '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({ label, isVisible: async () => true }) },
      '@tauri-apps/api/app': { getVersion: async () => '1.0.0' },
      '@tauri-apps/plugin-process': { exit: async () => nativeExit() },
      '@tauri-store/pinia': {
        getStoreState: async () => {
          if (failure === 'read') throw new Error('read failed')
          await backendHold?.promise
          return backend
        },
        saveAllNow: async () => {
          if (failure === 'save') throw new Error('disk full')
          disk = structuredClone(backend)
          calls.push('save')
        },
      },
      'vue': vue,
      '@/features/stateSafety': {
        editorsLocked: locked,
        quiesceEditors: async () => {
          assert.equal(label, 'preference', 'only the authoritative preference owner may save for Quit')
          calls.push('quiesce')
          locked.value = true
          await saveSynchronizedSettings({
            flushFrontend: async () => {},
            snapshots: () => [{ id: 'cat', state: frontend }],
            readBackend: async () => {
              if (failure === 'read') throw new Error('read failed')
              await backendHold?.promise
              return backend
            },
            saveNow: async () => {
              if (failure === 'save') throw new Error('disk full')
              disk = structuredClone(backend)
              calls.push('save')
            },
          })
        },
        releaseEditors: async () => {
          calls.push('release')
          locked.value = false
        },
      },
      '@/stores/app': {},
      '@/stores/block': {},
      '@/stores/general': {},
      '@/stores/shortcut': {},
      '@/utils/settingsPersistence': { saveSynchronizedSettings },
    }
    const context = {
      exports,
      require: (name: string) => mocks[name],
      console: { error: (error: unknown) => errors.push(error) },
      crypto: globalThis.crypto,
      Date: class extends Date {
        static now() {
          return now
        }
      },
      setTimeout: (callback: () => void, delay: number) => {
        timers.set(++timerId, { callback, delay })
        return timerId
      },
      clearTimeout: (id: number) => timers.delete(id),
    }
    if (actualRuntime) {
      const runtime = {} as typeof import('@/features/stateSafety/runtime')
      const runtimeLocked = label === 'preference' ? locked : vue.ref(false)
      Object.assign(mocks, {
        './bridge': { editorsLocked: runtimeLocked, stateOwners: { flushPresets: async () => true, presetsReady: () => ready && presetOperations.presetNativeEditPending.value === 0 }, shortcutWarnings: new Set() },
        './quiescence': { createQuiescenceOwner },
        '@/plugins/window': { setWindowMemoryActive: async () => {} },
        '@/services/skinLibrary': { listSkinLibraryEntries: async () => [] },
      })
      const runtimeSource = ts.transpileModule(readFileSync(new URL('../features/stateSafety/runtime.ts', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText
      runInNewContext(runtimeSource, { ...context, exports: runtime, performance, Uint8Array, document: { addEventListener: () => {}, removeEventListener: () => {} } })
      runtime.registerStateSnapshots(() => [{ id: 'cat', state: frontend }])
      runtime.markStoresReady()
      mocks['@/features/stateSafety'] = runtime
      runtimes.push(runtime)
    }
    runInNewContext(source, context)
    return exports
  }
  const main = window('main')
  const preference = window('preference')
  const register = () => preference.registerAppProcessOwner(() => ready && presetOperations.presetNativeEditPending.value === 0)
  const stop = register()
  return {
    main,
    preference,
    calls,
    errors,
    locked,
    register,
    stop,
    runtimes,
    nativeLease: () => nativeLease,
    holdBeginReply: () => {
      beginReplyHold = deferred()
      return () => beginReplyHold?.resolve()
    },
    disk: () => disk,
    setReady: (value: boolean) => {
      ready = value
    },
    fail: (value: typeof failure) => {
      failure = value
    },
    holdPatch: () => {
      backend = { opacity: 100, presetCollection: { activeId: 'old', opacity: 100 } }
      backendHold = deferred()
      return () => {
        backend = structuredClone(frontend)
        backendHold?.resolve()
      }
    },
    holdSubscription: () => {
      subscribeHold = deferred()
      return () => {
        subscribeHold?.resolve()
        subscribeHold = undefined
      }
    },
    listenerCount: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
    tick: async (delay: number) => {
      now += delay
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) {
          timers.delete(id)
          timer.callback()
        }
      }
      await flush()
    },
  }
}

describe('preference-owned application restart', () => {
  it('coalesces Main restart requests and waits for the authoritative patch and durable save', async () => {
    for (const delayed of [false, true]) {
      const h = quitHarness(0, true)
      await Promise.all(h.runtimes.map(runtime => runtime.initializeStateSafety()))
      const patch = delayed ? h.holdPatch() : () => {}
      const restart = h.main.restartApp()
      assert.equal(h.main.restartApp(), restart)
      await assert.rejects(h.main.quitApp(), /BUSY/, 'a concurrent Quit cannot replace a requested restart')
      await flush()
      if (delayed) assert.equal(h.calls.includes('restart_application'), false)
      patch()
      await restart
      assert.equal(h.calls.filter(call => call === 'restart_application').length, 1)
      assert.equal(h.calls.includes('exit'), false)
      assert.ok(h.calls.indexOf('save') < h.calls.indexOf('restart_application'))
      assert.deepEqual(h.disk(), { opacity: 75, presetCollection: { activeId: 'edited', opacity: 75 } })
      for (const runtime of h.runtimes) runtime.disposeStateSafety()
      h.stop()
    }
  })

  it('keeps the app running on read or save failure and permits a later restart retry', async () => {
    for (const failure of ['read', 'save'] as const) {
      const h = quitHarness()
      await flush()
      h.fail(failure)
      await assert.rejects(h.main.restartApp())
      assert.equal(h.calls.includes('restart_application'), false)
      h.fail(undefined)
      await h.main.restartApp()
      assert.equal(h.calls.filter(call => call === 'restart_application').length, 1)
      h.stop()
    }
  })

  it('propagates native restart refusal, releases the lease and permits retry', async () => {
    const h = quitHarness(0, true)
    await Promise.all(h.runtimes.map(runtime => runtime.initializeStateSafety()))
    h.fail('restart')
    await assert.rejects(h.main.restartApp())
    assert.equal(h.nativeLease(), undefined)
    assert.equal(h.locked.value, false)
    h.fail(undefined)
    await h.main.restartApp()
    assert.equal(h.calls.filter(call => call === 'restart_application').length, 2)
    for (const runtime of h.runtimes) runtime.disposeStateSafety()
    h.stop()
  })
})

describe('preference-owned application Quit', () => {
  it('retires a background query before readiness without waiting for its ten-second reply timeout', async () => {
    for (const action of ['quit', 'restart'] as const) {
      const h = quitHarness(0, true)
      await Promise.all(h.runtimes.map(runtime => runtime.initializeStateSafety()))
      let queryCancelled = false
      const releaseQuery = presetOperations.beginPresetNativeQuery(() => {
        queryCancelled = true
        releaseQuery()
      })
      const request = action === 'quit' ? h.main.quitApp() : h.main.restartApp()
      const settled = request.catch(() => {})
      try {
        await flush()
        assert.equal(queryCancelled, true, 'a read-only query must not hold process readiness')
        assert.equal(presetOperations.presetNativeEditPending.value, 0)
        await request
        const nativeAction = action === 'quit' ? 'exit' : 'restart_application'
        assert.ok(h.calls.indexOf('verify_state_quiescence') < h.calls.indexOf(nativeAction))
        assert.deepEqual(h.disk(), { opacity: 75, presetCollection: { activeId: 'edited', opacity: 75 } })
      } finally {
        releaseQuery()
        await h.tick(30_000)
        await settled
        for (const runtime of h.runtimes) runtime.disposeStateSafety()
        h.stop()
      }
    }
  })

  it('still waits for actual native edits after retiring queries, including new queries during that wait', async () => {
    const h = quitHarness(0, true)
    await Promise.all(h.runtimes.map(runtime => runtime.initializeStateSafety()))
    const releaseEdit = presetOperations.beginPresetNativeEdit()
    const quit = h.main.quitApp()
    const settled = quit.catch(() => {})
    let releaseQuery: (() => void) | undefined
    try {
      await flush()
      assert.equal(h.calls.includes('quiesce'), false)
      assert.equal(h.calls.includes('exit'), false)
      releaseQuery = presetOperations.beginPresetNativeQuery(() => releaseQuery?.())
      releaseEdit()
      await h.tick(25)
      await quit
      assert.equal(presetOperations.presetNativeEditPending.value, 0)
      assert.ok(h.calls.indexOf('verify_state_quiescence') < h.calls.indexOf('exit'))
    } finally {
      releaseQuery?.()
      releaseEdit()
      await h.tick(30_000)
      await settled
      for (const runtime of h.runtimes) runtime.disposeStateSafety()
      h.stop()
    }
  })

  it('uses the actual two-window runtime readback and durable save before Exit for fast and delayed patches', async () => {
    for (const delayed of [false, true]) {
      const h = quitHarness(0, true)
      await Promise.all(h.runtimes.map(runtime => runtime.initializeStateSafety()))
      const patch = delayed ? h.holdPatch() : () => {}
      const quit = h.main.quitApp()
      await flush()
      if (delayed) assert.equal(h.calls.includes('exit'), false)
      patch()
      await quit
      assert.equal(h.calls.filter(call => call === 'acknowledge_state_quiescence').length, 2)
      assert.ok(h.calls.indexOf('save') < h.calls.indexOf('exit'))
      assert.deepEqual(h.disk(), { opacity: 75, presetCollection: { activeId: 'edited', opacity: 75 } })
      for (const runtime of h.runtimes) runtime.disposeStateSafety()
      h.stop()
    }
  })
  it('releases a late native begin response through actual runtime acknowledgement failure after Quit expires', async () => {
    const h = quitHarness(0, true)
    await Promise.all(h.runtimes.map(runtime => runtime.initializeStateSafety()))
    const reply = h.holdBeginReply()
    const quit = h.main.quitApp()
    const rejected = assert.rejects(quit)
    await flush()
    assert.ok(h.nativeLease(), 'the synchronous native begin created the lease before its IPC reply')
    await h.tick(30_000)
    await rejected
    assert.equal(h.nativeLease(), undefined, 'deadline cleanup released the actual native lease')
    reply()
    await flush()
    assert.ok(h.calls.includes('acknowledge_state_quiescence'), 'late freeze reaches native validation, which rejects the released identity')
    await flush()
    assert.equal(h.nativeLease(), undefined)
    assert.equal(h.calls.includes('exit'), false)
    for (const runtime of h.runtimes) {
      assert.equal(runtime.editorsLocked.value, false)
      assert.deepEqual(runtime.filterBackendSync({ current: true }), { current: true })
      runtime.disposeStateSafety()
    }
    h.stop()
  })
  it('retries a failed owner subscription and removes retries on disposal', async () => {
    const h = quitHarness(1)
    await flush()
    assert.equal(h.listenerCount(), 0)
    await h.tick(1000)
    assert.equal(h.listenerCount(), 1)
    await h.main.quitApp()
    assert.equal(h.calls.filter(call => call === 'exit').length, 1)
    h.stop()
    const disposed = quitHarness(1)
    await flush()
    disposed.stop()
    await disposed.tick(1000)
    assert.equal(disposed.listenerCount(), 0)
  })
  it('coalesces clicks, preserves the authoritative catalog, and saves before native Exit', async () => {
    for (const delayed of [false, true]) {
      const h = quitHarness()
      await flush()
      const applyPatch = delayed ? h.holdPatch() : () => {}
      const quit = h.main.quitApp()
      assert.equal(h.main.quitApp(), quit)
      await flush()
      if (delayed) assert.equal(h.calls.includes('exit'), false)
      applyPatch()
      await quit
      assert.equal(h.calls.filter(call => call === 'exit').length, 1)
      assert.ok(h.calls.indexOf('save') < h.calls.indexOf('exit'))
      assert.deepEqual(h.disk(), { opacity: 75, presetCollection: { activeId: 'edited', opacity: 75 } })
      assert.equal(h.locked.value, true, 'writers stay frozen until native Exit')
      h.stop()
    }
  })

  it('waits for an initializing or busy preset owner and cancels disposed or replaced owners', async () => {
    for (const replaced of [false, true]) {
      const h = quitHarness()
      h.setReady(false)
      await flush()
      const quit = h.main.quitApp()
      const rejection = assert.rejects(quit)
      await flush()
      assert.equal(h.calls.includes('quiesce'), false)
      const stopReplacement = replaced ? h.register() : () => {}
      if (!replaced) h.stop()
      h.setReady(true)
      await h.tick(25)
      await rejection
      assert.equal(h.calls.includes('exit'), false)
      h.stop()
      stopReplacement()
    }
    const h = quitHarness()
    h.setReady(false)
    await flush()
    const quit = h.main.quitApp()
    await flush()
    h.setReady(true)
    await h.tick(25)
    await quit
    assert.equal(h.calls.at(-1), 'exit')
    h.stop()
  })

  it('keeps the app open on disk or exit-permission failure and permits retry', async () => {
    for (const failure of ['save', 'exit'] as const) {
      const h = quitHarness()
      await flush()
      h.fail(failure)
      await assert.rejects(h.main.quitApp())
      assert.equal(h.calls.includes('exit'), false)
      assert.equal(h.locked.value, false)
      h.fail(undefined)
      await h.main.quitApp()
      assert.equal(h.calls.filter(call => call === 'exit').length, 1)
      h.stop()
    }
  })

  it('never exits after the request deadline or a late subscription', async () => {
    for (const boundary of ['save', 'subscription'] as const) {
      const h = quitHarness()
      await flush()
      const release = boundary === 'save' ? h.holdPatch() : h.holdSubscription()
      const quit = h.main.quitApp()
      const rejection = assert.rejects(quit)
      await flush()
      await h.tick(30_000)
      await rejection
      release()
      await flush()
      assert.equal(h.calls.includes('exit'), false)
      assert.equal(h.listenerCount(), 1, 'only the live preference owner remains subscribed')
      h.stop()
    }
  })

  it('verifies the final saved state before exiting and never contacts an updater', async () => {
    const h = quitHarness(0, true)
    await Promise.all(h.runtimes.map(runtime => runtime.initializeStateSafety()))
    await h.main.quitApp()
    assert.ok(h.calls.indexOf('save') < h.calls.indexOf('verify_state_quiescence'))
    assert.ok(h.calls.indexOf('verify_state_quiescence') < h.calls.indexOf('exit'))
    assert.equal(h.calls.some(call => call.startsWith('update_')), false)
    for (const runtime of h.runtimes) runtime.disposeStateSafety()
    h.stop()
  })

  it('keeps the app alive when another editor operation owns the write lock', async () => {
    const h = quitHarness()
    await flush()
    h.locked.value = true
    await assert.rejects(h.main.quitApp())
    assert.equal(h.calls.includes('quiesce'), false)
    assert.equal(h.calls.includes('exit'), false)
    h.stop()
  })

  it('keeps the app alive on disk verification failure and releases both window leases', async () => {
    const h = quitHarness(0, true)
    await Promise.all(h.runtimes.map(runtime => runtime.initializeStateSafety()))
    h.fail('verify')
    await assert.rejects(h.main.quitApp())
    assert.equal(h.calls.includes('exit'), false)
    assert.equal(h.nativeLease(), undefined)
    assert.equal(h.locked.value, false)
    h.fail(undefined)
    await h.main.quitApp()
    assert.equal(h.calls.filter(call => call === 'exit').length, 1)
    for (const runtime of h.runtimes) runtime.disposeStateSafety()
    h.stop()
  })
})
