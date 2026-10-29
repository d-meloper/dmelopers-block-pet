/* eslint-disable test/no-import-node-test */
import { isEqual } from 'es-toolkit'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createPinia } from 'pinia'
import ts from 'typescript'
import { createSSRApp, nextTick } from 'vue'

import type { PreferenceUpdates } from '@/features/updates/preferenceUpdates'
import type { Language } from '@/locales/languageBranch'
import type { UpdateReminderSnooze } from '@/stores/general'
import type { SettingsPersistenceSteps } from '@/utils/settingsPersistence'

import { DEFAULT_GENERAL_SETTINGS } from '@/config/defaultSettings'
import { serializeSettingsState } from '@/config/persistedNames'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { isForegroundHidingSettings } from '@/features/foregroundHiding/settings'
import { isDeviceInputState } from '@/features/input/types'
import { reconcileAppWindowState } from '@/stores/app'
import { requestMainViewportReset } from '@/utils/mainViewportReset'

type State = Record<string, any>
interface SettingsStore {
  $id: string
  $state: State
  $tauri: { start: () => Promise<void> }
  $dispose: () => void
  init?: () => void | Promise<void>
  reset?: () => void
  resetWindowState?: () => void
  resolvedLanguage?: Language
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
// Exact shared General/reminder readers from the retained v1.1.1/v1.1.2
// producer SHAs and their authored defaults, captured before this correction.
const legacyReminder = JSON.parse(readFileSync(new URL('./fixtures/updateReminderLegacy.json', import.meta.url), 'utf8')) as {
  generalSource: string
  reminderSource: string
  generalDefaults: State
}

async function settle() {
  for (let index = 0; index < 20; index++) await nextTick()
}

/** Native storage/event boundaries only; all four stores and both plugin packages are real. */
function harness(systemLanguage: Language = 'ko-KR') {
  const backend = new Map<string, State>()
  const handlers = new Map<string, Set<(event: { payload: { id: string, state: State } }) => void>>()
  const heldPatches: Array<() => void> = []
  let heldOwner: string | undefined
  let saves = 0
  function window(label: string, legacyReader = false) {
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
      '@/services/systemLanguage': { getSystemLanguage: () => systemLanguage },
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
        const defaults = JSON.parse(readFileSync(file, 'utf8'))
        if (legacyReader && file === path.join(root, 'src/config/defaultSettings.json')) defaults.general = clone(legacyReminder.generalDefaults)
        module.exports = { default: defaults }
        return module.exports
      }
      const cacheKey = `${file}:${legacyReader}`
      let source = transpiled.get(cacheKey)
      if (!source) {
        let raw = readFileSync(file, 'utf8')
        if (legacyReader && file === path.join(root, 'src/stores/general.ts')) raw = legacyReminder.generalSource
        if (legacyReader && file === path.join(root, 'src/features/updates/preferenceUpdates.ts')) raw = legacyReminder.reminderSource
        source = ts.transpileModule(raw, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, allowJs: true },
        }).outputText
        transpiled.set(cacheKey, source)
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
      load,
      overrides,
      reminder: (version: string, currentVersion = '1.1.2', time = 1_800_000_000_000): PreferenceUpdates => {
        const general = stores.find(store => store.$id === 'general')!.$state
        return load('@/features/updates/preferenceUpdates').createPreferenceUpdates({
          channel: async () => 'github',
          checkApp: async () => ({ available: true, version, currentVersion, bytes: 123 }),
          install: async () => {},
          cancel: async () => {},
          hiddenUntil: () => general.app.updateReminderHiddenUntil,
          hideUntil: (deadline: number) => {
            general.app.updateReminderHiddenUntil = deadline
          },
          reminderSnooze: () => general.app.updateReminderSnooze,
          snoozeReminder: (value: UpdateReminderSnooze) => {
            general.app.updateReminderSnooze = value
          },
          now: () => time,
          report: () => assert.fail('unexpected reminder failure'),
        })
      },
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

async function seededHarness(systemLanguage: Language = 'ko-KR') {
  const h = harness(systemLanguage)
  const seed = h.window('fixture')
  for (const store of seed.stores) {
    await store.init?.()
    h.backend.set(store.$id, clone(serializeSettingsState(store.$id, store.$state)))
  }
  seed.dispose()
  return h
}

describe('general defaults and real two-window Pinia persistence', () => {
  for (const systemLanguage of ['ko-KR', 'en-US', 'ja-JP'] as const) {
    it(`retains raw language choices across both windows, save, restart and reset on ${systemLanguage}`, async () => {
      const h = await seededHarness(systemLanguage)
      const main = h.window('main')
      const preference = h.window('preference')
      const generalStore = (window: typeof main) => window.stores.find(store => store.$id === 'general')!
      try {
        await main.initialize()
        await preference.initialize()
        assert.equal(preference.general.appearance.language, 'system')
        assert.equal(generalStore(preference).resolvedLanguage, systemLanguage)
        for (const choice of ['ko-KR', 'en-US', 'ja-JP', 'system'] as const) {
          preference.general.appearance.language = choice
          await settle()
          await preference.save()
          await main.save()
          const resolved = choice === 'system' ? systemLanguage : choice
          assert.equal(main.general.appearance.language, choice)
          assert.equal(generalStore(main).resolvedLanguage, resolved)
          assert.equal(generalStore(preference).resolvedLanguage, resolved)
          assert.equal(h.backend.get('general')!.appearance.language, choice)
          assert.equal('resolvedLanguage' in h.backend.get('general')!, false)
          const restarted = h.window('restart')
          try {
            await restarted.initialize()
            assert.equal(restarted.general.appearance.language, choice)
            assert.equal(generalStore(restarted).resolvedLanguage, resolved)
            assert.equal('resolvedLanguage' in restarted.general, false)
          } finally {
            restarted.dispose()
          }
        }
        preference.general.appearance.language = 'en-US'
        await settle()
        generalStore(preference).reset!()
        await generalStore(preference).init!()
        await settle()
        await preference.save()
        assert.equal(main.general.appearance.language, 'system')
        assert.equal(generalStore(main).resolvedLanguage, systemLanguage)
      } finally {
        main.dispose()
        preference.dispose()
      }
    })
  }

  it('preserves previously saved explicit languages and repairs invalid language choices to system', async () => {
    for (const [stored, expected] of [
      ['ko-KR', 'ko-KR'],
      ['en-US', 'en-US'],
      ['system', 'system'],
      ['ja-JP', 'ja-JP'],
      ['fr-FR', 'system'],
      [null, 'system'],
    ] as const) {
      const h = await seededHarness()
      h.backend.get('general')!.appearance.language = stored
      const preference = h.window('preference')
      try {
        await preference.initialize()
        await preference.save()
        assert.equal(preference.general.appearance.language, expected)
        assert.equal(h.backend.get('general')!.appearance.language, expected)
      } finally {
        preference.dispose()
      }
    }
  })

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

  it('persists the offered-version pair through two windows, save, upgrade/restart and reset', async () => {
    const h = await seededHarness()
    const main = h.window('main')
    const preference = h.window('preference')
    const deadline = 1_800_604_800_000
    try {
      await main.initialize()
      await preference.initialize()
      preference.general.app.updateReminderHiddenUntil = deadline + 100
      const reminder = preference.reminder('1.1.3')
      await reminder.setVisible(true)
      reminder.snooze()
      await settle()
      await preference.save()
      await main.save()
      const pair = { version: '1.1.3', hiddenUntil: deadline }
      assert.deepEqual(clone(main.general.app.updateReminderSnooze), pair)
      assert.deepEqual(h.backend.get('general')!.app.updateReminderSnooze, pair)
      assert.equal(h.backend.get('general')!.app.updateReminderHiddenUntil, deadline + 100)
      preference.dispose()
      const restarted = h.window('preference')
      try {
        await restarted.initialize()
        const same = restarted.reminder('1.1.3', '1.1.2', deadline - 1)
        await same.setVisible(true)
        assert.equal(same.reminderVersion.value, undefined)
        const boundary = restarted.reminder('1.1.3', '1.1.2', deadline)
        await boundary.setVisible(true)
        assert.equal(boundary.reminderVersion.value, '1.1.3')
        const upgraded = restarted.reminder('1.1.4', '1.1.3', deadline - 1)
        await upgraded.setVisible(true)
        assert.equal(upgraded.reminderVersion.value, '1.1.4')
        assert.deepEqual(clone(restarted.general.app.updateReminderSnooze), pair)
        restarted.stores.find(store => store.$id === 'general')!.reset!()
        await settle()
        await restarted.save()
        assert.deepEqual(h.backend.get('general')!.app.updateReminderSnooze, { version: '', hiddenUntil: 0 })
        assert.deepEqual(clone(main.general.app.updateReminderSnooze), { version: '', hiddenUntil: 0 })
        const afterReset = restarted.reminder('1.1.3')
        await afterReset.setVisible(true)
        assert.equal(afterReset.reminderVersion.value, '1.1.3')
      } finally {
        restarted.dispose()
      }
    } finally {
      main.dispose()
      preference.dispose()
    }
  })

  it('new readers preserve legacy deadlines without guessing their target; old readers preserve the new pair', async () => {
    const h = await seededHarness()
    const deadline = 1_800_604_800_000
    const persisted = h.backend.get('general')!
    delete persisted.app.updateReminderSnooze
    persisted.app.updateReminderHiddenUntil = deadline
    // The unchanged native initializer recursively adds only missing defaults.
    persisted.app.updateReminderSnooze = clone(nativeDefaults.app.updateReminderSnooze)
    const current = h.window('preference')
    try {
      await current.initialize()
      const offered = current.reminder('1.1.3')
      await offered.setVisible(true)
      assert.equal(offered.reminderVersion.value, '1.1.3')
      assert.equal(current.general.app.updateReminderHiddenUntil, deadline)
      offered.snooze()
      await settle()
      await current.save()
      current.dispose()
      const old = h.window('older-reader', true)
      const pair = { version: '1.1.3', hiddenUntil: deadline }
      try {
        await old.initialize()
        assert.deepEqual(clone(old.general.app.updateReminderSnooze), pair)
        const hidden = old.reminder('1.1.4')
        await hidden.setVisible(true)
        assert.equal(hidden.reminderVersion.value, undefined, 'old reader retains its global legacy deadline')
        old.general.app.taskbarVisible = true
        await settle()
        await old.save()
        old.stores.find(store => store.$id === 'general')!.reset!()
        await settle()
        await old.save()
        assert.deepEqual(h.backend.get('general')!.app.updateReminderSnooze, pair, 'old reset preserves unknown new data')
        const visible = old.reminder('1.1.3')
        await visible.setVisible(true)
        assert.equal(visible.reminderVersion.value, '1.1.3', 'old reader cannot apply the new-only snooze')
        visible.snooze()
        await settle()
        await old.save()
        assert.deepEqual(h.backend.get('general')!.app.updateReminderSnooze, pair)
      } finally {
        old.dispose()
      }
      const upgraded = h.window('re-upgrade')
      try {
        await upgraded.initialize()
        const same = upgraded.reminder('1.1.3')
        await same.setVisible(true)
        assert.equal(same.reminderVersion.value, undefined)
        const different = upgraded.reminder('1.1.4', '1.1.3')
        await different.setVisible(true)
        assert.equal(different.reminderVersion.value, '1.1.4')
        await upgraded.save()
        assert.deepEqual(h.backend.get('general')!.app.updateReminderSnooze, pair)
      } finally {
        upgraded.dispose()
      }
    } finally {
      current.dispose()
    }
  })

  it('normalizes malformed incoming pairs before merge without borrowing a previous target or deadline', async () => {
    const h = await seededHarness()
    const current = h.window('preference')
    const old = h.window('legacy-writer', true)
    try {
      await current.initialize()
      await old.initialize()
      const initial = current.reminder('1.1.3')
      await initial.setVisible(true)
      initial.snooze()
      await settle()
      for (const malformed of [null, [], '1.1.3', { version: '1.1.4' }, { hiddenUntil: 1_800_604_800_000 }, { version: 13, hiddenUntil: 1_800_604_800_000 }, { version: ' ', hiddenUntil: 1_800_604_800_000 }, { version: '1.1.3', hiddenUntil: '1800604800000' }, { version: '1.1.3', hiddenUntil: -1 }]) {
        old.general.app.updateReminderSnooze = malformed
        await settle()
        assert.deepEqual(clone(current.general.app.updateReminderSnooze), { version: '', hiddenUntil: 0 })
        const offer = current.reminder('1.1.4')
        await offer.setVisible(true)
        assert.equal(offer.reminderVersion.value, '1.1.4')
        offer.snooze()
        await settle()
        await current.save()
        assert.deepEqual(h.backend.get('general')!.app.updateReminderSnooze, { version: '1.1.4', hiddenUntil: 1_800_604_800_000 })
      }
    } finally {
      current.dispose()
      old.dispose()
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
      ['app', 'updateReminderSnooze'],
      ['app', 'broadcastRestorePromptDismissed'],
      ['app', 'applyPresetSkin'],
      ['app', 'foregroundHiding'],
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

describe('foreground hiding through current and retained v1.1.2 general readers', () => {
  const configured = {
    enabled: true,
    applications: ['C:\\Program Files\\Browser\\chrome.exe'],
    sites: ['example.com', 'sub.example.org'],
    future: { empty: '', explicitNull: null, choice: false },
  }

  it('loads old stores using native missing-only defaults, then retains new choices through old load/edit/save/reset/reload', async () => {
    const h = await seededHarness()
    const persisted = h.backend.get('general')!
    delete persisted.app.foregroundHiding
    // Feed the existing native bootstrap's declared missing-only result. Its
    // actual JSON/disk behavior is covered by the parent's native defaults test.
    persisted.app.foregroundHiding = clone(nativeDefaults.app.foregroundHiding)
    const current = h.window('new-reader')
    try {
      await current.initialize()
      assert.deepEqual(clone(current.general.app.foregroundHiding), { enabled: false, applications: [] })
      current.general.app.foregroundHiding = clone(configured)
      await settle()
      await current.save()
    } finally {
      current.dispose()
    }
    const old = h.window('retained-v1.1.2', true)
    try {
      await old.initialize()
      assert.deepEqual(clone(old.general.app.foregroundHiding), configured)
      old.general.app.taskbarVisible = true
      await settle()
      await old.save()
      old.stores.find(store => store.$id === 'general')!.reset!()
      await settle()
      await old.save()
      assert.deepEqual(h.backend.get('general')!.app.foregroundHiding, configured, 'the old reader and its reset preserve unknown nested app fields')
    } finally {
      old.dispose()
    }
    const oldReload = h.window('old-reload', true)
    try {
      await oldReload.initialize()
      assert.deepEqual(clone(oldReload.general.app.foregroundHiding), configured)
      await oldReload.save()
    } finally {
      oldReload.dispose()
    }
    const upgraded = h.window('new-reload')
    const peer = h.window('main')
    try {
      await upgraded.initialize()
      await peer.initialize()
      assert.deepEqual(clone(upgraded.general.app.foregroundHiding), configured)
      upgraded.general.app.foregroundHiding.enabled = false
      upgraded.general.app.foregroundHiding.applications.push('C:\\Apps\\Another.exe')
      await settle()
      await upgraded.save()
      await peer.save()
      assert.equal(peer.general.app.foregroundHiding.enabled, false)
      assert.deepEqual(peer.general.app.foregroundHiding.applications, [...configured.applications, 'C:\\Apps\\Another.exe'])
      upgraded.stores.find(store => store.$id === 'general')!.reset!()
      await settle()
      await upgraded.save()
      assert.deepEqual(h.backend.get('general')!.app.foregroundHiding, { enabled: false, applications: [], sites: configured.sites, future: configured.future })
      const restarted = h.window('after-new-reset')
      try {
        await restarted.initialize()
        assert.deepEqual(clone(restarted.general.app.foregroundHiding), { enabled: false, applications: [], sites: configured.sites, future: configured.future })
        await restarted.save()
      } finally {
        restarted.dispose()
      }
    } finally {
      upgraded.dispose()
      peer.dispose()
    }
  })

  it('preserves malformed raw records at startup and incoming sync without borrowing defaults or previous rules', async () => {
    const malformed = [null, [], 'off', { enabled: true }, { ...configured, applications: ['relative.exe'] }, { ...configured, enabled: 'true' }]
    for (const raw of malformed) {
      const h = await seededHarness()
      h.backend.get('general')!.app.foregroundHiding = clone(raw)
      const current = h.window('new-reader')
      const old = h.window('old-writer', true)
      try {
        await current.initialize()
        assert.deepEqual(clone(current.general.app.foregroundHiding), raw)
        assert.equal(isForegroundHidingSettings(current.general.app.foregroundHiding), false)
        current.general.app.taskbarVisible = true
        await settle()
        await current.save()
        assert.deepEqual(h.backend.get('general')!.app.foregroundHiding, raw)
        await old.initialize()
        old.general.app.foregroundHiding = clone(configured)
        await settle()
        assert.equal(isForegroundHidingSettings(current.general.app.foregroundHiding), true)
        old.general.app.foregroundHiding = clone(raw)
        await settle()
        assert.deepEqual(clone(current.general.app.foregroundHiding), raw, 'a partial incoming object must replace the complete prior record')
        assert.equal(isForegroundHidingSettings(current.general.app.foregroundHiding), false)
        await old.save()
        await current.save()
        const restarted = h.window('malformed-reload')
        try {
          await restarted.initialize()
          assert.deepEqual(clone(restarted.general.app.foregroundHiding), raw)
          assert.equal(isForegroundHidingSettings(restarted.general.app.foregroundHiding), false)
          await restarted.save()
        } finally {
          restarted.dispose()
        }
      } finally {
        current.dispose()
        old.dispose()
      }
    }
  })

  it('keeps rule edits behind the real two-window acknowledgement barrier', async () => {
    const h = await seededHarness()
    const current = h.window('preference')
    const peer = h.window('main')
    try {
      await current.initialize()
      await peer.initialize()
      h.hold('preference')
      current.general.app.foregroundHiding = clone(configured)
      await settle()
      await assert.rejects(current.save(), /synchronization was not acknowledged/i)
      assert.deepEqual(clone(peer.general.app.foregroundHiding), { enabled: false, applications: [] })
      assert.equal(h.saves(), 0)
      await h.release()
      await current.save()
      await peer.save()
      assert.deepEqual(clone(peer.general.app.foregroundHiding), configured)
      assert.deepEqual(h.backend.get('general')!.app.foregroundHiding, configured)
    } finally {
      current.dispose()
      peer.dispose()
    }
  })
})

it('synchronizes legacy and explicit animation choices through the installed two-window plugin and acknowledged save barrier', async () => {
  for (const mode of [undefined, 'default', 'headbutt'] as const) {
    const h = await seededHarness()
    const backend = h.backend.get('cat')!
    backend.customization3d.schemaVersion = 13
    if (mode === undefined) delete backend.customization3d.preset.petAnimationMode
    else backend.customization3d.preset.petAnimationMode = mode
    const main = h.window('main')
    const preference = h.window('preference')
    const mainBlock = main.stores.find(store => store.$id === 'cat')!.$state
    const preferenceBlock = preference.stores.find(store => store.$id === 'cat')!.$state
    try {
      await preference.initialize()
      await main.initialize()
      assert.equal(preferenceBlock.customization3d.preset.petAnimationMode, mode ?? 'default')
      assert.equal(mainBlock.customization3d.preset.petAnimationMode, mode ?? 'default')
      const next = mode === 'headbutt' ? 'default' : 'headbutt'
      h.hold('preference')
      preferenceBlock.customization3d.preset.petAnimationMode = next
      await settle()
      await assert.rejects(preference.save(), /synchronization was not acknowledged/i)
      assert.equal(h.saves(), 0)
      assert.equal(mainBlock.customization3d.preset.petAnimationMode, mode ?? 'default')
      await h.release()
      assert.equal(mainBlock.customization3d.preset.petAnimationMode, next)
      await preference.save()
      await main.save()
      assert.equal(h.saves(), 2)
      assert.equal(h.backend.get('cat')!.customization3d.preset.petAnimationMode, next)
    } finally {
      main.dispose()
      preference.dispose()
    }
  }
})

// Exercise the full-reset entrypoint and actual main acknowledgement, rather
// than equating a store assignment or geometry completion with native input.
it('full reset restores every authored field through both real Pinia windows and native mouse acknowledgement', async () => {
  const defaults = JSON.parse(readFileSync(new URL('../config/defaultSettings.json', import.meta.url), 'utf8')) as State
  const changed = (value: any): any => {
    if (typeof value === 'boolean') return !value
    if (typeof value === 'number') return value + 7
    if (typeof value === 'string') return `changed:${value}`
    if (Array.isArray(value)) return ['changed']
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, changed(item)]))
  }
  const mainSource = readFileSync(new URL('../pages/main/index.vue', import.meta.url), 'utf8')
  const start = mainSource.indexOf('useTauriListen<MainViewportResetRequest>(')
  const handlerSource = mainSource.slice(start, mainSource.indexOf('async function handleMouseDown(', start))
  for (const resetPresets of [false, true]) {
    const h = await seededHarness()
    const main = h.window('main')
    const preference = h.window('preference')
    const block = preference.stores.find(store => store.$id === 'cat')!
    const mainBlock = main.stores.find(store => store.$id === 'cat')!
    const shortcut = preference.stores.find(store => store.$id === 'shortcut')!
    const app = preference.stores.find(store => store.$id === 'app')!
    const events = new Map<string, (event: { payload: any }) => void>()
    const native = { mouseEnabled: false, mouseGeneration: 0 }
    const gates: boolean[] = []
    let clearCalls = 0
    let centered = 0
    try {
      await main.initialize()
      await preference.initialize()
      Object.assign(block.$state.model, changed(defaults.model))
      Object.assign(block.$state.window, changed(defaults.window))
      Object.assign(block.$state.customization3d, changed(defaults.skinAppearance))
      Object.assign(block.$state.customization3d.preset, changed(defaults.preset), { viewportModeRevision: 40 })
      Object.assign(preference.general.app, changed(defaults.general.app), { foregroundHiding: { enabled: true, applications: ['C:\\Apps\\keep.exe'], future: 'kept' } })
      Object.assign(preference.general.broadcast, changed(defaults.general.broadcast))
      Object.assign(preference.general.appearance, changed(defaults.general.appearance), { isDark: true })
      shortcut.$state = changed(shortcut.$state)
      app.$state.windowState.main = { x: 99, y: 88 }
      block.$state.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,retained-library-is-separate'
      const { createPresetCollection, createDefaultPresetSnapshot } = preference.load('@/features/presets/model')
      const catalog = createPresetCollection()
      block.$state.presetCollection = catalog
      catalog.entries.push({ id: 'retained-catalog', name: 'Keep', favorite: false, snapshot: createDefaultPresetSnapshot() })
      catalog.activeId = 'retained-catalog'
      const beforeCatalog = clone(catalog)
      await settle()
      await preference.save()
      assert.equal(mainBlock.$state.customization3d.preset.mouseEnabled, false)
      // Load the actual session with only its native/renderer boundaries replaced.
      const deviceExports: State = {}
      runInNewContext(ts.transpileModule(readFileSync(new URL('../composables/useDevice.ts', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText, { exports: deviceExports, require: (id: string) => id === '@/features/input/types' ? { isDeviceInputState } : {} })
      const session = deviceExports.createDeviceInputSession({
        readSetting: () => mainBlock.$state.customization3d.preset.mouseEnabled,
        activity: async (active: boolean, enabled: boolean) => ({ ...Object.assign(native, { mouseEnabled: active && enabled, mouseGeneration: native.mouseGeneration + 1 }) }),
        stop: async () => {},
        onConfirmed: (enabled: boolean) => {
          mainBlock.$state.customization3d.preset.mouseEnabled = enabled
        },
        onGate: (enabled: boolean) => gates.push(enabled),
      })
      await session.setActive(true)
      await session.start()
      assert.equal((await session.request()).mouseEnabled, false)
      runInNewContext(ts.transpileModule(handlerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
        useTauriListen: (event: string, callback: (event: { payload: unknown }) => void) => events.set(event, callback),
        LISTEN_KEY,
        WINDOW_LABEL,
        device: { requestMouseSetting: session.request },
        settleAndCenterResetViewport: async () => {
          assert.equal(native.mouseEnabled, true, 'geometry success must follow native mouse reset')
          centered++
          return true
        },
        emitTo: async (_label: string, event: string, payload: unknown) => events.get(event)?.({ payload }),
        console,
      })
      Object.assign(preference.overrides, {
        '@tauri-apps/api/dpi': { LogicalSize: class {} },
        '@tauri-apps/api/webviewWindow': { getAllWebviewWindows: async () => [{ label: 'main' }] },
        '@tauri-apps/api/event': {
          emitTo: async (_label: string, event: string, payload: unknown) => events.get(event)?.({ payload }),
          listen: async (event: string, callback: (event: { payload: unknown }) => void) => {
            events.set(event, callback)
            return () => events.delete(event)
          },
        },
        '@/services/autostart': { getAutostartStatus: async () => ({ enabled: false }), setAutostartEnabled: async () => {} },
        '@/services/presetTransfer': { readPresetImport: async () => undefined },
        '@/services/skinLibrary': { clearSkinLibrary: async () => {
          clearCalls++
        } },
        '@/stores/performance': { usePerformanceStore: () => ({ stop: async () => {}, reset: async () => {} }) },
        '@/utils/mainViewportReset': { requestMainViewportReset },
      })
      const reset = preference.load('@/composables/useProgramSettingsReset').useProgramSettingsReset()
      await reset.resetProgramSettings({ deleteSkins: false, resetPresets })
      // The real preference unblock/focus readback used to overwrite true with false.
      block.$state.customization3d.preset.mouseEnabled = (await session.request()).mouseEnabled
      await settle()
      await preference.save()
      assert.equal(native.mouseEnabled, true)
      assert.equal(gates.at(-1), true, 'effective mouse input resumes')
      assert.equal(centered, 1)
      assert.equal(clearCalls, 0, 'the skin library is preserved by default')
      for (const state of [block.$state, mainBlock.$state, h.backend.get('cat')!]) {
        assert.deepEqual(clone(state.model), defaults.model)
        assert.deepEqual(clone(state.window), defaults.window)
        assert.deepEqual(clone(state.customization3d.preset), { ...defaults.preset, viewportModeRevision: 41 })
        for (const [key, value] of Object.entries(defaults.skinAppearance)) assert.deepEqual(state.customization3d[key], value)
        assert.equal(state.customization3d.dmeloperSkinDataUrl, undefined)
        assert.deepEqual(clone(state.presetCollection), resetPresets ? { ...beforeCatalog, activeId: null, entries: [] } : beforeCatalog)
      }
      for (const state of [preference.general, main.general, h.backend.get('general')!]) {
        assert.deepEqual(clone(state.app), { ...defaults.general.app, foregroundHiding: { ...defaults.general.app.foregroundHiding, future: 'kept' } })
        assert.deepEqual(clone(state.broadcast), defaults.general.broadcast)
        assert.deepEqual(clone(state.appearance), { ...defaults.general.appearance, isDark: true })
      }
      for (const state of [shortcut.$state, main.stores.find(store => store.$id === 'shortcut')!.$state, h.backend.get('shortcut')!]) {
        assert.deepEqual(clone(serializeSettingsState('shortcut', state)), defaults.shortcuts)
      }
      for (const state of [app.$state, main.stores.find(store => store.$id === 'app')!.$state, h.backend.get('app')!]) {
        assert.deepEqual(clone(state.windowState), {})
      }
      const reloaded = h.window('reload')
      try {
        await reloaded.initialize()
        assert.equal(reloaded.stores.find(store => store.$id === 'cat')!.$state.customization3d.preset.mouseEnabled, true)
      } finally {
        reloaded.dispose()
      }
      await session.dispose()
    } finally {
      main.dispose()
      preference.dispose()
    }
  }
})

it('preserves ko/en/ja/system keycaps through real two-window sync, save/reload and category/full reset', async () => {
  const h = await seededHarness()
  const preference = h.window('preference')
  const main = h.window('main')
  const block = preference.stores.find(store => store.$id === 'cat')! as SettingsStore & { resetKeyboard3d: () => void, resetAllSettings: () => void }
  const mainBlock = main.stores.find(store => store.$id === 'cat')!
  try {
    await preference.initialize()
    await main.initialize()
    for (const choice of ['ko', 'en', 'ja', 'system'] as const) {
      block.$state.customization3d.preset.keyboardLegendLanguage = choice
      await settle()
      await preference.save()
      assert.equal(mainBlock.$state.customization3d.preset.keyboardLegendLanguage, choice)
      assert.equal(h.backend.get('cat')!.customization3d.preset.keyboardLegendLanguage, choice)
      const reloaded = h.window('reloaded')
      try {
        await reloaded.initialize()
        assert.equal(reloaded.stores.find(store => store.$id === 'cat')!.$state.customization3d.preset.keyboardLegendLanguage, choice)
      } finally {
        reloaded.dispose()
      }
    }
    for (const reset of [block.resetKeyboard3d, block.resetAllSettings]) {
      block.$state.customization3d.preset.keyboardLegendLanguage = 'ja'
      await settle()
      await preference.save()
      reset()
      await settle()
      await preference.save()
      assert.equal(block.$state.customization3d.preset.keyboardLegendLanguage, 'ko')
      assert.equal(mainBlock.$state.customization3d.preset.keyboardLegendLanguage, 'ko')
      assert.equal(h.backend.get('cat')!.customization3d.preset.keyboardLegendLanguage, 'ko')
    }
  } finally {
    main.dispose()
    preference.dispose()
  }
})
