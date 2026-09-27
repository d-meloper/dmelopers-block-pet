/* eslint-disable test/no-import-node-test */
import { isEqual } from 'es-toolkit'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia } from 'pinia'
import ts from 'typescript'
import { createSSRApp, nextTick } from 'vue'

import type { SettingsPersistenceSteps } from '@/utils/settingsPersistence'

import { DEFAULT_GENERAL_SETTINGS } from '@/config/defaultSettings'

type State = Record<string, any>
interface SettingsStore {
  $id: string
  $state: State
  $tauri: { start: () => Promise<void> }
  $dispose: () => void
  init?: () => void | Promise<void>
}

const root = fileURLToPath(new URL('../../', import.meta.url))
const nodeRequire = createRequire(import.meta.url)
const pluginPath = nodeRequire.resolve('@tauri-store/pinia/dist/index.js')
const sharedPath = nodeRequire.resolve('@tauri-store/shared/dist/index.js', { paths: [path.dirname(pluginPath)] })
const transpiled = new Map<string, string>()
const nativeSourceUrl = new URL('../../src-tauri/src/settings_defaults.rs', import.meta.url)
const nativeSource = readFileSync(nativeSourceUrl, 'utf8')
const defaultsPath = nativeSource.match(/include_str!\("([^"]+)"\)/)?.[1]
assert.ok(defaultsPath, 'the native reader must embed the authored defaults file')
const nativeDefaults = JSON.parse(readFileSync(new URL(defaultsPath, nativeSourceUrl), 'utf8')).general as State
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

async function settle() {
  for (let index = 0; index < 20; index++) await nextTick()
}

