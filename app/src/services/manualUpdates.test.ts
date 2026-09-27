/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('./manualUpdates.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function harness(repository = 'd-meloper/dmelopers-block-pet') {
  const opened: string[] = []
  const invoked: Array<[string, unknown[]]> = []
  const response = { status: 'available', currentVersion: '1.0.0', latestVersion: '1.10.0' }
  let fail = false
  const api = {} as typeof import('./manualUpdates')
  runInNewContext(source, {
    exports: api,
    require: (name: string) => {
      if (name === '@tauri-apps/api/core') {
        return { invoke: async (command: string, ...args: unknown[]) => {
          invoked.push([command, args])
          if (fail) throw new Error('native unavailable')
          return command === 'check_latest_version' ? response : command === 'latest_version_releases_url' ? `https://github.com/${repository}/releases` : undefined
        } }
      }
      assert.equal(name, '@tauri-apps/plugin-opener')
      return { openUrl: async (url: string) => {
        if (fail) throw new Error('browser unavailable')
        opened.push(url)
      } }
    },
    fetch: () => assert.fail('the frontend must not fetch release metadata or files'),
    setInterval: () => assert.fail('the frontend must not schedule checks'),
  })
  return { api, opened, invoked, response, fail: () => {
    fail = true
  } }
}

test('loading the service performs no I/O; the button only opens the fixed releases list', async () => {
  const h = harness()
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.invoked, [])
  await h.api.openReleaseDownloads()
  assert.deepEqual(h.opened, ['https://github.com/d-meloper/dmelopers-block-pet/releases'])
  assert.deepEqual(h.invoked, [['latest_version_releases_url', []]])
})

test('version checks wait for native startup and send no caller-controlled URL or version', async () => {
  const h = harness()
  assert.equal(await h.api.checkLatestVersion(), h.response)
  assert.deepEqual(h.invoked, [['await_native_startup', []], ['check_latest_version', []]])
  assert.deepEqual(h.opened, [])
})

test('startup and browser failures reach the visible component without a fallback source', async () => {
  const h = harness()
  h.fail()
  await assert.rejects(h.api.checkLatestVersion(), /native unavailable/)
  assert.deepEqual(h.invoked, [['await_native_startup', []]])
  await assert.rejects(h.api.openReleaseDownloads(), /native unavailable/)
  assert.deepEqual(h.opened, [])
})

test('test builds open only their native fixed test repository and reject arbitrary destinations', async () => {
  const h = harness('oup030416/dmelopers-block-pet-test')
  await h.api.openReleaseDownloads()
  assert.deepEqual(h.opened, ['https://github.com/oup030416/dmelopers-block-pet-test/releases'])
  const invalid = harness('attacker/repository')
  await assert.rejects(invalid.api.openReleaseDownloads(), /Unexpected release source/)
  assert.deepEqual(invalid.opened, [])
})
