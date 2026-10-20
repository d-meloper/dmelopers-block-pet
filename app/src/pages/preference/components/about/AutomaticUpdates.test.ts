/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { RecoveryReport } from '@/features/recovery/types'
import type { PreferenceUpdates } from '@/features/updates/preferenceUpdates'
import type { DistributionChannel, DistributionInfo } from '@/services/distribution'
import type { AppUpdateInfo, UpdatePhase } from '@/services/inAppUpdates'

import externalLinks from '@/config/externalLinks.json'
import { APP_DISPLAY_NAME } from '@/constants/branding'
import { createPreferenceUpdates } from '@/features/updates/preferenceUpdates'
import en from '@/locales/en-US.json'
import ko from '@/locales/ko-KR.json'
import { selectByLanguage } from '@/locales/languageBranch'
import { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS } from '@/utils/programSettingsReset'

import * as supportRecovery from './supportRecovery'

const listItem = { name: 'ListItem' }

const available = (version = '1.0.2'): AppUpdateInfo => ({ available: true, currentVersion: '1.0.1', version, bytes: 123 })

function harness(channel: DistributionChannel = 'github', language?: 'ko-KR' | 'en-US') {
  const calls: string[] = []
  const errors: string[] = []
  let result = available()
  let failCheck = false
  let storeRequest = async () => {}
  const updates = createPreferenceUpdates({
    channel: async () => channel,
    checkApp: async (force) => {
      calls.push(force ? 'check:fresh' : 'check:cached')
      if (failCheck) throw new Error('offline')
      return result
    },
    install: async () => {
      calls.push('install')
    },
    cancel: async () => {
      calls.push('cancel')
    },
    reminderSnooze: () => ({ version: '', hiddenUntil: 0 }),
    snoozeReminder: () => {},
    report: () => {},
  })
  const view = renderComponent('AutomaticUpdates.vue', updates, {
    ...(language ? { 'vue-i18n': { useI18n: () => ({ t: translate(language) }) } } : {}),
    'ant-design-vue': { Button: 'button', Flex: 'flex', Progress: 'progress', message: { error: (key: string) => errors.push(key) } },
    '@/services/distribution': { openStore: async () => {
      calls.push('store')
      await storeRequest()
    } },
  })
  return {
    updates,
    calls,
    errors,
    nodes: view,
    action: () => view().find(node => node.props?.class === 'update-action')!,
    click: () => (view().find(node => node.props?.class === 'update-action')!.props!.onClick as () => Promise<void>)(),
    result: (value: AppUpdateInfo) => {
      result = value
    },
    failCheck: (value: boolean) => {
      failCheck = value
    },
    storeRequest: (request: () => Promise<void>) => {
      storeRequest = request
    },
  }
}

function translate(language: 'ko-KR' | 'en-US') {
  return (key: string, params: Record<string, unknown> = {}) => {
    let value: unknown = language === 'ko-KR' ? ko : en
    for (const part of key.split('.')) value = (value as Record<string, unknown>)[part]
    assert.equal(typeof value, 'string')
    return (value as string).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))
  }
}

