/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { createI18n } from 'vue-i18n'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { PerformanceUnavailableReasons } from '@/utils/performance'

import { snapSliderValue } from '@/components/default-snap-slider/snapValue'
import externalLinks from '@/config/externalLinks.json'
import * as performanceConfig from '@/config/performance'
import { WINDOW_LABEL } from '@/constants'
import en from '@/locales/en-US.json'
import ko from '@/locales/ko-KR.json'
import * as languageBranch from '@/locales/languageBranch'
import { useBlockStore } from '@/stores/block'
import { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS, ProgramSettingsResetError } from '@/utils/programSettingsReset'

function mainAntialiasHarness(readonlyModel = false) {
  const { descriptor } = parse(readFileSync(new URL('../../../main/index.vue', import.meta.url), 'utf8'))
  const source = ts.createSourceFile('main.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.ES2022, true)
  const names = ['applyAntialiasSetting', 'synchronizeAntialias', 'acknowledgeAntialiasSetting']
  const functions = source.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ''))
  assert.equal(functions.length, names.length)
  const compiled = ts.transpileModule(functions.map(fn => fn.getText(source)).join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const model = { antialiasEnabled: false }
  if (readonlyModel) Object.freeze(model)
  const canvas = { value: undefined as unknown }
  const visible = { value: true }
  const replies: Array<{ label: string, event: string, payload: unknown }> = []
  let actual = true
  let change: () => Promise<unknown> = async () => {
    throw new Error('The new renderer could not be created.')
  }
  // Run the actual desktop synchronization function; freeze its mirror to catch
  // accidental persistence writes outside the preference settings owner.
  // eslint-disable-next-line no-new-func
  const actions = new Function('blockStore', 'three3d', 'canvas', 'desktopPetVisible', 'emitTo', 'WINDOW_LABEL', 'ANTIALIAS_SETTING_RESPONSE', 'console', `
    'use strict';
    let rendererReady = true;
    const rendererLifecycleGeneration = 1;
    let componentMounted = true;
    let rendererInitialization;
    let antialiasSynchronization = Promise.resolve();
    let antialiasRequest;
    ${compiled}
    return {
      run: synchronizeAntialias,
      request: (requestId, requested) => {
        antialiasRequest = { requestId, requested, responding: false };
        return acknowledgeAntialiasSetting();
      },
      resume: acknowledgeAntialiasSetting,
      setReady: value => { rendererReady = value; },
      setInitialization: promise => {
        rendererReady = false;
        rendererInitialization = { promise: promise.finally(() => {
          rendererInitialization = undefined;
          rendererReady = true;
        }) };
      },
      dispose: () => { componentMounted = false; antialiasRequest = undefined; },
    };
  `)(
    { model },
    { setAntialiasEnabled: () => change(), getAntialiasEnabled: () => actual },
    canvas,
    visible,
    async (label: string, event: string, payload: unknown) => replies.push({ label, event, payload }),
    WINDOW_LABEL,
    performanceConfig.ANTIALIAS_SETTING_RESPONSE,
    { error: () => {}, warn: () => {} },
  ) as {
    run: () => Promise<void>
    request: (id: string, requested: boolean) => Promise<void>
    resume: () => Promise<void>
    setReady: (value: boolean) => void
    setInitialization: (promise: Promise<unknown>) => void
    dispose: () => void
  }
  return {
    ...actions,
    model,
    canvas,
    visible,
    replies,
    setActual: (value: boolean) => {
      actual = value
    },
    setChange: (next: typeof change) => {
      change = next
    },
  }
}

interface ResetDialog {
  onOk: () => unknown
}

