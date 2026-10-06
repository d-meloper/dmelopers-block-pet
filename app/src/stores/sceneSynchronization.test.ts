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
import type { useBlockStore } from '@/stores/block'

import { serializeSettingsState } from '@/config/persistedNames'
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
      '@/features/presets/thumbnail': { createPresetThumbnailBatch: () => ({ render: async () => 'test-thumbnail', dispose: () => {} }) },
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
    const stores: SettingsStore[] = ['app', 'block', 'general', 'shortcut'].map((id) => {
      const definitions = load(`@/stores/${id}`)
      const definition = Object.keys(definitions).find(key => /^use.*Store$/.test(key))!
      return definitions[definition](pinia)
    })
    const block = stores.find(store => store.$id === 'cat')! as unknown as ReturnType<typeof useBlockStore>
    return {
      stores,
      block,
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
        return descendants(render({ $t: (key: string) => key }, [], {}, { blockStore: block, rendererLoading: false }))
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
    h.backend.set(store.$id, clone(serializeSettingsState(store.$id, store.$state)))
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
    assert.equal(await owner.create('Saved scene'), true)
    const storedSnapshot = clone(preference.block.presetCollection!.entries[0].snapshot)
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
    assert.equal(main.block.window.opacity, 37.9)
    assert.equal(main.block.model.mirror, true)
    assert.equal(main.block.activePet3dPreset.showDisplayArea, true)
    const desktop = main.presentation()
    assert.equal(desktop.find(node => node.props?.style?.opacity !== undefined)?.props?.style.opacity, 0.379)
    assert.match(desktop.find(node => node.props?.style?.opacity !== undefined)!.props!.class, /-scale-x-100/)
    assert.match(desktop.find(node => String(node.props?.class ?? '').split(/\s+/).includes('viewport-hologram'))!.props!.class, /viewport-hologram-visible/)
    assert.equal(await owner.retry(), true)
    assert.equal(preference.block.presetCollection!.activeId, null)
    assert.deepEqual(clone(preference.block.presetCollection!.entries[0].snapshot), storedSnapshot)
    assert.equal((h.backend.get('cat')!.customization3d as ReturnType<typeof useBlockStore>['customization3d']).preset.showDisplayArea, true)
    Object.assign(preference.block.model, { maxFPS: 47, renderScalePercent: 75, antialiasEnabled: false })
    await settle()
    assert.equal(main.block.model.maxFPS, 47)
    assert.equal(main.block.model.renderScalePercent, 75)
    assert.equal(main.block.model.antialiasEnabled, false)
    const broadcast = captureBroadcastScene(preference.block)
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
    preference.block.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
    await settle()
    const owner = await preference.startOwner()
    assert.equal(owner.ready.value, true)
    await settle()
    main.block.activePet3dPreset.mouseEnabled = false
    await settle()
    assert.equal(preference.block.activePet3dPreset.mouseEnabled, true)
    // The existing matching MOUSE_SETTING_RESPONSE handler performs this narrow
    // owner write; the desktop snapshot itself must never be its authority.
    preference.block.activePet3dPreset.mouseEnabled = false
    await settle()
    assert.equal(preference.block.activePet3dPreset.mouseEnabled, false)
    assert.deepEqual(clone(preference.block.presetCollection), h.backend.get('cat')!.presetCollection)
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
    main.block.activePet3dPreset.mouseEnabled = false
    await settle()
    owner.markUserEdit()
    preference.block.window.opacity = 37.9
    owner.markUserEdit()
    preference.block.model.mirror = true
    owner.markUserEdit()
    preference.block.activePet3dPreset.showDisplayArea = true
    await settle()
    await h.release()
    assert.equal(preference.block.window.opacity, 37.9)
    assert.equal(preference.block.model.mirror, true)
    assert.equal(preference.block.activePet3dPreset.showDisplayArea, true)
  } finally {
    await h.release()
    main.dispose()
    preference.dispose()
  }
})
