/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { shallowRef } from 'vue'

import { LANGUAGE } from '@/constants'
import { isLanguage } from '@/locales/languageBranch'

function harness(read: () => Promise<unknown>) {
  const calls: string[] = []
  const diagnostics: Array<{ level: string, operation: string, error: unknown }> = []
  const exports = {} as typeof import('./systemLanguage')
  const source = ts.transpileModule(readFileSync(new URL('./systemLanguage.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(source, {
    exports,
    require: (id: string) => {
      if (id === '@tauri-apps/api/core') {
        return { invoke: async (command: string) => {
          calls.push(command)
          return read()
        } }
      }
      if (id === 'vue') return { shallowRef }
      if (id === '@/constants') return { LANGUAGE }
      if (id === '@/locales/languageBranch') return { isLanguage }
      if (id === './diagnostics') return { reportDiagnostic: (level: string, operation: string, error: unknown) => diagnostics.push({ level, operation, error }) }
      throw new Error(`Unexpected import: ${id}`)
    },
  })
  return { ...exports, calls, diagnostics }
}

it('waits for the native observation, coalesces startup callers and retains the snapshot', async () => {
  let complete!: (language: unknown) => void
  const h = harness(() => new Promise((resolve) => {
    complete = resolve
  }))
  const first = h.initializeSystemLanguage()
  const second = h.initializeSystemLanguage()
  assert.equal(first, second)
  assert.equal(h.getSystemLanguage(), 'en-US')
  complete('ko-KR')
  await first
  assert.equal(h.getSystemLanguage(), 'ko-KR')
  await h.initializeSystemLanguage()
  assert.deepEqual(h.calls, ['get_system_ui_language'])
  assert.deepEqual(h.diagnostics, [])
})

it('accepts a native English result without diagnostics', async () => {
  const h = harness(async () => 'en-US')
  await h.initializeSystemLanguage()
  assert.equal(h.getSystemLanguage(), 'en-US')
  assert.deepEqual(h.diagnostics, [])
})

it('falls back to English and logs one warning for rejected or invalid native observations', async () => {
  const failure = new Error('SYSTEM_UI_LANGUAGE_UNAVAILABLE')
  for (const read of [async () => {
    throw failure
  }, async () => 'ja-JP', async () => null]) {
    const h = harness(read)
    await Promise.all([h.initializeSystemLanguage(), h.initializeSystemLanguage()])
    assert.equal(h.getSystemLanguage(), 'en-US')
    assert.deepEqual(h.calls, ['get_system_ui_language'])
    assert.equal(h.diagnostics.length, 1)
    assert.equal(h.diagnostics[0].level, 'warn')
    assert.equal(h.diagnostics[0].operation, 'language.system_ui')
  }
})