function harness(component: 'performance' | 'about', options: {
  locale?: 'ko-KR' | 'en-US'
  antialias?: boolean
  withoutBroadcastController?: boolean
  resetFails?: boolean
  resetFailsAfterChange?: boolean
  render?: boolean
} = {}) {
  setActivePinia(createPinia())
  const blockStore = useBlockStore()
  blockStore.model.antialiasEnabled = options.antialias ?? true
  const { descriptor } = parse(readFileSync(new URL(`../${component}/index.vue`, import.meta.url), 'utf8'))
  const compiled = compileScript(descriptor, { id: `${component}-performance-test`, inlineTemplate: options.render })
  const transformed = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  let measurementResets = 0
  const unmountHandlers: Array<() => void> = []
  const performanceState = Vue.reactive({
    currentMetrics: {} as { cpuPercent?: number, gpuPercent?: number, ramBytes?: number },
    averageMetrics: {} as { cpuPercent?: number, gpuPercent?: number, ramBytes?: number },
    unavailableReasons: {} as PerformanceUnavailableReasons,
    hasSampled: false,
    isWarmingUp: false,
    elapsedSeconds: 0,
    reset: async () => {
      measurementResets += 1
      performanceState.currentMetrics = {}
      performanceState.averageMetrics = {}
      performanceState.unavailableReasons = {}
      performanceState.hasSampled = false
      performanceState.elapsedSeconds = 0
    },
  })
  const i18n = createI18n({ legacy: false, locale: options.locale ?? 'ko-KR', messages: { 'ko-KR': ko, 'en-US': en } })
  const broadcastKey = Symbol('broadcast')
  const broadcastStatus = Vue.ref({ enabled: false, clients: 0, error: undefined as string | undefined })
  const dialogs: ResetDialog[] = []
  const errors: string[] = []
  const module = { exports: {} as { default: { setup: (props: object, context: object) => {
    metrics: Vue.ComputedRef<Array<{ value: string, average?: string }>>
    samplingHint: Vue.ComputedRef<string>
    unavailableHint: Vue.ComputedRef<string | undefined>
    broadcastHint: Vue.ComputedRef<string | undefined>
    confirmPerformanceReset: () => void
    confirmProgramReset: () => void
    submitProgramReset: () => Promise<void>
    resetOpen: Vue.Ref<boolean>
    updatePerformanceToggle: (key: 'antialiasEnabled' | 'pixelFilterEnabled' | 'idlePowerSavingEnabled', value: boolean) => void
    updateShadowQuality: (value: performanceConfig.ShadowQualitySelection) => void
    resetMeasurements: () => void
  } } } }
  // Compile the actual SFC script and exercise its user actions with the real store.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', transformed.outputText)((id: string) => {
    if (id === 'vue') {
      return {
        ...Vue,
        onMounted: () => {},
        onBeforeUnmount: (handler: () => void) => unmountHandlers.push(handler),
        inject: (key: symbol) => key === broadcastKey && !options.withoutBroadcastController
          ? { status: broadcastStatus }
          : undefined,
      }
    }
    if (id === '@/composables/useAppLanguage') {
      return { useAppLanguage: () => ({
        language: Vue.computed(() => i18n.global.locale.value),
        select: <T>(korean: T, global: T) => languageBranch.selectByLanguage(i18n.global.locale.value, korean, global),
      }) }
    }
    if (id === '@/composables/useBroadcast') return { BROADCAST_CONTROLLER: broadcastKey }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: i18n.global.t }) }
    if (id === 'ant-design-vue') {
      return {
        Button: 'button',
        Flex: 'flex',
        Select: { name: 'Select', Option: 'select-option' },
        Switch: 'switch',
        Modal: { confirm: (dialog: ResetDialog) => dialogs.push(dialog) },
        message: { error: (key: string) => errors.push(key) },
      }
    }
    if (id === '@/config/externalLinks.json') return { default: externalLinks }
    if (id === '@/config/performance') return performanceConfig
    if (options.render && id.startsWith('@/components/')) {
      return {
        default: id.includes('default-snap-slider')
          ? 'default-snap-slider'
          : id.includes('/pro-list/') ? { name: 'ProList' } : 'section',
      }
    }
    if (id === '@/locales/languageBranch') return languageBranch
    if (id === './AutomaticUpdates.vue' || id === './MicrosoftStoreIcon.vue' || id === './NotionIcon.vue') return { default: {} }
    if (id === '@ant-design/icons-vue') return { GithubFilled: {} }
    if (id === '@/services/environmentInfo') return { collectEnvironmentInfo: async () => '' }
    if (id === '@/services/diagnostics') return { reportDiagnostic: () => {} }
    if (id === '@/services/distribution') return { getDistributionInfo: async () => ({ dataRoot: '/data' }) }
    if (id === '@/utils/programSettingsReset') return { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS, ProgramSettingsResetError }
    if (id === '@/stores/block') return { useBlockStore: () => blockStore }
    if (id === '@/stores/app') return { useAppStore: () => ({ name: '', version: '' }) }
    if (id === '@/stores/performance') {
      return { usePerformanceStore: () => performanceState }
    }
    if (id === '@/composables/useProgramSettingsReset') {
      return { useProgramSettingsReset: () => ({ resetProgramSettings: async () => {
        if (options.resetFails) throw new ProgramSettingsResetError('preflight', 'preflight', new Error('reset failed'))
        blockStore.resetAllSettings()
        if (options.resetFailsAfterChange) throw new ProgramSettingsResetError('partial', 'window', new Error('geometry reset failed'))
      } }) }
    }
    if (id.startsWith('@tauri-apps/') || id.startsWith('@/components/') || id === '@/constants/branding') {
      return {}
    }
    throw new Error(`Unexpected import: ${id}`)
  }, module, module.exports)
  const actions = module.exports.default.setup({}, { expose: () => {} })
  const flatten = (node: Vue.VNode): Vue.VNode[] => {
    const children = Array.isArray(node.children)
      ? node.children
      : node.children && typeof node.children === 'object'
        ? Object.values(node.children).flatMap(slot => typeof slot === 'function' ? slot() : [])
        : []
    return [node, ...children.flatMap(child => Vue.isVNode(child) ? flatten(child) : [])]
  }
  return {
    performanceState,
    broadcastStatus,
    blockStore,
    actions,
    dialogs,
    errors,
    renderNodes: () => flatten((actions as unknown as (context: object, cache: unknown[]) => Vue.VNode)({ $t: i18n.global.t }, [])),
    get measurementResets() {
      return measurementResets
    },
    unmount: () => unmountHandlers.forEach(handler => handler()),
  }
}

