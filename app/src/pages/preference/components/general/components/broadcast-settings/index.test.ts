/* eslint-disable test/no-import-node-test */
import type { VNode } from 'vue'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { BroadcastStatus } from '@/features/broadcast/types'

import { applyPresetSnapshot, createDefaultPresetSnapshot } from '@/features/presets/model'
import { useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'

function harness() {
  setActivePinia(createPinia())
  const block = useBlockStore()
  const general = useGeneralStore()
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const compiled = compileScript(descriptor, { id: 'broadcast-visibility', inlineTemplate: true })
  const source = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const Switch = { name: 'Switch' }
  const Button = { name: 'Button' }
  const status = Vue.ref<BroadcastStatus>({ enabled: true, clients: 1 })
  let retried = 0
  let desktopShown = false
  const controller = { status, pending: Vue.ref(false), retry: () => {
    retried++
  } }
  const exports = {} as { default: { setup: (props: object, context: object) => (ctx: object, cache: unknown[]) => VNode } }
  runInNewContext(source, { exports, require: (id: string) => {
    if (id === '@/services/diagnostics') return { reportDiagnostic: () => {} }
    if (id === 'vue') {
      return { ...Vue, inject: () => controller, withDirectives: (node: VNode, bindings: Array<[unknown, boolean]>) => {
        desktopShown = bindings[0][1]
        return node
      } }
    }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
    if (id === 'ant-design-vue') return { Switch, Button, Flex: {}, Input: {} }
    if (id === '@/stores/block') return { useBlockStore: () => block }
    if (id === '@/stores/general') return { useGeneralStore: () => general }
    return { default: {} }
  } })
  const render = exports.default.setup({}, { expose: () => {} })
  function switches() {
    const found: VNode[] = []
    function visit(node: unknown) {
      if (Array.isArray(node)) return node.forEach(visit)
      if (!Vue.isVNode(node)) return
      if (node.type === Switch) found.push(node)
      if (Array.isArray(node.children)) {
        visit(node.children)
      } else if (node.children && typeof node.children === 'object') {
        const slot = node.children.default
        if (typeof slot === 'function') visit(slot())
      }
    }
    visit(render({}, []))
    assert.equal(found.length, 2)
    return found
  }
  function rendered() {
    const buttons: VNode[] = []
    const text: string[] = []
    function visit(node: unknown) {
      if (typeof node === 'string') {
        text.push(node)
        return
      }
      if (Array.isArray(node)) {
        node.forEach(visit)
        return
      }
      if (!Vue.isVNode(node)) return
      if (node.type === Button) buttons.push(node)
      if (node.children && typeof node.children === 'object' && !Array.isArray(node.children)) {
        const slot = node.children.default
        if (typeof slot === 'function') visit(slot())
      } else {
        visit(node.children)
      }
    }
    visit(render({}, []))
    return { buttons, text: text.join(' ') }
  }
  return { block, general, desktop: () => switches()[1].props!, desktopShown: () => {
    switches()
    return desktopShown
  }, status, rendered, retried: () => retried }
}

it('hides and disables the local display row while output is OFF and ignores attempted edits', () => {
  const h = harness()
  h.block.window.visible = false
  assert.equal(h.desktop().disabled, true)
  assert.equal(h.desktopShown(), false)
  h.desktop()['onUpdate:checked'](false)
  assert.equal(h.general.broadcast.showOnDesktop, false)
  assert.equal(h.block.window.visible, false)
  h.general.broadcast.showOnDesktop = false
  h.desktop()['onUpdate:checked'](true)
  assert.equal(h.general.broadcast.showOnDesktop, false)
  assert.equal(h.block.window.visible, false)
})

it('retains its own OFF choice through presets and enables basic visibility only on explicit ON', () => {
  const h = harness()
  h.general.broadcast.enabled = true
  assert.equal(h.desktop().disabled, false)
  assert.equal(h.desktopShown(), true)
  h.desktop()['onUpdate:checked'](false)
  assert.equal(h.block.window.visible, true, 'local hiding does not rewrite basic visibility')
  applyPresetSnapshot(h.block, createDefaultPresetSnapshot())
  assert.equal(h.desktop().checked, false)
  h.block.window.visible = false
  h.desktop()['onUpdate:checked'](true)
  assert.equal(h.desktop().checked, true)
  assert.equal(h.block.window.visible, true)
  h.block.window.visible = false
  assert.equal(h.desktop().checked, true, 'basic visibility is no longer the switch value')
  h.general.broadcast.enabled = false
  assert.equal(h.desktop().disabled, true)
  assert.equal(h.desktopShown(), false)
  assert.equal(h.general.broadcast.showOnDesktop, true)
  h.general.broadcast.enabled = true
  assert.equal(h.desktopShown(), true)
  assert.equal(h.desktop().checked, true)
})
it('retains the connected status with a backup warning and exposes a working retry', () => {
  const h = harness()
  h.status.value.warning = 'endpoint_backup_unavailable'
  const view = h.rendered()
  assert.ok(view.text.includes('pages.preference.broadcast.status.connected'))
  assert.ok(view.text.includes('pages.preference.broadcast.endpointBackupHint'))
  assert.equal(view.buttons.length, 2)
  view.buttons[1].props!.onClick()
  assert.equal(h.retried(), 1)
  h.status.value.warning = undefined
  assert.equal(h.rendered().buttons.length, 1)
})

it('distinguishes address preservation errors from rendering and port errors', () => {
  const h = harness()
  for (const [error, key] of [
    ['endpoint_conflict', 'endpointConflictHint'],
    ['endpoint_invalid', 'endpointInvalidHint'],
    ['endpoint_unavailable', 'endpointUnavailableHint'],
    ['port_in_use', 'portInUseHint'],
    ['render_failed', 'renderErrorHint'],
  ]) {
    h.status.value.error = error
    assert.ok(h.rendered().text.includes(`pages.preference.broadcast.${key}`))
  }
})