function renderComponent(filename: string, updates?: PreferenceUpdates, overrides: Record<string, unknown> = {}) {
  const { descriptor } = parse(readFileSync(new URL(filename, import.meta.url), 'utf8'))
  const component = compileScript(descriptor, { id: filename, inlineTemplate: true })
  type Render = (context: object, cache: unknown[]) => Vue.VNode
  const exports = {} as { default: { setup: (props: object, context: object) => Render } }
  const mocks: Record<string, unknown> = {
    'vue': { ...Vue, onMounted: () => {}, onBeforeUnmount: () => {}, renderSlot: (slots: Vue.Slots, name: string) => Vue.createVNode(Vue.Fragment, null, slots?.[name]?.() ?? []) },
    'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
    '@ant-design/icons-vue': { GithubFilled: 'github-icon' },
    './NotionIcon.vue': { default: 'notion-icon' },
    './MicrosoftStoreIcon.vue': { default: 'microsoft-store-icon' },
    'ant-design-vue': { Button: 'button', Flex: 'flex', Progress: 'progress', Modal: 'modal', Switch: 'switch', message: { error: () => {} } },
    '@/components/preference-sections/index.vue': { default: 'sections' },
    '@/composables/useAppLanguage': { useAppLanguage: () => ({ select: <T>(korean: T, global: T) => selectByLanguage('ko-KR', korean, global) }) },
    '@/config/externalLinks.json': { default: externalLinks },
    '@/constants/branding': { APP_DISPLAY_NAME },
    '@/composables/useProgramSettingsReset': { useProgramSettingsReset: () => ({ resetProgramSettings: async () => {} }) },
    '@/components/pro-list-item/index.vue': { default: listItem },
    '@/components/pro-list/index.vue': { default: 'list' },
    '@/composables/usePreferenceUpdates': { usePreferenceUpdates: () => updates },
    '@/services/diagnostics': { reportDiagnostic: () => {} },
    '@/utils/programSettingsReset': { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS },
    '@/stores/app': { useAppStore: () => ({ version: '1.0.1' }) },
    './AutomaticUpdates.vue': { default: 'automatic-updates' },
    './supportRecovery': supportRecovery,
    '@/components/recovery-feedback/index.vue': { default: 'recovery-feedback' },
    './AppIdentity.vue': { default: listItem },
    ...overrides,
  }
  runInNewContext(ts.transpileModule(component.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => mocks[name] ?? {} })
  const render = exports.default.setup({}, { expose: () => {} })
  const flatten = (node: Vue.VNode): Vue.VNode[] => {
    const children = Array.isArray(node.children)
      ? node.children
      : node.children && typeof node.children === 'object'
        ? Object.values(node.children).flatMap(slot => typeof slot === 'function' ? slot() : [])
        : []
    return [node, ...children.flatMap(child => Vue.isVNode(child) ? flatten(child) : [])]
  }
  return () => flatten(render({ $t: (key: string) => key }, []))
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}

