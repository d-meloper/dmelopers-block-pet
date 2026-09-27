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
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'

function harness() {
  setActivePinia(createPinia())
  const cat = useCatStore()
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
  const controller = { status, pending: Vue.ref(false), retry: () => {
    retried++
  } }
  const exports = {} as { default: { setup: (props: object, context: object) => (ctx: object, cache: unknown[]) => VNode } }
  runInNewContext(source, { exports, require: (id: string) => {
    if (id === '@/services/diagnostics') return { reportDiagnostic: () => {} }
    if (id === 'vue') return { ...Vue, inject: () => controller }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
    if (id === 'ant-design-vue') return { Switch, Button, Flex: {}, Input: {} }
    if (id === '@/stores/cat') return { useCatStore: () => cat }
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
  return { cat, general, desktop: () => switches()[1].props!, status, rendered, retried: () => retried }
}

it('disables the local display switch while output is OFF and ignores attempted edits', () => {
  const h = harness()
  h.cat.window.visible = false
  assert.equal(h.desktop().disabled, true)
  h.desktop()['onUpdate:checked'](false)
  assert.equal(h.general.broadcast.showOnDesktop, false)
  assert.equal(h.cat.window.visible, false)
  h.general.broadcast.showOnDesktop = false
  h.desktop()['onUpdate:checked'](true)
  assert.equal(h.general.broadcast.showOnDesktop, false)
  assert.equal(h.cat.window.visible, false)
})

it('retains its own OFF choice through presets and enables basic visibility only on explicit ON', () => {
  const h = harness()
  h.general.broadcast.enabled = true
  assert.equal(h.desktop().disabled, false)
  h.desktop()['onUpdate:checked'](false)
  assert.equal(h.cat.window.visible, true, 'local hiding does not rewrite basic visibility')
  applyPresetSnapshot(h.cat, createDefaultPresetSnapshot())
  assert.equal(h.desktop().checked, false)
  h.cat.window.visible = false
  h.desktop()['onUpdate:checked'](true)
  assert.equal(h.desktop().checked, true)
  assert.equal(h.cat.window.visible, true)
  h.cat.window.visible = false
  assert.equal(h.desktop().checked, true, 'basic visibility is no longer the switch value')
  h.general.broadcast.enabled = false
  assert.equal(h.desktop().disabled, true)
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
