/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { Language, LanguagePreference } from '@/locales/languageBranch'
import type { ProgramSettingsResetOptions } from '@/utils/programSettingsReset'

import externalLinks from '@/config/externalLinks.json'
import { APP_DISPLAY_NAME } from '@/constants/branding'
import { isKoreanLanguage, resolveLanguage, selectByLanguage } from '@/locales/languageBranch'
import { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS, ProgramSettingsResetError } from '@/utils/programSettingsReset'

function harness(renderTemplate = false) {
  const preference = Vue.ref<LanguagePreference>('system')
  const systemLanguage = Vue.ref<Language>('ko-KR')
  const locale = Vue.computed(() => resolveLanguage(preference.value, systemLanguage.value))
  const opened: string[] = []
  const openedPaths: string[] = []
  const logActions: string[] = []
  const copied: string[] = []
  const successes: string[] = []
  const errors: string[] = []
  let failOpen = false
  let failCopy = false
  let failLogPath = false
  let failLogPreparation = false
  let collectInfo = async () => ({ appName: APP_DISPLAY_NAME, appVersion: '1.0.0', distributionChannel: 'store', unavailable: [] as object[] })
  let mounted: () => Promise<void> = async () => {}
  let resetError: unknown
  const resetCalls: ProgramSettingsResetOptions[] = []
  let resetPending = Promise.resolve()
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'about-actions', inlineTemplate: renderTemplate })
  interface Actions {
    openDeveloperLink: () => Promise<void>
    showDataNotice: () => Promise<void>
    dataNotice: Vue.Ref<string>
    copyDeveloperEmail: () => Promise<void>
    copyInfo: () => Promise<void>
    openLogs: () => Promise<void>
    confirmProgramReset: () => void
    cancelProgramReset: () => void
    submitProgramReset: () => Promise<void>
    resetOpen: Vue.Ref<boolean>
    resetting: Vue.Ref<boolean>
    resetOptions: Vue.Ref<ProgramSettingsResetOptions>
  }
  type Render = (context: object, cache: unknown[]) => Vue.VNode
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Actions | Render } } }
  const mocks: Record<string, unknown> = {
    '@/services/diagnostics': { reportDiagnostic: () => {} },
    'vue': { ...Vue, onMounted: (callback: typeof mounted) => {
      mounted = callback
    } },
    'vue-i18n': { useI18n: () => ({ locale, t: (key: string) => key }) },
    '@ant-design/icons-vue': { GithubFilled: 'github-icon' },
    './NotionIcon.vue': { default: 'notion-icon' },
    './MicrosoftStoreIcon.vue': { default: 'microsoft-store-icon' },
    'ant-design-vue': {
      Button: 'button',
      Flex: 'flex',
      Switch: 'switch',
      message: { success: (key: string) => successes.push(key), error: (key: string) => errors.push(key) },
      Modal: 'modal',
    },
    '@tauri-apps/api/app': { getTauriVersion: async () => '2.0.0' },
    '@tauri-apps/api/core': { invoke: async (command: string, args?: unknown) => {
      assert.equal(command, 'prepare_log_directory')
      assert.equal(args, undefined)
      logActions.push('prepare')
      if (failLogPreparation) throw new Error('LOG_DIRECTORY_CREATE_FAILED')
      return '/logs'
    } },
    '@tauri-apps/api/path': { appLogDir: async () => {
      if (failLogPath) throw new Error('directory failed')
      return '/logs'
    } },
    '@tauri-apps/plugin-os': { arch: () => 'x86_64', platform: () => 'windows', version: () => '10' },
    '@tauri-apps/plugin-opener': { openUrl: async (url: string) => {
      if (failOpen) throw new Error('open failed')
      opened.push(url)
    }, openPath: async (path: string) => {
      logActions.push('open')
      if (failOpen) throw new Error('open failed')
      openedPaths.push(path)
    } },
    '@tauri-apps/plugin-clipboard-manager': { writeText: async (text: string) => {
      if (failCopy) throw new Error('copy failed')
      copied.push(text)
    } },
    '@/composables/useAppLanguage': { useAppLanguage: () => ({ select: <T>(korean: T, global: T) => selectByLanguage(locale.value, korean, global) }) },
    '@/legal/data-permissions.ko-KR.txt?raw': { default: 'Korean data notice' },
    '@/legal/data-permissions.en-US.txt?raw': { default: 'English data notice' },
    '@/constants/branding': { APP_DISPLAY_NAME },
    '@/config/externalLinks.json': { default: externalLinks },
    '@/services/environmentInfo': { collectEnvironmentInfo: () => collectInfo() },
    '@/composables/useProgramSettingsReset': { useProgramSettingsReset: () => ({ resetProgramSettings: async (options: ProgramSettingsResetOptions) => {
      resetCalls.push({ ...options })
      await resetPending
      if (resetError) throw resetError
    } }) },
    '@/utils/programSettingsReset': { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS, ProgramSettingsResetError },
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
    nodes: () => flatten((setup as Render)({ $t: (key: string) => key }, [])),
    buttons: (title: string) => {
      const nodes = flatten((setup as Render)({ $t: (key: string) => key }, []))
      const row = nodes.find(node => node.props?.title === title || node.props?.['aria-label'] === title)
      assert.ok(row)
      return flatten(row).filter(node => node.type === 'button')
    },
    preference,
    systemLanguage,
    opened,
    openedPaths,
    logActions,
    copied,
    successes,
    errors,
    resetCalls,
    setCollector: (collector: typeof collectInfo) => {
      collectInfo = collector
    },
    failLogPath: (failed: boolean) => {
      failLogPath = failed
    },
    failLogPreparation: (failed: boolean) => {
      failLogPreparation = failed
    },
    failReset: (error: unknown) => {
      resetError = error
    },
    pauseReset: (pending: Promise<void>) => {
      resetPending = pending
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
  h.preference.value = 'en-US'
  await h.actions.openDeveloperLink()
  h.systemLanguage.value = 'en-US'
  h.preference.value = 'system'
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
  assert.equal(JSON.parse(h.copied[1]).distributionChannel, 'store')
})

