/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWindowVisibilityQueue } from './windowVisibility'

test('orders delayed native visibility operations and remains usable after native failure', async () => {
  const order = createWindowVisibilityQueue()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let visible = false
  const events: boolean[] = []
  const show = order(async () => {
    await gate
    visible = true
    events.push(visible)
  })
  const hide = order(async () => {
    visible = false
    events.push(visible)
  })
  await Promise.resolve()
  assert.deepEqual(events, [])
  release()
  await Promise.all([show, hide])
  assert.deepEqual(events, [true, false])
  assert.equal(visible, false)
  await assert.rejects(order(async () => {
    throw new Error('native operation failed')
  }))
  await order(async () => {
    visible = true
  })
  assert.equal(visible, true)
})
