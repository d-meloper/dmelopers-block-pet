/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('./inAppUpdates.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function harness(failing?: string) {
  const calls: string[] = []
  const api = {} as typeof import('./inAppUpdates')
  const action = async (name: string, requestId?: string) => {
    if (requestId !== undefined) assert.equal(requestId, 'operation-id')
    calls.push(name)
    if (name === failing) throw new Error(name)
  }
  runInNewContext(source, {
    exports: api,
    crypto: { randomUUID: () => 'operation-id' },
    require: (name: string) => name === '@tauri-apps/api/core'
      ? { invoke: (command: string, args?: { requestId: string }) => action(command, args?.requestId) }
      : { quiesceEditors: (id: string) => action('save', id), releaseEditors: (id: string) => action('release', id) },
  })
  return { api, calls, phase: (value: string) => calls.push(value) }
}

test('download verifies before saving; installation gets only the active save request', async () => {
  const h = harness()
  await h.api.installAppUpdate(h.phase)
  assert.deepEqual(h.calls, ['downloading', 'download_app_update', 'saving', 'save', 'installing', 'install_app_update'])
})
test('a failed download neither freezes settings nor invokes installation', async () => {
  const h = harness('download_app_update')
  await assert.rejects(h.api.installAppUpdate(h.phase))
  assert.deepEqual(h.calls, ['downloading', 'download_app_update'])
})
test('a save failure releases its lease and blocks installation', async () => {
  const h = harness('save')
  await assert.rejects(h.api.installAppUpdate(h.phase))
  assert.deepEqual(h.calls, ['downloading', 'download_app_update', 'saving', 'save', 'release'])
})
test('a failed native handoff releases the same lease', async () => {
  const h = harness('install_app_update')
  await assert.rejects(h.api.installAppUpdate(h.phase))
  assert.equal(h.calls.at(-1), 'release')
})
test('duplicate installs cannot start a second download', async () => {
  const h = harness()
  const first = h.api.installAppUpdate(h.phase)
  await assert.rejects(h.api.installAppUpdate(h.phase), /UPDATE_BUSY/)
  await first
  assert.equal(h.calls.filter(x => x === 'download_app_update').length, 1)
})