async function storeRecoveryFixture() {
  const calls: string[] = []
  const errors: string[] = []
  const pauses = new Map<string, Promise<void>>()
  const distribution = {} as typeof import('@/services/distribution')
  const info: DistributionInfo = {
    channel: 'store',
    updateUrl: 'ms-windows-store://downloadsandupdates',
    dataRoot: 'durable',
    localDataRoot: 'local',
    dataSchema: 1,
  }
  const source = ts.transpileModule(readFileSync(new URL('../../../../services/distribution.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(source, {
    exports: distribution,
    require: (id: string) => id === '@tauri-apps/api/core'
      ? { invoke: async (command: string) => {
          calls.push(command)
          await pauses.get(command)
          if (command === 'distribution_info') return info
        } }
      : { openUrl: async (url: string) => {
          calls.push(`open:${url}`)
          await pauses.get('opener')
        } },
  })
  const updates = createPreferenceUpdates({
    channel: async () => 'store',
    checkApp: async () => {
      throw new Error('Store must not check GitHub updates')
    },
    install: async () => {
      throw new Error('Store must not install GitHub updates')
    },
    cancel: async () => {},
    reminderSnooze: () => ({ version: '', hiddenUntil: 0 }),
    snoozeReminder: () => {},
    report: () => {},
  })
  await updates.setVisible(true)
  const recovery = supportRecovery.createSupportRecovery(20)
  let unmount = () => {}
  const nodes = renderComponent('AutomaticUpdates.vue', updates, {
    'vue': { ...Vue, renderSlot: (slots: Vue.Slots, name: string) => Vue.createVNode(Vue.Fragment, null, slots?.[name]?.() ?? []), onBeforeUnmount: (callback: () => void) => {
      unmount = callback
    } },
    'ant-design-vue': { Button: 'button', Flex: 'flex', Progress: 'progress', message: { error: (key: string) => errors.push(key) } },
    '@/services/distribution': distribution,
    './supportRecovery': { createSupportRecovery: () => recovery },
  })
  const action = () => nodes().find(node => node.props?.class === 'update-action')!
  return {
    calls,
    errors,
    recovery,
    action,
    click: () => (action().props!.onClick as () => Promise<void>)(),
    pause: (operation: string, work: Promise<void>) => pauses.set(operation, work),
    dispose: () => {
      unmount()
      updates.dispose()
    },
  }
}

it('uses the same single icon action to check or install on GitHub and test channels', async () => {
  for (const channel of ['github', 'test'] as const) {
    const h = harness(channel)
    await h.updates.setVisible(true)
    assert.equal(h.nodes().filter(node => node.type === 'button').length, 1)
    assert.equal(h.action().props!['aria-label'], 'inAppUpdates.install')
    assert.ok(!h.nodes().some(node => node.type === 'microsoft-store-icon'))
    assert.ok(h.nodes().some(node => String(node.props?.class).includes('i-lucide:download')))
    await h.click()
    assert.deepEqual(h.calls, ['check:cached', 'check:fresh', 'install'])
    h.result({ ...available(), available: false })
    await h.updates.check()
    assert.equal(h.action().props!['aria-label'], 'inAppUpdates.check')
    assert.ok(h.nodes().some(node => String(node.props?.class).includes('i-lucide:refresh-cw')))
    await h.click()
    assert.equal(h.calls.at(-1), 'check:fresh')
  }
})

it('checks instead of installing stale failed information and revalidates changed versions', async () => {
  const h = harness()
  await h.updates.setVisible(true)
  h.failCheck(true)
  await h.updates.check()
  assert.equal(h.updates.appInfo.value?.available, true)
  assert.equal(h.action().props!['aria-label'], 'inAppUpdates.check')
  h.failCheck(false)
  h.result(available('1.0.3'))
  await h.click()
  assert.ok(!h.calls.includes('install'))
  h.result(available('1.0.4'))
  await h.click()
  assert.ok(!h.calls.includes('install'))
  await h.click()
  assert.equal(h.calls.filter(call => call === 'install').length, 1)
  h.updates.appInfo.value = { ...available(), version: null }
  assert.equal(h.action().props!['aria-label'], 'inAppUpdates.check')
})

it('keeps progress, cancellation and duplicate-action guards during every update phase', async () => {
  const h = harness()
  await h.updates.setVisible(true)
  for (const phase of ['downloading', 'verifying', 'saving', 'installing'] as UpdatePhase[]) {
    h.updates.phase.value = phase
    h.updates.percent.value = 42
    assert.equal(h.action().props!.disabled, true)
    assert.ok(h.nodes().some(node => String(node.props?.class).includes('i-lucide:loader-circle')))
    assert.ok(!h.nodes().some(node => String(node.props?.class).includes('i-lucide:download')))
    assert.equal(h.nodes().find(node => node.type === listItem)!.props!['stack-actions'], true)
    assert.equal(h.nodes().find(node => node.props?.class === 'update-phase-text')!.children, `inAppUpdates.${phase}`)
    const before = h.calls.length
    await h.click()
    assert.equal(h.calls.length, before)
    const cancellable = phase === 'downloading' || phase === 'verifying'
    assert.equal(h.nodes().filter(node => node.type === 'button').length, cancellable ? 2 : 1)
    const progress = h.nodes().find(node => node.type === 'progress')
    assert.equal(Boolean(progress), cancellable)
    if (cancellable) {
      assert.equal(progress!.props!.percent, 42)
      const cancel = h.nodes().find(node => node.type === 'button' && node.props?.class !== 'update-action')!
      await cancel.props!.onClick()
      assert.equal(h.calls.at(-1), 'cancel')
    }
    assert.ok(h.nodes().some(node => node.props?.role === 'status'))
  }
  h.updates.phase.value = undefined
  h.updates.checking.value = true
  assert.equal(h.action().props!.disabled, true)
  await h.click()
  assert.ok(!h.calls.includes('install'))
})

it('opens only Microsoft Store with a duplicate guard and reports an open failure', async () => {
  const h = harness('store')
  await h.updates.setVisible(true)
  assert.equal(h.action().props!['aria-label'], 'storeUpdates.open')
  assert.ok(h.nodes().some(node => node.type === 'microsoft-store-icon'))
  assert.ok(!h.nodes().some(node => String(node.props?.class).includes('i-lucide:refresh-cw')))
  let reject!: (reason: Error) => void
  h.storeRequest(() => new Promise<void>((_, no) => {
    reject = no
  }))
  const opening = h.click()
  assert.equal(h.action().props!.disabled, true)
  assert.ok(h.nodes().some(node => String(node.props?.class).includes('i-lucide:loader-circle')))
  assert.ok(!h.nodes().some(node => node.type === 'microsoft-store-icon'))
  await h.click()
  reject(new Error('Store unavailable'))
  await opening
  assert.deepEqual(h.calls, ['store'])
  assert.deepEqual(h.errors, ['storeUpdates.openFailed'])
  assert.equal(h.action().props!.disabled, false)
  assert.ok(h.nodes().some(node => node.type === 'microsoft-store-icon'))
})

it('keeps Store opening silent while preserving genuine update recovery feedback', async () => {
  const h = harness('store')
  const recovery = Vue.shallowRef<RecoveryReport>()
  const nodes = renderComponent('AutomaticUpdates.vue', h.updates, {
    '@/composables/usePreferenceUpdates': { usePreferenceUpdates: () => ({ ...h.updates, recovery }) },
    '@/services/distribution': { openStore: async () => {} },
  })
  const click = () => (nodes().find(node => node.props?.class === 'update-action')!.props!.onClick as () => Promise<void>)()
  try {
    await h.updates.setVisible(true)
    await click()
    const feedback = () => nodes().find(node => node.type === 'recovery-feedback')!
    assert.equal(feedback().props!.report, undefined)
    const report = { status: 'unresolved' as const, steps: [] }
    recovery.value = report
    assert.deepEqual(feedback().props!.report, report)
    await click()
    assert.deepEqual(feedback().props!.report, report)
  } finally {
    h.updates.dispose()
  }
})

for (const operation of ['await_native_startup', 'distribution_info']) {
  it(`does not open Store after recovery times out during ${operation}, then permits a current retry`, async () => {
    const h = await storeRecoveryFixture()
    const preparation = deferred()
    h.pause(operation, preparation.promise)
    try {
      await h.click()
      assert.ok(h.calls.includes(operation))
      assert.equal(h.recovery.busy.value, true)
      assert.equal(h.action().props!.disabled, true)
      const before = [...h.calls]
      await h.click()
      assert.deepEqual(h.calls, before, 'the timed-out preparation retains ownership until it settles')
      preparation.resolve()
      await settle()
      assert.deepEqual(h.calls, ['await_native_startup', 'distribution_info'])
      assert.equal(h.recovery.busy.value, false)
      assert.equal(h.action().props!.disabled, false)
      await h.click()
      assert.equal(h.calls.at(-1), 'open:ms-windows-store://downloadsandupdates')
      assert.equal(h.calls.filter(call => call.startsWith('open:')).length, 1)
    } finally {
      preparation.resolve()
      h.dispose()
    }
  })

  it(`does not open Store after About disposal during ${operation}`, async () => {
    const h = await storeRecoveryFixture()
    const preparation = deferred()
    h.pause(operation, preparation.promise)
    const opening = h.click()
    await settle()
    assert.ok(h.calls.includes(operation))
    h.dispose()
    await opening
    preparation.resolve()
    await settle()
    assert.deepEqual(h.calls, ['await_native_startup', 'distribution_info'])
    assert.deepEqual(h.errors, [])
    await h.click()
    assert.equal(h.calls.length, 2)
  })
}

it('retains an already issued Store opener through recovery timeout without replay or claiming cancellation', async () => {
  const h = await storeRecoveryFixture()
  const opener = deferred()
  h.pause('opener', opener.promise)
  try {
    await h.click()
    assert.equal(h.calls.filter(call => call.startsWith('open:')).length, 1)
    assert.equal(h.recovery.busy.value, true)
    assert.equal(h.action().props!.disabled, true)
    await h.click()
    assert.equal(h.calls.length, 3)
    opener.resolve()
    await settle()
    assert.equal(h.recovery.busy.value, false)
    assert.equal(h.calls.length, 3)
  } finally {
    opener.resolve()
    h.dispose()
  }
})

it('disposal retires feedback but does not cancel or repeat an already issued Store opener', async () => {
  const h = await storeRecoveryFixture()
  const opener = deferred()
  h.pause('opener', opener.promise)
  const opening = h.click()
  await settle()
  assert.equal(h.calls.filter(call => call.startsWith('open:')).length, 1)
  h.dispose()
  await opening
  opener.resolve()
  await settle()
  assert.deepEqual(h.errors, [])
  await h.click()
  assert.equal(h.calls.length, 3)
})

it('keeps the development refresh action disabled without development status or tooltip copy', async () => {
  const h = harness('development')
  await h.updates.setVisible(true)
  const row = h.nodes().find(node => node.type === listItem)!
  assert.equal(row.props!.title, APP_DISPLAY_NAME)
  assert.equal(row.props!.description, 'v1.0.1')
  assert.equal(h.action().props!.disabled, true)
  assert.equal(h.action().props!['aria-label'], 'inAppUpdates.check')
  assert.equal(h.action().props!.title, 'inAppUpdates.check')
  assert.equal(h.nodes().find(node => node.props?.role === 'status')!.children, 'v1.0.1')
  await h.click()
  assert.deepEqual(h.calls, [])
})

it('groups app information and support actions in their requested order', () => {
  const nodes = renderComponent('index.vue')()
  const updateIndex = nodes.findIndex(node => node.type === 'automatic-updates')
  const developerIndex = nodes.findIndex(node => node.props?.title === 'pages.preference.about.labels.developer')
  const environmentIndex = nodes.findIndex(node => node.props?.title === 'pages.preference.about.labels.appInfo')
  const contactIndex = nodes.findIndex(node => node.props?.title === 'pages.preference.about.labels.contactUs')
  const developerEmailIndex = nodes.findIndex(node => node.props?.title === 'pages.preference.about.labels.developerEmail')
  const appLogIndex = nodes.findIndex(node => node.props?.title === 'pages.preference.about.labels.appLog')
  const introductionIndex = nodes.findIndex(node => node.props?.['aria-label'] === 'pages.preference.about.labels.introduction')
  const releaseNotesIndex = nodes.findIndex(node => node.props?.['aria-label'] === 'pages.preference.about.labels.releaseNotes')
  const appSection = nodes.findIndex(node => node.type === 'list' && !node.props?.title)
  const supportSection = nodes.findIndex(node => node.type === 'list' && node.props?.title === 'pages.preference.about.labels.troubleshootingSupport')
  assert.ok(appSection >= 0 && updateIndex > appSection && developerIndex > updateIndex && introductionIndex > developerIndex)
  assert.ok(releaseNotesIndex > introductionIndex && supportSection > releaseNotesIndex)
  assert.ok(contactIndex > supportSection && developerEmailIndex > contactIndex)
  assert.ok(environmentIndex > developerEmailIndex && appLogIndex > environmentIndex)
  assert.ok(!nodes.some(node => node.type === 'list' && node.props?.title === 'pages.preference.about.labels.developerInfo'))
  assert.ok(!nodes.some(node => node.props?.title === 'inAppUpdates.title' || node.props?.title === 'inAppUpdates.latest'))
  const buttonsFor = (index: number) => {
    const end = nodes.findIndex((node, next) => next > index && (node.type === listItem || node.props?.class === 'about-resource-group' || node.props?.class === 'about-policy-links' || node.props?.class === 'about-reset'))
    return nodes.slice(index, end < 0 ? undefined : end).filter(node => node.type === 'button')
  }
  for (const index of [introductionIndex, releaseNotesIndex]) {
    const buttons = buttonsFor(index)
    assert.equal(buttons.length, 3)
    for (const button of buttons) assert.equal(typeof button.props?.onClick, 'function')
  }
  for (const index of [environmentIndex, contactIndex, developerEmailIndex, appLogIndex]) {
    const buttons = buttonsFor(index)
    assert.equal(buttons.length, 1)
    assert.equal(typeof buttons[0].props?.onClick, 'function')
  }
})

it('shows localized current and latest versions together, including checking, failure and Store states', async () => {
  for (const language of ['ko-KR', 'en-US'] as const) {
    const t = translate(language)
    const h = harness('github', language)
    const description = () => h.nodes().find(node => node.type === listItem)!.props!.description
    await h.updates.setVisible(true)
    assert.equal(description(), `v1.0.1 ${t('inAppUpdates.available', { version: '1.0.2' })}`)
    if (language === 'ko-KR') assert.equal(description(), 'v1.0.1 최신 버전(v1.0.2)으로 업데이트가 가능합니다.')
    h.result({ ...available(), available: false })
    await h.updates.check()
    assert.equal(description(), `v1.0.1 ${t('inAppUpdates.upToDate')}`)
    if (language === 'ko-KR') assert.equal(description(), 'v1.0.1 현재 프로그램이 최신 버전입니다.')
    h.updates.checking.value = true
    assert.equal(description(), `v1.0.1 ${t('inAppUpdates.checking')}`)
    h.updates.checking.value = false
    h.failCheck(true)
    await h.updates.check()
    assert.equal(description(), `v1.0.1 ${t('inAppUpdates.unknown')}`)
    h.updates.failed.value = false
    h.updates.appInfo.value = { ...available(), version: null }
    assert.equal(description(), `v1.0.1 ${t('inAppUpdates.unknown')}`)
    const store = harness('store', language)
    await store.updates.setVisible(true)
    assert.equal(store.nodes().find(node => node.type === listItem)!.props!.description, `v1.0.1 ${t('storeUpdates.hint')}`)
    assert.deepEqual(store.calls, [])
  }
})
