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

async function harness() {
  const calls: string[] = []
  const app = Vue.reactive({ alwaysRunAsAdministrator: true, administratorReminderDismissed: true, taskbarVisible: true })
  let confirmation: { onOk: () => Promise<void> } | undefined
  const elevation = createPreferenceElevation({
    status: async () => ({ supported: true, elevated: true }),
    prepare: async () => {
      assert.fail('changing a saved choice must not request UAC')
    },
    restart: async () => assert.fail('must not exit'),
    cancel: async () => {},
    persist: async (key, enabled) => {
      calls.push(key)
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
    require: (id: string) => ({
      'vue': { ...Vue, onMounted: () => {}, onBeforeUnmount: () => {} },
      'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
      'ant-design-vue': { Button: button, Switch: toggle, Select: { ...placeholder, Option: placeholder }, message: { error: () => {} }, Modal: { confirm: (value: typeof confirmation) => {
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
  return { app, calls, elevation, nodes: () => flatten(render({ $t: (key: string) => key }, [])), confirmation: () => confirmation }
}

test('the Always switch ignores Ant Design change-event arguments and never changes reminder suppression', async () => {
  const h = await harness()
  const setting = h.nodes().find(node => node.type === toggle && node.props?.['aria-label'] === 'administratorSettings.title')!
  const saving = setting.props!.onChange(false, { type: 'change' })
  assert.equal(h.nodes().some(node => node.props?.role === 'status'), false)
  await saving
  assert.equal(h.app.alwaysRunAsAdministrator, false)
  assert.equal(h.app.administratorReminderDismissed, true)
  assert.equal(h.app.taskbarVisible, true)
  assert.deepEqual(h.calls, ['alwaysRunAsAdministrator'])
  assert.equal(h.elevation.status.value?.elevated, true)
  h.elevation.dispose()
})

test('General exposes only the Always administrator setting and turning it back on opens the shared dialog', async () => {
  const h = await harness()
  const administratorRows = h.nodes().filter(node => String(node.props?.title).startsWith('administratorSettings.'))
  assert.equal(administratorRows.length, 1)
  assert.equal(administratorRows[0].props?.description, 'administratorSettings.hint')
  const setting = h.nodes().find(node => node.type === toggle && node.props?.['aria-label'] === 'administratorSettings.title')!
  await setting.props!.onChange(false, { type: 'change' })
  await setting.props!.onChange(true, { type: 'change' })
  assert.equal(h.app.administratorReminderDismissed, true)
  assert.equal(h.app.alwaysRunAsAdministrator, false)
  assert.equal(h.elevation.open.value, true)
  assert.equal(h.elevation.showDismiss.value, false)
  assert.deepEqual(h.calls, ['alwaysRunAsAdministrator'])
  await h.elevation.restartAlways()
  assert.equal(h.app.alwaysRunAsAdministrator, true)
  assert.equal(h.elevation.open.value, false)
  assert.deepEqual(h.calls, ['alwaysRunAsAdministrator', 'alwaysRunAsAdministrator'])
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
