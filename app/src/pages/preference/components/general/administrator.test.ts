/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import { createPreferenceElevation } from '@/features/elevation/preferenceElevation'

const button = { name: 'Button' }
const toggle = { name: 'Switch' }
const placeholder = { name: 'Placeholder' }

async function harness(options: {
  elevated?: boolean
  inputElevated?: boolean
  always?: boolean
  persist?: boolean
  save?: () => Promise<void>
} = {}) {
  const calls: string[] = []
  const infos: Array<{ key: string, duration?: number }> = []
  const errors: string[] = []
  const unmount: Array<() => void> = []
  const app = Vue.reactive({ alwaysRunAsAdministrator: options.always ?? true, administratorReminderDismissed: true, taskbarVisible: true })
  let inputElevated = options.inputElevated
  let confirmation: { title?: string, content?: Vue.VNode, okButtonProps?: { danger?: boolean, type?: string, style?: object }, onOk: () => Promise<void> } | undefined
  const elevation = createPreferenceElevation({
    status: async () => ({ supported: true, elevated: options.elevated ?? true, inputElevated }),
    prepare: async () => {
      assert.fail('changing a saved choice must not request UAC')
    },
    restart: async () => assert.fail('must not exit'),
    cancel: async () => {},
    disableInput: async () => {
      calls.push('disable')
      inputElevated = false
      return { supported: true, elevated: options.elevated ?? true, inputElevated: false }
    },
    persist: options.persist === false
      ? undefined
      : async (key, enabled) => {
        calls.push(key)
        await options.save?.()
        app[key] = enabled
      },
    reminderDismissed: () => app.administratorReminderDismissed,
    report: () => {},
  })
  elevation.setBlocked(false)
  await elevation.setVisible(true)
  const general = { app, appearance: { language: 'system' }, reset: () => {
    app.alwaysRunAsAdministrator = false
    app.administratorReminderDismissed = false
  }, init: async () => {} }
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'general-settings', inlineTemplate: true })
  const exports = {} as { default: { setup: (props: object, context: object) => (context: object, cache: unknown[]) => Vue.VNode } }
  runInNewContext(ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    window: { removeEventListener: () => {} },
    require: (id: string) => ({
      'vue': { ...Vue, onMounted: () => {}, onBeforeUnmount: (callback: () => void) => unmount.push(callback) },
      'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
      'ant-design-vue': { Button: button, Switch: toggle, Select: { ...placeholder, Option: placeholder }, message: {
        error: (key: string) => errors.push(key),
        info: (key: string, duration?: number) => infos.push({ key, duration }),
      }, Modal: { confirm: (value: typeof confirmation) => {
        confirmation = value
      } } },
      '@/services/autostart': { getAutostartStatus: async () => ({ enabled: false, canDisable: true, canEnable: true }) },
      '@/services/diagnostics': { reportDiagnostic: () => {} },
      '@/plugins/process': { saveAppSettings: async () => {
        calls.push('save-reset')
      } },
      '@/stores/block': { useBlockStore: () => ({ resetGeneralSettings: () => {} }) },
      '@/stores/general': { useGeneralStore: () => general },
      '@/locales/registry': { getPublicLanguageOptions: () => [] },
    })[id] ?? { default: placeholder },
  })
  const render = exports.default.setup({ elevation }, { expose: () => {} })
  const flatten = (node: Vue.VNode): Vue.VNode[] => {
    const children = Array.isArray(node.children)
      ? node.children
      : node.children && typeof node.children === 'object'
        ? Object.values(node.children).flatMap(slot => typeof slot === 'function' ? slot() : [])
        : []
    return [node, ...children.flatMap(child => Vue.isVNode(child) ? flatten(child) : [])]
  }
  return { app, calls, elevation, errors, infos, unmount: () => unmount.forEach(callback => callback()), nodes: () => flatten(render({ $t: (key: string) => key }, [])), confirmation: () => confirmation }
}

test('General displays actual administrator state, accent and shield without an administrator toggle or enable button', async () => {
  for (const opts of [{ elevated: true, always: false }, { elevated: false, inputElevated: true, always: false }]) {
    const h = await harness(opts)
    const rows = h.nodes().filter(node => node.props?.title === 'administratorSettings.title')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].props?.description, 'administratorSettings.hint')
    const slots = rows[0].children as Record<string, () => Vue.VNode[]>
    const title = slots.title()[0]
    const titleMarkup = JSON.stringify(title, (key, value) => ['component', 'ctx', 'appContext'].includes(key) ? undefined : value)
    assert.ok(titleMarkup.includes('administrator-status-active'))
    const controls = h.nodes().find(node => node.props?.class === 'administrator-status-controls')!
    assert.equal(JSON.stringify(controls.children).includes('administrator-status-active'), false)
    assert.equal(h.nodes().some(node => node.type === toggle && node.props?.['aria-label'] === 'administratorSettings.title'), false)
    assert.ok(h.nodes().some(node => node.props?.class?.includes('administrator-status-active')))
    assert.ok(h.nodes().some(node => node.props?.class === 'i-lucide:shield-check'))
    assert.equal(h.nodes().some(node => node.children === 'adminLaunchReminder.always'), false)
    assert.deepEqual(h.calls, [])
    h.elevation.dispose()
  }
})

