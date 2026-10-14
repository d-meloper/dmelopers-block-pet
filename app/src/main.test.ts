/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import { RecoveryWaitError, waitForRecovery } from './features/recovery/wait'

function fixture() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const native = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  const root = { children: [] as unknown[], replaceChildren: (...children: unknown[]) => {
    root.children = children
  } }
  const counts = { native: 0, safety: 0, stores: 0, mount: 0 }
  const diagnostics: unknown[] = []
  const app = { config: {}, use: () => app, mount: () => {
    counts.mount++
    root.replaceChildren('app')
  } }
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/core': { invoke: () => {
      counts.native++
      return native
    } },
    'pinia': { createPinia: () => {
      counts.stores++
      return { use: () => {} }
    } },
    'vue': { watch: () => {}, createApp: () => app },
    './features/stateSafety': { editorsLocked: { value: false }, initializeStateSafety: async () => {
      counts.safety++
    } },
    './features/recovery/wait': { RecoveryWaitError, waitForRecovery: (operation: Promise<void>) => waitForRecovery(operation, 5) },
    './locales': { i18n: { global: { locale: {} } } },
    './plugins/settingsStore': { createSettingsStorePlugin: () => {} },
    './services/diagnostics': { installDiagnostics: () => {}, reportDiagnostic: (...args: unknown[]) => diagnostics.push(args) },
    './services/systemLanguage': { initializeSystemLanguage: async () => {} },
  }
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: {},
    require: (name: string) => mocks[name] ?? {},
    document: {
      documentElement: {},
      querySelector: () => root,
      createElement: () => {
        const element = { textContent: '', style: {}, focus: () => {}, setAttribute: () => {}, children: [] as unknown[], append: (...children: unknown[]) => {
          element.children = children
        } }
        return element
      },
    },
  })
  return { resolve, reject, root, counts, diagnostics, text: () => JSON.stringify(root.children) }
}

test('a stalled startup shows manual guidance without repeating native or store initialization, then permits its original completion', async () => {
  const h = fixture()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.match(h.text(), /Startup not confirmed/)
  assert.match(h.text(), /컴퓨터 재부팅, 프로그램 재설치/)
  assert.deepEqual(h.counts, { native: 1, safety: 0, stores: 0, mount: 0 })
  h.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.counts, { native: 1, safety: 1, stores: 1, mount: 1 })
  assert.deepEqual(h.root.children, ['app'])
})

test('a definite late startup failure replaces an uncertain outcome without exposing raw exception data', async () => {
  const h = fixture()
  await new Promise(resolve => setTimeout(resolve, 20))
  h.reject(new Error('C:/PRIVATE_USER/TOKEN'))
  await new Promise(resolve => setImmediate(resolve))
  assert.match(h.text(), /Unable to start/)
  assert.ok(!h.text().includes('PRIVATE_USER'))
  assert.deepEqual(h.counts, { native: 1, safety: 0, stores: 0, mount: 0 })
  assert.equal(h.diagnostics.length, 2)
})
