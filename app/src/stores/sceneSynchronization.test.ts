/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as vue from 'vue'
import { createSSRApp, nextTick } from 'vue'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'

import type { usePresetManager } from '@/composables/usePresetManager'
import type { useCatStore } from '@/stores/cat'

import { captureBroadcastScene } from '@/features/broadcast/scene'

type State = Record<string, any>
interface SettingsStore {
  $id: string
  $state: State
  $tauri: { start: () => Promise<void> }
  $dispose: () => void
  init?: () => void | Promise<void>
  reset?: () => void
}

const root = fileURLToPath(new URL('../../', import.meta.url))
const nodeRequire = createRequire(import.meta.url)
const pluginPath = nodeRequire.resolve('@tauri-store/pinia/dist/index.js')
const sharedPath = nodeRequire.resolve('@tauri-store/shared/dist/index.js', { paths: [path.dirname(pluginPath)] })
const transpiled = new Map<string, string>()
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function sfc(file: string) {
  const { descriptor } = parse(readFileSync(path.join(root, file), 'utf8'))
  const script = compileScript(descriptor, { id: file })
  const template = compileTemplate({ source: descriptor.template!.content, filename: file, id: file, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  return { script: script.content, template: template.code }
}

function evaluate(source: string, require: (id: string) => unknown) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} as any }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports)
  return module.exports
}

function descendants(value: vue.VNode): vue.VNode[] {
  const slot = typeof value.children === 'object' && value.children && 'default' in value.children ? value.children.default : undefined
  const children = typeof slot === 'function' ? slot() as vue.VNode[] : Array.isArray(value.children) ? value.children : []
  return [value, ...children.filter(vue.isVNode).flatMap(descendants)]
}

const sceneSfc = sfc('src/pages/preference/components/scene/index.vue')
const mainSfc = sfc('src/pages/main/index.vue')

async function settle() {
  for (let index = 0; index < 20; index++) await nextTick()
}

