/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

import { saveSynchronizedSettings } from '@/utils/settingsPersistence'

import { createQuiescenceOwner } from './quiescence'

type Runtime = typeof import('./runtime')
type Handler = (event: { payload: any }) => unknown
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const source = ts.transpileModule(readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const deliverySource = ts.transpileModule(readFileSync(new URL('../../services/updateDelivery.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const pendingOperation = { requestId: 'a'.repeat(32), phase: 'awaitingHealth', expectedVersion: '1.0.0', sourceVersion: '1.0.0', warnings: [], rendered: false }
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve))
}
function harness() {
  const listeners = new Map<string, Set<Handler>>()
  const timers = new Map<number, { delay: number, callback: () => void }>()
  const commands: Array<{ label: string, command: string, args?: any }> = []
  let timerId = 0
  let state: any = null
  let statusHold: Promise<any> | undefined
  let releaseHold: Promise<void> | undefined
  let releaseEventHold: Promise<void> | undefined
  let failedSubscription: string | undefined
  let failedCommand: string | undefined
  let failedEvent: string | undefined
  let failBeforeEventDelivery = false
  let acknowledgedPhase = 'verified'
  const errors: unknown[] = []
  const emit = async (event: string, payload?: unknown) => {
    if (event === failedEvent && failBeforeEventDelivery) throw new Error('event delivery failed')
    for (const callback of [...(listeners.get(event) ?? [])]) {
      Promise.resolve(callback({ payload })).catch(error => errors.push(error))
    }
    if (event === 'update-quiesce-release' && releaseEventHold) {
      const held = releaseEventHold
      releaseEventHold = undefined
      await held
    }
    if (event === failedEvent) throw new Error('event delivery failed')
  }
  function window(label: string) {
    const owners: { flushPresets?: () => Promise<boolean>, presetsReady?: () => boolean } = { flushPresets: async () => true, presetsReady: () => true }
    const bridge = { updateEditorsLocked: vue.ref(false), updateOwners: owners, shortcutWarnings: new Set<string>(), registerUpdatePresetFlush: (flush: () => Promise<boolean>, ready: () => boolean = () => true) => {
      owners.flushPresets = flush
      owners.presetsReady = ready
      return () => {
        if (owners.flushPresets === flush) {
          owners.flushPresets = undefined
          owners.presetsReady = undefined
        }
      }
    }, reportUpdateShortcutConflict: (key: string) => bridge.shortcutWarnings.add(key) }
    const exports = {} as Runtime
    const documentListeners = new Set<unknown>()
    const stores = { cat: { presetCollection: { activeId: 'initial', entries: [] } }, app: {}, general: {}, shortcut: {} }
    const context = {
      exports,
      console,
      crypto: globalThis.crypto,
      performance,
      Uint8Array,
      Array,
      Set,
      Error,
      document: { addEventListener: (_event: string, handler: unknown) => documentListeners.add(handler), removeEventListener: (_event: string, handler: unknown) => documentListeners.delete(handler) },
      setTimeout: (callback: () => void, delay: number) => {
        const id = ++timerId
        timers.set(id, { callback, delay })
        return id
      },
      clearTimeout: (id: number) => timers.delete(id),
      require(name: string) {
        if (name === 'vue') return vue
        if (name === './bridge') return bridge
        if (name === './quiescence') return { createQuiescenceOwner }
        if (name === '@/features/updateRecovery') return exports
        if (name === '@/utils/settingsPersistence') return { saveSynchronizedSettings }
        if (name === '@/services/skinLibrary') return { listSkinLibraryEntries: async () => [] }
        if (name === '@/plugins/window') return { setWindowMemoryActive: async () => undefined }
        if (name === '@tauri-apps/api/app') return { getVersion: async () => '1.0.0' }
        if (name === '@tauri-store/pinia') return { getStoreState: async (id: keyof typeof stores) => stores[id], saveAllNow: async () => undefined }
        if (name === '@tauri-apps/api/webviewWindow') return { getCurrentWebviewWindow: () => ({ label, isVisible: async () => false }) }
        if (name === '@tauri-apps/api/event') {
          return { emit, listen: async (event: string, handler: Handler) => {
            if (event === failedSubscription) throw new Error('subscription failure')
            const callbacks = listeners.get(event) ?? new Set()
            callbacks.add(handler)
            listeners.set(event, callbacks)
            return () => callbacks.delete(handler)
          } }
        }
        if (name === '@tauri-apps/api/core') {
          return { invoke: async (command: string, args?: any) => {
            commands.push({ label, command, args })
            if (failedCommand === command) throw new Error('native preparation failed')
            if (command === 'release_update_quiescence' && releaseHold) {
              const held = releaseHold
              releaseHold = undefined
              return held
            }
            if (command === 'update_recovery_status') return statusHold ?? state
            if (command === 'update_get_status') return { revision: 0, phase: 'idle' }
            if (command === 'acknowledge_update_health') {
              state = { ...state, warnings: [...state.warnings], phase: acknowledgedPhase, rendered: true }
              await emit('update-recovery-status', state)
              return state
            }
            return undefined
          } }
        }
        throw new Error(`Unexpected dependency ${name}`)
      },
    }
    runInNewContext(source, context)
    const delivery = {} as typeof import('../../services/updateDelivery')
    runInNewContext(deliverySource, { ...context, exports: delivery })
    exports.registerUpdateSnapshots(() => Object.entries(stores).map(([id, state]) => ({ id, state })))
    exports.markUpdateStoresReady()
    return { runtime: exports, delivery, owners, documentListeners }
  }
  return { window, commands, errors, emit, timers, state: (value: any) => {
    state = value
  }, acknowledgeAs: (phase: string) => {
    acknowledgedPhase = phase
  }, status: (value?: Promise<any>) => {
    statusHold = value
  }, holdNextRelease: (value: Promise<void>) => {
    releaseHold = value
  }, holdNextReleaseEvent: (value: Promise<void>) => {
    releaseEventHold = value
  }, failCommand: (command?: string) => {
    failedCommand = command
  }, failEvent: (event?: string, beforeDelivery = false) => {
    failedEvent = event
    failBeforeEventDelivery = beforeDelivery
  }, failSubscription: (event: string) => {
    failedSubscription = event
  }, listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0) }
}