it('copies a partial report and suppresses duplicate clicks until collection finishes', async () => {
  const h = harness()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  h.setCollector(async () => {
    calls++
    await pending
    return { appName: APP_DISPLAY_NAME, appVersion: '1.0.0', distributionChannel: 'github', unavailable: [{ section: 'graphics', reason: 'failed' }] }
  })
  const first = h.actions.copyInfo()
  await h.actions.copyInfo()
  assert.equal(calls, 1)
  release()
  await first
  assert.equal(h.copied.length, 1)
  assert.deepEqual(JSON.parse(h.copied[0]).unavailable, [{ section: 'graphics', reason: 'failed' }])
  await h.actions.copyInfo()
  assert.equal(calls, 2)
})

it('allows retry after an unexpected collection failure', async () => {
  const h = harness()
  h.setCollector(async () => {
    throw new Error('failed')
  })
  await h.actions.copyInfo()
  await h.actions.copyInfo()
  assert.equal(h.errors.length, 2)
  assert.equal(h.copied.length, 0)
})

it('reports native open and clipboard failures without success notifications', async () => {
  const h = harness()
  h.fail()
  await h.actions.openDeveloperLink()
  await h.actions.copyDeveloperEmail()
  assert.deepEqual(h.errors, ['pages.preference.about.errors.openDeveloperLink', 'pages.preference.about.errors.copyEmail'])
  assert.deepEqual(h.successes, [])
})

