/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Vector3 } from 'three'

import { createHandContactTransition } from './handContactTransition'

describe('hand contact travel interpolation', () => {
  it('eases a large jump in 120 ms at different frame rates without delaying strike height', () => {
    for (const step of [8, 16, 1000 / 30, 1000 / 15]) {
      const transition = createHandContactTransition(0.35, 120)
      const up = new Vector3(0, 1, 0)
      const current = new Vector3()
      transition.update(current, current, up, 0, true)
      const target = new Vector3(2, 1.2, 0)
      let elapsed = 0
      let previousX = 0
      while (elapsed < 120) {
        const delta = Math.min(step, 120 - elapsed)
        elapsed += delta
        current.copy(transition.update(target, current, up, delta))
        const progress = elapsed / 120
        const expectedX = 2 * progress * progress * (3 - 2 * progress)
        assert.ok(Math.abs(current.x - expectedX) < 1e-10)
        assert.equal(current.y, target.y)
        assert.ok(current.x >= previousX && current.x <= target.x)
        previousX = current.x
      }
      assert.ok(current.distanceTo(target) < 1e-10)
    }
  })

  it('retargets from the current contact and clears travel on direct tracking/reset', () => {
    const transition = createHandContactTransition(0.35, 120)
    const up = new Vector3(0, 1, 0)
    const current = new Vector3()
    transition.update(current, current, up, 0, true)
    current.copy(transition.update(new Vector3(2, 0, 0), current, up, 48))
    const before = current.clone()
    const next = new Vector3(-2, 0.4, 0)
    current.copy(transition.update(next, current, up, 0))
    assert.equal(current.x, before.x)
    assert.equal(current.y, next.y)
    current.copy(transition.update(next, current, up, 16))
    assert.ok(current.x < before.x && current.x > next.x)
    assert.deepEqual(transition.update(next, current, up, 16, true).toArray(), next.toArray())
    transition.reset()
    const restored = new Vector3(3, 0, 0)
    assert.deepEqual(transition.update(restored, current, up, 16).toArray(), restored.toArray())
  })

  it('leaves nearby contacts and pure strikes unchanged on a tilted keyboard plane', () => {
    const up = new Vector3(0, 1, 1).normalize()
    const transition = createHandContactTransition(0.35, 120)
    const current = new Vector3()
    transition.update(current, current, up, 0, true)
    const nearby = new Vector3(0.2, 0, 0)
    assert.deepEqual(transition.update(nearby, current, up, 16).toArray(), nearby.toArray())
    const strike = nearby.clone().addScaledVector(up, 1.2)
    assert.deepEqual(transition.update(strike, nearby, up, 16).toArray(), strike.toArray())
    const far = strike.clone().add(new Vector3(2, 0, 0))
    const result = transition.update(far, strike, up, 16)
    assert.ok(result.x > strike.x && result.x < far.x)
    assert.ok(Math.abs(result.dot(up) - far.dot(up)) < 1e-10)
  })
})