/** Native storage/event boundaries only; all four stores and both plugin packages are real. */
function harness() {
  const backend = new Map<string, State>()
  const handlers = new Map<string, Set<(event: { payload: { id: string, state: State } }) => void>>()
  const heldPatches: Array<() => void> = []
  let heldOwner: string | undefined
  function window(label: string) {
    const modules = new Map<string, { exports: any }>()
    const mounted: Array<() => void | Promise<void>> = []
    const unmounted: Array<() => void> = []
    const invoke = async (command: string, args: { id: string, state: State }) => {
      if (command === 'plugin:pinia|load' || command === 'plugin:pinia|get_store_state') {
        return clone(backend.get(args.id) ?? {})
      }
      if (command !== 'plugin:pinia|patch') return
      // Match Tauri JSON and Pinia's native top-level replacement semantics.
      const incoming = clone(args.state)
      const deliver = () => {
        backend.set(args.id, { ...(backend.get(args.id) ?? {}), ...incoming })
        for (const [owner, listeners] of handlers) {
          if (owner === label) continue
          for (const listener of listeners) listener({ payload: { id: args.id, state: clone(backend.get(args.id)!) } })
        }
      }
      if (heldOwner === label) {
        await new Promise<void>((resolve) => {
          heldPatches.push(() => {
            deliver()
            resolve()
          })
        })
      } else {
        deliver()
      }
    }
    const overrides: Record<string, unknown> = {
      'vue': { ...vue, onMounted: (callback: () => Promise<void>) => mounted.push(callback), onBeforeUnmount: (callback: () => void) => unmounted.push(callback) },
      'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
      'ant-design-vue': Object.fromEntries(['Button', 'Flex', 'InputNumber', 'Switch'].map(name => [name, name])),
      '@tauri-apps/api/core': { invoke },
      '@tauri-apps/api/app': { getVersion: async () => '1.0.2' },
      '@tauri-apps/api/event': { listen: async () => () => {} },
      '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({
        label,
        onCloseRequested: async () => () => {},
        listen: async (event: string, handler: (event: { payload: { id: string, state: State } }) => void) => {
          if (event !== 'tauri-store://state-change') return () => {}
          const listeners = handlers.get(label) ?? new Set()
          listeners.add(handler)
          handlers.set(label, listeners)
          return () => listeners.delete(handler)
        },
      }) },
      'tauri-plugin-locale-api': { getLocale: async () => 'ko-KR' },
      '@/services/diagnostics': { reportDiagnostic: () => {} },
      '@/features/presets/skin': { preparePresetSkin: async (snapshot: unknown) => clone(snapshot) },
      '@/features/presets/thumbnail': { renderPresetThumbnail: async () => 'test-thumbnail' },
      '@/services/presetTransfer': { readPresetImport: async () => undefined },
      '@/plugins/process': { registerAppProcessOwner: () => () => {} },
    }
    function load(name: string, from = root): any {
      if (name in overrides) return overrides[name]
      if (name.endsWith('.vue')) return { default: name }
      let file: string | undefined
      if (name === '@tauri-store/pinia') file = pluginPath
      else if (name === '@tauri-store/shared') file = sharedPath
      else if (name.startsWith('@/')) file = path.join(root, 'src', name.slice(2))
      else if (name.startsWith('.')) file = path.resolve(from, name)
      else return nodeRequire(name)
      if (!existsSync(file) || statSync(file).isDirectory()) {
        file = [`${file}.ts`, path.join(file, 'index.ts')].find(existsSync)
      }
      assert.ok(file, `unresolved fixture module ${name}`)
      if (modules.has(file)) return modules.get(file)!.exports
      const module = { exports: {} }
      modules.set(file, module)
      if (file.endsWith('.json')) {
        module.exports = { default: JSON.parse(readFileSync(file, 'utf8')) }
        return module.exports
      }
      let source = transpiled.get(file)
      if (!source) {
        source = ts.transpileModule(readFileSync(file, 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, allowJs: true },
        }).outputText
        transpiled.set(file, source)
      }
      // Isolate each webview's actual plugin and store module instances.
      // eslint-disable-next-line no-new-func
      new Function('require', 'module', 'exports', source)(
        (id: string) => load(id, path.dirname(file)),
        module,
        module.exports,
      )
      return module.exports
    }
    const pinia = createPinia()
    pinia.use(load('@/plugins/settingsStore').createSettingsStorePlugin({ isSavingAllowed: () => true, beforeBackendSync: (state: State) => state }))
    createSSRApp({ render: () => null }).use(pinia)
    const stores: SettingsStore[] = ['app', 'cat', 'general', 'shortcut'].map((id) => {
      const definitions = load(`@/stores/${id}`)
      const definition = Object.keys(definitions).find(key => /^use.*Store$/.test(key))!
      return definitions[definition](pinia)
    })
    const cat = stores.find(store => store.$id === 'cat')! as unknown as ReturnType<typeof useCatStore>
    return {
      stores,
      cat,
      flushOwner: () => load('@/features/stateSafety/bridge').stateOwners.flushPresets(),
      startOwner: async () => {
        setActivePinia(pinia)
        const owner = (load('@/composables/usePresetManager') as { usePresetManager: typeof usePresetManager }).usePresetManager()
        for (const mount of mounted.splice(0)) await mount()
        return owner
      },
      sceneControls: () => {
        setActivePinia(pinia)
        const props = { viewportPending: false, viewportState: { automatic: true, revision: 0, rect: { x: 0, y: 0, width: 500, height: 422 }, monitorSize: { width: 1920, height: 1080 } } }
        const setup = vue.proxyRefs(evaluate(sceneSfc.script, load).default.setup(props, { expose: () => {} }))
        const render = evaluate(sceneSfc.template, load).render
        return () => descendants(render({ $t: (key: string) => key }, [], props, setup))
      },
      presentation: () => {
        const render = evaluate(mainSfc.template, load).render
        return descendants(render({ $t: (key: string) => key }, [], {}, { catStore: cat, rendererLoading: false }))
      },
      initialize: async () => {
        for (const store of stores) {
          await store.$tauri.start()
          await store.init?.()
          await settle()
        }
      },
      dispose: () => {
        unmounted.forEach(stop => stop())
        stores.forEach(store => store.$dispose())
        handlers.delete(label)
      },
    }
  }
  return {
    backend,
    window,
    hold: (label: string) => {
      heldOwner = label
    },
    release: async () => {
      heldOwner = undefined
      heldPatches.splice(0).forEach(deliver => deliver())
      await settle()
    },
  }
}

async function seededHarness() {
  const h = harness()
  const seed = h.window('fixture')
  for (const store of seed.stores) {
    await store.init?.()
    h.backend.set(store.$id, clone(store.$state))
  }
  seed.dispose()
  return h
}

