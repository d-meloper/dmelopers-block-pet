/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { AutostartStatus } from '@/services/autostart'

function resetHarness(native: {
  read: () => Promise<AutostartStatus>
  disable: () => Promise<void>
}, initialize = async () => {}) {
  const calls: string[] = []
  const errors: string[] = []
  let dialog: { onOk: () => Promise<void> } | undefined
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'general-reset' })
  interface Actions {
    confirmGeneralReset: () => void
    changeAutostart: (value: boolean) => Promise<void>
    resetting: Vue.Ref<boolean>
    autostartBusy: Vue.Ref<boolean>
  }
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Actions } } }
  const mocks: Record<string, unknown> = {
    'vue': { ...Vue, withDirectives: (node: Vue.VNode) => node, onMounted: () => {}, onBeforeUnmount: () => {} },
    'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
    'ant-design-vue': {
      Modal: { confirm: (options: typeof dialog) => {
        dialog = options
      } },
      message: { error: (key: string) => errors.push(key) },
    },
    '@/services/diagnostics': { reportDiagnostic: () => {} },
    '@/stores/block': { useBlockStore: () => ({ resetGeneralSettings: () => calls.push('reset-block') }) },
    '@/stores/general': { useGeneralStore: () => ({
      reset: () => calls.push('reset-general'),
      init: async () => {
        calls.push('initialize-general')
        await initialize()
      },
    }) },
    '@/services/autostart': {
      getAutostartStatus: async () => {
        calls.push('read')
        return native.read()
      },
      setAutostartEnabled: async (value: boolean) => {
        assert.equal(value, false)
        calls.push('disable')
        await native.disable()
      },
    },
  }
  runInNewContext(ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: (id: string) => mocks[id] ?? {} })
  const actions = module.exports.default.setup({}, { expose: () => {} })
  actions.confirmGeneralReset()
  assert.ok(dialog)
  return { calls, errors, actions, reset: () => dialog!.onOk() }
}

function startupStatus(enabled: boolean): AutostartStatus {
  return { enabled, state: enabled ? 'enabled' : 'disabled', canEnable: true, canDisable: true }
}

it('preserves preferences when Windows policy blocks disabling startup', async () => {
  const h = resetHarness({
    read: async () => ({ enabled: true, state: 'enabledByPolicy', canEnable: false, canDisable: false }),
    disable: async () => {
      assert.fail('A policy-blocked startup entry must not be changed')
    },
  })
  await assert.rejects(h.reset(), /AUTOSTART_RESET_BLOCKED/)
  assert.deepEqual(h.calls, ['read', 'read'])
  assert.deepEqual(h.errors, ['pages.preference.general.errors.resetAutostartBlocked'])
  assert.equal(h.actions.resetting.value, false)
  assert.equal(h.actions.autostartBusy.value, false)
})

for (const failure of ['status', 'disable', 'readback', 'still-enabled'] as const) {
  it(`keeps settings before a ${failure} failure and allows a confirmed retry`, async () => {
    let enabled = true
    let failing = true
    let reads = 0
    const h = resetHarness({
      read: async () => {
        reads++
        if (failing && (failure === 'status' || (failure === 'readback' && reads === 2))) throw new Error('NATIVE_STATUS_FAILED')
        return startupStatus(enabled)
      },
      disable: async () => {
        if (failing && failure === 'disable') throw new Error('NATIVE_DISABLE_FAILED')
        if (!failing || failure !== 'still-enabled') enabled = false
      },
    })
    await assert.rejects(h.reset())
    assert.ok(h.calls.every(call => call === 'read' || call === 'disable'))
    assert.deepEqual(h.errors, ['pages.preference.general.errors.resetPreflight'])
    assert.equal(h.actions.resetting.value, false)
    assert.equal(h.actions.autostartBusy.value, false)
    failing = false
    h.calls.length = 0
    await h.reset()
    assert.deepEqual(h.calls, [
      'read',
      ...(failure === 'readback' ? [] : ['disable', 'read']),
      'reset-block',
      'reset-general',
      'initialize-general',
      'read',
    ])
  })
}

it('waits for native startup readback and ignores reset or toggle reentry', async () => {
  let enabled = true
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const h = resetHarness({
    read: async () => startupStatus(enabled),
    disable: async () => {
      await pending
      enabled = false
    },
  })
  const resetting = h.reset()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.actions.resetting.value, true)
  assert.equal(h.actions.autostartBusy.value, true)
  await h.reset()
  await h.actions.changeAutostart(true)
  assert.deepEqual(h.calls, ['read', 'disable'])
  finish()
  await resetting
  assert.deepEqual(h.calls, ['read', 'disable', 'read', 'reset-block', 'reset-general', 'initialize-general', 'read'])
})

