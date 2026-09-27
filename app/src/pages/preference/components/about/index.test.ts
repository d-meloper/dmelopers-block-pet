/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import { APP_DISPLAY_NAME } from '@/constants/branding'
import { isKoreanLanguage, selectByLanguage } from '@/locales/languageBranch'

function harness() {
  const locale = Vue.ref('ko-KR')
  const opened: string[] = []
  const copied: string[] = []
  const successes: string[] = []
  const errors: string[] = []
  let failOpen = false
  let failCopy = false
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'about-actions' })
  interface Actions {
    openDeveloperLink: () => Promise<void>
    copyDeveloperEmail: () => Promise<void>
    copyInfo: () => Promise<void>
  }
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Actions } } }
  const mocks: Record<string, unknown> = {
    '@/services/diagnostics': { reportDiagnostic: () => {} },
    'vue': { ...Vue, onMounted: () => {} },
    'vue-i18n': { useI18n: () => ({ locale, t: (key: string) => key }) },
    'ant-design-vue': { message: { success: (key: string) => successes.push(key), error: (key: string) => errors.push(key) } },
    '@tauri-apps/api/app': { getTauriVersion: async () => '2.0.0' },
    '@tauri-apps/api/path': { appLogDir: async () => '/logs' },
    '@tauri-apps/plugin-os': { arch: () => 'x86_64', platform: () => 'windows', version: () => '10' },
    '@tauri-apps/plugin-opener': { openUrl: async (url: string) => {
      if (failOpen) throw new Error('open failed')
      opened.push(url)
    } },
    '@tauri-apps/plugin-clipboard-manager': { writeText: async (text: string) => {
      if (failCopy) throw new Error('copy failed')
      copied.push(text)
    } },
    '@/locales/languageBranch': { selectByLanguage },
    '@/constants/branding': { APP_DISPLAY_NAME },
    '@/stores/app': { useAppStore: () => ({ version: '1.0.0' }) },
    '@/composables/useProgramSettingsReset': { useProgramSettingsReset: () => ({ resetProgramSettings: async () => {} }) },
  }
  runInNewContext(ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: (id: string) => mocks[id] ?? {} })
  return {
    actions: module.exports.default.setup({}, { expose: () => {} }),
    locale,
    opened,
    copied,
    successes,
    errors,
    fail: () => {
      failOpen = true
      failCopy = true
    },
  }
}

it('selects Korean or other values using the current application locale', async () => {
  assert.equal(isKoreanLanguage('ko-KR'), true)
  for (const locale of ['en-US', 'ja-JP', '']) {
    assert.equal(isKoreanLanguage(locale), false)
    assert.equal(selectByLanguage(locale, 1, 2), 2)
  }
  const h = harness()
  await h.actions.openDeveloperLink()
  h.locale.value = 'en-US'
  await h.actions.openDeveloperLink()
  h.locale.value = 'ja-JP'
  await h.actions.openDeveloperLink()
  assert.deepEqual(h.opened, ['https://litt.ly/dmeloper', 'https://linktr.ee/dmeloper.dev', 'https://linktr.ee/dmeloper.dev'])
})

it('copies the exact email and preserves the shared name in diagnostic information', async () => {
  const h = harness()
  await h.actions.copyDeveloperEmail()
  assert.deepEqual(h.copied, ['dmeloper@gmail.com'])
  assert.deepEqual(h.successes, ['pages.preference.about.hints.copySuccess'])
  await h.actions.copyInfo()
  assert.equal(JSON.parse(h.copied[1]).appName, APP_DISPLAY_NAME)
  assert.equal(JSON.parse(h.copied[1]).appVersion, '1.0.0')
})

it('reports native open and clipboard failures without success notifications', async () => {
  const h = harness()
  h.fail()
  await h.actions.openDeveloperLink()
  await h.actions.copyDeveloperEmail()
  assert.deepEqual(h.errors, ['pages.preference.about.errors.openDeveloperLink', 'pages.preference.about.errors.copyEmail'])
  assert.deepEqual(h.successes, [])
})
