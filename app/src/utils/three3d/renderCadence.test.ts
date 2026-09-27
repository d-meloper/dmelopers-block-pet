/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RenderCadence } from './renderCadence'

function savingCadence() {
  const cadence = new RenderCadence()
  cadence.reset(0)
  cadence.setEnabled(true, 0)
  return cadence
}

describe('idle rendering cadence', () => {
  it('retains the normal cap by default and switches at exactly five seconds', () => {
    const cadence = new RenderCadence()
    assert.equal(cadence.getFrameLimit(60000, 60), 60)
    cadence.setEnabled(true, 60000)
    assert.equal(cadence.getFrameLimit(64999, 60), 60)
    assert.equal(cadence.getFrameLimit(65000, 60), 15)
    assert.equal(cadence.getFrameLimit(65000, 10), 10)
  })

  it('renders fifteen frames per second across common display refresh rates', () => {
    for (const refreshRate of [60, 120, 144, 240]) {
      const cadence = savingCadence()
      let frames = 0
      for (let i = 0; i < refreshRate * 4; i++) {
        if (cadence.shouldRender(5000 + i * 1000 / refreshRate, 60)) frames++
      }
      assert.equal(frames, 60, `${refreshRate} Hz`)
    }
  })

  it('wakes on the next RAF without waiting out the idle interval', () => {
    const cadence = savingCadence()
    assert.equal(cadence.shouldRender(5000, 60), true)
    assert.equal(cadence.shouldRender(5010, 60), false)
    cadence.handleInput({ kind: 'pointer_activity', x: 0.6, y: 0.5 }, 5011)
    assert.equal(cadence.shouldRender(5012, 60), true)
    assert.equal(cadence.shouldRender(5020, 60), false)
    assert.equal(cadence.getFrameLimit(10010, 60), 60)
    assert.equal(cadence.getFrameLimit(10011, 60), 15)
  })

  it('does not idle while a key, mouse button, or viewport interaction is held', () => {
    const cadence = savingCadence()
    cadence.handleInput({ kind: 'typing', active: true, intensity: 1 }, 10)
    assert.equal(cadence.getFrameLimit(20000, 60), 60)
    cadence.handleInput({ kind: 'typing', active: false, intensity: 0 }, 20000)
    assert.equal(cadence.getFrameLimit(24999, 60), 60)
    assert.equal(cadence.getFrameLimit(25000, 60), 15)
    for (const kind of ['mouse_primary', 'mouse_secondary', 'mouse_middle', 'drag'] as const) {
      cadence.handleInput({ kind, active: true }, 25000)
      assert.equal(cadence.getFrameLimit(35000, 60), 60)
      cadence.handleInput({ kind, active: false }, 35000)
      assert.equal(cadence.getFrameLimit(40000, 60), 15)
    }
    cadence.setInteractionHeld(true, 40000)
    assert.equal(cadence.getFrameLimit(60000, 60), 60)
    cadence.setInteractionHeld(false, 60000)
    assert.equal(cadence.getFrameLimit(64999, 60), 60)
    assert.equal(cadence.getFrameLimit(65000, 60), 15)
  })

  it('keeps keyboard holds across mouse reset and clears stale holds on lifecycle reset', () => {
    const cadence = savingCadence()
    cadence.handleInput({ kind: 'typing', active: true, intensity: 1 }, 10)
    cadence.handleInput({ kind: 'mouse_middle', active: true }, 10)
    cadence.handleInput({ kind: 'drag', active: true }, 10)
    cadence.resetMouseInput(10000)
    assert.equal(cadence.getFrameLimit(20000, 60), 60)
    cadence.handleInput({ kind: 'typing', active: false, intensity: 0 }, 20000)
    assert.equal(cadence.getFrameLimit(25000, 60), 15)
    cadence.setInteractionHeld(true, 25000)
    cadence.reset(30000)
    assert.equal(cadence.getFrameLimit(34999, 60), 60)
    assert.equal(cadence.getFrameLimit(35000, 60), 15)
  })

  it('wakes for settings and scroll, and disabling saving restores the normal cap', () => {
    const cadence = savingCadence()
    cadence.shouldRender(5000, 60)
    cadence.noteActivity(5010)
    assert.equal(cadence.shouldRender(5011, 60), true)
    cadence.handleInput({ kind: 'scroll', deltaX: 0, deltaY: 1 }, 10000)
    assert.equal(cadence.getFrameLimit(14999, 60), 60)
    assert.equal(cadence.getFrameLimit(15000, 60), 15)
    cadence.setEnabled(false, 15000)
    assert.equal(cadence.getFrameLimit(30000, 60), 60)
    assert.equal(cadence.shouldRender(30000, 30), true)
  })
})
