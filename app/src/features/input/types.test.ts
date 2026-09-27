/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isCurrentSemanticInput, isDeviceInputState, isMouseSettingRequest, isMouseSettingResponse, isSemanticInputEvent } from './types'

describe('mouse setting acknowledgements', () => {
  it('accepts state queries and requires a valid confirmed state for success', () => {
    assert.equal(isMouseSettingRequest({ requestId: 'session:1' }), true)
    assert.equal(isMouseSettingRequest({ requestId: 'session:1', enabled: false }), true)
    assert.equal(isMouseSettingRequest({ requestId: '', enabled: false }), false)
    assert.equal(isMouseSettingRequest({ requestId: 'session:1', enabled: 'false' }), false)
    assert.equal(isMouseSettingResponse({ requestId: 'session:1', success: true }), false)
    assert.equal(isMouseSettingResponse({ requestId: 'session:1', success: false, error: 'unsupported' }), true)
    assert.equal(isMouseSettingResponse({ requestId: 'session:1', success: true, state: { mouseEnabled: false, mouseGeneration: 2 } }), true)
    assert.equal(isDeviceInputState({ mouseEnabled: false, mouseGeneration: -1 }), false)
    assert.equal(isDeviceInputState({ mouseEnabled: 'false', mouseGeneration: 1 }), false)
  })
})

describe('semantic keyboard contact privacy boundary', () => {
  it('accepts a bounded geometry-only contact', () => {
    assert.equal(isSemanticInputEvent({
      kind: 'typing',
      active: true,
      intensity: 0.5,
      contact: { row: 2, column: 4, pressed: true },
    }), true)
  })

  it('rejects contact labels and out-of-range coordinates', () => {
    assert.equal(isSemanticInputEvent({
      kind: 'typing',
      active: true,
      intensity: 1,
      contact: { row: 2, column: 4, pressed: true, key: 'KeyF' },
    }), false)
    assert.equal(isSemanticInputEvent({
      kind: 'typing',
      active: true,
      intensity: 1,
      contact: { row: 8, column: 4, pressed: true },
    }), false)
  })
})

describe('semantic mouse input contract', () => {
  it('accepts middle press/release and finite scroll on either axis', () => {
    for (const active of [true, false]) {
      assert.equal(isSemanticInputEvent({ kind: 'mouse_middle', active }), true)
    }
    for (const [deltaX, deltaY] of [[0, 1], [0, -1], [1200, 0], [-1200, 0], [1, -1], [0, 0]]) {
      assert.equal(isSemanticInputEvent({ kind: 'scroll', deltaX, deltaY }), true)
    }
  })

  it('rejects malformed middle and scroll payloads', () => {
    for (const active of [undefined, null, 0, 1, 'true', {}]) {
      assert.equal(isSemanticInputEvent({ kind: 'mouse_middle', active }), false)
    }
    for (const value of [undefined, null, '1', Number.NaN, Infinity, -Infinity, {}]) {
      assert.equal(isSemanticInputEvent({ kind: 'scroll', deltaX: value, deltaY: 1 }), false)
      assert.equal(isSemanticInputEvent({ kind: 'scroll', deltaX: 0, deltaY: value }), false)
    }
    assert.equal(isSemanticInputEvent({ kind: 'mouse_wheel', active: true }), false)
  })

  it('accepts optional collection epochs and rejects malformed epochs', () => {
    for (const mouseGeneration of [0, 1, 200]) {
      assert.equal(isSemanticInputEvent({ kind: 'mouse_middle', active: true, mouseGeneration }), true)
    }
    for (const mouseGeneration of [null, -1, 0.5, '1', Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(isSemanticInputEvent({ kind: 'scroll', deltaX: 1, deltaY: 0, mouseGeneration }), false)
    }
  })

  it('rejects queued mouse events across OFF/ON or restart without dropping keyboard releases', () => {
    const event = { kind: 'pointer_activity' as const, x: 0.2, y: 0.8, mouseGeneration: 1 }
    assert.equal(isCurrentSemanticInput(event, { mouseEnabled: true, mouseGeneration: 1 }), true)
    assert.equal(isCurrentSemanticInput(event, { mouseEnabled: false, mouseGeneration: 2 }), false)
    assert.equal(isCurrentSemanticInput(event, { mouseEnabled: true, mouseGeneration: 3 }), false)
    assert.equal(isCurrentSemanticInput({ ...event, mouseGeneration: 3 }, { mouseEnabled: true, mouseGeneration: 3 }), true)
    assert.equal(isCurrentSemanticInput({ kind: 'typing', active: false, intensity: 0 }, { mouseEnabled: false, mouseGeneration: 2 }), true)
  })
})
