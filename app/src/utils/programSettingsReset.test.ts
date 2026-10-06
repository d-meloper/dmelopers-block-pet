/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ProgramSettingsResetSteps } from './programSettingsReset'

import { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS, ProgramSettingsResetError, runProgramSettingsReset } from './programSettingsReset'

function createSteps(calls: string[]): ProgramSettingsResetSteps {
  return {
    checkPresetImport: async () => {
      calls.push('check-preset-import')
    },
    getAutostartStatus: async () => {
      calls.push('read-autostart')
      return { enabled: false, state: 'disabled', canEnable: true, canDisable: true }
    },
    clearSkinLibrary: async () => {
      calls.push('clear-library')
    },
    resetAutostart: async () => {
      calls.push('reset-autostart')
    },
    stopPerformance: async () => {
      calls.push('stop-performance')
    },
    resetPerformanceMetrics: async () => {
      calls.push('reset-metrics')
    },
    resetBlock: () => {
      calls.push('reset-block')
    },
    resetGeneral: () => {
      calls.push('reset-general')
    },
    initializeGeneral: async () => {
      calls.push('init-general')
    },
    resetShortcut: () => {
      calls.push('reset-shortcut')
    },
    resetWindowState: () => {
      calls.push('reset-window-state')
    },
    resetWindowGeometry: async () => {
      calls.push('reset-window-geometry')
    },
  }
}