test('data health keeps writers frozen until the program commit is verified', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  h.state({ ...pendingOperation })
  h.acknowledgeAs('awaitingCommit')
  await main.runtime.initializeUpdateRecovery()
  await preference.runtime.initializeUpdateRecovery()
  main.runtime.setUpdateHealthRenderer(async () => true)
  await settle()
  assert.equal(main.runtime.updateRecovery.value?.phase, 'awaitingCommit')
  assert.equal(main.runtime.updateEditorsLocked.value, true)
  assert.equal(preference.runtime.updateEditorsLocked.value, true)
  assert.equal(main.runtime.filterUpdateBackendSync({ value: 1 }), undefined)
  assert.equal(h.commands.filter(item => item.command === 'release_update_quiescence').length, 0)
  const committed = { ...pendingOperation, phase: 'verified', rendered: true }
  h.state(committed)
  await h.emit('update-recovery-status', committed)
  await settle()
  assert.equal(main.runtime.updateEditorsLocked.value, false)
  assert.equal(preference.runtime.updateEditorsLocked.value, false)
  assert.deepEqual(main.runtime.filterUpdateBackendSync({ value: 1 }), { value: 1 })
  assert.equal(h.commands.filter(item => item.command === 'acknowledge_update_health').length, 1)
  main.runtime.disposeUpdateRecovery()
  preference.runtime.disposeUpdateRecovery()
})

test('actual runtime serializes simultaneous health requests before its first native await', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  await main.runtime.initializeUpdateRecovery()
  await preference.runtime.initializeUpdateRecovery()
  const gate = deferred<any>()
  h.state(pendingOperation)
  h.status(gate.promise)
  main.runtime.setUpdateHealthRenderer(async () => true)
  await main.runtime.checkUpdateHealth()
  await h.emit('update-health-recheck')
  assert.equal(h.commands.filter(item => item.command === 'update_recovery_status').length, 3)
  gate.resolve(pendingOperation)
  h.status()
  await settle()
  assert.equal(h.commands.filter(item => item.command === 'begin_update_quiescence').length, 1)
  assert.equal(h.commands.filter(item => item.command === 'acknowledge_update_quiescence').length, 2)
  assert.equal(h.commands.filter(item => item.command === 'acknowledge_update_health').length, 1)
  assert.equal(main.runtime.updateRecovery.value?.phase, 'verified')
  assert.deepEqual(h.errors, [])
})

