/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import type { ProgramSettingsResetOptions } from '@/utils/programSettingsReset'

import { beginPresetOperation, presetResetInProgress, withPresetReset } from '@/features/presets/operations'
import { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS, ProgramSettingsResetError, runProgramSettingsReset } from '@/utils/programSettingsReset'

function harness() {
  const calls: string[] = []
  const selections: ProgramSettingsResetOptions[] = []
  let journal: { phase: 'prepared' | 'committed' } | undefined
  let readFailure: unknown
  const record = (name: string) => () => {
    calls.push(name)
  }
  const exports = {} as typeof import('./useProgramSettingsReset')
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/dpi': { LogicalSize: class {} },
    '@tauri-apps/api/webviewWindow': { getAllWebviewWindows: async () => [{ label: 'main' }] },
    '@/config/window': { DEFAULT_PREFERENCE_SIZE: { width: 911, height: 692 } },
    '@/constants': { WINDOW_LABEL: { MAIN: 'main' } },
    '@/features/presets/operations': { withPresetReset },
    '@/services/presetTransfer': { readPresetImport: async () => {
      calls.push('read-import')
      if (readFailure) throw readFailure
      return journal
    } },
    '@/services/autostart': {
      getAutostartStatus: async () => {
        calls.push('read-autostart')
        return { enabled: false, state: 'disabled', canEnable: true, canDisable: true }
      },
      setAutostartEnabled: async () => record('reset-autostart')(),
    },
    '@/services/skinLibrary': { clearSkinLibrary: async () => record('clear-library')() },
    '@/stores/block': { useBlockStore: () => ({ resetAllSettings: (options: ProgramSettingsResetOptions) => {
      calls.push('reset-block')
      selections.push({ ...options })
    } }) },
    '@/stores/general': { useGeneralStore: () => ({ reset: record('reset-general'), init: async () => record('init-general')() }) },
    '@/stores/performance': { usePerformanceStore: () => ({ stop: async () => record('stop-performance')(), reset: async () => record('reset-metrics')() }) },
    '@/stores/shortcut': { useShortcutStore: () => ({ reset: record('reset-shortcuts') }) },
    '@/stores/app': { useAppStore: () => ({ resetWindowState: record('reset-window-state') }) },
    '@/utils/mainViewportReset': { requestMainViewportReset: async () => record('reset-main-viewport')() },
    '@/utils/programSettingsReset': { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS, runProgramSettingsReset },
  }
  runInNewContext(ts.transpileModule(readFileSync(new URL('./useProgramSettingsReset.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id: string) => mocks[id] ?? {} })
  return {
    ...exports.useProgramSettingsReset(),
    calls,
    selections,
    journal: (phase?: 'prepared' | 'committed') => {
      journal = phase ? { phase } : undefined
    },
    failRead: (failure: unknown) => {
      readFailure = failure
    },
  }
}

it('checks the remaining journal only after the active preset transaction finishes and keeps captured options', async () => {
  const h = harness()
  h.journal('prepared')
  const finish = beginPresetOperation()
  const options = { deleteSkins: false, resetPresets: true }
  const resetting = h.resetProgramSettings(options)
  try {
    await Promise.resolve()
    assert.equal(presetResetInProgress.value, true)
    assert.equal(h.calls.length, 0)
    options.deleteSkins = true
    options.resetPresets = false
    h.journal()
    finish()
    await resetting
    assert.equal(h.calls[0], 'read-import')
    assert.equal(h.calls.includes('clear-library'), false)
    assert.equal(h.calls.at(-1), 'reset-main-viewport')
    assert.deepEqual(h.selections, [{ deleteSkins: false, resetPresets: true }])
    assert.equal(presetResetInProgress.value, false)
  } finally {
    finish()
  }
})

it('fails safely for a prepared or unreadable journal with either skin option and permits retry after recovery', async () => {
  for (const deleteSkins of [false, true]) {
    for (const failure of ['prepared', 'read'] as const) {
      const h = harness()
      if (failure === 'prepared') h.journal('prepared')
      else h.failRead(new Error('journal unavailable'))
      await assert.rejects(h.resetProgramSettings({ deleteSkins, resetPresets: true }), (error: unknown) => {
        assert.ok(error instanceof ProgramSettingsResetError)
        assert.equal(error.outcome, 'preflight')
        assert.equal(error.stage, 'preflight')
        return true
      })
      assert.deepEqual(h.calls, ['read-import'])
      assert.deepEqual(h.selections, [])
      assert.equal(presetResetInProgress.value, false)
      h.journal('committed')
      h.failRead(undefined)
      await h.resetProgramSettings({ deleteSkins, resetPresets: true })
      assert.equal(h.calls.includes('clear-library'), deleteSkins)
      assert.equal(h.calls.at(-1), 'reset-main-viewport')
      assert.deepEqual(h.selections, [{ deleteSkins, resetPresets: true }])
    }
  }
})