test('known inactive input shows warning and Enable even when the saved choice is already enabled', async () => {
  const h = await harness({ elevated: false, inputElevated: false, always: true })
  assert.ok(h.nodes().some(node => node.props?.class?.includes('administrator-status-inactive')))
  assert.ok(h.nodes().some(node => node.props?.class === 'i-lucide:triangle-alert'))
  const enable = h.nodes().find(node => node.type === button && node.props?.block !== '')!
  assert.ok(enable)
  assert.equal(enable.props?.type, undefined)
  enable.props!.onClick()
  assert.equal(h.elevation.open.value, true)
  assert.equal(h.elevation.showDismiss.value, false)
  assert.deepEqual(h.calls, [])
  assert.equal(h.app.alwaysRunAsAdministrator, true)
  assert.equal(h.app.administratorReminderDismissed, true)
  h.elevation.dispose()
})

test('unknown and checking states remain neutral and cannot blindly request administrator input', async () => {
  const h = await harness({ elevated: false })
  h.elevation.status.value = undefined
  assert.ok(h.nodes().some(node => node.props?.class?.includes('administrator-status-unknown')))
  assert.equal(h.nodes().some(node => node.children === 'adminLaunchReminder.always'), false)
  h.elevation.checking.value = true
  assert.ok(h.nodes().some(node => node.props?.class?.includes('administrator-status-checking')))
  assert.equal(h.nodes().some(node => node.children === 'adminLaunchReminder.always'), false)
  h.elevation.dispose()
})

test('unsupported runtime shows the reason without an enable action or a fake activated state', async () => {
  const h = await harness({ elevated: false })
  h.elevation.status.value = { supported: false, elevated: false }
  assert.ok(h.nodes().some(node => node.children === 'administratorSettings.unsupported'))
  assert.equal(h.nodes().some(node => node.children === 'adminLaunchReminder.always'), false)
  h.elevation.dispose()
})
test('General reset persists automatic elevation off and restores the reminder', async () => {
  const h = await harness()
  const reset = h.nodes().find(node => node.type === button && node.props?.block === '')!
  reset.props!.onClick()
  await h.confirmation()!.onOk()
  assert.equal(h.app.alwaysRunAsAdministrator, false)
  assert.equal(h.app.administratorReminderDismissed, false)
  assert.deepEqual(h.calls, ['save-reset'])
  h.elevation.dispose()
})

test('administrator status precedes autostart with a normal disable action and warning confirmation', async () => {
  const h = await harness({ elevated: false, inputElevated: true })
  const rows = h.nodes().filter(node => node.props?.title)
  assert.ok(rows.findIndex(node => node.props?.title === 'administratorSettings.title')
    < rows.findIndex(node => node.props?.title === 'pages.preference.general.labels.launchOnStartup'))
  const disable = h.nodes().find(node => node.type === button && node.props?.class === 'administrator-disable')!
  assert.equal(disable.props?.danger, undefined)
  assert.equal(disable.props?.type, undefined)
  assert.equal(disable.props?.style, undefined)
  disable.props!.onClick()
  assert.equal(h.confirmation()!.title, 'administratorSettings.disableTitle')
  assert.equal(h.confirmation()!.content?.children, 'administratorSettings.disableMessage')
  assert.equal(h.confirmation()!.content?.props?.style.whiteSpace, 'pre-line')
  assert.equal(h.confirmation()!.okButtonProps?.danger, undefined)
  assert.equal((h.confirmation()!.okButtonProps?.style as { backgroundColor: string }).backgroundColor, 'var(--ant-color-warning)')
  assert.deepEqual(h.calls, [])
  assert.equal(h.app.alwaysRunAsAdministrator, true)
  await h.confirmation()!.onOk()
  assert.deepEqual(h.calls, ['alwaysRunAsAdministrator', 'disable'])
  assert.equal(h.app.alwaysRunAsAdministrator, false)
  assert.equal(h.elevation.isActive.value, false)
  assert.equal(h.nodes().some(node => node.type === button && node.props?.class === 'administrator-disable'), false)
  assert.ok(h.nodes().some(node => node.children === 'adminLaunchReminder.always'))
  h.elevation.dispose()
})