describe('performance settings user actions', () => {
  it('snaps performance sliders to the same authored values used by category reset', () => {
    const h = harness('performance', { render: true })
    h.blockStore.model.maxFPS = 75
    h.blockStore.model.renderScalePercent = 50
    h.blockStore.resetPerformanceSettings()
    const sliders = h.renderNodes().filter(node => node.type === 'default-snap-slider')
    assert.equal(sliders.length, 2)
    for (const [index, key] of ['maxFPS', 'renderScalePercent'].entries()) {
      const slider = sliders[index].props!
      const defaultValue = slider['default-value']
      assert.equal(defaultValue, h.blockStore.model[key as 'maxFPS' | 'renderScalePercent'])
      assert.equal(snapSliderValue(defaultValue + 1, { min: slider.min, max: slider.max, defaultValue }), defaultValue)
    }
  })

  it('exposes independent live toggles without restart controls', () => {
    const h = harness('performance')
    h.actions.updatePerformanceToggle('antialiasEnabled', false)
    h.actions.updatePerformanceToggle('pixelFilterEnabled', false)
    assert.equal(h.blockStore.model.antialiasEnabled, false)
    assert.equal(h.blockStore.model.pixelFilterEnabled, false)
    assert.equal(h.measurementResets, 2)
    assert.equal(h.dialogs.length, 0)
    const source = readFileSync(new URL('./index.vue', import.meta.url), 'utf8')
    assert.ok(source.includes(':checked="blockStore.model.antialiasEnabled"'))
    assert.ok(source.includes(':checked="blockStore.model.pixelFilterEnabled"'))
    assert.ok(!/restart|RenderQualityLab/.test(source))
  })

  it('clears all measurement displays once for each actual switch or quality change', () => {
    const h = harness('performance')
    for (const key of ['antialiasEnabled', 'pixelFilterEnabled', 'idlePowerSavingEnabled'] as const) {
      const resets = h.measurementResets
      const previous = h.blockStore.model[key]
      h.actions.updatePerformanceToggle(key, previous)
      assert.equal(h.measurementResets, resets)
      h.performanceState.currentMetrics = { cpuPercent: 20, gpuPercent: 30, ramBytes: 512 }
      h.performanceState.averageMetrics = { cpuPercent: 10, gpuPercent: 15, ramBytes: 256 }
      h.performanceState.hasSampled = true
      h.performanceState.elapsedSeconds = 12
      h.actions.updatePerformanceToggle(key, !previous)
      assert.equal(h.blockStore.model[key], !previous)
      assert.equal(h.measurementResets, resets + 1)
      assert.deepEqual(h.performanceState.currentMetrics, {})
      assert.deepEqual(h.performanceState.averageMetrics, {})
      assert.equal(h.performanceState.hasSampled, false)
      assert.equal(h.performanceState.elapsedSeconds, 0)
    }
    for (const quality of ['off', 'low', 'medium', 'high'] as const) {
      const resets = h.measurementResets
      h.actions.updateShadowQuality(quality)
      assert.equal(h.blockStore.shadowQualitySelection, quality)
      assert.equal(h.measurementResets, resets + 1)
      h.actions.updateShadowQuality(quality)
      assert.equal(h.measurementResets, resets + 1)
    }
  })

  it('keeps slider edits live and resets only through the completed-gesture event', () => {
    const h = harness('performance')
    for (const key of ['maxFPS', 'renderScalePercent'] as const) {
      const resets = h.measurementResets
      for (const value of [60, 65, 70]) {
        h.blockStore.model[key] = value
        assert.equal(h.blockStore.model[key], value)
        assert.equal(h.measurementResets, resets)
      }
      h.actions.resetMeasurements()
      assert.equal(h.measurementResets, resets + 1)
    }
    const source = readFileSync(new URL('./index.vue', import.meta.url), 'utf8')
    const sliders = [...source.matchAll(/<DefaultSnapSlider\b[\s\S]*?\/>/g)].map(match => match[0])
    assert.equal(sliders.length, 2)
    assert.ok(sliders[0]!.includes(':min="MIN_FPS"'))
    assert.equal(performanceConfig.MIN_FPS, 15)
    for (const slider of sliders) {
      assert.ok(slider.includes('display-mode="raw"'))
      assert.ok(slider.includes('@after-change="resetMeasurements"'))
      assert.ok(!slider.includes('@change='))
    }
  })

  it('ignores stale completed gestures and reset confirmations after unmount', () => {
    const h = harness('performance', { antialias: false })
    h.actions.confirmPerformanceReset()
    h.unmount()
    h.actions.resetMeasurements()
    h.actions.updatePerformanceToggle('antialiasEnabled', true)
    h.actions.updateShadowQuality('off')
    h.dialogs[0].onOk()
    assert.equal(h.measurementResets, 0)
    assert.equal(h.blockStore.model.antialiasEnabled, false)
    assert.equal(h.blockStore.shadowQualitySelection, 'medium')
  })

  it('resets both options with only the ordinary reset confirmation', () => {
    const h = harness('performance', { antialias: false })
    h.blockStore.model.pixelFilterEnabled = true
    h.blockStore.model.maxFPS = 80
    h.blockStore.model.renderScalePercent = 50
    h.blockStore.shadowQualitySelection = 'off'
    h.actions.confirmPerformanceReset()
    h.dialogs[0].onOk()
    assert.equal(h.blockStore.model.antialiasEnabled, true)
    assert.equal(h.blockStore.model.pixelFilterEnabled, true)
    assert.equal(h.blockStore.model.maxFPS, 30)
    assert.equal(h.blockStore.model.renderScalePercent, 100)
    assert.equal(h.blockStore.shadowQualitySelection, 'medium')
    assert.equal(h.measurementResets, 1)
    assert.equal(h.dialogs.length, 1)
  })

  it('resets the program through its option dialog without a second confirmation', async () => {
    const h = harness('about', { antialias: false })
    h.actions.confirmProgramReset()
    assert.equal(h.actions.resetOpen.value, true)
    await h.actions.submitProgramReset()
    assert.equal(h.blockStore.model.antialiasEnabled, true)
    assert.equal(h.actions.resetOpen.value, false)
    assert.equal(h.dialogs.length, 0)
    assert.deepEqual(h.errors, [])
  })

  it('reports reset errors without prompting for a restart', async () => {
    for (const resetFailsAfterChange of [true, false]) {
      const h = harness('about', { antialias: false, resetFails: !resetFailsAfterChange, resetFailsAfterChange })
      h.actions.confirmProgramReset()
      await h.actions.submitProgramReset()
      assert.equal(h.blockStore.model.antialiasEnabled, resetFailsAfterChange)
      assert.equal(h.actions.resetOpen.value, true)
      assert.equal(h.dialogs.length, 0)
      assert.deepEqual(h.errors, [ko.pages.preference.about.errors[resetFailsAfterChange ? 'resetPartial' : 'resetPreflight']])
    }
  })

  it('reports possible partial changes in both languages when window reset fails', async () => {
    for (const [locale, expected] of [
      ['ko-KR', ko.pages.preference.about.errors.resetPartial],
      ['en-US', en.pages.preference.about.errors.resetPartial],
    ] as const) {
      const h = harness('about', { locale, antialias: false, resetFailsAfterChange: true })
      h.actions.confirmProgramReset()
      await h.actions.submitProgramReset()
      assert.equal(h.blockStore.model.antialiasEnabled, true)
      assert.equal(h.actions.resetOpen.value, true)
      assert.deepEqual(h.errors, [expected])
    }
  })
})

