/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import * as prompt from '@/features/petRuntime/recoveryPrompt'
import * as events from '@/features/petRuntime/types'

function fixture(registration: Promise<void> | ((event: string) => Promise<void>) = Promise.resolve(), failSecond = false) {
  const mounted: Array<() => Promise<void>> = []
  const disposed: Array<() => void> = []
  const listeners = new Map<string, (event: { payload: unknown }) => void>()
  const released: string[] = []
  const queried: string[] = []
  const dialogs: Array<{ onOk: () => Promise<void> }> = []
  const diagnostics: unknown[] = []
  let restarts = 0
  let activeIncident: number | undefined = 1
  const emitRuntime = (event: string, incident: number) => {
    activeIncident = event === events.PET_RUNTIME_RESTART_REQUIRED ? incident : undefined
    listeners.get(event)?.({ payload: { incident } })
  }
  const mocks: Record<string, unknown> = {
    'vue': { onMounted: (fn: () => Promise<void>) => mounted.push(fn), onUnmounted: (fn: () => void) => disposed.push(fn) },
    '@tauri-apps/api/event': {
      listen: async (event: string, listener: (event: { payload: unknown }) => void) => {
        await (typeof registration === 'function' ? registration(event) : registration)
        if (failSecond && event === events.PET_RUNTIME_RESTART_REQUIRED) throw new Error('registration failed')
        listeners.set(event, listener)
        return () => {
          released.push(event)
          listeners.delete(event)
        }
      },
      emitTo: async (target: string, event: string) => {
        assert.equal(target, 'main')
        assert.equal(listeners.size, 2, 'both subscriptions precede the replay request')
        queried.push(event)
        if (activeIncident !== undefined) listeners.get(events.PET_RUNTIME_RESTART_REQUIRED)?.({ payload: { incident: activeIncident } })
      },
    },
    'ant-design-vue': { Modal: { confirm: (options: { onOk: () => Promise<void> }) => {
      dialogs.push(options)
      return { destroy: () => {} }
    } }, message: { error: () => {} } },
    '@/constants': { WINDOW_LABEL: { MAIN: 'main' } },
    '@/features/petRuntime/recoveryPrompt': prompt,
    '@/features/petRuntime/types': events,
    '@/plugins/process': { restartApp: async () => {
      restarts++
    } },
    '@/plugins/window': { showWindow: async () => {} },
    '@/services/diagnostics': { reportDiagnostic: (...args: unknown[]) => diagnostics.push(args) },
  }
  const source = readFileSync(new URL('./usePetRuntimeRecovery.ts', import.meta.url), 'utf8')
  const exports = {} as { usePetRuntimeRecovery: (t: (key: string) => string) => void }
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => mocks[name] })
  exports.usePetRuntimeRecovery(key => key)
  return { mount: () => Promise.all(mounted.map(fn => fn())), dispose: () => disposed.forEach(fn => fn()), dialogs, queried, released, diagnostics, emitRuntime, listeners, restarts: () => restarts }
}

it('replays a startup incident after subscribing and delegates a confirmed restart to the save owner', async () => {
  const h = fixture()
  await h.mount()
  assert.deepEqual(h.queried, [events.PET_RUNTIME_RECOVERY_QUERY])
  assert.equal(h.dialogs.length, 1)
  assert.equal(h.restarts(), 0)
  await h.dialogs[0].onOk()
  assert.equal(h.restarts(), 1)
  h.dispose()
  assert.equal(h.released.length, 2)
})

it('releases late subscriptions on unmount without requesting a stale incident', async () => {
  let resolve!: () => void
  const h = fixture(new Promise<void>((done) => {
    resolve = done
  }))
  const mounted = h.mount()
  h.dispose()
  resolve()
  await mounted
  assert.deepEqual(h.released, [events.PET_RUNTIME_RECOVERED])
  assert.equal(h.queried.length, 0)
  assert.equal(h.dialogs.length, 0)
})

it('releases partial subscriptions and reports registration failure', async () => {
  const h = fixture(Promise.resolve(), true)
  await h.mount()
  assert.deepEqual(h.released, [events.PET_RUNTIME_RECOVERED])
  assert.equal(h.queried.length, 0)
  assert.equal(h.diagnostics.length, 1)
  h.dispose()
})

it('cannot open a stale failure prompt before the recovery listener finishes registering', async () => {
  let releaseRecovered!: () => void
  const recovered = new Promise<void>((resolve) => {
    releaseRecovered = resolve
  })
  const h = fixture(event => event === events.PET_RUNTIME_RECOVERED ? recovered : Promise.resolve())
  const mounted = h.mount()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  // With parallel subscriptions the failure listener is active here, but the
  // recovery below is lost. The subsequent healthy query has nothing to replay.
  h.emitRuntime(events.PET_RUNTIME_RESTART_REQUIRED, 1)
  h.emitRuntime(events.PET_RUNTIME_RECOVERED, 1)
  releaseRecovered()
  await mounted
  assert.equal(h.dialogs.length, 0)
  assert.deepEqual(h.queried, [events.PET_RUNTIME_RECOVERY_QUERY])
  h.emitRuntime(events.PET_RUNTIME_RESTART_REQUIRED, 2)
  assert.equal(h.dialogs.length, 1)
  assert.equal(h.restarts(), 0)
  h.dispose()
})

it('releases the recovery listener and a late failure listener when unmounted between subscriptions', async () => {
  let releaseFailure!: () => void
  const failed = new Promise<void>((resolve) => {
    releaseFailure = resolve
  })
  const h = fixture(event => event === events.PET_RUNTIME_RESTART_REQUIRED ? failed : Promise.resolve())
  const mounted = h.mount()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(h.listeners.has(events.PET_RUNTIME_RECOVERED), true)
  assert.equal(h.listeners.has(events.PET_RUNTIME_RESTART_REQUIRED), false)
  h.dispose()
  releaseFailure()
  await mounted
  assert.deepEqual(h.released, [events.PET_RUNTIME_RECOVERED, events.PET_RUNTIME_RESTART_REQUIRED])
  assert.equal(h.queried.length, 0)
  assert.equal(h.dialogs.length, 0)
})
