/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { LatestVersionResponse } from '@/services/manualUpdates'

import { createPreferenceUpdates } from '@/features/updates/preferenceUpdates'

function harness() {
  const calls: string[] = []
  const locale = Vue.ref('ko-KR')
  const result: LatestVersionResponse = { status: 'available', currentVersion: '1.0.1', latestVersion: '1.0.2', lastSuccessAt: 1, lastAttemptAt: 1, errorCode: null, fromCache: false }
  const updates = createPreferenceUpdates({
    enabled: async () => false,
    checkManual: async () => {
      calls.push('check')
      return { ...result }
    },
    checkApp: async () => {
      throw new Error('Wrong feed')
    },
    install: async () => {
      throw new Error('Wrong installer')
    },
    openDownloads: async () => {},
    hiddenUntil: () => 0,
    hideUntil: () => {},
    report: () => {},
  })
  const messages = Object.fromEntries(['ko-KR', 'en-US'].map(language => [language, JSON.parse(readFileSync(new URL(`../../../../locales/${language}.json`, import.meta.url), 'utf8')).manualUpdates]))
  const { descriptor } = parse(readFileSync(new URL('./ManualUpdates.vue', import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'manual-version-status' })
  interface Actions {
    statusMessage: Vue.ComputedRef<string>
    download: () => Promise<void>
  }
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Actions } } }
  const mocks: Record<string, unknown> = {
    '@/services/diagnostics': { reportDiagnostic: () => {} },
    '@/composables/usePreferenceUpdates': { usePreferenceUpdates: () => updates },
    'vue': Vue,
    'vue-i18n': { useI18n: () => ({ t: (key: string, params?: { version: string }) => messages[locale.value][key.split('.')[1]].replace('{version}', params?.version ?? '') }) },
    'ant-design-vue': { message: { error: (text: string) => calls.push(text) } },
    '@/services/manualUpdates': { openReleaseDownloads: async () => {
      calls.push('open')
    } },
  }
  runInNewContext(ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: (id: string) => mocks[id] ?? {} })
  const mount = () => module.exports.default.setup({}, { expose: () => {} })
  return { calls, locale, updates, result, mount }
}

test('About mounts reuse the preference-owned status without starting extra checks', async () => {
  for (const status of ['upToDate', 'available', 'localNewer', 'unknown'] as const) {
    const h = harness()
    h.result.status = status
    const first = h.mount()
    assert.deepEqual(h.calls, [])
    await h.updates.setVisible(true)
    const second = h.mount()
    assert.deepEqual(h.calls, ['check'])
    assert.equal(second.statusMessage.value, first.statusMessage.value)
    if (status === 'upToDate') assert.equal(first.statusMessage.value, '현재 프로그램이 최신 버전입니다.')
    if (status === 'available') assert.match(first.statusMessage.value, /최신 버전: v1\.0\.2/)
    if (status === 'unknown') assert.match(first.statusMessage.value, /확인할 수 없습니다/)
    if (status === 'localNewer') assert.match(first.statusMessage.value, /공개 최신 버전/)
    h.locale.value = 'en-US'
    assert.doesNotMatch(second.statusMessage.value, /현재|최신/)
    await second.download()
    assert.deepEqual(h.calls, ['check', 'open'])
  }
})