describe('whole-program settings reset transaction gate', () => {
  it('blocks unresolved or unreadable preset imports before any reset mutation, regardless of deletion choices', async () => {
    for (const deleteSkins of [false, true]) {
      for (const resetPresets of [false, true]) {
        const calls: string[] = []
        const steps = createSteps(calls)
        const cause = new Error('preset recovery pending')
        steps.checkPresetImport = async () => {
          calls.push('check-preset-import')
          throw cause
        }
        await assert.rejects(runProgramSettingsReset(steps, { deleteSkins, resetPresets }), (error: unknown) => {
          assert.ok(error instanceof ProgramSettingsResetError)
          assert.equal(error.outcome, 'preflight')
          assert.equal(error.stage, 'preflight')
          assert.equal(error.cause, cause)
          return true
        })
        assert.deepEqual(calls, ['check-preset-import'])
      }
    }
  })

  it('keeps both destructive options OFF unless explicitly selected', async () => {
    const calls: string[] = []
    const steps = createSteps(calls)
    let resetOptions
    steps.resetBlock = (options) => {
      resetOptions = options
    }
    await runProgramSettingsReset(steps)
    assert.equal(calls.includes('clear-library'), false)
    assert.deepEqual(resetOptions, { deleteSkins: false, resetPresets: false })
    assert.equal(calls.at(-1), 'reset-window-geometry')
    assert.notEqual(resetOptions, DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS)
  })

  for (const deleteSkins of [false, true]) {
    for (const resetPresets of [false, true]) {
      it(`independently applies skin deletion ${deleteSkins} and preset reset ${resetPresets}`, async () => {
        const calls: string[] = []
        const steps = createSteps(calls)
        const options = { deleteSkins, resetPresets }
        let received
        steps.resetBlock = (selection) => {
          received = selection
          calls.push('reset-block')
        }
        await runProgramSettingsReset(steps, options)
        assert.equal(calls.includes('clear-library'), deleteSkins)
        assert.deepEqual(received, options)
        assert.notEqual(received, options)
        assert.ok(calls.includes('reset-block'))
        assert.equal(calls.at(-1), 'reset-window-geometry')
      })
    }
  }

  it('captures the choices before asynchronous preflight and marks post-mutation failures partial without skin deletion', async () => {
    const calls: string[] = []
    const steps = createSteps(calls)
    const options = { deleteSkins: false, resetPresets: true }
    steps.getAutostartStatus = async () => {
      options.deleteSkins = true
      options.resetPresets = false
      return { enabled: false, state: 'disabled', canEnable: true, canDisable: true }
    }
    let received
    steps.resetBlock = (selection) => {
      received = selection
    }
    steps.resetWindowGeometry = async () => {
      throw new Error('window failed')
    }
    await assert.rejects(runProgramSettingsReset(steps, options), (error: unknown) => {
      assert.ok(error instanceof ProgramSettingsResetError)
      assert.equal(error.outcome, 'partial')
      assert.equal(error.stage, 'window')
      return true
    })
    assert.equal(calls.includes('clear-library'), false)
    assert.deepEqual(received, { deleteSkins: false, resetPresets: true })
  })

  it('does not begin any other reset when the skin library cannot be cleared', async () => {
    const calls: string[] = []
    const steps = createSteps(calls)
    steps.clearSkinLibrary = async () => {
      calls.push('clear-library')
      throw new Error('storage unavailable')
    }

    await assert.rejects(runProgramSettingsReset(steps, { deleteSkins: true, resetPresets: true }), (error: unknown) => {
      assert.ok(error instanceof ProgramSettingsResetError)
      assert.equal(error.outcome, 'partial')
      assert.equal(error.stage, 'library')
      assert.equal(error.message, 'storage unavailable')
      return true
    })
    assert.deepEqual(calls, ['check-preset-import', 'read-autostart', 'clear-library'])
  })

  it('runs the remaining reset only after a successful library clear', async () => {
    const calls: string[] = []
    await runProgramSettingsReset(createSteps(calls), { deleteSkins: true, resetPresets: true })
    assert.deepEqual(calls, [
      'check-preset-import',
      'read-autostart',
      'clear-library',
      'reset-autostart',
      'read-autostart',
      'stop-performance',
      'reset-metrics',
      'reset-block',
      'reset-general',
      'init-general',
      'reset-shortcut',
      'reset-window-state',
      'reset-window-geometry',
    ])
  })

  it('blocks policy-enabled autostart before clearing data and permits a later retry', async () => {
    const calls: string[] = []
    const steps = createSteps(calls)
    let blocked = true
    steps.getAutostartStatus = async () => {
      calls.push('read-autostart')
      return blocked
        ? { enabled: true, state: 'enabledByPolicy', canEnable: false, canDisable: false }
        : { enabled: false, state: 'disabled', canEnable: true, canDisable: true }
    }
    await assert.rejects(runProgramSettingsReset(steps, { deleteSkins: true, resetPresets: true }), (error: unknown) => {
      assert.ok(error instanceof ProgramSettingsResetError)
      assert.equal(error.outcome, 'blocked')
      assert.equal(error.stage, 'preflight')
      return true
    })
    assert.deepEqual(calls, ['check-preset-import', 'read-autostart'])
    blocked = false
    calls.length = 0
    await runProgramSettingsReset(steps, { deleteSkins: true, resetPresets: true })
    assert.equal(calls.at(-1), 'reset-window-geometry')
  })

  it('preserves preflight failure evidence without attempting destructive work', async () => {
    const calls: string[] = []
    const steps = createSteps(calls)
    const cause = new Error('autostart unavailable')
    steps.getAutostartStatus = async () => {
      throw cause
    }
    await assert.rejects(runProgramSettingsReset(steps, { deleteSkins: true, resetPresets: true }), (error: unknown) => {
      assert.ok(error instanceof ProgramSettingsResetError)
      assert.equal(error.outcome, 'preflight')
      assert.equal(error.cause, cause)
      assert.equal(error.message, cause.message)
      return true
    })
    assert.deepEqual(calls, ['check-preset-import'])
  })

  it('requires disabled OS readback after the write and stops with a partial outcome', async () => {
    for (const failedReadback of [false, true]) {
      const calls: string[] = []
      const steps = createSteps(calls)
      let reads = 0
      steps.getAutostartStatus = async () => {
        calls.push('read-autostart')
        if (++reads === 2 && failedReadback) throw new Error('readback unavailable')
        return { enabled: true, state: 'enabled', canEnable: true, canDisable: true }
      }
      await assert.rejects(runProgramSettingsReset(steps, { deleteSkins: true, resetPresets: true }), (error: unknown) => {
        assert.ok(error instanceof ProgramSettingsResetError)
        assert.equal(error.outcome, 'partial')
        assert.equal(error.stage, 'autostart')
        assert.equal(error.message, failedReadback ? 'readback unavailable' : 'AUTOSTART_RESET_NOT_DISABLED')
        return true
      })
      assert.deepEqual(calls, ['check-preset-import', 'read-autostart', 'clear-library', 'reset-autostart', 'read-autostart'])
    }
  })

  it('labels every post-clear failure as partial and preserves its original cause', async () => {
    const failures = {
      resetAutostart: 'autostart',
      stopPerformance: 'performance',
      resetPerformanceMetrics: 'performance',
      resetBlock: 'stores',
      resetGeneral: 'stores',
      initializeGeneral: 'stores',
      resetShortcut: 'shortcuts',
      resetWindowState: 'window',
      resetWindowGeometry: 'window',
    } as const
    for (const key of Object.keys(failures) as (keyof typeof failures)[]) {
      const calls: string[] = []
      const steps = createSteps(calls)
      const cause = new Error(`${key} failed`)
      steps[key] = () => {
        throw cause
      }
      await assert.rejects(runProgramSettingsReset(steps, { deleteSkins: true, resetPresets: true }), (error: unknown) => {
        assert.ok(error instanceof ProgramSettingsResetError)
        assert.equal(error.outcome, 'partial')
        assert.equal(error.stage, failures[key])
        assert.equal(error.cause, cause)
        return true
      })
      assert.ok(calls.includes('clear-library'))
    }
  })
})
