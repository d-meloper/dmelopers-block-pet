/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

import { isDesktopPetVisible } from '@/features/broadcast/visibility'
import * as settings from '@/features/foregroundHiding/settings'
import * as status from '@/features/foregroundHiding/status'
import { createLatestAsyncTaskQueue } from '@/utils/latestAsyncTask'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function packet(sequence: number, suppressed = false): status.ForegroundHidingStatus {
  return {
    revision: 1,
    sequence,
    visit: 1,
    ready: true,
    suppressed,
    matchedRule: { kind: 'application', index: 0 },
    state: suppressed ? 'hidden' : 'bypassed',
  }
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function harness(delayedRegistration = false) {
  const query = deferred<unknown>()
  const registration = deferred<void>()
  const catalog = deferred<unknown>()
  let applicationChannel: { onmessage: (value: unknown) => void } | undefined
  const calls: Array<{ command: string, args?: object }> = []
  const timers = new Map<number, () => void>()
  const diagnostics: string[] = []
  let nextTimer = 0
  let released = 0
  let listener!: (event: { payload: unknown }) => void
  let configure: (args?: object) => Promise<unknown> = async () => packet(2, true)
  const exports = {} as typeof import('./foregroundHiding')
  const mocks: Record<string, unknown> = {
    'vue': vue,
    '@tauri-apps/api/event': { listen: async (_event: string, callback: typeof listener) => {
      listener = callback
      if (delayedRegistration) await registration.promise
      return () => {
        released++
      }
    } },
    '@tauri-apps/api/core': { Channel: class {
      onmessage: (value: unknown) => void
      constructor(callback: (value: unknown) => void) {
        this.onmessage = callback
        applicationChannel = { onmessage: value => this.onmessage(value) }
      }
    }, invoke: (command: string, args?: object) => {
      calls.push({ command, args })
      if (command === 'get_foreground_hiding_status') return query.promise
      if (command === 'configure_foreground_hiding') return configure(args)
      if (command === 'show_foreground_hiding_visit') return Promise.resolve(packet(9))
      if (command === 'stream_foreground_programs' || command === 'list_foreground_applications') return catalog.promise
      throw new Error('unexpected command')
    } },
    '@/features/foregroundHiding/status': status,
    '@/features/foregroundHiding/settings': settings,
    '@/utils/latestAsyncTask': { createLatestAsyncTaskQueue },
    './diagnostics': { reportDiagnostic: (_level: string, operation: string) => diagnostics.push(operation) },
  }
  runInNewContext(ts.transpileModule(readFileSync(new URL('./foregroundHiding.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => mocks[name], setTimeout: (callback: () => void) => {
    timers.set(++nextTimer, callback)
    return nextTimer
  }, clearTimeout: (id: number) => timers.delete(id) })
  return { exports, query, registration, catalog, application: (value: unknown) => {
    assert.ok(applicationChannel)
    applicationChannel.onmessage(value)
  }, calls, diagnostics, event: (value: unknown) => listener({ payload: value }), timeout: () => {
    for (const callback of [...timers.values()]) callback()
  }, released: () => released, configure: (fn: typeof configure) => {
    configure = fn
  } }
}

it('delivers ready catalog rows before completion, reports incomplete sources and retires the channel', async () => {
  const h = harness()
  const rows: import('./foregroundHiding').ForegroundApplication[] = []
  const incomplete: boolean[] = []
  const result = h.exports.listForegroundApplications(row => rows.push(row), value => incomplete.push(value))
  const league = { id: 'league', path: 'C:\\Riot\\Client.exe', name: 'League of Legends', launchOptions: true }
  const unresolved = { id: 'protocol-game', path: '', name: 'Protocol Game' }
  h.application(league)
  h.application(unresolved)
  assert.deepEqual(rows, [league, unresolved])
  assert.deepEqual(incomplete, [])
  assert.equal(h.calls.at(-1)?.command, 'stream_foreground_programs')
  h.catalog.resolve({ items: [league, unresolved], incomplete: true, truncated: false })
  assert.equal((await result).length, 2)
  assert.deepEqual(incomplete, [true])
  h.application({ id: 'late', path: '', name: 'Late item' })
  assert.equal(rows.length, 2)
})

it('rejects malformed streamed metadata without breaking channel message delivery', async () => {
  const h = harness()
  const rows: unknown[] = []
  const pending = h.exports.listForegroundApplications(row => rows.push(row))
  h.application({ id: 'bad', path: '', name: 'Bad', launchOptions: 'true' })
  h.application({ id: 'next', path: '', name: 'Next' })
  h.catalog.resolve({ items: [], incomplete: false, truncated: false })
  await assert.rejects(pending, /FOREGROUND_APPLICATIONS_INVALID/)
  assert.equal(rows.length, 0)
})

it('rejects stale, malformed and retired status packets and discards unexpected URL fields', () => {
  const published: status.ForegroundHidingStatus[] = []
  const receiver = status.createForegroundStatusReceiver(value => published.push(value))
  assert.equal(receiver.accept({ ...packet(3, true), url: 'https://fixture.invalid/private' }), true)
  assert.equal(receiver.accept(packet(2)), false)
  assert.equal(receiver.accept({ ...packet(4), revision: 0 }), false)
  assert.equal(receiver.accept({ ...packet(4), sequence: Number.NaN }), false)
  assert.equal(receiver.accept({ ...packet(4, true), matchedRule: null }), false)
  assert.equal('url' in published[0], false)
  receiver.dispose()
  assert.equal(receiver.accept(packet(5)), false)
})

it('a newer native event wins an older startup query and its failure', async () => {
  for (const failedQuery of [false, true]) {
    const h = harness()
    const started = h.exports.startForegroundHiding()
    await flush()
    h.event(packet(3, true))
    const release = await started
    if (failedQuery) h.query.reject(new Error('delayed query failed'))
    else h.query.resolve(packet(1))
    await flush()
    assert.equal(h.exports.foregroundHidingSuppressed.value, true)
    assert.equal(h.exports.foregroundHidingStatus.value?.sequence, 3)
    release()
    h.event(packet(4, true))
    assert.equal(h.exports.foregroundHidingSuppressed.value, false)
    assert.equal(h.released(), 1)
  }
})

it('timed-out registration cleans up its late listener without sending native queries or settings', async () => {
  const h = harness(true)
  const started = h.exports.startForegroundHiding(() => ({ enabled: true }))
  await flush()
  h.timeout()
  const release = await started
  h.registration.resolve()
  await flush()
  h.event(packet(8, true))
  release()
  assert.equal(h.calls.length, 0)
  assert.equal(h.released(), 1)
  assert.equal(h.exports.foregroundHidingSuppressed.value, false)
})

it('a valid subscribed event recovers from an initial query failure', async () => {
  const h = harness()
  const started = h.exports.startForegroundHiding()
  await flush()
  h.query.reject(new Error('initial query failed'))
  const release = await started
  assert.equal(h.exports.foregroundHidingSuppressed.value, false)
  h.event(packet(3, true))
  assert.equal(h.exports.foregroundHidingSuppressed.value, true)
  release()
})

it('configuration failure releases the mask and a subsequent valid configuration recovers', async () => {
  const h = harness()
  const config = vue.ref({ enabled: true })
  const release = await h.exports.startForegroundHiding(() => config.value)
  assert.equal(h.exports.foregroundHidingSuppressed.value, true)
  h.configure(async () => {
    throw new Error('unavailable')
  })
  config.value = { enabled: false }
  await flush()
  assert.equal(h.exports.foregroundHidingSuppressed.value, false)
  h.event(packet(3, true))
  assert.equal(h.exports.foregroundHidingSuppressed.value, false, 'events cannot conceal an unacknowledged settings write')
  h.configure(async () => packet(4, true))
  config.value = { enabled: true }
  await flush()
  assert.equal(h.exports.foregroundHidingSuppressed.value, true)
  release()
  const before = h.calls.length
  config.value = { enabled: false }
  await flush()
  assert.equal(h.calls.length, before)
})

it('synchronizes manual and broadcast desktop intent without persisting it or reacting to automatic suppression', async () => {
  const h = harness()
  const config = vue.reactive({ enabled: true, applications: ['C:\\Apps\\Player.exe'] })
  const display = vue.reactive({ visible: false, broadcast: { enabled: false, showOnDesktop: true } })
  let sequence = 2
  h.configure(async () => packet(sequence++))
  const release = await h.exports.startForegroundHiding(() => config, () => isDesktopPetVisible(display.visible, display.broadcast))
  const calls = () => h.calls.filter(call => call.command === 'configure_foreground_hiding')
  assert.equal((calls().at(-1)?.args as { desktopVisible: boolean }).desktopVisible, false)
  display.visible = true
  await flush()
  assert.equal((calls().at(-1)?.args as { desktopVisible: boolean }).desktopVisible, true)
  const beforeSuppression = calls().length
  h.event(packet(sequence++, true))
  await flush()
  assert.equal(calls().length, beforeSuppression, 'Automatic hiding must not stop the observer that restores the pet')
  display.broadcast.enabled = true
  display.broadcast.showOnDesktop = false
  await flush()
  assert.equal((calls().at(-1)?.args as { desktopVisible: boolean }).desktopVisible, false)
  display.broadcast.showOnDesktop = true
  await flush()
  assert.equal((calls().at(-1)?.args as { desktopVisible: boolean }).desktopVisible, true)
  assert.deepEqual(config, { enabled: true, applications: ['C:\\Apps\\Player.exe'] })
  release()
  const afterRelease = calls().length
  display.visible = false
  await flush()
  assert.equal(calls().length, afterRelease)
})

it('an old lifetime cannot update or retire the replacement and manual show uses the native visit', async () => {
  const h = harness()
  const first = h.exports.startForegroundHiding()
  await flush()
  h.event(packet(2, true))
  const stopFirst = await first
  const second = h.exports.startForegroundHiding()
  await flush()
  assert.equal(h.exports.foregroundHidingSuppressed.value, false)
  h.event(packet(5, true))
  const stopSecond = await second
  stopFirst()
  h.query.resolve(packet(6, true))
  await h.exports.showForegroundHidingVisit()
  assert.equal(h.calls.at(-1)?.command, 'show_foreground_hiding_visit')
  assert.equal(JSON.stringify(h.calls.at(-1)?.args), '{"revision":1,"visit":1}')
  assert.equal(h.exports.foregroundHidingSuppressed.value, false)
  stopSecond()
})
