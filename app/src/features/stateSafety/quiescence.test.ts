/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createQuiescenceOwner } from './quiescence'

describe('request-bound save quiescence', () => {
  it('invalidates a delayed continuation when timeout releases its barrier', async () => {
    const owner = createQuiescenceOwner()
    const current = owner.begin('request-1')
    let finish!: () => void
    let frozen = false
    const nativeDrain = new Promise<void>((resolve) => {
      finish = resolve
    })
    const participant = (async () => {
      await nativeDrain
      if (current()) frozen = true
    })()
    owner.release()
    finish()
    await participant
    assert.equal(frozen, false)
  })
  it('keeps duplicate and stale requests from replacing or releasing the live owner', () => {
    const owner = createQuiescenceOwner()
    const first = owner.begin('same-id')
    assert.equal(owner.begin('same-id')(), false)
    assert.equal(owner.begin('late-old-id')(), false)
    assert.equal(first(), true)
    assert.equal(owner.release('late-old-id'), false)
    owner.release('same-id')
    const next = owner.begin('new-id')
    assert.equal(first(), false)
    assert.equal(next(), true)
  })
})