test('pending update health completes after late preset readiness before manual recheck', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  const initialization = deferred<void>()
  let presetReady = false
  let presetBusy = true
  let prematureFlushes = 0
  let flushes = 0
  let rendered = 0
  // usePresetManager registers this owner during setup, before its mounted
  // initialize() finishes applying the restored preset and clears localBusy.
  const unregister = preference.runtime.registerUpdatePresetFlush(async () => {
    flushes++
    if (!presetReady || presetBusy) {
      prematureFlushes++
      return false
    }
    return true
  }, () => presetReady && !presetBusy)
  const initialized = initialization.promise.then(() => {
    presetReady = true
    presetBusy = false
  })
  try {
    h.state({ ...pendingOperation })
    await main.runtime.initializeUpdateRecovery()
    await preference.runtime.initializeUpdateRecovery()
    main.runtime.setUpdateHealthRenderer(async () => {
      rendered++
      return true
    })
    await settle()
    assert.equal(flushes, 0, 'registered owner must not flush during preset initialization')
    assert.equal(rendered, 0, 'health cannot render before the preset owner is ready')
    assert.equal(h.commands.filter(item => item.command === 'acknowledge_update_health').length, 0)
    assert.equal(h.commands.filter(item => item.command === 'confirm_update_failure').length, 0)

    initialization.resolve()
    await initialized
    // Advance the existing readiness polling boundary, without firing the
    // unrelated 120-second ambiguity timer or manufacturing a backend event.
    for (const [id, timer] of [...h.timers]) {
      if (timer.delay === 25) {
        h.timers.delete(id)
        timer.callback()
      }
    }
    await settle()
    const automaticAcknowledgements = h.commands.filter(item => item.command === 'acknowledge_update_health').length
    assert.equal(flushes, 1, 'readiness must release exactly one preset flush')
    assert.equal(prematureFlushes, 0)

    // Control: once ready, the same stores/owner/renderer can finish through
    // the existing manual path. This must not conceal a missing automatic run.
    await main.runtime.checkUpdateHealth()
    await settle()
    assert.equal(h.commands.filter(item => item.command === 'acknowledge_update_health').length, 1)
    assert.equal(rendered, 1)
    assert.equal(main.runtime.updateRecovery.value?.phase, 'verified')
    assert.equal(h.commands.filter(item => item.command === 'confirm_update_failure').length, 0)
    assert.deepEqual(h.errors, [])
    assert.equal(automaticAcknowledgements, 1, `late preset initialization needs no manual recheck (${prematureFlushes} premature flushes)`)
  } finally {
    unregister()
    main.runtime.disposeUpdateRecovery()
    preference.runtime.disposeUpdateRecovery()
  }
})

test('a ready preset owner flush rejection is not retried or accepted as health', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  let flushes = 0
  const unregister = preference.runtime.registerUpdatePresetFlush(async () => {
    flushes++
    return false
  }, () => true)
  try {
    h.state({ ...pendingOperation })
    await main.runtime.initializeUpdateRecovery()
    await preference.runtime.initializeUpdateRecovery()
    main.runtime.setUpdateHealthRenderer(async () => true)
    await settle()
    assert.equal(flushes, 1)
    assert.equal([...h.timers.values()].filter(timer => timer.delay === 25).length, 0)
    assert.equal(h.commands.filter(item => item.command === 'acknowledge_update_health').length, 0)
    assert.equal(h.commands.filter(item => item.command === 'confirm_update_failure').length, 0)
    assert.equal(main.runtime.updateRecovery.value?.phase, 'awaitingHealth')
    assert.deepEqual(h.errors, [])
  } finally {
    unregister()
    main.runtime.disposeUpdateRecovery()
    preference.runtime.disposeUpdateRecovery()
  }
})

