/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

const button = { name: 'Button' }
const checkbox = { name: 'Checkbox' }
const modal = { name: 'Modal' }
const flex = { name: 'Flex' }

function compile(filename: string, modalComponent: unknown = modal) {
  const { descriptor } = parse(readFileSync(new URL(filename, import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: filename, inlineTemplate: true })
  type Render = (context: object, cache: unknown[]) => Vue.VNode
  const exports = {} as { default: { setup: (props: object, context: object) => Render } }
  runInNewContext(ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require: (id: string) => ({
      'vue': Vue,
      'ant-design-vue': { Modal: modalComponent, Flex: flex, Button: button, Checkbox: checkbox },
      'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
    })[id],
  })
  return exports.default
}

function harness(props = Vue.reactive<{ open: boolean, showDismiss?: boolean, showOnce?: boolean, reminderDismissed?: boolean, restartConfirmation?: boolean, busy?: boolean, phase?: string, feedback?: string }>({ open: true })) {
  const events: string[] = []
  const changes: boolean[] = []
  const emit = (event: string, value?: unknown) => {
    events.push(event)
    if (event === 'reminderDismissedChange') changes.push(value as boolean)
  }
  const render = compile('./AdminLaunchReminder.vue').setup(props, { expose: () => {}, emit })
  const tree = () => render({ $emit: emit }, [])
  const flatten = (node: Vue.VNode): Vue.VNode[] => {
    const children = Array.isArray(node.children)
      ? node.children
      : node.children && typeof node.children === 'object'
        ? Object.values(node.children).flatMap(slot => typeof slot === 'function' ? slot() : [])
        : []
    return [node, ...children.flatMap(child => Vue.isVNode(child) ? flatten(child) : [])]
  }
  const slotNodes = (slot: string) => {
    const slots = tree().children as Record<string, () => Vue.VNode[]>
    return (slots[slot]?.() ?? []).flatMap(flatten)
  }
  return { props, events, changes, tree, slotNodes, nodes: () => flatten(tree()) }
}

test('the automatic reminder places the checkbox above its three buttons and omits the extra permission paragraph', () => {
  const h = harness()
  const modal = h.tree()
  assert.equal(modal.props?.open, true)
  assert.equal(modal.props?.title, 'adminLaunchReminder.title')
  assert.equal(modal.props?.closable, false)
  assert.equal(modal.props?.['mask-closable'], false)
  const buttons = h.nodes().filter(node => node.type === button)
  assert.equal(buttons.length, 3)
  assert.ok(h.nodes().some(node => node.children === 'adminLaunchReminder.continue'))
  assert.ok(h.nodes().some(node => node.children === 'adminLaunchReminder.neverShow'))
  assert.ok(h.nodes().some(node => node.children === 'adminLaunchReminder.always'))
  assert.deepEqual(buttons.map(button => button.props?.type), [undefined, undefined, 'primary'])
  assert.ok(h.nodes().some(node => node.children === 'adminLaunchReminder.restart'))
  assert.equal(h.nodes().some(node => node.children === 'adminLaunchReminder.permissionHint'), false)
  assert.equal(h.slotNodes('default').filter(node => node.type === checkbox).length, 1)
  assert.equal(h.slotNodes('footer').some(node => node.type === checkbox), false)
  assert.equal(h.slotNodes('default').some(node => node.type === button), false)
  assert.ok(h.nodes().some(node => node.type === 'div' && node.props?.class === 'admin-launch-reminder-option'))
  buttons.forEach(button => (button.props?.onClick as () => void)())
  assert.deepEqual(h.events, ['continue', 'restart', 'always'])
})

test('the checkbox reflects saved state, emits the checked value and ignores changes while busy', () => {
  const h = harness()
  const option = () => h.nodes().find(node => node.type === checkbox)!
  assert.equal(option().props?.checked, false)
  assert.equal(option().props?.['aria-label'], 'adminLaunchReminder.neverShow')
  option().props!.onChange({ target: { checked: true } })
  h.props.reminderDismissed = true
  assert.equal(option().props?.checked, true)
  option().props!.onChange({ target: { checked: false } })
  h.props.busy = true
  assert.equal(option().props?.disabled, true)
  option().props!.onChange({ target: { checked: true } })
  assert.deepEqual(h.changes, [true, false])
})