it('resets preferences when startup is already disabled by Windows', async () => {
  const h = resetHarness({
    read: async () => ({ enabled: false, state: 'disabledByPolicy', canEnable: false, canDisable: false }),
    disable: async () => {
      assert.fail('Disabled startup requires no native mutation')
    },
  })
  await h.reset()
  assert.deepEqual(h.calls, ['read', 'reset-block', 'reset-general', 'initialize-general', 'read'])
  assert.deepEqual(h.errors, [])
})

it('reports a partial reset if initialization fails after native startup is disabled', async () => {
  const h = resetHarness({ read: async () => startupStatus(false), disable: async () => {} }, async () => {
    throw new Error('LOCALE_UNAVAILABLE')
  })
  await assert.rejects(h.reset(), /LOCALE_UNAVAILABLE/)
  assert.deepEqual(h.errors, ['pages.preference.general.errors.resetPartial'])
  assert.equal(h.actions.resetting.value, false)
  assert.equal(h.actions.autostartBusy.value, false)
})

it('reads per-installation Windows state without applying a shared autostart preference', async () => {
  const changes: boolean[] = []
  let enabled = false
  let mounted: () => void = () => {}
  const general = { app: Vue.reactive({ autostart: true }) }
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'native-autostart' })
  interface Actions { changeAutostart: (value: boolean) => Promise<void>, refreshAutostart: () => Promise<void>, autostart: Vue.Ref<{ enabled: boolean }> }
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Actions } } }
  const mocks: Record<string, unknown> = {
    'vue': { ...Vue, onMounted: (fn: () => void) => {
      mounted = fn
    }, onBeforeUnmount: () => {} },
    'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
    'ant-design-vue': { Modal: {}, message: { error: () => {} } },
    '@/services/diagnostics': { reportDiagnostic: () => {} },
    '@/stores/general': { useGeneralStore: () => general },
    '@/stores/block': { useBlockStore: () => ({}) },
    '@/services/autostart': {
      getAutostartStatus: async () => ({ enabled, state: enabled ? 'enabled' : 'disabled', canEnable: true, canDisable: true }),
      setAutostartEnabled: async (value: boolean) => {
        changes.push(value)
        enabled = value
      },
    },
  }
  runInNewContext(ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: (id: string) => mocks[id] ?? {}, window: { addEventListener: () => {} } })
  const actions = module.exports.default.setup({}, { expose: () => {} })
  mounted()
  await actions.refreshAutostart()
  assert.equal(actions.autostart.value.enabled, false)
  assert.deepEqual(changes, [])
  general.app.autostart = false
  await Vue.nextTick()
  assert.deepEqual(changes, [])
  await actions.changeAutostart(true)
  assert.deepEqual(changes, [true])
  assert.equal(actions.autostart.value.enabled, true)
  assert.equal(general.app.autostart, false)
})

