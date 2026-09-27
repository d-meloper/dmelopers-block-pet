/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

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
    '@/stores/cat': { useCatStore: () => ({}) },
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
