/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createSerializedRetryPump } from './serializedRetryPump'

describe('createSerializedRetryPump', () => {
  it('retries a stale attempt serially until it completes', async () => {
    let active = 0
    let attempts = 0
    let maximumActive = 0
    const pump = createSerializedRetryPump(async () => {
      active += 1
      attempts += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return attempts < 3 ? 'retry' : 'complete'
    }, {
      yieldBeforeRetry: () => Promise.resolve(),
    })

    pump.request()
    await pump.whenIdle()

    assert.equal(attempts, 3)
    assert.equal(maximumActive, 1)
    assert.equal(pump.hasPendingRequest(), false)
  })

  it('does not let an older successful attempt consume a newer request', async () => {
    let attempts = 0
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const pump = createSerializedRetryPump(async () => {
      attempts += 1
      if (attempts === 1) await firstBlocked
      return 'complete'
    })

    pump.request()
    await Promise.resolve()
    pump.request()
    releaseFirst?.()
    await pump.whenIdle()

    assert.equal(attempts, 2)
    assert.equal(pump.hasPendingRequest(), false)
  })

  it('keeps a blocked request until the caller resumes it', async () => {
    let blocked = true
    let attempts = 0
    const pump = createSerializedRetryPump(async () => {
      attempts += 1
      return blocked ? 'blocked' : 'complete'
    })

    pump.request()
    await pump.whenIdle()

    assert.equal(attempts, 1)
    assert.equal(pump.hasPendingRequest(), true)

    blocked = false
    pump.resume()
    await pump.whenIdle()

    assert.equal(attempts, 2)
    assert.equal(pump.hasPendingRequest(), false)
  })

  it('does not resurrect a request cleared during an attempt', async () => {
    let releaseAttempt: (() => void) | undefined
    const attemptBlocked = new Promise<void>((resolve) => {
      releaseAttempt = resolve
    })
    const pump = createSerializedRetryPump(async () => {
      await attemptBlocked
      return 'retry'
    }, {
      yieldBeforeRetry: () => Promise.resolve(),
    })

    pump.request()
    await Promise.resolve()
    pump.clear()
    releaseAttempt?.()
    await pump.whenIdle()

    assert.equal(pump.hasPendingRequest(), false)
  })

  it('reports an error and preserves the request for a later resume', async () => {
    const errors: unknown[] = []
    let shouldFail = true
    const pump = createSerializedRetryPump(async () => {
      if (shouldFail) throw new Error('expected')
      return 'complete'
    }, {
      onError: error => errors.push(error),
    })

    pump.request()
    await pump.whenIdle()
    assert.equal(errors.length, 1)
    assert.equal(pump.hasPendingRequest(), true)

    shouldFail = false
    pump.resume()
    await pump.whenIdle()
    assert.equal(pump.hasPendingRequest(), false)
  })
})