test('late owner completion and stale release cannot freeze or unlock the next runtime lease', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  await main.runtime.initializeUpdateRecovery()
  await preference.runtime.initializeUpdateRecovery()
  const flush = deferred<boolean>()
  preference.owners.flushPresets = () => flush.promise
  const first = preference.runtime.quiesceUpdateEditors('first').catch(error => error.message)
  await settle()
  for (const timer of [...h.timers.values()]) {
    if (timer.delay === 15000) timer.callback()
  }
  assert.equal(await first, 'QUIESCE_TIMEOUT')
  preference.owners.flushPresets = async () => true
  await preference.runtime.quiesceUpdateEditors('second')
  flush.resolve(true)
  await settle()
  await h.emit('update-quiesce-release', { requestId: 'first' })
  await preference.runtime.releaseUpdateEditors('first')
  assert.equal(main.runtime.updateEditorsLocked.value, true)
  assert.equal(preference.runtime.filterUpdateBackendSync({ value: 1 }), undefined)
  assert.equal(h.commands.filter(item => item.command === 'acknowledge_update_quiescence' && item.args.requestId === 'first' && item.label === 'preference').length, 0)
  await preference.runtime.releaseUpdateEditors('second')
  await settle()
  assert.equal(main.runtime.updateEditorsLocked.value, false)
  assert.equal(preference.runtime.updateEditorsLocked.value, false)
})

test('startup subscriptions own newer state and partial subscription failure disposes listeners', async () => {
  const h = harness()
  const main = h.window('main')
  const query = deferred<any>()
  h.status(query.promise)
  const starting = main.runtime.initializeUpdateRecovery()
  await settle()
  await h.emit('update-recovery-status', pendingOperation)
  query.resolve(null)
  await starting
  assert.equal(main.runtime.updateRecovery.value?.requestId, pendingOperation.requestId)
  assert.equal(main.runtime.updateEditorsLocked.value, true)
  main.runtime.disposeUpdateRecovery()
  assert.equal(h.listenerCount(), 0)
  assert.equal(main.documentListeners.size, 0)
  const failed = harness()
  failed.failSubscription('update-quiesce-request')
  await assert.rejects(failed.window('main').runtime.initializeUpdateRecovery(), /subscription failure/)
  assert.equal(failed.listenerCount(), 0)
})

test('barrier subscription or acquisition failures retain pending health instead of confirming data failure', async () => {
  for (const boundary of ['subscribe', 'acquire']) {
    const h = harness()
    const main = h.window('main')
    const preference = h.window('preference')
    h.state(pendingOperation)
    await main.runtime.initializeUpdateRecovery()
    await preference.runtime.initializeUpdateRecovery()
    if (boundary === 'subscribe') h.failSubscription('update-quiesce-response')
    else h.failCommand('begin_update_quiescence')
    main.runtime.setUpdateHealthRenderer(async () => true)
    await settle()
    assert.equal(h.commands.filter(item => item.command === 'confirm_update_failure').length, 0)
    assert.equal(main.runtime.updateRecovery.value?.phase, 'awaitingHealth')
    assert.equal(h.commands.filter(item => item.command === 'release_update_quiescence').length, boundary === 'subscribe' ? 1 : 0)
  }
})

test('a release error after durable acknowledgement cannot turn verified recovery into rollback', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  h.state(pendingOperation)
  await main.runtime.initializeUpdateRecovery()
  await preference.runtime.initializeUpdateRecovery()
  h.failCommand('release_update_quiescence')
  main.runtime.setUpdateHealthRenderer(async () => true)
  await settle()
  assert.equal(main.runtime.updateRecovery.value?.phase, 'verified')
  assert.equal(main.runtime.updateRecovery.value?.warnings.includes('QUIESCENCE_RELEASE_DEFERRED'), true)
  assert.equal(h.commands.filter(item => item.command === 'confirm_update_failure').length, 0)
  assert.equal(main.runtime.updateEditorsLocked.value, true)
  assert.equal(preference.runtime.updateEditorsLocked.value, true)
  assert.equal(main.runtime.filterUpdateBackendSync({ value: 1 }), undefined)
  const retry = [...h.timers.entries()].find(([, timer]) => timer.delay === 2000)
  assert.ok(retry, 'verified recovery must retry its deferred lease cleanup without user intervention')
  h.timers.delete(retry[0])
  retry[1].callback()
  await settle()
  assert.equal(main.runtime.updateEditorsLocked.value, true)
  assert.equal(main.runtime.updateRecovery.value?.warnings.filter(warning => warning === 'QUIESCENCE_RELEASE_DEFERRED').length, 1)
  const nextRetry = [...h.timers.entries()].find(([, timer]) => timer.delay === 2000)
  assert.ok(nextRetry)
  h.failCommand()
  h.timers.delete(nextRetry[0])
  nextRetry[1].callback()
  await settle()
  assert.equal(main.runtime.updateRecovery.value?.phase, 'verified')
  assert.equal(main.runtime.updateRecovery.value?.warnings.includes('QUIESCENCE_RELEASE_DEFERRED'), false)
  assert.equal(main.runtime.updateEditorsLocked.value, false)
  assert.equal(preference.runtime.updateEditorsLocked.value, false)
  assert.deepEqual(main.runtime.filterUpdateBackendSync({ value: 1 }), { value: 1 })
  assert.equal(h.commands.filter(item => item.command === 'acknowledge_update_health').length, 1)
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 2000).length, 0)
  main.runtime.disposeUpdateRecovery()
  preference.runtime.disposeUpdateRecovery()
})

