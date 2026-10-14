/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { RecoveryReport } from '@/features/recovery/types'

import en from '@/locales/en-US.json'
import ko from '@/locales/ko-KR.json'

function harness(report?: RecoveryReport) {
  const props = Vue.reactive({ report })
  const language = Vue.ref<'ko' | 'en'>('ko')
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: 'recovery-feedback', inlineTemplate: true })
  const source = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  type Render = (context: object, cache: unknown[]) => Vue.VNode
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Render } } }
  const t = (key: string): string => key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], language.value === 'ko' ? ko : en) as string ?? key
  runInNewContext(source, {
    exports: module.exports,
    module,
    require: (id: string) => id === 'vue'
      ? { ...Vue, renderSlot: () => Vue.createVNode('slot') }
      : id === 'vue-i18n' ? { useI18n: () => ({ t }) } : {},
  })
  const scope = Vue.effectScope()
  const render = scope.run(() => module.exports.default.setup(props, { expose: () => {} }))!
  return { props, language, render: () => render({ $slots: {} }, []), dispose: () => scope.stop() }
}

function text(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(text).join(' ')
  if (node && typeof node === 'object' && 'type' in node && (node as Vue.VNode).type === Vue.Comment) return ''
  if (node && typeof node === 'object' && 'children' in node) return text((node as Vue.VNode).children)
  return ''
}

it('announces pending recovery, shows failed steps and guidance, and switches language reactively', () => {
  const h = harness({ status: 'running', steps: [{ key: 'recovery.broadcast.steps.configure', state: 'running' }] })
  try {
    const pending = h.render()
    assert.equal(pending.props?.role, 'status')
    assert.equal(pending.props?.['aria-live'], 'polite')
    assert.equal(pending.props?.['aria-busy'], true)
    assert.ok(text(pending).includes('시도 중'))
    assert.ok(!text(pending).includes(ko.recovery.nextSteps))
    h.props.report = { status: 'unresolved', steps: [{ key: 'recovery.broadcast.steps.configure', state: 'failed' }], guidanceKeys: ['recovery.broadcast.guidance.port'] }
    const failed = h.render()
    assert.equal(failed.props?.['aria-busy'], false)
    assert.ok(text(failed).includes(ko.recovery.broadcast.guidance.port))
    assert.ok(text(failed).includes('확인 실패'))
    h.language.value = 'en'
    assert.ok(text(h.render()).includes(en.recovery.broadcast.guidance.port))
  } finally {
    h.dispose()
  }
})

it('keeps prepared-but-waiting distinct from a connected source and never renders raw cause data', () => {
  const h = harness({ status: 'recovered', summaryKey: 'recovery.broadcast.waiting', steps: [], cause: 'private/raw/path', guidanceKeys: ['recovery.broadcast.guidance.refresh'] })
  try {
    const waiting = text(h.render())
    assert.ok(waiting.includes(ko.recovery.broadcast.waiting))
    assert.ok(!waiting.includes(ko.recovery.broadcast.connected))
    assert.ok(!waiting.includes('private/raw/path'))
    h.props.report = undefined
    assert.equal(text(h.render()), '')
  } finally {
    h.dispose()
  }
})
