/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ProgramSettingsResetSteps } from './programSettingsReset'

import { runProgramSettingsReset } from './programSettingsReset'

function createSteps(calls: string[]): ProgramSettingsResetSteps {
  return {
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

    await assert.rejects(runProgramSettingsReset(steps), /storage unavailable/)
    assert.deepEqual(calls, ['clear-library'])
  })

  it('runs the remaining reset only after a successful library clear', async () => {
    const calls: string[] = []
    await runProgramSettingsReset(createSteps(calls))
    assert.deepEqual(calls, [
      'clear-library',
      'reset-autostart',
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
})