it('opens the introduction, Release Notes and survey destinations and reports opener failures', async () => {
  const h = harness(true)
  const introductionButtons = h.buttons('pages.preference.about.labels.introduction')
  assert.equal(introductionButtons.length, 3)
  for (const button of introductionButtons) {
    assert.equal(typeof button.props?.onClick, 'function')
    await button.props!.onClick()
  }
  const releaseNotesButtons = h.buttons('pages.preference.about.labels.releaseNotes')
  assert.equal(releaseNotesButtons.length, 3)
  for (const button of releaseNotesButtons) {
    assert.equal(typeof button.props?.onClick, 'function')
    await button.props!.onClick()
  }
  for (const buttons of [introductionButtons, releaseNotesButtons]) {
    const store = buttons[2]
    assert.equal(store.props?.['aria-label'], 'pages.preference.about.buttons.microsoftStore')
    assert.equal(store.props?.title, 'pages.preference.about.buttons.microsoftStore')
  }
  const contactButtons = h.buttons('pages.preference.about.labels.contactUs')
  assert.equal(contactButtons.length, 1)
  const contactLabel = Array.isArray(contactButtons[0].children)
    ? contactButtons[0].children.map(child => Vue.isVNode(child) ? child.children : child).join('')
    : contactButtons[0].children
  assert.equal(String(contactLabel).trim(), 'pages.preference.about.labels.contactUs')
  assert.equal(typeof contactButtons[0].props?.onClick, 'function')
  await contactButtons[0].props!.onClick()
  assert.deepEqual(h.opened, [
    'https://app.notion.com/p/aismash/0da2dc0bb4ae82ab8db301718dde497b?source=copy_link',
    'https://github.com/d-meloper/dmelopers-block-pet',
    'https://apps.microsoft.com/detail/9PLKW6NBMKQ7?hl=ko-kr&gl=KR&ocid=pdpshare',
    'https://app.notion.com/p/aismash/DMeloper-s-Block-Pet-b872dc0bb4ae83d5b15681b53f73d0f9?source=copy_link',
    'https://github.com/d-meloper/dmelopers-block-pet/releases',
    'https://apps.microsoft.com/detail/9PLKW6NBMKQ7?hl=ko-kr&gl=KR&ocid=pdpshare',
    'https://aismash.notion.site/9cff9655595342d78a22c17b61a2084c',
  ])
  const failed = harness(true)
  failed.fail()
  await failed.buttons('pages.preference.about.labels.introduction')[2].props!.onClick()
  assert.deepEqual(failed.errors, ['pages.preference.about.errors.openLink'])
  assert.deepEqual(failed.opened, [])
})

it('prepares the fixed log folder before every open and keeps real failures visible', async () => {
  const h = harness()
  h.failLogPath(true)
  await h.mount()
  h.failLogPreparation(true)
  await h.actions.openLogs()
  assert.deepEqual(h.openedPaths, [])
  assert.deepEqual(h.logActions, ['prepare'])
  assert.deepEqual(h.errors, ['pages.preference.about.errors.openLog'])
  h.failLogPreparation(false)
  await h.actions.openLogs()
  assert.deepEqual(h.openedPaths, ['/logs'])
  assert.deepEqual(h.logActions, ['prepare', 'prepare', 'open'])
  await h.actions.openLogs()
  assert.deepEqual(h.openedPaths, ['/logs', '/logs'])
  assert.deepEqual(h.logActions, ['prepare', 'prepare', 'open', 'prepare', 'open'])
  h.fail()
  await h.actions.openLogs()
  assert.equal(h.errors.at(-1), 'pages.preference.about.errors.openLog')
  assert.deepEqual(h.openedPaths, ['/logs', '/logs'])
  assert.deepEqual(h.logActions.slice(-2), ['prepare', 'open'])
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
    await h.actions.submitProgramReset()
    assert.deepEqual(h.errors, [`pages.preference.about.errors.${key}`])
    assert.equal(h.actions.resetOpen.value, true)
    assert.equal(h.actions.resetting.value, false)
    h.failReset(undefined)
    await h.actions.submitProgramReset()
    assert.equal(h.actions.resetOpen.value, false)
    assert.deepEqual(h.successes, [])
  }
})