test('verified recovery retries a release event that never reached its frozen windows', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  h.state(pendingOperation)
  await main.runtime.initializeUpdateRecovery()
  await preference.runtime.initializeUpdateRecovery()
  h.failEvent('update-quiesce-release', true)
  main.runtime.setUpdateHealthRenderer(async () => true)
  await settle()
  assert.equal(main.runtime.updateRecovery.value?.phase, 'verified')
  assert.equal(main.runtime.updateEditorsLocked.value, true)
  assert.equal(preference.runtime.updateEditorsLocked.value, true)
  assert.equal(main.runtime.filterUpdateBackendSync({ value: 1 }), undefined)
  assert.equal(preference.runtime.filterUpdateBackendSync({ value: 1 }), undefined)
  const retry = [...h.timers.entries()].find(([, timer]) => timer.delay === 2000)
  assert.ok(retry)
  h.failEvent()
  h.timers.delete(retry[0])
  retry[1].callback()
  await settle()
  assert.equal(main.runtime.updateEditorsLocked.value, false)
  assert.equal(preference.runtime.updateEditorsLocked.value, false)
  assert.deepEqual(preference.runtime.filterUpdateBackendSync({ value: 1 }), { value: 1 })
  assert.equal(h.commands.filter(item => item.command === 'acknowledge_update_health').length, 1)
  assert.equal(h.commands.filter(item => item.command === 'confirm_update_failure').length, 0)
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 2000).length, 0)
  main.runtime.disposeUpdateRecovery()
  preference.runtime.disposeUpdateRecovery()
})

test('late verified cleanup cannot unlock a newer quiescence lease', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  h.state(pendingOperation)
  await main.runtime.initializeUpdateRecovery()
  await preference.runtime.initializeUpdateRecovery()
  h.failEvent('update-quiesce-release')
  main.runtime.setUpdateHealthRenderer(async () => true)
  await settle()
  const retry = [...h.timers.entries()].find(([, timer]) => timer.delay === 2000)
  assert.ok(retry)
  assert.equal(preference.runtime.updateEditorsLocked.value, false)
  h.failEvent()
  await preference.runtime.quiesceUpdateEditors('next-owner')
  h.timers.delete(retry[0])
  retry[1].callback()
  await settle()
  assert.equal(main.runtime.updateEditorsLocked.value, true)
  assert.equal(preference.runtime.updateEditorsLocked.value, true)
  assert.equal(main.runtime.filterUpdateBackendSync({ value: 1 }), undefined)
  await preference.runtime.releaseUpdateEditors('next-owner')
  assert.equal(main.runtime.updateEditorsLocked.value, false)
  assert.deepEqual(main.runtime.filterUpdateBackendSync({ value: 1 }), { value: 1 })
  main.runtime.disposeUpdateRecovery()
  preference.runtime.disposeUpdateRecovery()
})

