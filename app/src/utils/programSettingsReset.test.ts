/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ProgramSettingsResetSteps } from './programSettingsReset'

import { ProgramSettingsResetError, runProgramSettingsReset } from './programSettingsReset'

function createSteps(calls: string[]): ProgramSettingsResetSteps {
  return {
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
    resetCat: () => {
      calls.push('reset-cat')
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
  it('does not begin any other reset when the skin library cannot be cleared', async () => {
    const calls: string[] = []
    const steps = createSteps(calls)
    steps.clearSkinLibrary = async () => {
      calls.push('clear-library')
      throw new Error('storage unavailable')
    }

    await assert.rejects(runProgramSettingsReset(steps), (error: unknown) => {
      assert.ok(error instanceof ProgramSettingsResetError)
      assert.equal(error.outcome, 'partial')
      assert.equal(error.stage, 'library')
      assert.equal(error.message, 'storage unavailable')
      return true
    })
    assert.deepEqual(calls, ['read-autostart', 'clear-library'])
  })

  it('runs the remaining reset only after a successful library clear', async () => {
    const calls: string[] = []
    await runProgramSettingsReset(createSteps(calls))
    assert.deepEqual(calls, [
      'read-autostart',
      'clear-library',
      'reset-autostart',
      'read-autostart',
      'stop-performance',
      'reset-metrics',
      'reset-cat',
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
    await assert.rejects(runProgramSettingsReset(steps), (error: unknown) => {
      assert.ok(error instanceof ProgramSettingsResetError)
      assert.equal(error.outcome, 'blocked')
      assert.equal(error.stage, 'preflight')
      return true
    })
    assert.deepEqual(calls, ['read-autostart'])
    blocked = false
    calls.length = 0
    await runProgramSettingsReset(steps)
    assert.equal(calls.at(-1), 'reset-window-geometry')
  })

  it('preserves preflight failure evidence without attempting destructive work', async () => {
    const calls: string[] = []
    const steps = createSteps(calls)
    const cause = new Error('autostart unavailable')
    steps.getAutostartStatus = async () => {
      throw cause
    }
    await assert.rejects(runProgramSettingsReset(steps), (error: unknown) => {
      assert.ok(error instanceof ProgramSettingsResetError)
      assert.equal(error.outcome, 'preflight')
      assert.equal(error.cause, cause)
      assert.equal(error.message, cause.message)
      return true
    })
    assert.deepEqual(calls, [])
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
      await assert.rejects(runProgramSettingsReset(steps), (error: unknown) => {
        assert.ok(error instanceof ProgramSettingsResetError)
        assert.equal(error.outcome, 'partial')
        assert.equal(error.stage, 'autostart')
        assert.equal(error.message, failedReadback ? 'readback unavailable' : 'AUTOSTART_RESET_NOT_DISABLED')
        return true
      })
      assert.deepEqual(calls, ['read-autostart', 'clear-library', 'reset-autostart', 'read-autostart'])
    }
  })

  it('labels every post-clear failure as partial and preserves its original cause', async () => {
    const failures = {
      resetAutostart: 'autostart',
      stopPerformance: 'performance',
      resetPerformanceMetrics: 'performance',
      resetCat: 'stores',
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
      await assert.rejects(runProgramSettingsReset(steps), (error: unknown) => {
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