/** Native storage/event boundaries only; all four stores and both plugin packages are real. */
function harness() {
  const backend = new Map<string, State>()
  const handlers = new Map<string, Set<(event: { payload: { id: string, state: State } }) => void>>()
  const heldPatches: Array<() => void> = []
  let heldOwner: string | undefined
  let saves = 0
  function window(label: string) {
    const modules = new Map<string, { exports: any }>()
    const invoke = async (command: string, args: { id: string, state: State }) => {
      if (command === 'plugin:pinia|load' || command === 'plugin:pinia|get_store_state') {
        return clone(backend.get(args.id) ?? {})
      }
      if (command === 'plugin:pinia|save_all_now') saves++
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
      '@tauri-apps/api/core': { invoke },
      '@tauri-apps/api/app': { getVersion: async () => '1.0.2' },
      '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({
        label,
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
    }
    function load(name: string, from = root): any {
      if (name in overrides) return overrides[name]
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
    const plugin = load('@tauri-store/pinia') as typeof import('@tauri-store/pinia')
    const pinia = createPinia()
    pinia.use(plugin.createPlugin({ saveOnChange: true }))
    createSSRApp({ render: () => null }).use(pinia)
    const stores: SettingsStore[] = ['app', 'cat', 'general', 'shortcut'].map((id) => {
      const definitions = load(`@/stores/${id}`)
      const definition = Object.keys(definitions).find(key => /^use.*Store$/.test(key))!
      return definitions[definition](pinia)
    })
    return {
      stores,
      general: stores.find(store => store.$id === 'general')!.$state,
      initialize: async () => {
        for (const store of stores) {
          await store.$tauri.start()
          await store.init?.()
          await settle()
        }
      },
      save: async () => {
        let now = 0
        const steps: SettingsPersistenceSteps = {
          flushFrontend: nextTick,
          snapshots: () => stores.map(store => ({ id: store.$id, state: store.$state })),
          readBackend: plugin.getStoreState,
          saveNow: plugin.saveAllNow,
          followFrontendChanges: true,
          now: () => now,
          wait: async () => {
            now += 25
          },
          timeoutMs: 50,
        }
        await load('@/utils/settingsPersistence').saveSynchronizedSettings(steps)
      },
      dispose: () => {
        stores.forEach(store => store.$dispose())
        handlers.delete(label)
      },
    }
  }
  return {
    backend,
    window,
    saves: () => saves,
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

describe('general defaults and real two-window Pinia persistence', () => {
  it('retains a reminder expiry through both windows and a restarted store', async () => {
    const h = await seededHarness()
    const main = h.window('main')
    const preference = h.window('preference')
    try {
      await main.initialize()
      await preference.initialize()
      assert.equal(preference.general.app.updateReminderHiddenUntil, 0)
      const deadline = 1_800_604_800_000
      preference.general.app.updateReminderHiddenUntil = deadline
      await settle()
      await preference.save()
      assert.equal(main.general.app.updateReminderHiddenUntil, deadline)
      assert.equal(h.backend.get('general')!.app.updateReminderHiddenUntil, deadline)
      preference.dispose()
      const restarted = h.window('preference')
      try {
        await restarted.initialize()
        assert.equal(restarted.general.app.updateReminderHiddenUntil, deadline)
      } finally {
        restarted.dispose()
      }
    } finally {
      main.dispose()
      preference.dispose()
    }
  })

  it('keeps native startup defaults identical to the shared authored data', () => {
    assert.deepEqual(nativeDefaults, DEFAULT_GENERAL_SETTINGS)
    assert.deepEqual(Object.keys(nativeDefaults).sort(), ['app', 'appearance', 'broadcast'])
  })

  it('reproduces missing defaults in all four-store barriers and accepts their native materialization', async () => {
    for (const missing of [
      ['broadcast'],
      ['broadcast', 'showOnDesktop'], // Exact installed v1.0.2 failure in the retained VMware state.
      ['app', 'taskbarVisible'],
      ['app', 'autoUpdateCheck'],
      ['app', 'updateReminderHiddenUntil'],
      ['appearance', 'language'],
      ['appearance', 'isDark'],
    ]) {
      for (const complete of [false, true]) {
        const h = await seededHarness()
        const state = h.backend.get('general')!
        state.retained = { zero: 0, empty: '', explicitNull: null }
        state.app.autostart = true
        state.broadcast.extra = 0
        if (missing.length === 1) delete state[missing[0]]
        else delete state[missing[0]][missing[1]]
        if (complete) {
          // The real native initializer and its memory/file boundaries are tested
          // in general_defaults_tests.rs. Feed its declared missing-field result here.
          if (missing.length === 1) state[missing[0]] = clone(nativeDefaults[missing[0]])
          else state[missing[0]][missing[1]] = clone(nativeDefaults[missing[0]][missing[1]])
        }
        const main = h.window('main')
        const preference = h.window('preference')
        try {
          await main.initialize()
          await preference.initialize()
          if (complete) {
            await main.save()
            await preference.save()
            assert.equal(h.saves(), 2)
            assert.ok(isEqual(main.general, preference.general))
            assert.equal(main.general.app.autostart, true)
            assert.deepEqual(main.general.retained, { zero: 0, empty: '', explicitNull: null })
          } else {
            await assert.rejects(main.save(), /synchronization was not acknowledged/i)
            await assert.rejects(preference.save(), /synchronization was not acknowledged/i)
            assert.equal(h.saves(), 0, 'missing persisted fields cannot count as an acknowledged save')
          }
        } finally {
          main.dispose()
          preference.dispose()
        }
      }
    }
  })

  it('still rejects an unsent peer edit and preserves it after the real plugin receives acknowledgement', async () => {
    const h = await seededHarness()
    const main = h.window('main')
    const preference = h.window('preference')
    try {
      await main.initialize()
      await preference.initialize()
      h.hold('main')
      main.general.app.taskbarVisible = true
      await settle()
      await assert.rejects(main.save(), /synchronization was not acknowledged/i)
      assert.equal(h.saves(), 0)
      assert.equal(h.backend.get('general')!.app.taskbarVisible, false)
      await h.release()
      await main.save()
      await preference.save()
      assert.equal(h.saves(), 2)
      assert.equal(main.general.app.taskbarVisible, true)
      assert.equal(preference.general.app.taskbarVisible, true)
      assert.equal(h.backend.get('general')!.app.taskbarVisible, true)
    } finally {
      main.dispose()
      preference.dispose()
    }
  })
})
