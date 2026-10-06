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
import { serializeSettingsState } from '@/config/persistedNames'
import { reconcileAppWindowState } from '@/stores/app'

type State = Record<string, any>
interface SettingsStore {
  $id: string
  $state: State
  $tauri: { start: () => Promise<void> }
  $dispose: () => void
  init?: () => void | Promise<void>
  reset?: () => void
  resetWindowState?: () => void
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
    let syncFrozen = false
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
    const { createSettingsStorePlugin } = load('@/plugins/settingsStore') as typeof import('@/plugins/settingsStore')
    pinia.use(createSettingsStorePlugin({
      isSavingAllowed: () => true,
      beforeBackendSync: state => syncFrozen ? undefined : state,
    }))
    createSSRApp({ render: () => null }).use(pinia)
    const stores: SettingsStore[] = ['app', 'block', 'general', 'shortcut'].map((id) => {
      const definitions = load(`@/stores/${id}`)
      const definition = Object.keys(definitions).find(key => /^use.*Store$/.test(key))!
      return definitions[definition](pinia)
    })
    return {
      stores,
      freeze: (frozen: boolean) => {
        syncFrozen = frozen
      },
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
    h.backend.set(store.$id, clone(serializeSettingsState(store.$id, store.$state)))
  }
  seed.dispose()
  return h
}

