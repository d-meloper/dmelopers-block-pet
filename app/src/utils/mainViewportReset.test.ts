/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { MainViewportResetComplete } from './mainViewportReset'

import { requestMainViewportReset } from './mainViewportReset'

describe('main viewport reset request', () => {
  it('waits for the matching acknowledgement and cleans up its listener', async () => {
    let handler: ((response: MainViewportResetComplete) => void) | undefined
    let unlistenCount = 0
    const request = requestMainViewportReset({
      emit: async ({ requestId }) => {
        handler?.({ requestId: 'stale', success: true })
        handler?.({ requestId, success: true })
      },
      listen: async (next) => {
        handler = next
        return () => {
          unlistenCount += 1
        }
      },
    }, {
      createRequestId: () => 'request-1',
    })

    await request
    assert.equal(unlistenCount, 1)
  })

  it('rejects a failed acknowledgement and a timeout', async () => {
    let handler: ((response: MainViewportResetComplete) => void) | undefined
    await assert.rejects(requestMainViewportReset({
      emit: async ({ requestId }) => handler?.({ requestId, success: false }),
      listen: async (next) => {
        handler = next
        return () => {}
      },
    }, {
      createRequestId: () => 'failed',
    }), /could not be reset/)

    let timeoutCallback: (() => void) | undefined
    const timedOut = requestMainViewportReset({
      emit: async () => {},
      listen: async () => () => {},
    }, {
      clock: {
        clearTimeout: () => {},
        setTimeout: (callback) => {
          timeoutCallback = callback
          return 1
        },
      },
      createRequestId: () => 'timeout',
      timeoutMs: 5000,
    })
    await Promise.resolve()
    timeoutCallback?.()
    await assert.rejects(timedOut, /timed out/)
  })

  it('does not abandon an acknowledged local reset on a fixed default timer', async () => {
    let handler: ((response: MainViewportResetComplete) => void) | undefined
    let timeoutScheduled = false
    const request = requestMainViewportReset({
      emit: async ({ requestId }) => {
        await Promise.resolve()
        handler?.({ requestId, success: true })
      },
      listen: async (next) => {
        handler = next
        return () => {}
      },
    }, {
      clock: {
        clearTimeout: () => {},
        setTimeout: () => {
          timeoutScheduled = true
          return 1
        },
      },
      createRequestId: () => 'no-default-timeout',
    })

    await request
    assert.equal(timeoutScheduled, false)
  })
})
