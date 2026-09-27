/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  classifyNativePositionEvent,
  classifyNativeSizeEvent,
  selectCurrentProgrammaticGeneration,
} from './nativeGeometryEvent'

describe('native geometry event classification', () => {
  it('trusts pending and superseded tokens only while a mutation is pending', () => {
    assert.equal(selectCurrentProgrammaticGeneration(4, 4), 4)
    assert.equal(selectCurrentProgrammaticGeneration(3, 4), 3)
    assert.equal(selectCurrentProgrammaticGeneration(5, 4), undefined)
    assert.equal(selectCurrentProgrammaticGeneration(2, undefined), undefined)
    assert.equal(selectCurrentProgrammaticGeneration(undefined, 4), undefined)
  })

  it('does not mistake a superseded programmatic move for a user move', () => {
    const supersededToken = selectCurrentProgrammaticGeneration(3, 4)

    assert.equal(classifyNativePositionEvent({
      actualValue: { x: 100, y: 200 },
      committedValue: { x: 300, y: 400 },
      eventValue: { x: 100, y: 200 },
      programmaticGeneration: supersededToken,
    }), 'programmatic')
  })

  it('recognizes an event that still has a programmatic generation token', () => {
    assert.equal(classifyNativePositionEvent({
      actualValue: { x: 100, y: 200 },
      committedValue: { x: 100, y: 200 },
      eventValue: { x: 20, y: 30 },
      programmaticGeneration: 4,
    }), 'programmatic')
  })

  it('rejects a delayed event when its payload no longer matches native state', () => {
    assert.equal(classifyNativePositionEvent({
      actualValue: { x: 300, y: 400 },
      committedValue: { x: 300, y: 400 },
      eventValue: { x: 100, y: 200 },
    }), 'stale')
  })

  it('keeps an actual user move when a later stale payload wins the event race', () => {
    assert.equal(classifyNativePositionEvent({
      actualValue: { x: -450, y: 80 },
      committedValue: { x: 100, y: 200 },
      eventValue: { x: 100, y: 200 },
    }), 'external')
  })

  it('treats a token-expired programmatic event at committed state as a noop', () => {
    assert.equal(classifyNativePositionEvent({
      actualValue: { x: 101, y: 199 },
      committedValue: { x: 100, y: 200 },
      eventValue: { x: 100, y: 200 },
    }), 'noop')
  })

  it('recognizes an actual user move that differs from committed state', () => {
    assert.equal(classifyNativePositionEvent({
      actualValue: { x: -450, y: 80 },
      committedValue: { x: 100, y: 200 },
      eventValue: { x: -450, y: 80 },
    }), 'external')
  })

  it('does not let a leftover committed token swallow a user move', () => {
    const leftoverToken = selectCurrentProgrammaticGeneration(4, undefined)

    assert.equal(classifyNativePositionEvent({
      actualValue: { x: 100, y: 200 },
      committedValue: { x: 300, y: 400 },
      eventValue: { x: 100, y: 200 },
      programmaticGeneration: leftoverToken,
    }), 'external')
  })

  it('applies the same stale/noop/external rules to inner-size events', () => {
    assert.equal(classifyNativeSizeEvent({
      actualValue: { width: 320, height: 240 },
      committedValue: { width: 320, height: 240 },
      eventValue: { width: 500, height: 422 },
    }), 'stale')
    assert.equal(classifyNativeSizeEvent({
      actualValue: { width: 320, height: 240 },
      committedValue: { width: 320, height: 240 },
      eventValue: { width: 320, height: 240 },
    }), 'noop')
    assert.equal(classifyNativeSizeEvent({
      actualValue: { width: 640, height: 480 },
      committedValue: { width: 320, height: 240 },
      eventValue: { width: 640, height: 480 },
    }), 'external')
    assert.equal(classifyNativeSizeEvent({
      actualValue: { width: 640, height: 480 },
      committedValue: { width: 320, height: 240 },
      eventValue: { width: 320, height: 240 },
    }), 'external')
  })

  it('treats a one-pixel native delta as external when tolerance is zero', () => {
    assert.equal(classifyNativeSizeEvent({
      actualValue: { width: 301, height: 200 },
      committedValue: { width: 300, height: 200 },
      eventValue: { width: 300, height: 200 },
      tolerance: 0,
    }), 'external')
  })
})