test('cancelled or failed preparation retries lease release automatically through the delivery service', async () => {
  for (const phase of ['cancelled', 'failed']) {
    for (const boundary of ['native', 'event-before', 'event-after']) {
      const h = harness()
      const main = h.window('main')
      const preference = h.window('preference')
      await main.runtime.initializeUpdateRecovery()
      await preference.runtime.initializeUpdateRecovery()
      await preference.delivery.initializeUpdateDelivery()
      await h.emit('update-prepare-data', { requestId: 'preparation' })
      await settle()
      assert.equal(preference.runtime.updateEditorsLocked.value, true)
      if (boundary === 'native') h.failCommand('release_update_quiescence')
      else h.failEvent('update-quiesce-release', boundary === 'event-before')
      await h.emit('update-status', { revision: 1, phase, requestId: 'preparation' })
      await settle()
      assert.equal(preference.runtime.updateEditorReleasePending.value, 'preparation')
      assert.equal(preference.runtime.updateEditorsLocked.value, true)
      const retry = async () => {
        const timers = [...h.timers.entries()].filter(([, timer]) => timer.delay === 2000)
        assert.equal(timers.length, 1, `${phase}/${boundary} must retry one pending cleanup without another user action`)
        const [id, timer] = timers[0]!
        h.timers.delete(id)
        timer.callback()
        await settle()
        return timer.callback
      }
      await retry()
      assert.equal(preference.runtime.updateEditorsLocked.value, true)
      h.failCommand()
      h.failEvent()
      const staleRetry = await retry()
      assert.equal(preference.runtime.updateEditorReleasePending.value, undefined)
      assert.equal(preference.runtime.updateEditorsLocked.value, false)
      assert.equal(main.runtime.updateEditorsLocked.value, false)
      assert.deepEqual(main.runtime.filterUpdateBackendSync({ value: 1 }), { value: 1 })
      assert.equal([...h.timers.values()].filter(timer => timer.delay === 2000).length, 0)
      assert.equal(h.commands.filter(item => ['acknowledge_update_health', 'confirm_update_failure'].includes(item.command)).length, 0)
      await preference.runtime.quiesceUpdateEditors('next-owner')
      const calls = h.commands.length
      staleRetry()
      await settle()
      assert.equal(h.commands.length, calls)
      assert.equal(preference.runtime.updateEditorsLocked.value, true)
      await preference.runtime.releaseUpdateEditors('next-owner')
      main.runtime.disposeUpdateRecovery()
      preference.runtime.disposeUpdateRecovery()
    }
  }
})

test('editor release retries preserve nonterminal recovery and stop with their disposed runtime', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  await main.runtime.initializeUpdateRecovery()
  await preference.runtime.initializeUpdateRecovery()
  await preference.runtime.quiesceUpdateEditors('preparation')
  h.failCommand('release_update_quiescence')
  await assert.rejects(preference.runtime.releaseUpdateEditors('preparation'))
  h.failCommand()
  await h.emit('update-recovery-status', pendingOperation)
  await settle()
  const retry = [...h.timers.entries()].find(([, timer]) => timer.delay === 2000)
  assert.ok(retry)
  const calls = h.commands.length
  h.timers.delete(retry[0])
  retry[1].callback()
  await settle()
  assert.equal(h.commands.length, calls, 'cleanup must not release a nonterminal recovery')
  assert.equal(preference.runtime.updateEditorsLocked.value, true)
  const pending = [...h.timers.values()].find(timer => timer.delay === 2000)
  assert.ok(pending, 'cleanup must remain scheduled until recovery becomes terminal')
  preference.runtime.disposeUpdateRecovery()
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 2000).length, 0)
  pending.callback()
  await settle()
  assert.equal(h.commands.length, calls)
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 2000).length, 0)
  main.runtime.disposeUpdateRecovery()
})

test('late duplicate delivery release rejection cannot relock a completed or newer editor owner', async () => {
  for (const newOwner of [false, true]) {
    const h = harness()
    const main = h.window('main')
    const preference = h.window('preference')
    await main.runtime.initializeUpdateRecovery()
    await preference.runtime.initializeUpdateRecovery()
    await preference.delivery.initializeUpdateDelivery()
    const flush = deferred<boolean>()
    preference.owners.flushPresets = () => flush.promise
    await h.emit('update-prepare-data', { requestId: 'first' })
    await settle()
    const late = deferred<void>()
    h.holdNextRelease(late.promise)
    await h.emit('update-status', { revision: 1, phase: 'cancelled', requestId: 'first' })
    await settle()
    flush.resolve(true)
    await settle()
    const releases = h.commands.filter(item => item.command === 'release_update_quiescence' && item.args.requestId === 'first')
    assert.equal(releases.length, 2, 'cancellation and the completed preparation both attempt release through the actual service')
    assert.equal(preference.runtime.updateEditorsLocked.value, false)
    if (newOwner) await preference.runtime.quiesceUpdateEditors('second')
    late.reject(new Error('late native release response failed'))
    await settle()
    assert.equal(preference.runtime.updateEditorReleasePending.value, undefined)
    assert.equal(preference.runtime.updateEditorsLocked.value, newOwner)
    assert.equal(main.runtime.updateEditorsLocked.value, newOwner)
    assert.equal([...h.timers.values()].filter(timer => timer.delay === 2000).length, 0)
    if (newOwner) {
      assert.equal(preference.runtime.filterUpdateBackendSync({ value: 1 }), undefined)
      await preference.runtime.releaseUpdateEditors('second')
    }
    main.runtime.disposeUpdateRecovery()
    preference.runtime.disposeUpdateRecovery()
  }
})

