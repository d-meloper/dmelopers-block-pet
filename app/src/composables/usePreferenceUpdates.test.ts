/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import * as controller from '@/features/updates/preferenceUpdates'

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

function harness() {
  let mount!: () => Promise<void>
  let unmount!: () => void
  let event!: (value: { payload: boolean }) => void
  let visibility = async () => false
  let checks = 0
  let releases = 0
  let provided: unknown
  const general = { app: { updateReminderHiddenUntil: 0 } }
  const api = {} as typeof import('./usePreferenceUpdates')
  const mocks: Record<string, unknown> = {
    'vue': {
      onMounted: (callback: typeof mount) => {
        mount = callback
      },
      onBeforeUnmount: (callback: typeof unmount) => {
        unmount = callback
      },
      provide: (_key: unknown, value: unknown) => {
        provided = value
      },
      inject: () => provided,
    },
    'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
    'ant-design-vue': { message: { error: () => {} } },
    '@tauri-apps/api/event': { listen: async (name: string, callback: typeof event) => {
      assert.equal(name, 'preference-visibility-changed')
      event = callback
      return () => {
        releases++
      }
    } },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({ isVisible: () => visibility() }) },
    '@/features/updates/preferenceUpdates': controller,
    '@/services/inAppUpdates': {
      inAppUpdaterEnabled: async () => true,
      checkAppUpdate: async () => {
        checks++
        return { available: true, currentVersion: '1.0.1', version: '1.0.2', bytes: 10 }
      },
    },
    '@/services/manualUpdates': {},
    '@/services/diagnostics': { reportDiagnostic: () => assert.fail('Unexpected diagnostic') },
    '@/stores/general': { useGeneralStore: () => general },
  }
  runInNewContext(ts.transpileModule(readFileSync(new URL('./usePreferenceUpdates.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: api, require: (name: string) => mocks[name] })
  const updates = api.providePreferenceUpdates()
  assert.equal(api.usePreferenceUpdates(), updates)
  return {
    updates,
    general,
    mount: () => mount(),
    unmount: () => unmount(),
    show: (visible: boolean) => event({ payload: visible }),
    checks: () => checks,
    releases: () => releases,
    visibility: (read: typeof visibility) => {
      visibility = read
    },
  }
}

test('the real window adapter checks only on confirmed opens, persists the deadline and cleans up', async () => {
  const h = harness()
  await h.mount()
  assert.equal(h.checks(), 0)
  h.show(true)
  await settle()
  assert.equal(h.checks(), 1)
  assert.equal(h.updates.reminderVersion.value, '1.0.2')
  h.show(true)
  await settle()
  assert.equal(h.checks(), 1)
  h.updates.snooze()
  assert.ok(h.general.app.updateReminderHiddenUntil > Date.now())
  h.show(false)
  h.show(true)
  await settle()
  assert.equal(h.checks(), 2)
  assert.equal(h.updates.reminderVersion.value, undefined)
  h.unmount()
  h.show(false)
  h.show(true)
  await settle()
  assert.equal(h.checks(), 2)
  assert.equal(h.releases(), 1)
})

test('a late initial visibility read cannot replace a newer close event', async () => {
  const h = harness()
  let resolve!: (visible: boolean) => void
  h.visibility(() => new Promise((yes) => {
    resolve = yes
  }))
  const mounted = h.mount()
  await settle()
  h.show(false)
  resolve(true)
  await mounted
  assert.equal(h.checks(), 0)
  h.unmount()
})

test('a window opened before mounting is checked once after registration', async () => {
  const h = harness()
  h.visibility(async () => true)
  await h.mount()
  h.show(true)
  await settle()
  assert.equal(h.checks(), 1)
  h.unmount()
})
