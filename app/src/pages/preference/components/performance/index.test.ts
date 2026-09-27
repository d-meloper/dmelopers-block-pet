/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { createI18n } from 'vue-i18n'
import { compileScript, parse } from 'vue/compiler-sfc'

import * as performanceConfig from '@/config/performance'
import en from '@/locales/en-US.json'
import ko from '@/locales/ko-KR.json'
import * as languageBranch from '@/locales/languageBranch'
import { useCatStore } from '@/stores/cat'

interface ResetDialog {
  onOk: () => unknown
}

function harness(component: 'performance' | 'about', options: {
  locale?: 'ko-KR' | 'en-US'
  antialias?: boolean
  withoutBroadcastController?: boolean
  resetFails?: boolean
  resetFailsAfterChange?: boolean
} = {}) {
  setActivePinia(createPinia())
  const catStore = useCatStore()
  catStore.model.antialiasEnabled = options.antialias ?? true
  const { descriptor } = parse(readFileSync(new URL(`../${component}/index.vue`, import.meta.url), 'utf8'))
  const compiled = compileScript(descriptor, { id: `${component}-performance-test` })
  const transformed = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const performanceState = Vue.reactive({
    currentMetrics: {} as { cpuPercent?: number, gpuPercent?: number, ramBytes?: number },
    averageMetrics: {} as { cpuPercent?: number, gpuPercent?: number, ramBytes?: number },
    hasSampled: false,
    elapsedSeconds: 0,
  })
  const i18n = createI18n({ legacy: false, locale: options.locale ?? 'ko-KR', messages: { 'ko-KR': ko, 'en-US': en } })
  const broadcastKey = Symbol('broadcast')
  const broadcastStatus = Vue.ref({ enabled: false, clients: 0, error: undefined as string | undefined })
  const dialogs: ResetDialog[] = []
  const errors: string[] = []
  const module = { exports: {} as { default: { setup: (props: object, context: object) => {
    metrics: Vue.ComputedRef<Array<{ value: string, average?: string }>>
    samplingHint: Vue.ComputedRef<string>
    broadcastHint: Vue.ComputedRef<string | undefined>
    confirmPerformanceReset: () => void
    confirmProgramReset: () => void
  } } } }
  // Compile the actual SFC script and exercise its user actions with the real store.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', transformed.outputText)((id: string) => {
    if (id === 'vue') {
      return {
        ...Vue,
        onMounted: () => {},
        inject: (key: symbol) => key === broadcastKey && !options.withoutBroadcastController
          ? { status: broadcastStatus }
          : undefined,
      }
    }
    if (id === '@/composables/useBroadcast') return { BROADCAST_CONTROLLER: broadcastKey }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: i18n.global.t }) }
    if (id === 'ant-design-vue') {
      return {
        Modal: { confirm: (dialog: ResetDialog) => dialogs.push(dialog) },
        message: { error: (key: string) => errors.push(key) },
      }
    }
    if (id === '@/config/performance') return performanceConfig
    if (id === '@/locales/languageBranch') return languageBranch
    if (id === './ManualUpdates.vue') return { default: {} }
    if (id === '@/stores/cat') return { useCatStore: () => catStore }
    if (id === '@/stores/app') return { useAppStore: () => ({ name: '', version: '' }) }
    if (id === '@/stores/performance') {
      return { usePerformanceStore: () => performanceState }
    }
    if (id === '@/composables/useProgramSettingsReset') {
      return { useProgramSettingsReset: () => ({ resetProgramSettings: async () => {
        if (options.resetFails) throw new Error('reset failed')
        catStore.resetAllSettings()
        if (options.resetFailsAfterChange) throw new Error('geometry reset failed')
      } }) }
    }
    if (id.startsWith('@tauri-apps/') || id.startsWith('@/components/') || id === '@/constants/branding') {
      return {}
    }
    throw new Error(`Unexpected import: ${id}`)
  }, module, module.exports)
  const actions = module.exports.default.setup({}, { expose: () => {} })
  return { performanceState, broadcastStatus, catStore, actions, dialogs, errors }
}

describe('performance settings user actions', () => {
  it('exposes independent live toggles without restart controls', () => {
    const h = harness('performance')
    h.catStore.model.antialiasEnabled = false
    h.catStore.model.pixelFilterEnabled = true
    assert.equal(h.dialogs.length, 0)
    const source = readFileSync(new URL('./index.vue', import.meta.url), 'utf8')
    assert.ok(source.includes('v-model:checked="catStore.model.antialiasEnabled"'))
    assert.ok(source.includes('v-model:checked="catStore.model.pixelFilterEnabled"'))
    assert.ok(!/restart|RenderQualityLab/.test(source))
  })

  it('resets both options with only the ordinary reset confirmation', () => {
    const h = harness('performance', { antialias: false })
    h.catStore.model.pixelFilterEnabled = true
    h.actions.confirmPerformanceReset()
    h.dialogs[0].onOk()
    assert.equal(h.catStore.model.antialiasEnabled, true)
    assert.equal(h.catStore.model.pixelFilterEnabled, true)
    assert.equal(h.dialogs.length, 1)
  })

  it('resets the program without a second confirmation', async () => {
    const h = harness('about', { antialias: false })
    h.actions.confirmProgramReset()
    await h.dialogs[0].onOk()
    assert.equal(h.catStore.model.antialiasEnabled, true)
    assert.equal(h.dialogs.length, 1)
  })

  it('reports reset errors without prompting for a restart', async () => {
    for (const resetFailsAfterChange of [true, false]) {
      const h = harness('about', { antialias: false, resetFails: !resetFailsAfterChange, resetFailsAfterChange })
      h.actions.confirmProgramReset()
      await assert.rejects(Promise.resolve().then(() => h.dialogs[0].onOk()), /reset failed/)
      assert.equal(h.catStore.model.antialiasEnabled, resetFailsAfterChange)
      assert.equal(h.dialogs.length, 1)
      assert.deepEqual(h.errors, [ko.pages.preference.about.errors.resetAll])
    }
  })

  it('does not blame skin deletion when window reset fails after settings changed', async () => {
    for (const [locale, expected] of [
      ['ko-KR', '프로그램 초기화를 완료하지 못했습니다.'],
      ['en-US', 'The program reset could not be completed.'],
    ] as const) {
      const h = harness('about', { locale, antialias: false, resetFailsAfterChange: true })
      h.actions.confirmProgramReset()
      await assert.rejects(Promise.resolve().then(() => h.dialogs[0].onOk()), /geometry reset failed/)
      assert.equal(h.catStore.model.antialiasEnabled, true)
      assert.deepEqual(h.errors, [expected])
    }
  })
})