describe('performance average display', () => {
  it('shows localized current failure lines in the existing tooltip alongside sampling, average and OBS text', () => {
    for (const locale of ['ko-KR', 'en-US'] as const) {
      const h = harness('performance', { locale })
      const messages = (locale === 'ko-KR' ? ko : en).pages.preference.performance
      h.performanceState.hasSampled = true
      h.performanceState.currentMetrics = { ramBytes: 512 }
      h.performanceState.unavailableReasons = { cpu: 'accessDenied', gpu: 'counterReadFailed' }
      const expected = [
        `${messages.metrics.cpu}: ${messages.unavailableReasons.accessDenied}`,
        `${messages.metrics.gpu}: ${messages.unavailableReasons.counterReadFailed}`,
      ].join('\n')
      assert.equal(h.actions.unavailableHint.value, expected)
      assert.ok(h.actions.samplingHint.value.startsWith(messages.hints.sampling))
      assert.ok(h.actions.samplingHint.value.includes(messages.hints.average.replace('{duration}', locale === 'ko-KR' ? '0초' : '0s')))
      assert.ok(h.actions.samplingHint.value.endsWith(`\n\n${expected}`))
      h.broadcastStatus.value = { enabled: true, clients: 1, error: undefined }
      assert.equal(h.actions.broadcastHint.value, messages.hints.broadcastUsage)
    }
    const h = harness('performance', { render: true })
    h.performanceState.hasSampled = true
    h.performanceState.unavailableReasons = { gpu: 'counterUnavailable' }
    h.broadcastStatus.value = { enabled: true, clients: 1, error: undefined }
    const info = h.renderNodes().find(node => node.props?.label === ko.pages.preference.performance.buttons.measurementInfo)
    assert.ok(info?.props?.text.includes(`${ko.pages.preference.performance.metrics.gpu}: ${ko.pages.preference.performance.unavailableReasons.counterUnavailable}`))
    assert.equal(info?.props?.['emphasis-text'], ko.pages.preference.performance.hints.broadcastUsage)
  })

  it('includes the exact generic notice once for unknown resources and clears it on recovery and reset', () => {
    assert.equal(ko.pages.preference.performance.hints.unavailableEnvironment, '일부 환경에서는 특정 리소스 사용량이 측정되지 않을 수 있습니다.')
    for (const locale of ['ko-KR', 'en-US'] as const) {
      const h = harness('performance', { locale })
      const messages = (locale === 'ko-KR' ? ko : en).pages.preference.performance
      h.performanceState.hasSampled = true
      h.performanceState.unavailableReasons = { cpu: 'unknown', gpu: 'counterUnavailable', ram: 'unknown' }
      assert.equal(h.actions.unavailableHint.value, `${messages.metrics.gpu}: ${messages.unavailableReasons.counterUnavailable}\n${messages.hints.unavailableEnvironment}`)
      assert.equal(h.actions.samplingHint.value.split(messages.hints.unavailableEnvironment).length - 1, 1)
      h.performanceState.currentMetrics = { cpuPercent: 0, gpuPercent: 0, ramBytes: 0 }
      h.performanceState.unavailableReasons = {}
      assert.equal(h.actions.unavailableHint.value, undefined)
      assert.ok(!h.actions.samplingHint.value.includes(messages.hints.unavailableEnvironment))
      h.performanceState.unavailableReasons = { gpu: 'accessDenied' }
      h.actions.resetMeasurements()
      assert.deepEqual(h.performanceState.unavailableReasons, {})
      assert.equal(h.actions.unavailableHint.value, undefined)
    }
  })

  it('does not treat the initial or bounded preparation display as a measurement failure', () => {
    const h = harness('performance')
    h.performanceState.unavailableReasons = { cpu: 'unknown', gpu: 'initializing', ram: 'unknown' }
    assert.equal(h.actions.unavailableHint.value, undefined)
    h.performanceState.hasSampled = true
    h.performanceState.isWarmingUp = true
    assert.equal(h.actions.unavailableHint.value, undefined)
    assert.equal(h.actions.samplingHint.value, ko.pages.preference.performance.hints.warmup)
  })

  it('shows preparation without current values, averages or a measurement duration', () => {
    for (const locale of ['ko-KR', 'en-US'] as const) {
      const h = harness('performance', { locale })
      h.performanceState.isWarmingUp = true
      const messages = (locale === 'ko-KR' ? ko : en).pages.preference.performance
      assert.deepEqual(h.actions.metrics.value.map(metric => [metric.value, metric.average]), [['---', '---'], ['---', '---'], ['---', '---']])
      assert.equal(h.actions.samplingHint.value, messages.hints.warmup)
      assert.equal(h.performanceState.elapsedSeconds, 0)
      h.performanceState.isWarmingUp = false
      h.performanceState.elapsedSeconds = 1
      h.performanceState.hasSampled = true
      h.performanceState.currentMetrics = { cpuPercent: 95, gpuPercent: 99, ramBytes: 512 }
      h.performanceState.averageMetrics = { ...h.performanceState.currentMetrics }
      assert.equal(h.actions.metrics.value[0].average, '95.0%')
      assert.ok(h.actions.samplingHint.value.startsWith(messages.hints.sampling))
      assert.ok(!h.actions.samplingHint.value.includes(messages.hints.warmup))
    }
    const source = readFileSync(new URL('./index.vue', import.meta.url), 'utf8')
    assert.ok(source.includes('v-if="performanceStore.isWarmingUp"'))
    assert.ok(source.includes('role="status"'))
    assert.ok(source.includes('pages.preference.performance.status.preparing'))
  })

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

describe('desktop antialias acknowledgement', () => {
  it('reports the failed request and actual renderer state without writing its readonly model', async () => {
    const h = mainAntialiasHarness(true)
    await h.request('failed', false)
    assert.equal(h.model.antialiasEnabled, false)
    assert.deepEqual(h.replies, [{
      label: WINDOW_LABEL.PREFERENCE,
      event: performanceConfig.ANTIALIAS_SETTING_RESPONSE,
      payload: { requestId: 'failed', requested: false, actual: true, success: false },
    }])
  })

  it('acknowledges hidden or uninitialized rendering without rolling back its next startup choice', async () => {
    for (const boundary of ['hidden', 'startup']) {
      const h = mainAntialiasHarness(true)
      if (boundary === 'hidden') h.visible.value = false
      else h.setReady(false)
      h.setChange(async () => assert.fail('Deferred renderer configuration must not allocate a context.'))
      await h.request(boundary, false)
      assert.deepEqual(h.replies[0]?.payload, { requestId: boundary, requested: false, actual: false, success: true })
    }
  })

  it('waits for the matching Pinia value and for a newer coalescing renderer call before acknowledging', async () => {
    const h = mainAntialiasHarness()
    h.model.antialiasEnabled = true
    await h.request('request-before-patch', false)
    assert.equal(h.replies.length, 0)
    h.model.antialiasEnabled = false
    const completions: Array<(value: unknown) => void> = []
    h.setChange(() => new Promise(resolve => completions.push(resolve)))
    const acknowledged = h.resume()
    const coalesced = h.run()
    assert.equal(completions.length, 2)
    completions[0](undefined)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(h.replies.length, 0, 'a coalesced call cannot report the previous actual setting as failure')
    h.setActual(false)
    completions[1]({})
    await Promise.all([acknowledged, coalesced])
    assert.deepEqual(h.replies[0]?.payload, { requestId: 'request-before-patch', requested: false, actual: false, success: true })
  })

  it('waits for an older context initialization and acknowledges its actual final setting', async () => {
    const h = mainAntialiasHarness(true)
    let initialized!: () => void
    h.setInitialization(new Promise<void>((resolve) => {
      initialized = resolve
    }))
    const pending = h.request('during-initialization', false)
    await Promise.resolve()
    assert.equal(h.replies.length, 0)
    // The initial context used the earlier true setting. Changing it failed.
    initialized()
    await pending
    assert.deepEqual(h.replies[0]?.payload, { requestId: 'during-initialization', requested: false, actual: true, success: false })
  })

  it('suppresses a superseded request and completion after unmount', async () => {
    const h = mainAntialiasHarness()
    const completions: Array<(value: unknown) => void> = []
    h.setChange(() => new Promise(resolve => completions.push(resolve)))
    const first = h.request('first', false)
    h.model.antialiasEnabled = true
    const next = h.request('next', true)
    completions[0](undefined)
    completions[1]({})
    await Promise.all([first, next])
    assert.deepEqual(h.replies.map(reply => reply.payload), [{ requestId: 'next', requested: true, actual: true, success: true }])
    h.model.antialiasEnabled = false
    const disposed = h.request('disposed', false)
    h.dispose()
    completions[2]({})
    await disposed
    assert.equal(h.replies.length, 1)
  })

  it('keeps successful replacement local and ignores superseded or hidden failure replies', async () => {
    const success = mainAntialiasHarness(true)
    const replacement = {}
    success.setChange(async () => replacement)
    await success.run()
    assert.equal(success.canvas.value, replacement)
    assert.deepEqual(success.replies, [])

    for (const boundary of ['setting', 'hidden']) {
      const h = mainAntialiasHarness()
      let reject!: (error: Error) => void
      h.setChange(() => new Promise((_resolve, rejectChange) => {
        reject = rejectChange
      }))
      const changing = h.run()
      if (boundary === 'setting') h.model.antialiasEnabled = true
      else h.visible.value = false
      reject(new Error('Superseded renderer failure.'))
      await changing
      assert.deepEqual(h.replies, [])
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
      h.blockStore.window.visible = false
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
