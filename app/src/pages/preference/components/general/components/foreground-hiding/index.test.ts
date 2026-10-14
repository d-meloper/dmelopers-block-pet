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

import * as settings from '@/features/foregroundHiding/settings'
import en from '@/locales/en-US.json'
import ko from '@/locales/ko-KR.json'
import { useGeneralStore } from '@/stores/general'

const key = 'pages.preference.foregroundHiding'
interface Row { id?: string, path: string, name: string, icon?: string | null, launchOptions?: boolean }

function harness(
  list: (onApplication: (row: Row) => void, onIncomplete: (incomplete: boolean) => void) => Promise<Row[]> = async () => [{ path: 'C:\\Browser\\chrome.exe', name: 'Chrome' }],
  pick: () => Promise<Row | undefined> = async () => undefined,
) {
  setActivePinia(createPinia())
  const general = useGeneralStore()
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const compiled = compileScript(descriptor, { id: 'foreground-hiding', inlineTemplate: true })
  const source = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const Button = { name: 'Button' }
  const Switch = { name: 'Switch' }
  const Spin = { name: 'Spin' }
  const Input = { name: 'Input' }
  const Modal = { name: 'Modal', confirm: (options: { onOk: () => void }) => {
    confirmation = options
  } }
  const status = Vue.shallowRef<{ state: string }>()
  const locked = Vue.ref(false)
  let calls = 0
  let confirmation: { onOk: () => void } | undefined
  let dispose = () => {}
  const visibility = new WeakMap<VNode, boolean>()
  const exports = {} as { default: { setup: (props: object, context: object) => (ctx: object, cache: unknown[]) => VNode } }
  runInNewContext(source, { exports, require: (id: string) => {
    if (id === 'vue') {
      return { ...Vue, withDirectives: (node: VNode, bindings: Array<[unknown, boolean]>) => {
        for (const [directive, value] of bindings) {
          if (directive === Vue.vShow) visibility.set(node, value)
        }
        return node
      }, onBeforeUnmount: (fn: () => void) => {
        dispose = fn
      } }
    }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: (name: string) => name }) }
    if (id === 'ant-design-vue') return { Button, Switch, Spin, Modal, Input }
    if (id === '@/stores/general') return { useGeneralStore: () => general }
    if (id === '@/features/foregroundHiding/settings') return settings
    if (id === '@/features/stateSafety/bridge') return { editorsLocked: locked }
    if (id === '@/services/foregroundHiding') {
      return { foregroundHidingStatus: status, MAX_FOREGROUND_CATALOG_ITEMS: 16384, listForegroundApplications: async (onApplication: (row: Row) => void, onIncomplete: (incomplete: boolean) => void) => {
        calls++
        return list(onApplication, onIncomplete)
      }, describeForegroundApplications: async () => [], selectForegroundApplication: pick }
    }
    return { default: {} }
  } })
  const render = exports.default.setup({}, { expose: () => {} })
  function view() {
    const nodes: VNode[] = []
    const text: string[] = []
    function visit(node: unknown) {
      if (typeof node === 'string') {
        text.push(node)
        return
      }
      if (Array.isArray(node)) return node.forEach(visit)
      if (!Vue.isVNode(node)) return
      if (visibility.get(node) === false) return
      nodes.push(node)
      if (node.children && typeof node.children === 'object' && !Array.isArray(node.children)) {
        for (const name of ['title-extra', 'default']) {
          const slot = node.children[name]
          if (typeof slot === 'function') visit(slot())
        }
      } else {
        visit(node.children)
      }
    }
    visit(render({}, []))
    return { nodes, text: text.join(' ') }
  }
  function button(suffix: string, picker = false) {
    const matches = view().nodes.filter((node) => {
      if (node.type !== Button) return false
      const slot = (node.children as { default?: () => VNode[] })?.default
      return slot?.().some(child => child.children === `${key}.${suffix}`)
    })
    const found = picker ? matches.at(-1) : matches[0]
    assert.ok(found, `missing button ${suffix}`)
    return found.props!
  }
  return {
    general,
    locked,
    status,
    view,
    button,
    calls: () => calls,
    input: () => view().nodes.find(node => node.type === Input)!.props!,
    toggle: () => view().nodes.find(node => node.type === Switch)!.props!,
    modal: () => view().nodes.find(node => node.type === Modal)!.props!,
    confirm: () => {
      assert.ok(confirmation)
      confirmation.onOk()
    },
    dispose: () => dispose(),
  }
}

async function settle() {
  for (let index = 0; index < 5; index++) await Vue.nextTick()
}

