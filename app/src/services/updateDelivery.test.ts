/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

import type { UpdateStatus } from './updateDelivery'

type Service = typeof import('./updateDelivery')
type Handler = (event: { payload: unknown }) => Promise<void> | void

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
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

function status(revision: number, phase: UpdateStatus['phase'] = 'idle'): UpdateStatus {
  return { revision, phase, requestId: null, currentVersion: '1.0.0', targetVersion: null, downloadedBytes: 0, totalBytes: 0, canCancel: false, errorCode: null, releaseUrl: null }
}

function harness() {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
  const calls: Array<{ command: string, args: Record<string, unknown> }> = []
  const released: string[] = []
  const releaseHandlers = new Map<string, () => Promise<void>>()
  const errors: string[] = []
  const preparations = new Map<string, ReturnType<typeof deferred<void>>>()
  const timers = new Map<number, { callback: () => void, delay: number }>()
  let timerId = 0
  let unlistens = 0
  let delayedSubscription: ReturnType<typeof deferred<() => void>> | undefined
  const exports = {} as Service
  commands.set('update_get_status', async () => status(0))
  const mocks: Record<string, unknown> = {
    'vue': vue,
    '@tauri-apps/api/core': { invoke: async (command: string, args = {}) => {
      calls.push({ command, args })
      return commands.get(command)?.(args)
    } },
    '@tauri-apps/api/event': { listen: async (name: string, handler: Handler) => {
      handlers.set(name, handler)
      if (delayedSubscription) return delayedSubscription.promise
      return () => {
        unlistens += 1
        if (handlers.get(name) === handler) handlers.delete(name)
      }
    } },
    '@/features/updateRecovery': {
      quiesceUpdateEditors: async (request: string) => preparations.get(request)?.promise,
      releaseUpdateEditors: async (request: string) => {
        released.push(request)
        await releaseHandlers.get(request)?.()
      },
    },
  }
  const source = ts.transpileModule(readFileSync(new URL('./updateDelivery.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(source, {
    exports,
    require: (name: string) => {
      assert.ok(name in mocks, `Unexpected import: ${name}`)
      return mocks[name]
    },
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++timerId, { callback, delay })
      return timerId
    },
    clearTimeout: (id: number) => timers.delete(id),
    console: { error: (message: string) => errors.push(message) },
  })
  return {
    api: exports,
    handlers,
    commands,
    calls,
    preparations,
    released,
    releaseHandlers,
    errors,
    get unlistens() {
      return unlistens
    },
    setDelayedSubscription(value: typeof delayedSubscription) {
      delayedSubscription = value
    },
    async tick(delay: number) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) {
          timers.delete(id)
          timer.callback()
        }
      }
      await flush()
    },
    async emit(name: string, payload: unknown) {
      await handlers.get(name)?.({ payload })
    },
  }
}

describe('update delivery request ownership', () => {
  it('a stale initial read, manual check, or start response cannot replace a newer push', async () => {
    const h = harness()
    const initial = deferred<UpdateStatus>()
    h.commands.set('update_get_status', () => initial.promise)
    const initialized = h.api.initializeUpdateDelivery()
    await flush()
    await h.emit('update-status', status(10, 'downloading'))
    initial.resolve(status(1))
    await initialized
    assert.equal(h.api.updateStatus.value.revision, 10)
    for (const [command, action] of [['update_check', h.api.checkForUpdates], ['update_start', h.api.startUpdate]] as const) {
      const reply = deferred<UpdateStatus>()
      h.commands.set(command, () => reply.promise)
      const pending = action()
      await flush()
      const next: number = h.api.updateStatus.value.revision + 2
      await h.emit('update-status', status(next, 'preparing'))
      reply.resolve(status(next - 1, 'available'))
      await pending
      assert.equal(h.api.updateStatus.value.revision, next)
    }
  })

  it('a timed out subscription is inert, closes its late handle, and retries', async () => {
    const h = harness()
    const subscription = deferred<() => void>()
    let lateClosed = 0
    h.setDelayedSubscription(subscription)
    const rejected = assert.rejects(h.api.initializeUpdateDelivery(), /UPDATE_STATUS_TIMEOUT/)
    await flush()
    await h.tick(5000)
    await rejected
    await h.emit('update-status', status(99, 'installing'))
    assert.equal(h.api.updateStatus.value.revision, -1)
    subscription.resolve(() => {
      lateClosed += 1
    })
    await flush()
    assert.equal(lateClosed, 1)
    h.setDelayedSubscription(undefined)
    await h.tick(1000)
    assert.equal(h.api.updateStatus.value.revision, 0)
    assert.ok(h.handlers.has('update-prepare-data'))
  })

  it('an expired preparation can release only its lease and cannot acknowledge the next request', async () => {
    const h = harness()
    await h.api.initializeUpdateDelivery()
    const first = deferred<void>()
    const second = deferred<void>()
    h.preparations.set('first', first)
    h.preparations.set('second', second)
    const old = h.emit('update-prepare-data', { requestId: 'first' })
    await flush()
    await h.emit('update-status', { ...status(1, 'failed'), requestId: 'first' })
    const current = h.emit('update-prepare-data', { requestId: 'second' })
    first.resolve()
    await old
    assert.ok(h.released.every(request => request === 'first'))
    assert.equal(h.calls.filter(call => call.command === 'update_data_ready').length, 0)
    second.resolve()
    await current
    const ready = h.calls.filter(call => call.command === 'update_data_ready')
    assert.equal(ready.length, 1)
    assert.equal(ready[0]!.args.requestId, 'second')
    assert.equal(ready[0]!.args.ready, true)
  })

  it('a late failed release is handled and cannot clear the next preparation owner', async () => {
    const h = harness()
    await h.api.initializeUpdateDelivery()
    const first = deferred<void>()
    const second = deferred<void>()
    const release = deferred<void>()
    h.preparations.set('first', first)
    h.preparations.set('second', second)
    h.releaseHandlers.set('first', () => release.promise)
    const old = h.emit('update-prepare-data', { requestId: 'first' })
    await flush()
    await h.emit('update-status', { ...status(1, 'failed'), requestId: 'first' })
    const current = h.emit('update-prepare-data', { requestId: 'second' })
    first.resolve()
    await flush()
    release.reject(new Error('sensitive diagnostic must not be logged'))
    await old
    await flush()
    assert.ok(h.errors.length > 0)
    assert.ok(h.errors.every(message => message === 'Update preparation editor release is still pending.'))
    second.resolve()
    await current
    const ready = h.calls.filter(call => call.command === 'update_data_ready')
    assert.deepEqual(ready.map(call => call.args.requestId), ['second'])
    assert.equal(ready[0]!.args.ready, true)
    assert.ok(h.released.every(request => request === 'first'))
  })

  it('a preparation failure still settles when releasing its native lease fails', async () => {
    const h = harness()
    await h.api.initializeUpdateDelivery()
    h.commands.set('update_data_ready', async (args) => {
      if (args.requestId === 'first') throw new Error('expired native request')
    })
    h.releaseHandlers.set('first', async () => {
      throw new Error('release denied')
    })
    await h.emit('update-prepare-data', { requestId: 'first' })
    assert.equal(h.errors.length, 1)
    await h.emit('update-prepare-data', { requestId: 'second' })
    const ready = h.calls.filter(call => call.command === 'update_data_ready')
    assert.equal(ready.at(-1)!.args.requestId, 'second')
    assert.equal(ready.at(-1)!.args.ready, true)
  })
})