test('late editor release response preserves a new lease initiated by the other window', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  await main.runtime.initializeUpdateRecovery()
  await preference.runtime.initializeUpdateRecovery()
  await preference.runtime.quiesceUpdateEditors('first')
  const late = deferred<void>()
  h.holdNextReleaseEvent(late.promise)
  const firstReleased = preference.runtime.releaseUpdateEditors('first')
  await settle()
  // The event was delivered, but its caller has not received success yet.
  // Main acquires B; preference has no local editingOperationId for that lease.
  await main.runtime.quiesceUpdateEditors('other-window')
  assert.equal(preference.runtime.filterUpdateBackendSync({ value: 1 }), undefined)
  late.resolve()
  await firstReleased
  assert.equal(preference.runtime.updateEditorReleasePending.value, undefined)
  assert.equal(preference.runtime.updateEditorsLocked.value, true)
  assert.equal(preference.runtime.filterUpdateBackendSync({ value: 1 }), undefined)
  assert.equal(main.runtime.filterUpdateBackendSync({ value: 1 }), undefined)
  await main.runtime.releaseUpdateEditors('other-window')
  assert.deepEqual(preference.runtime.filterUpdateBackendSync({ value: 1 }), { value: 1 })
  main.runtime.disposeUpdateRecovery()
  preference.runtime.disposeUpdateRecovery()
})

test('release rejection arriving after disposal cannot create pending cleanup or retry work', async () => {
  const h = harness()
  const main = h.window('main')
  const preference = h.window('preference')
  await main.runtime.initializeUpdateRecovery()
  await preference.runtime.initializeUpdateRecovery()
  await preference.runtime.quiesceUpdateEditors('first')
  const late = deferred<void>()
  h.holdNextRelease(late.promise)
  const failed = assert.rejects(preference.runtime.releaseUpdateEditors('first'))
  preference.runtime.disposeUpdateRecovery()
  const locked = preference.runtime.updateEditorsLocked.value
  late.reject(new Error('disposed runtime release failed'))
  await failed
  await settle()
  assert.equal(preference.runtime.updateEditorReleasePending.value, undefined)
  assert.equal(preference.runtime.updateEditorsLocked.value, locked)
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 2000).length, 0)
  main.runtime.disposeUpdateRecovery()
})

test('actual editor release keeps a retryable owner through native or event failure and rejects unrelated unlocks', async () => {
  for (const boundary of ['native', 'event']) {
    const h = harness()
    const main = h.window('main')
    const preference = h.window('preference')
    await main.runtime.initializeUpdateRecovery()
    await preference.runtime.initializeUpdateRecovery()
    await preference.runtime.quiesceUpdateEditors('update-owner')
    if (boundary === 'native') h.failCommand('release_update_quiescence')
    else h.failEvent('update-quiesce-release')
    await assert.rejects(preference.runtime.releaseUpdateEditors('update-owner'))
    assert.equal(preference.runtime.updateEditorReleasePending.value, 'update-owner')
    assert.equal(preference.runtime.updateEditorsLocked.value, true)
    const calls = h.commands.length
    await preference.runtime.releaseUpdateEditors('another-owner')
    assert.equal(h.commands.length, calls)
    await assert.rejects(preference.runtime.quiesceUpdateEditors('next-owner'), /OPERATION_BUSY/)
    h.failCommand()
    h.failEvent()
    await preference.runtime.releaseUpdateEditors('update-owner')
    assert.equal(preference.runtime.updateEditorReleasePending.value, undefined)
    assert.equal(preference.runtime.updateEditorsLocked.value, false)
    assert.equal(main.runtime.updateEditorsLocked.value, false)
    await preference.runtime.quiesceUpdateEditors('next-owner')
    await preference.runtime.releaseUpdateEditors('update-owner')
    assert.equal(preference.runtime.updateEditorsLocked.value, true)
    await preference.runtime.releaseUpdateEditors('next-owner')
  }
})
