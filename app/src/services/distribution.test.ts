/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import type { DistributionChannel, DistributionInfo } from './distribution'

function harness(channel: DistributionChannel, updateUrl: string) {
  const calls: string[] = []
  let startupFailure: unknown
  let openerFailure: unknown
  const info: DistributionInfo = { channel, updateUrl, dataRoot: 'durable', localDataRoot: 'local', dataSchema: 1 }
  const exports = {} as typeof import('./distribution')
  const source = ts.transpileModule(readFileSync(new URL('./distribution.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(source, {
    exports,
    require: (id: string) => id === '@tauri-apps/api/core'
      ? { invoke: async (command: string) => {
          calls.push(command)
          if (command === 'await_native_startup' && startupFailure) throw startupFailure
          if (command === 'distribution_info') return info
        } }
      : { openUrl: async (url: string) => {
          calls.push(`open:${url}`)
          if (openerFailure) throw openerFailure
        } },
  })
  return {
    ...exports,
    calls,
    failStartup: (failure: unknown) => {
      startupFailure = failure
    },
    failOpener: (failure: unknown) => {
      openerFailure = failure
    },
  }
}

it('opens the verified Store product page or exact native updates fallback after startup', async () => {
  for (const url of ['https://apps.microsoft.com/detail/9NBLGGH4NNS1', 'ms-windows-store://downloadsandupdates']) {
    const h = harness('store', url)
    await h.openStore()
    assert.deepEqual(h.calls, ['await_native_startup', 'distribution_info', `open:${url}`])
  }
})

it('rejects a Store destination on GitHub, test and development channels', async () => {
  for (const channel of ['github', 'test', 'development'] as const) {
    for (const url of ['https://apps.microsoft.com/detail/9NBLGGH4NNS1', 'ms-windows-store://downloadsandupdates']) {
      const h = harness(channel, url)
      await assert.rejects(h.openStore(), /STORE_ID_UNAVAILABLE/)
      assert.deepEqual(h.calls, ['await_native_startup', 'distribution_info'])
    }
  }
})

it('rejects other Store URIs, arbitrary product hosts, suffixes and missing product IDs', async () => {
  for (const url of [
    '',
    'ms-windows-store://pdp/?productid=9NBLGGH4NNS1',
    'ms-windows-store://downloadsandupdates?query=other',
    'ms-windows-store://downloadsandupdates/',
    'MS-WINDOWS-STORE://downloadsandupdates',
    'https://apps.microsoft.com/detail/',
    'https://apps.microsoft.com/detail/9NBLGGH4NNS1?other=true',
    'https://apps.microsoft.com.evil.invalid/detail/9NBLGGH4NNS1',
    'https://example.invalid/9NBLGGH4NNS1',
    'file:///C:/Windows/System32/calc.exe',
  ]) {
    const h = harness('store', url)
    await assert.rejects(h.openStore(), /STORE_ID_UNAVAILABLE/)
    assert.deepEqual(h.calls, ['await_native_startup', 'distribution_info'])
  }
})

it('preserves native readiness and opener failures for the caller to report', async () => {
  const h = harness('store', 'ms-windows-store://downloadsandupdates')
  const failure = new Error('Store unavailable')
  h.failStartup(failure)
  await assert.rejects(h.openStore(), error => error === failure)
  assert.deepEqual(h.calls, ['await_native_startup'])
  h.failStartup(undefined)
  h.failOpener(failure)
  await assert.rejects(h.openStore(), error => error === failure)
  assert.deepEqual(h.calls.slice(1), ['await_native_startup', 'distribution_info', 'open:ms-windows-store://downloadsandupdates'])
})

it('allows only the exact Store updates URI in the native custom-scheme opener scope', () => {
  const capability = JSON.parse(readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'))
  const permission = capability.permissions.find((entry: string | { identifier: string }) => typeof entry === 'object' && entry.identifier === 'opener:allow-open-url')
  assert.deepEqual(permission.allow, [{ url: 'ms-windows-store://downloadsandupdates' }])
  assert.ok(capability.permissions.includes('opener:allow-default-urls'), 'existing HTTPS resource links remain available')
})
