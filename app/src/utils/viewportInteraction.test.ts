/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createViewportInteraction } from './viewportInteraction'

describe('viewport mouse interaction', () => {
  it('drops only native holds when mouse input is disabled', () => {
    const states: boolean[] = []
    const interaction = createViewportInteraction(held => void states.push(held))
    interaction.setNativeButton(1, true)
    interaction.setButtons('main', 1)
    interaction.setButtons('preference', 2)
    interaction.resetNativeButtons()
    interaction.setButtons('main', 0)
    assert.equal(interaction.isHeld(), true)
    interaction.setButtons('preference', 0)
    assert.deepEqual(states, [true, false])
    interaction.setNativeButton(2, true)
    interaction.resetNativeButtons()
    interaction.resetNativeButtons()
    assert.deepEqual(states, [true, false, true, false])
  })
  it('requires every button and every source to release', () => {
    const states: boolean[] = []
    const interaction = createViewportInteraction(held => void states.push(held))
    interaction.setButtons('preference', 3)
    interaction.setButtons('main', 4)
    interaction.setButtons('preference', 2)
    interaction.setButtons('preference', 0)
    assert.deepEqual(states, [true])
    interaction.setButtons('main', 0)
    assert.deepEqual(states, [true, false])
  })

  it('accepts native outside release without requiring a DOM mouseup', () => {
    const states: boolean[] = []
    const interaction = createViewportInteraction(held => void states.push(held))
    interaction.setNativeButton(1, true)
    interaction.setButtons('preference', 1)
    interaction.setNativeButton(2, true)
    interaction.setNativeButton(1, false)
    assert.equal(interaction.isHeld(), true)
    interaction.setNativeButton(2, false)
    assert.deepEqual(states, [true, false])
  })

  it('cleans cancelled/blurred DOM gestures without releasing a physical native hold', () => {
    const states: boolean[] = []
    const interaction = createViewportInteraction(held => void states.push(held))
    interaction.setButtons('preference', 4)
    interaction.cancel('preference')
    interaction.setNativeButton(1, true)
    interaction.setButtons('preference', 1)
    interaction.cancel('preference')
    assert.deepEqual(states, [true, false, true])
    interaction.setNativeButton(1, false)
    interaction.setButtons('main', 1)
    interaction.clear()
    interaction.clear()
    assert.deepEqual(states, [true, false, true, false, true, false])
  })

  it('does not block keyboard-only edits or accept invalid button state', () => {
    const interaction = createViewportInteraction(() => assert.fail('unexpected hold'))
    interaction.setButtons('preference', 0)
    interaction.setButtons('preference', Number.NaN)
    interaction.setButtons('preference', -1)
    assert.equal(interaction.isHeld(), false)
  })
})
