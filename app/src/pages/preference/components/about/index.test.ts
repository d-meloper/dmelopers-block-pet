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
import { ProgramSettingsResetError } from '@/utils/programSettingsReset'

function harness(renderTemplate = false) {
  const locale = Vue.ref('ko-KR')
  const opened: string[] = []
  const openedPaths: string[] = []
  const copied: string[] = []
  const successes: string[] = []
  const errors: string[] = []
  let failOpen = false
  let failCopy = false
  let failLogPath = false
  let mounted: () => Promise<void> = async () => {}
  let resetError: unknown
  let confirmReset: (() => Promise<void>) | undefined
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'about-actions', inlineTemplate: renderTemplate })
  interface Actions {
    openDeveloperLink: () => Promise<void>
    copyDeveloperEmail: () => Promise<void>
    copyInfo: () => Promise<void>
    openLogs: () => Promise<void>
    confirmProgramReset: () => void
  }
  type Render = (context: object, cache: unknown[]) => Vue.VNode
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Actions | Render } } }
  const mocks: Record<string, unknown> = {
    '@/services/diagnostics': { reportDiagnostic: () => {} },
    'vue': { ...Vue, onMounted: (callback: typeof mounted) => {
      mounted = callback
    } },
    'vue-i18n': { useI18n: () => ({ locale, t: (key: string) => key }) },
    'ant-design-vue': {
      Button: 'button',
      Flex: 'flex',
      message: { success: (key: string) => successes.push(key), error: (key: string) => errors.push(key) },
      Modal: { confirm: ({ onOk }: { onOk: () => Promise<void> }) => {
        confirmReset = onOk
      } },
    },
    '@tauri-apps/api/app': { getTauriVersion: async () => '2.0.0' },
    '@tauri-apps/api/path': { appLogDir: async () => {
      if (failLogPath) throw new Error('directory failed')
      return '/logs'
    } },
    '@tauri-apps/plugin-os': { arch: () => 'x86_64', platform: () => 'windows', version: () => '10' },
    '@tauri-apps/plugin-opener': { openUrl: async (url: string) => {
      if (failOpen) throw new Error('open failed')
      opened.push(url)
    }, openPath: async (path: string) => {
      if (failOpen) throw new Error('open failed')
      openedPaths.push(path)
    } },
    '@tauri-apps/plugin-clipboard-manager': { writeText: async (text: string) => {
      if (failCopy) throw new Error('copy failed')
      copied.push(text)
    } },
    '@/locales/languageBranch': { selectByLanguage },
    '@/constants/branding': { APP_DISPLAY_NAME },
    '@/stores/app': { useAppStore: () => ({ version: '1.0.0' }) },
    '@/composables/useProgramSettingsReset': { useProgramSettingsReset: () => ({ resetProgramSettings: async () => {
      if (resetError) throw resetError
    } }) },
    '@/utils/programSettingsReset': { ProgramSettingsResetError },
    '@/components/preference-sections/index.vue': { default: 'sections' },
    '@/components/pro-list-item/index.vue': { default: 'list-item' },
    '@/components/pro-list/index.vue': { default: 'list' },
    './AutomaticUpdates.vue': { default: 'updates' },
  }
  runInNewContext(ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: (id: string) => mocks[id] ?? {} })
  const setup = module.exports.default.setup({}, { expose: () => {} })
  const flatten = (node: Vue.VNode): Vue.VNode[] => {
    const children = Array.isArray(node.children)
      ? node.children
      : node.children && typeof node.children === 'object'
        ? Object.values(node.children).flatMap(slot => typeof slot === 'function' ? slot() : [])
        : []
    return [node, ...children.flatMap(child => Vue.isVNode(child) ? flatten(child) : [])]
  }
  return {
    actions: setup as Actions,
    mount: () => mounted(),
    buttons: (title: string) => {
      const nodes = flatten((setup as Render)({ $t: (key: string) => key }, []))
      const row = nodes.find(node => node.type === 'list-item' && node.props?.title === title)
      assert.ok(row)
      return flatten(row).filter(node => node.type === 'button')
    },
    locale,
    opened,
    openedPaths,
    copied,
    successes,
    errors,
    failLogPath: (failed: boolean) => {
      failLogPath = failed
    },
    failReset: (error: unknown) => {
      resetError = error
    },
    confirmReset: () => {
      assert.ok(confirmReset)
      return confirmReset()
    },
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

it('opens the existing introduction destinations and reports opener failures', async () => {
  const h = harness(true)
  const buttons = h.buttons('pages.preference.about.labels.introduction')
  assert.equal(buttons.length, 2)
  for (const button of buttons) {
    assert.equal(typeof button.props?.onClick, 'function')
    await button.props!.onClick()
  }
  assert.deepEqual(h.opened, [
    'https://app.notion.com/p/aismash/0da2dc0bb4ae82ab8db301718dde497b?source=copy_link',
    'https://github.com/d-meloper/dmelopers-block-pet',
  ])
  const failed = harness(true)
  failed.fail()
  await failed.buttons('pages.preference.about.labels.introduction')[0].props!.onClick()
  assert.deepEqual(failed.errors, ['pages.preference.about.errors.openLink'])
  assert.deepEqual(failed.opened, [])
})

it('keeps log-folder failures visible and retries a failed initial path lookup', async () => {
  const h = harness()
  h.failLogPath(true)
  await h.mount()
  await h.actions.openLogs()
  assert.deepEqual(h.openedPaths, [])
  assert.deepEqual(h.errors, ['pages.preference.about.errors.openLog'])
  h.failLogPath(false)
  await h.actions.openLogs()
  assert.deepEqual(h.openedPaths, ['/logs'])
  h.fail()
  await h.actions.openLogs()
  assert.equal(h.errors.at(-1), 'pages.preference.about.errors.openLog')
  assert.deepEqual(h.openedPaths, ['/logs'])
})

it('reports app-info clipboard failure without a success toast', async () => {
  const h = harness()
  h.fail()
  await h.actions.copyInfo()
  assert.deepEqual(h.copied, [])
  assert.deepEqual(h.successes, [])
  assert.deepEqual(h.errors, ['pages.preference.about.errors.copyInfo'])
})

it('distinguishes blocked, preflight and partial reset errors without closing the retry dialog', async () => {
  for (const [outcome, key] of [
    ['blocked', 'resetAutostartBlocked'],
    ['preflight', 'resetPreflight'],
    ['partial', 'resetPartial'],
  ] as const) {
    const h = harness()
    const error = new ProgramSettingsResetError(outcome, outcome === 'partial' ? 'library' : 'preflight', new Error('failed'))
    h.failReset(error)
    h.actions.confirmProgramReset()
    await assert.rejects(h.confirmReset(), value => value === error)
    assert.deepEqual(h.errors, [`pages.preference.about.errors.${key}`])
    h.failReset(undefined)
    await h.confirmReset()
    assert.deepEqual(h.successes, [])
  }
})
