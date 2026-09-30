/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('./inAppUpdates.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function harness(failing?: string, abortFailure?: unknown, failure?: unknown) {
  const calls: string[] = []
  const diagnostics: Array<{ level: string, operation: string, error: unknown }> = []
  let progress: (event: { payload: unknown }) => void = () => {}
  let hold: (() => Promise<void>) | undefined
  const api = {} as typeof import('./inAppUpdates')
  const action = async (name: string, requestId?: string) => {
    if (requestId !== undefined) assert.equal(requestId, 'operation-id')
    calls.push(name)
    if (name === 'download_app_update') await hold?.()
    if (name === failing) throw failure ?? new Error(name)
    if (name === 'abort_app_update' && abortFailure !== undefined) throw abortFailure
  }
  runInNewContext(source, {
    exports: api,
    crypto: { randomUUID: () => 'operation-id' },
    require: (name: string) => name === '@tauri-apps/api/core'
      ? { invoke: (command: string, args?: { requestId: string }) => action(command, args?.requestId) }
      : name === '@tauri-apps/api/event'
        ? { listen: async (_event: string, handler: typeof progress) => {
            progress = handler
            return () => {}
          } }
        : name === '@/services/diagnostics'
          ? { reportDiagnostic: (level: string, operation: string, error: unknown) => diagnostics.push({ level, operation, error }) }
          : { quiesceEditors: (id: string) => action('save', id), releaseEditors: (id: string) => action('release', id) },
  })
  return { api, calls, diagnostics, progress: (payload: unknown) => progress({ payload }), hold: (value: () => Promise<void>) => {
    hold = value
  }, phase: (value: string) => calls.push(value) }
}

test('download verifies before saving; installation gets only the active save request', async () => {
  const h = harness()
  await h.api.installAppUpdate(h.phase, () => {})
  assert.deepEqual(h.calls, ['downloading', 'download_app_update', 'begin_app_update_save', 'saving', 'save', 'installing', 'install_app_update'])
})
test('a failed download neither freezes settings nor invokes installation', async () => {
  const h = harness('download_app_update')
  await assert.rejects(h.api.installAppUpdate(h.phase, () => {}))
  assert.deepEqual(h.calls, ['downloading', 'download_app_update', 'abort_app_update'])
})
test('a save failure releases its lease and blocks installation', async () => {
  const h = harness('save')
  await assert.rejects(h.api.installAppUpdate(h.phase, () => {}))
  assert.deepEqual(h.calls, ['downloading', 'download_app_update', 'begin_app_update_save', 'saving', 'save', 'abort_app_update', 'release'])
})
test('a failed native handoff releases the same lease', async () => {
  const h = harness('install_app_update')
  await assert.rejects(h.api.installAppUpdate(h.phase, () => {}))
  assert.equal(h.calls.at(-1), 'release')
})

test('an unexpected native abort failure is warned without replacing the original update failure', async () => {
  const originalFailure = new Error('install failed')
  const abortFailure = new Error('cleanup failed')
  const h = harness('download_app_update', abortFailure, originalFailure)
  let thrown: unknown
  try {
    await h.api.installAppUpdate(h.phase, () => {})
  } catch (error) {
    thrown = error
  }
  assert.equal(thrown, originalFailure)
  assert.deepEqual(h.diagnostics, [{ level: 'warn', operation: 'updates.abort', error: abortFailure }])
})

test('terminal abort responses and a cancelled update stay silent', async () => {
  for (const abortFailure of ['UPDATE_REQUEST_INVALID', 'UPDATE_TOO_LATE']) {
    const originalFailure = new Error('update failed')
    const h = harness('download_app_update', abortFailure, originalFailure)
    let thrown: unknown
    try {
      await h.api.installAppUpdate(h.phase, () => {})
    } catch (error) {
      thrown = error
    }
    assert.equal(thrown, originalFailure)
    assert.deepEqual(h.diagnostics, [])
  }

  const cancellation = 'UPDATE_CANCELLED'
  const h = harness('download_app_update', 'UPDATE_REQUEST_INVALID', cancellation)
  let thrown: unknown
  try {
    await h.api.installAppUpdate(h.phase, () => {})
  } catch (error) {
    thrown = error
  }
  assert.equal(thrown, cancellation)
  assert.deepEqual(h.diagnostics, [])
})
test('duplicate installs cannot start a second download', async () => {
  const h = harness()
  const first = h.api.installAppUpdate(h.phase, () => {})
  await assert.rejects(h.api.installAppUpdate(h.phase, () => {}), /UPDATE_BUSY/)
  await first
  assert.equal(h.calls.filter(x => x === 'download_app_update').length, 1)
})

test('only active request progress is applied and cancellation never saves or installs', async () => {
  const h = harness('download_app_update')
  let resume!: () => void
  h.hold(() => new Promise<void>((done) => {
    resume = done
  }))
  const progress: number[] = []
  const work = h.api.installAppUpdate(h.phase, value => progress.push(value))
  for (let i = 0; i < 10; i++) await Promise.resolve()
  h.progress({ requestId: 'old', received: 100, size: 100, phase: 'verifying' })
  assert.deepEqual(progress, [])
  h.progress({ requestId: 'operation-id', received: 50, size: 100, phase: 'downloading' })
  assert.deepEqual(progress, [50])
  await h.api.cancelAppUpdate()
  assert.ok(h.calls.includes('cancel_app_update'))
  resume()
  await assert.rejects(work)
  assert.ok(!h.calls.includes('save'))
  assert.ok(!h.calls.includes('install_app_update'))
})

test('native Saving rejection leaves editors writable', async () => {
  const h = harness('begin_app_update_save')
  await assert.rejects(h.api.installAppUpdate(h.phase, () => {}))
  assert.ok(!h.calls.includes('save'))
  assert.ok(!h.calls.includes('release'))
})