it('opens with both deletion choices OFF and cancels without a reset', async () => {
  const h = harness()
  h.actions.confirmProgramReset()
  assert.deepEqual({ ...h.actions.resetOptions.value }, { deleteSkins: false, resetPresets: false })
  h.actions.resetOptions.value.deleteSkins = true
  h.actions.resetOptions.value.resetPresets = true
  h.actions.cancelProgramReset()
  assert.equal(h.actions.resetOpen.value, false)
  await h.actions.submitProgramReset()
  assert.equal(h.resetCalls.length, 0)
  h.actions.confirmProgramReset()
  assert.deepEqual({ ...h.actions.resetOptions.value }, { deleteSkins: false, resetPresets: false })
})

it('captures reset choices for retries and ignores double submission or closing while in progress', async () => {
  const h = harness()
  let release!: () => void
  h.pauseReset(new Promise<void>((resolve) => {
    release = resolve
  }))
  h.actions.confirmProgramReset()
  h.actions.resetOptions.value.deleteSkins = true
  const running = h.actions.submitProgramReset()
  assert.equal(h.actions.resetting.value, true)
  h.actions.cancelProgramReset()
  h.actions.confirmProgramReset()
  await h.actions.submitProgramReset()
  assert.equal(h.resetCalls.length, 1)
  assert.equal(h.actions.resetOpen.value, true)
  h.actions.resetOptions.value.deleteSkins = false
  h.actions.resetOptions.value.resetPresets = true
  h.failReset(new ProgramSettingsResetError('partial', 'window', new Error('window failed')))
  release()
  await running
  assert.equal(h.actions.resetOpen.value, true)
  h.failReset(undefined)
  await h.actions.submitProgramReset()
  assert.deepEqual(h.resetCalls, [
    { deleteSkins: true, resetPresets: false },
    { deleteSkins: true, resetPresets: false },
  ])
  assert.equal(h.actions.resetOpen.value, false)
})

it('renders two accessible switches and locks the same choices while a reset is pending or awaiting retry', async () => {
  const h = harness(true)
  const resetButton = h.nodes().find(node => node.type === 'button'
    && Array.isArray(node.children) && node.children.some(child => Vue.isVNode(child) && String(child.children).includes('pages.preference.about.labels.resetAll')))!
  assert.ok(resetButton)
  resetButton.props!.onClick()
  const dialog = () => h.nodes().find(node => node.type === 'modal' && node.props?.title === 'pages.preference.about.confirm.resetAll')!
  const switches = () => h.nodes().filter(node => node.type === 'switch')
  assert.equal(dialog().props!.open, true)
  assert.deepEqual(switches().map(node => node.props!['aria-label']), ['pages.preference.about.labels.resetDeleteSkins', 'pages.preference.about.labels.resetPresets'])
  assert.ok(switches().every(node => node.props!.checked === false && node.props!.disabled === false))
  switches()[1].props!['onUpdate:checked'](true)
  let release!: () => void
  h.pauseReset(new Promise<void>((resolve) => {
    release = resolve
  }))
  h.failReset(new Error('try again'))
  const running = dialog().props!.onOk()
  assert.equal(dialog().props!.closable, false)
  assert.equal(dialog().props!.keyboard, false)
  assert.equal(dialog().props!['mask-closable'], false)
  assert.ok(switches().every(node => node.props!.disabled))
  release()
  await running
  assert.equal(dialog().props!.open, true)
  assert.equal(dialog().props!.closable, true)
  assert.ok(switches().every(node => node.props!.disabled))
  assert.deepEqual(h.resetCalls, [{ deleteSkins: false, resetPresets: true }])
  dialog().props!.onCancel()
  assert.equal(dialog().props!.open, false)
})