describe('general defaults and real two-window Pinia persistence', () => {
  it('restores, synchronizes and saves legacy shortcut keys across real plugin instances', async () => {
    const h = await seededHarness()
    const persisted = h.backend.get('shortcut')!
    persisted.visibleCat = 'Control+KeyB'
    persisted.retained = { empty: '', explicitNull: null }
    const main = h.window('main')
    const preference = h.window('preference')
    const shortcuts = (window: typeof main) => window.stores.find(store => store.$id === 'shortcut')!.$state
    try {
      await main.initialize()
      await preference.initialize()
      assert.equal(shortcuts(main).visibleBlock, 'Control+KeyB')
      assert.equal(shortcuts(preference).visibleBlock, 'Control+KeyB')
      assert.equal('visibleCat' in shortcuts(preference), false)
      preference.freeze(true)
      shortcuts(preference).visibleBlock = 'F9'
      await settle()
      assert.equal(h.backend.get('shortcut')!.visibleCat, 'Control+KeyB')
      assert.equal(shortcuts(main).visibleBlock, 'Control+KeyB')
      preference.freeze(false)
      shortcuts(preference).visibleBlock = 'F10'
      await settle()
      assert.equal(shortcuts(main).visibleBlock, 'F10')
      await preference.save()
      await main.save()
      assert.equal(h.backend.get('shortcut')!.visibleCat, 'F10')
      assert.equal('visibleBlock' in h.backend.get('shortcut')!, false)
      assert.deepEqual(h.backend.get('shortcut')!.retained, { empty: '', explicitNull: null })
      const restarted = h.window('restart')
      try {
        await restarted.initialize()
        assert.equal(shortcuts(restarted).visibleBlock, 'F10')
        assert.equal('visibleCat' in shortcuts(restarted), false)
      } finally {
        restarted.dispose()
      }
    } finally {
      main.dispose()
      preference.dispose()
    }
  })

  it('propagates a complete window-state reset to both windows and their save barriers', async () => {
    const h = await seededHarness()
    const main = h.window('main')
    const preference = h.window('preference')
    try {
      await main.initialize()
      await preference.initialize()
      const mainApp = main.stores.find(store => store.$id === 'app')!
      const ownerApp = preference.stores.find(store => store.$id === 'app')!
      ownerApp.$state.windowState.main = { x: 1, y: 2, width: 500, height: 422 }
      await settle()
      assert.ok(mainApp.$state.windowState.main)
      ownerApp.resetWindowState!()
      await settle()
      assert.deepEqual(clone(mainApp.$state.windowState), {})
      assert.deepEqual(clone(h.backend.get('app')!.windowState), {})
      await main.save()
      await preference.save()
    } finally {
      main.dispose()
      preference.dispose()
    }
  })

  it('retains window geometry on partial incoming state and preserves unrelated fields', () => {
    const local = { windowState: { main: { x: 1 }, preference: { x: 2 } }, retained: { key: true } }
    reconcileAppWindowState(local, { name: 'App' })
    assert.deepEqual(Object.keys(local.windowState), ['main', 'preference'])
    reconcileAppWindowState(local, { windowState: { preference: { x: 3 } } })
    assert.deepEqual(Object.keys(local.windowState), ['preference'])
    assert.deepEqual(local.retained, { key: true })
  })
  it('freezes pet and general backend writes while retaining the pet frontend migration hook', async () => {
    const h = await seededHarness()
    const persisted = h.backend.get('cat')!
    delete persisted.model.pixelFilterEnabled
    persisted.model.facePixelFilterEnabled = true
    const main = h.window('main')
    const preference = h.window('preference')
    try {
      const local = preference.stores.find(store => store.$id === 'cat')!
      await local.$tauri.start()
      assert.equal(local.$state.model.pixelFilterEnabled, true)
      assert.equal('facePixelFilterEnabled' in local.$state.model, false)
      await main.initialize()
      await preference.initialize()
      const beforePet = clone(h.backend.get('cat'))
      const beforeGeneral = clone(h.backend.get('general'))
      preference.freeze(true)
      local.$state.window.opacity = 37.9
      preference.general.app.taskbarVisible = true
      await settle()
      assert.deepEqual(h.backend.get('cat'), beforePet, 'per-store hooks must not bypass the common save barrier')
      assert.deepEqual(h.backend.get('general'), beforeGeneral)
      preference.freeze(false)
      local.$state.window.opacity = 46.9
      preference.general.app.taskbarVisible = false
      await settle()
      assert.equal(h.backend.get('cat')!.window.opacity, 46.9)
      assert.equal(main.stores.find(store => store.$id === 'cat')!.$state.window.opacity, 46.9)
      assert.equal(h.backend.get('general')!.app.taskbarVisible, false)
    } finally {
      main.dispose()
      preference.dispose()
    }
  })

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

  it('persists both modal choices through real two-window sync, restart and General reset', async () => {
    const h = await seededHarness()
    const main = h.window('main')
    const preference = h.window('preference')
    try {
      await main.initialize()
      await preference.initialize()
      assert.equal(preference.general.app.broadcastRestorePromptDismissed, false)
      assert.equal(preference.general.app.applyPresetSkin, true)
      preference.general.app.broadcastRestorePromptDismissed = true
      preference.general.app.applyPresetSkin = false
      await settle()
      await preference.save()
      assert.equal(main.general.app.broadcastRestorePromptDismissed, true)
      assert.equal(main.general.app.applyPresetSkin, false)
      preference.dispose()
      const restarted = h.window('preference')
      try {
        await restarted.initialize()
        assert.equal(restarted.general.app.broadcastRestorePromptDismissed, true)
        assert.equal(restarted.general.app.applyPresetSkin, false)
        restarted.stores.find(store => store.$id === 'general')!.reset!()
        await settle()
        await restarted.save()
        assert.equal(main.general.app.broadcastRestorePromptDismissed, false)
        assert.equal(main.general.app.applyPresetSkin, true)
        assert.equal(h.backend.get('general')!.app.broadcastRestorePromptDismissed, false)
        assert.equal(h.backend.get('general')!.app.applyPresetSkin, true)
      } finally {
        restarted.dispose()
      }
    } finally {
      main.dispose()
      preference.dispose()
    }
  })

  it('preserves a retired tray OFF value as inert data across two-window initialization, reset and save', async () => {
    const h = await seededHarness()
    const persisted = h.backend.get('general')!
    persisted.app.trayVisible = false
    persisted.app.retained = { zero: 0, empty: '', explicitNull: null }
    persisted.app.taskbarVisible = true
    const main = h.window('main')
    const preference = h.window('preference')
    try {
      await main.initialize()
      await preference.initialize()
      assert.equal(main.general.app.taskbarVisible, true)
      assert.equal(preference.general.app.taskbarVisible, true)
      await main.save()
      await preference.save()
      preference.stores.find(store => store.$id === 'general')!.reset!()
      await settle()
      await preference.save()
      assert.equal(main.general.app.taskbarVisible, DEFAULT_GENERAL_SETTINGS.app.taskbarVisible)
      assert.equal(h.backend.get('general')!.app.trayVisible, false)
      assert.deepEqual(h.backend.get('general')!.app.retained, { zero: 0, empty: '', explicitNull: null })
    } finally {
      main.dispose()
      preference.dispose()
    }
  })

  it('keeps native startup defaults identical to the shared authored data', () => {
    assert.deepEqual(nativeDefaults, DEFAULT_GENERAL_SETTINGS)
    assert.deepEqual(Object.keys(nativeDefaults).sort(), ['app', 'appearance', 'broadcast'])
    assert.equal('trayVisible' in nativeDefaults.app, false)
  })

  it('reproduces missing defaults in all four-store barriers and accepts their native materialization', async () => {
    for (const missing of [
      ['broadcast'],
      ['broadcast', 'showOnDesktop'], // Exact installed v1.0.2 failure in the retained VMware state.
      ['app', 'taskbarVisible'],
      ['app', 'autoUpdateCheck'],
      ['app', 'updateReminderHiddenUntil'],
      ['app', 'broadcastRestorePromptDismissed'],
      ['app', 'applyPresetSkin'],
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