it('rejects a native executable selection completed during a save lock and permits a fresh unlocked retry', async () => {
  let complete!: (row: Row) => void
  const picked: Row = { path: 'C:\\Apps\\New.exe', name: 'New app' }
  const selection = new Promise<Row>(resolve => complete = resolve)
  const h = harness(async () => [], () => selection)
  h.toggle().onChange(true)
  h.general.app.foregroundHiding.applications.push('C:\\Apps\\Existing.exe')
  h.button('addApplication').onClick()
  await settle()
  const pending = h.button('selectFromPc').onClick()
  const acknowledged = JSON.stringify(h.general.app.foregroundHiding)
  h.locked.value = true
  complete(picked)
  await pending
  assert.equal(JSON.stringify(h.general.app.foregroundHiding), acknowledged)
  assert.equal(h.button('selectFromPc').disabled, true)
  h.locked.value = false
  assert.equal(h.button('selectFromPc').disabled, false)
  await h.button('selectFromPc').onClick()
  assert.deepEqual(h.general.app.foregroundHiding.applications, ['C:\\Apps\\Existing.exe', picked.path])
  h.dispose()
})

it('streams distinct launcher entries during search and excludes unresolved names without saving options', async () => {
  let push!: (row: Row) => void
  let report!: (incomplete: boolean) => void
  let complete!: (rows: Row[]) => void
  const h = harness((onApplication, onIncomplete) => {
    push = onApplication
    report = onIncomplete
    return new Promise<Row[]>((resolve) => {
      complete = resolve
    })
  })
  h.toggle().onChange(true)
  h.button('addApplication').onClick()
  const league: Row = { id: 'league', path: 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe', name: 'League of Legends', launchOptions: true }
  const valorant: Row = { ...league, id: 'valorant', name: 'VALORANT' }
  push(league)
  push(valorant)
  push({ id: 'protocol-game', path: '', name: 'Protocol Game' })
  assert.ok(h.view().text.includes('League of Legends'))
  assert.ok(h.view().text.includes('VALORANT'))
  assert.ok(h.view().text.includes(`${key}.loadingApplications`))
  assert.ok(h.view().text.includes(`${key}.sharedExecutable`))
  assert.equal(h.view().text.includes('Protocol Game'), false)
  assert.equal(h.view().text.includes(`${key}.requiresExecutable`), false)
  h.input()['onUpdate:value']('  league  ')
  assert.ok(h.view().text.includes('League of Legends'))
  assert.equal(h.view().text.includes('VALORANT'), false)
  h.button('add').onClick()
  assert.deepEqual(h.general.app.foregroundHiding.applications, [league.path])
  assert.deepEqual(Object.keys(h.general.app.foregroundHiding).sort(), ['applications', 'enabled'])
  report(true)
  assert.ok(h.view().text.includes(`${key}.errors.applicationsIncomplete`))
  complete([valorant, league])
  await settle()
  assert.equal(h.view().text.includes(`${key}.loadingApplications`), false)
  h.input()['onUpdate:value']('not installed')
  assert.ok(h.view().text.includes(`${key}.noMatchingApplications`))
  h.modal().onCancel()
  push({ id: 'late', path: 'C:\\Late\\app.exe', name: 'Late application' })
  report(true)
  assert.equal(h.view().text.includes('Late application'), false)
})

it('hides the detail menus while disabled without reading installed apps', () => {
  const h = harness()
  assert.equal(h.calls(), 0)
  assert.equal(h.view().text.includes(`${key}.status.empty`), false)
  assert.equal(h.view().text.includes(`${key}.addApplication`), false)
  assert.equal(h.view().text.includes(`${key}.privacyHint`), false)
  h.toggle().onChange(true)
  assert.ok(h.view().text.includes(`${key}.status.empty`))
  assert.ok(h.view().text.includes(`${key}.addApplication`))
  h.general.app.foregroundHiding.applications.push('C:\\Apps\\Player.exe')
  const lateRemove = h.button('remove').onClick
  h.toggle().onChange(false)
  lateRemove()
  assert.deepEqual(h.general.app.foregroundHiding.applications, ['C:\\Apps\\Player.exe'])
  assert.equal(h.view().text.includes(`${key}.addApplication`), false)
  assert.equal(h.calls(), 0)
})

it('reads the installed-app list only on demand and adds executable rules without duplicates', async () => {
  const h = harness(async () => [
    { path: 'C:\\Browser\\chrome.exe', name: 'Chrome' },
    { path: 'c:\\browser\\CHROME.EXE', name: 'Duplicate' },
    { path: 'relative.exe', name: 'Invalid' },
  ])
  assert.equal(h.calls(), 0)
  h.toggle().onChange(true)
  h.button('addApplication').onClick()
  await settle()
  assert.equal(h.calls(), 1)
  assert.equal(h.modal().open, true)
  assert.equal(h.view().text.includes('Duplicate'), false)
  assert.equal(h.view().text.includes('Invalid'), false)
  const add = h.button('add')
  assert.equal(add['aria-label'], `${key}.addNamedApplication`)
  add.onClick()
  assert.deepEqual(h.general.app.foregroundHiding.applications, ['C:\\Browser\\chrome.exe'])
  assert.equal(h.button('remove', true).disabled, false)
  assert.equal(h.button('remove', true)['aria-label'], `${key}.removeApplication`)
  h.button('remove', true).onClick()
  assert.equal(h.general.app.foregroundHiding.applications.length, 0)
  h.button('add', true).onClick()
  assert.equal(h.general.app.foregroundHiding.applications.length, 1)
  h.modal().onCancel()
  h.button('addApplication').onClick()
  await settle()
  assert.equal(h.calls(), 2)
  assert.equal(h.view().text.includes('C:\\Browser\\chrome.exe'), false)
  h.modal().onCancel()
  h.button('remove').onClick()
  assert.deepEqual(h.general.app.foregroundHiding.applications, [])
})

it('removes a shared executable from every catalog alias and rejects actions after close or disable', async () => {
  const h = harness(async () => [
    { id: 'first', path: 'C:\\Apps\\Client.exe', name: 'First game' },
    { id: 'second', path: 'c:\\apps\\CLIENT.EXE', name: 'Second game' },
  ])
  h.toggle().onChange(true)
  h.general.app.foregroundHiding.applications.push('C:\\Apps\\Client.exe')
  h.button('addApplication').onClick()
  await settle()
  const remove = h.button('remove', true)
  assert.equal(remove.disabled, false)
  remove.onClick()
  assert.deepEqual(h.general.app.foregroundHiding.applications, [])
  assert.equal(h.view().text.includes(`${key}.remove`), false)
  const add = h.button('add', true).onClick
  add()
  assert.deepEqual(h.general.app.foregroundHiding.applications, ['c:\\apps\\CLIENT.EXE'])
  const lateRemove = h.button('remove', true).onClick
  h.modal().onCancel()
  lateRemove()
  assert.equal(h.general.app.foregroundHiding.applications.length, 1)
  h.toggle().onChange(false)
  lateRemove()
  assert.equal(h.general.app.foregroundHiding.applications.length, 1)
})

it('keeps catalog removal available at the rule limit and allows adding after a removal', async () => {
  const h = harness(async () => [
    { path: 'C:\\Apps\\0.exe', name: 'Selected' },
    { path: 'C:\\Apps\\Next.exe', name: 'Next' },
  ])
  h.toggle().onChange(true)
  h.general.app.foregroundHiding.applications = Array.from({ length: 128 }, (_, index) => `C:\\Apps\\${index}.exe`)
  h.button('addApplication').onClick()
  await settle()
  assert.equal(h.button('add', true).disabled, true)
  assert.equal(h.button('remove', true).disabled, false)
  h.button('remove', true).onClick()
  assert.equal(h.general.app.foregroundHiding.applications.length, 127)
  assert.equal(h.button('add', true).disabled, false)
  h.button('add', true).onClick()
  assert.equal(h.general.app.foregroundHiding.applications.length, 128)
  assert.equal(h.general.app.foregroundHiding.applications.includes('C:\\Apps\\Next.exe'), true)
})

it('shows the FAQ next to the section heading while auto hiding is disabled', () => {
  const h = harness()
  const faq = h.view().nodes.find(node => node.props?.['aria-label'] === `${key}.faqLabel`)
  assert.ok(faq)
  assert.equal(faq.props?.size, 'small')
  assert.equal(h.calls(), 0)
  assert.equal(ko.pages.preference.foregroundHiding.faqQuestion, 'Q. 등록한 앱을 켜도 펫이 숨겨지지 않아요.')
  assert.equal(ko.pages.preference.foregroundHiding.faqAnswer, 'A. 등록한 프로그램이 일반 설치본, Store 설치본 처럼 다른 경로로 설치돼있거나, 포터블 형태로 설치된 경우 실제 실행하는 앱과 다르게 지정하면 이 문제가 발생할 수 있습니다. 올바른 앱을 선택했는지 다시 한 번 확인해주세요.')
})

it('shows actionable enumeration failure and ignores a late list after closing or disposal', async () => {
  let failing = true
  let complete!: (rows: Row[]) => void
  const h = harness(async () => {
    if (failing) throw new Error('sensitive path must never become UI text')
    return new Promise<Row[]>((resolve) => {
      complete = resolve
    })
  })
  h.toggle().onChange(true)
  h.button('addApplication').onClick()
  await settle()
  assert.ok(h.view().text.includes(`${key}.errors.applicationsUnavailable`))
  assert.equal(h.view().text.includes('sensitive path'), false)
  failing = false
  h.modal().onCancel()
  h.button('addApplication').onClick()
  h.modal().onCancel()
  complete([{ path: 'C:\\Late\\app.exe', name: 'Late result' }])
  await settle()
  assert.equal(h.view().text.includes('Late result'), false)
  h.button('addApplication').onClick()
  h.dispose()
  complete([{ path: 'C:\\Disposed\\app.exe', name: 'Disposed result' }])
  await settle()
  assert.equal(h.view().text.includes('Disposed result'), false)
})

it('retains invalid settings until the explicit repair confirmation and preserves unknown fields', () => {
  const h = harness()
  const raw = { enabled: true, applications: ['relative.exe'], future: { preserved: false } }
  h.general.app.foregroundHiding = raw as unknown as settings.ForegroundHidingSettings
  assert.ok(h.view().text.includes(`${key}.invalidHint`))
  assert.equal(h.toggle().disabled, true)
  h.toggle().onChange(false)
  assert.deepEqual(h.general.app.foregroundHiding, raw)
  h.button('repair').onClick()
  assert.deepEqual(h.general.app.foregroundHiding, raw, 'opening the confirmation does not repair data')
  h.confirm()
  assert.deepEqual(h.general.app.foregroundHiding, { enabled: false, applications: [], future: raw.future })
  assert.equal(h.toggle().disabled, false)
  assert.equal(h.general.app.taskbarVisible, false)
})

it('shows only actionable guidance and failures with the existing red feedback style', () => {
  const h = harness()
  h.status.value = { state: 'hidden' }
  assert.equal(h.view().text.includes(`${key}.status.hidden`), false)
  h.toggle().onChange(true)
  assert.ok(h.view().text.includes(`${key}.status.empty`))
  assert.ok(h.view().nodes.some(node => node.props?.class === 'foreground-feedback' && node.props.role === 'status'))
  h.general.app.foregroundHiding.applications.push('C:\\Apps\\Player.exe')
  for (const state of ['observing', 'hidden', 'bypassed']) {
    h.status.value = { state }
    assert.equal(h.view().text.includes(`${key}.status.${state}`), false)
    assert.equal(h.view().nodes.some(node => node.props?.class === 'foreground-feedback'), false)
  }
  h.status.value = { state: 'unavailable' }
  assert.ok(h.view().text.includes(`${key}.unavailableHint`))
  assert.ok(h.view().nodes.some(node => node.props?.class === 'foreground-feedback' && node.props.role === 'alert'))
  assert.equal(h.view().text.includes(`${key}.status.unavailable`), false)
  assert.equal(h.view().text.includes(`${key}.privacyHint`), false)
  assert.equal(h.view().nodes.some(node => node.props?.description === `${key}.applicationsHint`), false)
  h.status.value = undefined
  assert.ok(h.view().text.includes(`${key}.unavailableHint`))
})

it('enforces UI rule bounds and maintains paired Korean and English leaves', () => {
  const h = harness()
  h.toggle().onChange(true)
  h.general.app.foregroundHiding.applications = Array.from({ length: 128 }, (_, index) => `C:\\Apps\\${index}.exe`)
  assert.equal(h.button('addApplication').disabled, false, 'The catalog must remain available for removal at the rule limit')
  function leaves(value: object, prefix = ''): string[] {
    return Object.entries(value).flatMap(([name, child]) => typeof child === 'object' ? leaves(child, `${prefix}${name}.`) : [`${prefix}${name}`])
  }
  assert.deepEqual(leaves(en.pages.preference.foregroundHiding), leaves(ko.pages.preference.foregroundHiding))
  // Paired inventories alone cannot catch a label missing in both languages.
  for (const locale of [en, ko]) {
    for (const [label, parameter] of [['removeApplication', 'name'], ['addNamedApplication', 'name']] as const) {
      assert.match(locale.pages.preference.foregroundHiding[label], new RegExp(`\\{${parameter}\\}`))
    }
  }
  assert.equal(ko.pages.preference.foregroundHiding.selectFromPc, 'PC에서 앱 선택')
})
