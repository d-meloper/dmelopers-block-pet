/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import { runProgramSettingsReset } from '@/utils/programSettingsReset'

function compile(source: string) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

function harness() {
  let nativeEnabled = false
  let finishEnable!: () => void
  const enablePending = new Promise<void>((resolve) => {
    finishEnable = resolve
  })
  const native = {
    isEnabled: async () => nativeEnabled,
    enable: async () => {
      await enablePending
      nativeEnabled = true
    },
    disable: async () => {
      nativeEnabled = false
    },
  }
  const general = {
    app: Vue.reactive({ autostart: false }),
    reset: () => {
      general.app.autostart = false
    },
    init: async () => {},
  }
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const compiled = compileScript(descriptor, { id: 'general-autostart-race' })
  const module = { exports: {} as { default: { setup: (props: object, context: object) => unknown } } }
  interface AutostartService { setAutostartEnabled: (enabled: boolean) => Promise<void> }
  let service: AutostartService | undefined
  const require = (id: string): unknown => {
    if (id === '@/services/diagnostics') return { reportDiagnostic: () => {} }
    if (id === 'vue') return Vue
    if (id === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
    if (id === 'ant-design-vue') return { Modal: {} }
    if (id === '@tauri-apps/plugin-autostart') return native
    if (id === '@/stores/general') return { useGeneralStore: () => general }
    if (id === '@/stores/cat') return { useCatStore: () => ({ resetAllSettings: () => {} }) }
    if (id === '@/services/autostart') {
      if (!service) {
        const exports = {}
        runInNewContext(compile(readFileSync(new URL('../../../../services/autostart.ts', import.meta.url), 'utf8')), { exports, require, console })
        service = exports as AutostartService
      }
      return service
    }
    if (id === '@tauri-apps/api/dpi') return { LogicalSize: class {} }
    if (id === '@tauri-apps/api/webviewWindow') return { getAllWebviewWindows: async () => [] }
    if (id === '@/features/presets/operations') return { withPresetReset: (reset: () => Promise<void>) => reset() }
    if (id === '@/services/skinLibrary') return { clearSkinLibrary: async () => {} }
    if (id === '@/stores/performance') return { usePerformanceStore: () => ({ stop: async () => {}, reset: async () => {} }) }
    if (id === '@/stores/shortcut') return { useShortcutStore: () => ({ reset: () => {} }) }
    if (id === '@/stores/app') return { useAppStore: () => ({ resetWindowState: () => {} }) }
    if (id === '@/utils/programSettingsReset') return { runProgramSettingsReset }
    return {}
  }
  runInNewContext(compile(compiled.content), { module, exports: module.exports, require, console })
  const scope = Vue.effectScope()
  scope.run(() => module.exports.default.setup({}, { expose: () => {} }))
  return {
    general,
    finishEnable,
    enabled: () => nativeEnabled,
    unmount: () => scope.stop(),
    reset: async () => {
      const exports = {} as { useProgramSettingsReset: () => { resetProgramSettings: () => Promise<void> } }
      runInNewContext(compile(readFileSync(new URL('../../../../composables/useProgramSettingsReset.ts', import.meta.url), 'utf8')), { exports, require, console })
      await exports.useProgramSettingsReset().resetProgramSettings()
    },
  }
}

it('keeps the final OFF choice when native enable finishes after a rapid ON/OFF', async () => {
  const h = harness()
  try {
    await flush()
    h.general.app.autostart = true
    await flush()
    h.general.app.autostart = false
    await flush()
    h.finishEnable()
    await flush()
    assert.equal(h.enabled(), false)
    assert.equal(h.general.app.autostart, false)
  } finally {
    h.unmount()
  }
})

it('orders whole-program autostart reset after an already issued enable from a closed tab', async () => {
  const h = harness()
  await flush()
  h.general.app.autostart = true
  await flush()
  h.unmount()
  const reset = h.reset()
  await flush()
  h.finishEnable()
  await reset
  await flush()
  assert.equal(h.enabled(), false)
})
