/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { Group, Vector3 } from 'three'

import { getTypingReachExtension, getTypingReachRadius, TYPING_REACH_RADII } from '@/config/typingReach'

import { createTypingReachConstraint } from './typingReach'

it('uses only the allowed outer range to increase torso and arm reach', () => {
  assert.equal(getTypingReachExtension(0, TYPING_REACH_RADII.max), 0)
  assert.equal(getTypingReachExtension(-1, TYPING_REACH_RADII.max), 0)
  assert.equal(getTypingReachExtension(1, TYPING_REACH_RADII.default), 0)
  assert.ok(Math.abs(getTypingReachExtension(0.5, TYPING_REACH_RADII.max) - 0.5) < 1e-10)
  assert.equal(getTypingReachExtension(1, TYPING_REACH_RADII.max * 3), 1)
})

it('keeps the same world radius on transformed keycap planes without flattening hand lift', () => {
  const root = new Group()
  root.position.set(-0.3, 0.4, -0.5)
  const keyboard = new Group()
  const constraint = createTypingReachConstraint(root, keyboard, 0.2)
  for (const scale of [0.5, 1, 2]) {
    keyboard.position.set(0.4 * scale, 0.3, 0.7 * scale)
    keyboard.rotation.set(0.15, 0.8, 0.1)
    keyboard.scale.set(scale, scale * 1.5, scale * 0.8)
    constraint.update()
    const direction = new Vector3(1, 0, 0).transformDirection(keyboard.matrixWorld)
    const radius = getTypingReachRadius(-0.6)
    const point = constraint.center.clone().addScaledVector(direction, radius * 3).addScaledVector(constraint.normal, 0.45)
    const copy = point.clone()
    constraint.clampWorldPoint(point, radius)
    assert.ok(Math.abs(constraint.projectedDistance(point) - radius) < 1e-8)
    assert.ok(Math.abs(point.clone().sub(constraint.center).dot(constraint.normal) - 0.45) < 1e-8)
    assert.equal(constraint.containsWorldPoint(copy, radius), false)
    assert.equal(constraint.containsWorldPoint(point, radius), true)
    const local = keyboard.worldToLocal(copy.clone())
    constraint.clampLocalPoint(local, radius)
    assert.ok(keyboard.localToWorld(local).distanceTo(point) < 1e-8)
  }
})
