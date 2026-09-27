/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

it('logs an autostart failure without poisoning later changes or logging successful work', async () => {
  const diagnostics: Array<{ level: string, operation: string, error: unknown }> = []
  const failure = new Error('startup registry access denied')
  let enabled = false
  let fail = true
  const exports = {} as typeof import('./autostart')
  const native = {
    isEnabled: async () => enabled,
    enable: async () => {
      if (fail) throw failure
      enabled = true
    },
    disable: async () => {
      enabled = false
    },
  }
  const source = ts.transpileModule(readFileSync(new URL('./autostart.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(source, {
    exports,
    require: (id: string) => id === '@tauri-apps/plugin-autostart'
      ? native
      : { reportDiagnostic: (level: string, operation: string, error: unknown) => diagnostics.push({ level, operation, error }) },
  })
  await exports.setAutostartEnabled(false)
  assert.deepEqual(diagnostics, [])
  await assert.rejects(exports.setAutostartEnabled(true), error => error === failure)
  assert.deepEqual(diagnostics, [{ level: 'error', operation: 'autostart.apply', error: failure }])
  fail = false
  await exports.setAutostartEnabled(true)
  assert.equal(enabled, true)
  await exports.setAutostartEnabled(false)
  assert.equal(enabled, false)
  assert.equal(diagnostics.length, 1)
})