it('preserves scene UI edits through the preset owner, real two-window plugins, and desktop template', async () => {
  const h = await seededHarness()
  const main = h.window('main')
  const preference = h.window('preference')
  try {
    await main.initialize()
    await preference.initialize()
    const owner = await preference.startOwner()
    assert.equal(owner.ready.value, true)
    const controls = preference.sceneControls()
    const opacity = controls().find(node => node.props?.['display-mode'] === 'unit')!
    assert.ok(opacity)
    owner.markUserEdit()
    opacity.props!['onUpdate:value'](37.9)
    const switches = controls().filter(node => node.type === 'Switch')
    owner.markUserEdit()
    switches[0].props!['onUpdate:checked'](true)
    owner.markUserEdit()
    switches[1].props!['onUpdate:checked'](true)
    await settle()
    assert.equal(main.cat.window.opacity, 37.9)
    assert.equal(main.cat.model.mirror, true)
    assert.equal(main.cat.activePet3dPreset.showDisplayArea, true)
    const desktop = main.presentation()
    assert.equal(desktop.find(node => node.props?.style?.opacity !== undefined)?.props?.style.opacity, 0.379)
    assert.match(desktop.find(node => node.props?.style?.opacity !== undefined)!.props!.class, /-scale-x-100/)
    assert.match(desktop.find(node => node.props?.['data-testid'] === 'viewport-hologram')!.props!.class, /viewport-hologram-visible/)
    assert.equal(await owner.retry(), true)
    const active = preference.cat.presetCollection!.entries.find(entry => entry.id === preference.cat.presetCollection!.activeId)!
    assert.equal(active.snapshot.opacity, 37.9)
    assert.equal(active.snapshot.mirror, true)
    assert.equal(active.snapshot.preset.showDisplayArea, true)
    Object.assign(preference.cat.model, { maxFPS: 47, renderScalePercent: 75, antialiasEnabled: false })
    await settle()
    assert.equal(main.cat.model.maxFPS, 47)
    assert.equal(main.cat.model.renderScalePercent, 75)
    assert.equal(main.cat.model.antialiasEnabled, false)
    const broadcast = captureBroadcastScene(preference.cat)
    assert.equal(broadcast.opacity, 37.9)
    assert.equal(broadcast.mirror, true)
    assert.equal(broadcast.preset.showDisplayArea, false, 'the desktop helper never leaks into OBS')
    assert.equal(broadcast.performance.maxFPS, 47)
    assert.equal(broadcast.performance.renderScalePercent, 75)
    assert.equal(broadcast.performance.antialiasEnabled, false)
    assert.equal(await preference.flushOwner(), true, 'the same preference owner protects quit and update saves')
  } finally {
    main.dispose()
    preference.dispose()
  }
})

it('keeps runtime-only main changes local until the preference owner accepts the matching acknowledgement', async () => {
  const h = await seededHarness()
  const main = h.window('main')
  const preference = h.window('preference')
  try {
    await main.initialize()
    await preference.initialize()
    preference.cat.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
    await settle()
    const owner = await preference.startOwner()
    assert.equal(owner.ready.value, true)
    await settle()
    main.cat.activePet3dPreset.mouseEnabled = false
    await settle()
    assert.equal(preference.cat.activePet3dPreset.mouseEnabled, true)
    // The existing matching MOUSE_SETTING_RESPONSE handler performs this narrow
    // owner write; the desktop snapshot itself must never be its authority.
    preference.cat.activePet3dPreset.mouseEnabled = false
    await settle()
    assert.equal(preference.cat.activePet3dPreset.mouseEnabled, false)
    assert.deepEqual(clone(preference.cat.presetCollection), h.backend.get('cat')!.presetCollection)
    assert.equal(await owner.retry(), true)
  } finally {
    main.dispose()
    preference.dispose()
  }
})

it('keeps scene UI edits when an earlier peer patch arrives after the edit', async () => {
  const h = await seededHarness()
  const main = h.window('main')
  const preference = h.window('preference')
  try {
    await main.initialize()
    await preference.initialize()
    const owner = await preference.startOwner()
    await settle()
    h.hold('main')
    main.cat.activePet3dPreset.mouseEnabled = false
    await settle()
    owner.markUserEdit()
    preference.cat.window.opacity = 37.9
    owner.markUserEdit()
    preference.cat.model.mirror = true
    owner.markUserEdit()
    preference.cat.activePet3dPreset.showDisplayArea = true
    await settle()
    await h.release()
    assert.equal(preference.cat.window.opacity, 37.9)
    assert.equal(preference.cat.model.mirror, true)
    assert.equal(preference.cat.activePet3dPreset.showDisplayArea, true)
  } finally {
    await h.release()
    main.dispose()
    preference.dispose()
  }
})