it('opens and closes all icon credits from the shared policy link', () => {
  const h = harness(true)
  const creditDialog = () => h.nodes().find(node => node.props?.title === 'pages.preference.about.labels.iconCredits')!
  assert.equal(creditDialog().props!.open, false)
  h.buttons('pages.preference.about.labels.iconCredits')[0].props!.onClick()
  assert.equal(creditDialog().props!.open, true)
  for (const title of ['Solar Icons', 'Lucide Icons', 'Ant Design Icons', 'Notion', 'Microsoft Store']) {
    assert.ok(h.nodes().some(node => node.props?.title === title))
  }
  creditDialog().props!['onUpdate:open'](false)
  assert.equal(creditDialog().props!.open, false)
})

it('selects legal content from the resolved preference on every open', async () => {
  const h = harness()
  await h.actions.showDataNotice()
  assert.equal(h.actions.dataNotice.value, 'Korean data notice')
  h.preference.value = 'en-US'
  await h.actions.showDataNotice()
  assert.equal(h.actions.dataNotice.value, 'English data notice')
  h.systemLanguage.value = 'en-US'
  h.preference.value = 'ko-KR'
  await h.actions.showDataNotice()
  assert.equal(h.actions.dataNotice.value, 'Korean data notice')
  h.preference.value = 'system'
  await h.actions.showDataNotice()
  assert.equal(h.actions.dataNotice.value, 'English data notice')
})

it('reacts to System and explicit overrides for all localized resource destinations', async () => {
  const h = harness(true)
  h.systemLanguage.value = 'en-US'
  const introduction = h.buttons('pages.preference.about.labels.introduction')
  await introduction[0].props!.onClick()
  await introduction[2].props!.onClick()
  await h.buttons('pages.preference.about.labels.contactUs')[0].props!.onClick()
  await h.buttons('pages.preference.about.labels.releaseNotes')[2].props!.onClick()
  await h.buttons('pages.preference.about.labels.releaseNotes')[0].props!.onClick()
  assert.deepEqual(h.opened, [
    'https://app.notion.com/p/aismash/DMeloper-s-Block-Pet-Global-3f32dc0bb4ae807987f5df0a0f1b112e?source=copy_link',
    'https://apps.microsoft.com/detail/9plkw6nbmkq7?hl=en-US',
    'https://aismash.notion.site/5402dc0bb4ae83fdb83681271f4b937e?pvs=105',
    'https://apps.microsoft.com/detail/9plkw6nbmkq7?hl=en-US',
    'https://app.notion.com/p/aismash/DMeloper-s-Block-Pet-Downloads-3f32dc0bb4ae800e9dc7e7fd7eeb55d7?source=copy_link',
  ])
  h.preference.value = 'ko-KR'
  await introduction[0].props!.onClick()
  await h.buttons('pages.preference.about.labels.contactUs')[0].props!.onClick()
  await h.buttons('pages.preference.about.labels.releaseNotes')[0].props!.onClick()
  assert.deepEqual(h.opened.slice(-3), [
    'https://app.notion.com/p/aismash/0da2dc0bb4ae82ab8db301718dde497b?source=copy_link',
    'https://aismash.notion.site/9cff9655595342d78a22c17b61a2084c',
    'https://app.notion.com/p/aismash/DMeloper-s-Block-Pet-b872dc0bb4ae83d5b15681b53f73d0f9?source=copy_link',
  ])
  h.systemLanguage.value = 'ko-KR'
  h.preference.value = 'en-US'
  await introduction[2].props!.onClick()
  await h.buttons('pages.preference.about.labels.developer')[0].props!.onClick()
  assert.deepEqual(h.opened.slice(-2), [
    'https://apps.microsoft.com/detail/9plkw6nbmkq7?hl=en-US',
    'https://linktr.ee/dmeloper.dev',
  ])
  h.preference.value = 'system'
  await introduction[2].props!.onClick()
  assert.equal(h.opened.at(-1), 'https://apps.microsoft.com/detail/9PLKW6NBMKQ7?hl=ko-kr&gl=KR&ocid=pdpshare')
})