it('keeps startup state accessible without hover, focus or native title tooltips', () => {
  const source = readFileSync(new URL('./index.vue', import.meta.url), 'utf8')
    .replace('</script>', '\ndefineExpose({ autostart })\n</script>')
  const { descriptor } = parse(source)
  const script = compileScript(descriptor, { id: 'autostart-tooltip', inlineTemplate: true })
  type Render = (context: { $t: (key: string) => string }, cache: unknown[]) => Vue.VNode
  const exports = {} as { default: { setup: (props: object, context: object) => Render } }
  const translate = (key: string) => key
  const mocks: Record<string, unknown> = {
    'vue': { ...Vue, withDirectives: (node: Vue.VNode) => node, onMounted: () => {}, onBeforeUnmount: () => {} },
    'vue-i18n': { useI18n: () => ({ t: translate }) },
    'ant-design-vue': { Button: 'button', Divider: 'divider', Flex: 'flex', InputNumber: 'input', Select: { Option: 'option' }, Switch: 'switch', Tooltip: 'tooltip' },
    '@/stores/general': { useGeneralStore: () => ({ app: {}, appearance: {} }) },
    '@/stores/block': { useBlockStore: () => ({ window: {} }) },
    '@/components/pro-list-item/index.vue': { default: 'list-item' },
  }
  runInNewContext(ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => mocks[name] ?? { default: 'section' } })
  let state!: Vue.Ref<AutostartStatus | undefined>
  const render = exports.default.setup({}, { expose: ({ autostart }: { autostart: typeof state }) => {
    state = autostart
  } })
  const flatten = (node: Vue.VNode): Vue.VNode[] => [node, ...Array.isArray(node.children)
    ? node.children.flatMap(child => Vue.isVNode(child) ? flatten(child) : [])
    : []]
  const nodes = () => flatten(render({ $t: translate }, []))
  for (const status of [
    undefined,
    { state: 'disabled', enabled: false, canEnable: true, canDisable: true },
    { state: 'disabledByUser', enabled: false, canEnable: false, canDisable: false },
    { state: 'enabledByPolicy', enabled: true, canEnable: false, canDisable: false },
  ] as Array<AutostartStatus | undefined>) {
    state.value = status
    const disabled = !status || !(status.enabled ? status.canDisable : status.canEnable)
    const rendered = nodes()
    const row = rendered.find(node => node.type === 'list-item' && node.props?.title === 'pages.preference.general.labels.launchOnStartup')!
    assert.equal(row.props!.description, 'pages.preference.general.hints.launchOnStartup')
    assert.equal(rendered.some(node => node.type === 'tooltip'), false)
    const wrapper = rendered.find(node => node.type === 'span' && node.props?.class === 'inline-flex')!
    const control = rendered.find(node => node.type === 'switch' && node.props?.['aria-label'] === 'pages.preference.general.labels.launchOnStartup')!
    assert.equal(control.props!.disabled, disabled)
    assert.equal(control.props!.title, undefined)
    assert.equal(control.props!['aria-description'], `autostartStatus.${status?.state ?? 'unknown'}`)
    assert.equal(wrapper.props!.tabindex, disabled ? 0 : undefined)
    assert.equal(wrapper.props!['aria-label'], disabled ? `pages.preference.general.labels.launchOnStartup: autostartStatus.${status?.state ?? 'unknown'}` : undefined)
    assert.equal(wrapper.props!.title, undefined)
    assert.equal(wrapper.props!.onFocusin, undefined)
    assert.equal(wrapper.props!.onFocusout, undefined)
  }
})

it('hides hover delay while OFF, rejects stale edits and retains its value', () => {
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'hover-delay-visibility', inlineTemplate: true })
  type Render = (context: { $t: (key: string) => string }, cache: unknown[]) => Vue.VNode
  const exports = {} as { default: { setup: (props: object, context: object) => Render } }
  const block = Vue.reactive({ window: { hideOnHover: true, hideOnHoverDelay: 2.5 } })
  const visibility = new Map<Vue.VNode, boolean>()
  const translate = (key: string) => key
  const mocks: Record<string, unknown> = {
    'vue': { ...Vue, onMounted: () => {}, onBeforeUnmount: () => {}, withDirectives: (node: Vue.VNode, bindings: Array<[unknown, boolean]>) => {
      visibility.set(node, bindings[0][1])
      return node
    } },
    'vue-i18n': { useI18n: () => ({ t: translate }) },
    'ant-design-vue': { Button: 'button', Divider: 'divider', Flex: 'flex', InputNumber: 'input', Select: { Option: 'option' }, Switch: 'switch', Tooltip: 'tooltip' },
    '@/stores/general': { useGeneralStore: () => ({ app: {}, appearance: {} }) },
    '@/stores/block': { useBlockStore: () => block },
  }
  runInNewContext(ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => mocks[name] ?? { default: 'section' } })
  const render = exports.default.setup({}, { expose: () => {} })
  const flatten = (node: Vue.VNode): Vue.VNode[] => [node, ...Array.isArray(node.children)
    ? node.children.flatMap(child => Vue.isVNode(child) ? flatten(child) : [])
    : []]
  let staleDelay: Vue.VNode | undefined
  for (const enabled of [true, false, true]) {
    block.window.hideOnHover = enabled
    visibility.clear()
    const nodes = flatten(render({ $t: translate }, []))
    const delay = nodes.find(node => node.type === 'input' && node.props?.['addon-after'] === 's')!
    const group = [...visibility.keys()].find(node => flatten(node).includes(delay))!
    assert.equal(visibility.get(group), enabled)
    assert.equal(delay.props!.value, 2.5)
    if (!enabled) staleDelay!.props!['onUpdate:value'](9)
    assert.equal(block.window.hideOnHoverDelay, 2.5)
    staleDelay = delay
  }
  staleDelay!.props!['onUpdate:value'](3.5)
  assert.equal(block.window.hideOnHoverDelay, 3.5, 'visible delay remains editable while ON')
})