describe('performance average display', () => {
  it('formats CPU, GPU, and RAM averages and distinguishes waiting from unavailable', () => {
    for (const locale of ['ko-KR', 'en-US'] as const) {
      const h = harness('performance', { locale })
      assert.deepEqual(h.actions.metrics.value.map(metric => metric.average), ['---', '---', '---'])
      assert.equal(h.actions.metrics.value[2].value, '---')
      h.performanceState.hasSampled = true
      const unavailable = (locale === 'ko-KR' ? ko : en).pages.preference.performance.status.unavailable
      assert.deepEqual(h.actions.metrics.value.map(metric => metric.average), [unavailable, unavailable, unavailable])
      assert.equal(h.actions.metrics.value[2].value, unavailable)
      h.performanceState.currentMetrics = { cpuPercent: 12.34, gpuPercent: 23.45, ramBytes: 100 * 1024 * 1024 + 512 * 1024 }
      h.performanceState.averageMetrics = { cpuPercent: 10.46, gpuPercent: 0, ramBytes: 75.25 * 1024 * 1024 }
      assert.equal(h.actions.metrics.value[0].value, '12.3%')
      assert.equal(h.actions.metrics.value[0].average, '10.5%')
      assert.equal(h.actions.metrics.value[1].average, '0.0%')
      assert.equal(h.actions.metrics.value[2].value, '100.5 MiB')
      assert.equal(h.actions.metrics.value[2].average, '75.3 MiB')
      h.performanceState.currentMetrics.ramBytes = undefined
      assert.equal(h.actions.metrics.value[2].value, unavailable)
      assert.equal(h.actions.metrics.value[2].average, '75.3 MiB')
      h.performanceState.currentMetrics.ramBytes = 0
      h.performanceState.averageMetrics.ramBytes = 0
      assert.equal(h.actions.metrics.value[2].value, '0.0 MiB')
      assert.equal(h.actions.metrics.value[2].average, '0.0 MiB')
    }
  })

  it('updates the existing hint with localized elapsed seconds and minutes', () => {
    for (const locale of ['ko-KR', 'en-US'] as const) {
      const h = harness('performance', { locale })
      const durations = locale === 'ko-KR' ? ['0초', '59초', '1분 0초', '2분 5초'] : ['0s', '59s', '1m 0s', '2m 5s']
      const messages = locale === 'ko-KR' ? ko : en
      for (const [index, seconds] of [0, 59, 60, 125].entries()) {
        h.performanceState.elapsedSeconds = seconds
        const hint = h.actions.samplingHint.value
        assert.ok(hint.startsWith(messages.pages.preference.performance.hints.sampling))
        assert.ok(hint.endsWith(messages.pages.preference.performance.hints.average.replace('{duration}', durations[index])))
      }
    }
  })
})

describe('broadcast performance scope notice', () => {
  it('follows ready source connections, including desktop-hidden and retained-scene states', () => {
    for (const locale of ['ko-KR', 'en-US'] as const) {
      const h = harness('performance', { locale })
      const expected = (locale === 'ko-KR' ? ko : en).pages.preference.performance.hints.broadcastUsage
      assert.equal(h.actions.broadcastHint.value, undefined)
      h.broadcastStatus.value.enabled = true
      assert.equal(h.actions.broadcastHint.value, undefined)
      h.broadcastStatus.value.clients = 1
      assert.equal(h.actions.broadcastHint.value, expected)
      h.catStore.window.visible = false
      h.broadcastStatus.value.error = 'render_failed'
      assert.equal(h.actions.broadcastHint.value, expected)
      h.broadcastStatus.value.clients = 2
      assert.equal(h.actions.broadcastHint.value, expected)
      h.broadcastStatus.value.clients = 0
      assert.equal(h.actions.broadcastHint.value, undefined)
      h.broadcastStatus.value.clients = 1
      assert.equal(h.actions.broadcastHint.value, expected)
      h.broadcastStatus.value.enabled = false
      assert.equal(h.actions.broadcastHint.value, undefined)
    }
  })

  it('keeps the ordinary measurement hint usable without a broadcast owner', () => {
    const h = harness('performance', { withoutBroadcastController: true })
    assert.equal(h.actions.broadcastHint.value, undefined)
    assert.ok(h.actions.samplingHint.value.includes(ko.pages.preference.performance.hints.sampling))
  })
})
