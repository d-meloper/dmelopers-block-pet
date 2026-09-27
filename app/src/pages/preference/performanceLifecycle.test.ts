/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { shouldMonitorPreferencePerformance } from './performanceLifecycle'

const activeState = {
  activeTab: 4,
  performanceTab: 4,
  visible: true,
  minimized: false,
  closing: false,
}

describe('preference performance lifecycle', () => {
  it('measures only while the visible performance tab is active', () => {
    assert.equal(shouldMonitorPreferencePerformance(activeState), true)
    assert.equal(shouldMonitorPreferencePerformance({ ...activeState, activeTab: 2 }), false)
    assert.equal(shouldMonitorPreferencePerformance({ ...activeState, visible: false }), false)
    assert.equal(shouldMonitorPreferencePerformance({ ...activeState, minimized: true }), false)
  })

  it('stops for close and restarts when the window is reopened', () => {
    assert.equal(shouldMonitorPreferencePerformance({ ...activeState, closing: true }), false)
    assert.equal(shouldMonitorPreferencePerformance({ ...activeState, closing: false }), true)
  })
})