test('saving settings keeps the same message layout without inserting progress text', () => {
  const h = harness()
  const paragraphs = () => h.slotNodes('default').filter(node => node.type === 'p').length
  const before = paragraphs()
  h.props.busy = true
  h.props.phase = 'saving'
  assert.equal(paragraphs(), before)
  assert.equal(h.nodes().some(node => node.props?.role === 'status'), false)
  h.props.feedback = 'saveFailed'
  assert.ok(h.nodes().some(node => node.props?.role === 'status' && node.children === 'adminLaunchReminder.saveFailed'))
})

test('UAC and restart waits disable dismissal and announce translated progress', () => {
  const h = harness()
  h.props.busy = true
  h.props.phase = 'preparing'
  assert.equal(h.tree().props?.keyboard, false)
  assert.ok(h.nodes().some(node => node.props?.role === 'status' && node.children === 'adminLaunchReminder.preparing'))
  assert.ok(h.nodes().filter(node => node.type === button).every(node => node.props?.disabled === true))
  ;(h.tree().props?.onCancel as () => void)()
  assert.deepEqual(h.events, [])
  h.props.phase = 'restarting'
  assert.ok(h.nodes().some(node => node.props?.role === 'status' && node.children === 'adminLaunchReminder.restarting'))
})

test('a manually opened dialog exposes only Cancel and highlighted Always', () => {
  const h = harness()
  h.props.showDismiss = false
  h.props.showOnce = false
  const buttons = h.nodes().filter(node => node.type === button)
  assert.equal(buttons.length, 2)
  assert.equal(h.nodes().some(node => node.children === 'adminLaunchReminder.neverShow'), false)
  assert.equal(h.nodes().some(node => node.children === 'adminLaunchReminder.restart'), false)
  assert.deepEqual(buttons.map(button => button.props?.type), [undefined, 'primary'])
  buttons.forEach(button => (button.props?.onClick as () => void)())
  assert.deepEqual(h.events, ['continue', 'always'])
  h.props.showDismiss = true
  h.props.showOnce = true
  assert.equal(h.nodes().filter(node => node.type === button).length, 3)
})

test('the second dialog shows the restart question with only Cancel and Restart now', () => {
  const h = harness()
  h.props.restartConfirmation = true
  assert.equal(h.tree().props?.title, 'adminLaunchReminder.restartConfirmationTitle')
  assert.ok(h.nodes().some(node => node.children === 'adminLaunchReminder.restartConfirmationMessage'))
  assert.equal(h.nodes().some(node => node.children === 'adminLaunchReminder.permissionHint'), false)
  assert.equal(h.nodes().some(node => node.type === checkbox), false)
  const buttons = h.nodes().filter(node => node.type === button)
  assert.equal(buttons.length, 2)
  assert.deepEqual(buttons.map(button => button.props?.type), [undefined, 'primary'])
  assert.ok(h.nodes().some(node => node.children === 'adminLaunchReminder.confirmRestart'))
  buttons.forEach(button => (button.props?.onClick as () => void)())
  assert.deepEqual(h.events, ['continue', 'confirmRestart'])
  h.props.busy = true
  assert.equal(h.tree().props?.keyboard, false)
  assert.ok(h.nodes().filter(node => node.type === button).every(node => node.props?.disabled === true))
})

test('cancellation/failure remain in the current dialog and Escape means continue normally', () => {
  const h = harness()
  for (const feedback of ['cancelled', 'failed']) {
    h.props.feedback = feedback
    assert.ok(h.nodes().some(node => node.props?.role === 'status' && node.children === `adminLaunchReminder.${feedback}`))
  }
  assert.equal(h.tree().props?.keyboard, true)
  ;(h.tree().props?.onCancel as () => void)()
  ;(h.tree().props?.['after-close'] as () => void)()
  assert.deepEqual(h.events, ['continue', 'afterClose'])
})

test('the existing update reminder forwards afterClose to its single Modal root', () => {
  const component = compile('./UpdateReminder.vue', 'modal')
  let received: unknown
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert: () => {},
    remove: () => {},
    setText: () => {},
    setElementText: () => {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp: (_element, key, _previous, value) => {
      if (key === 'after-close') received = value
    },
  })
  const afterClose = () => {}
  const app = renderer.createApp(component as Vue.Component, { 'version': '1.2.3', 'after-close': afterClose })
  app.mount({})
  assert.equal(received, afterClose)
  app.unmount()
})
