/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'

import { RecoveryWaitError, waitForRecovery } from './wait'

it('bounds an unresolved operation without cancelling or accepting its late result', async () => {
  let complete!: (value: number) => void
  const operation = new Promise<number>((resolve) => {
    complete = resolve
  })
  await assert.rejects(waitForRecovery(operation, 1), error => error instanceof RecoveryWaitError && error.reason === 'timeout')
  complete(7)
  assert.equal(await operation, 7, 'the operation owner still receives its actual completion')
})

it('cancels observation and still observes a late operation rejection', async () => {
  const abort = new AbortController()
  let fail!: (error: Error) => void
  const operation = new Promise<number>((_resolve, reject) => {
    fail = reject
  })
  const waiting = waitForRecovery(operation, 1000, abort.signal)
  abort.abort()
  await assert.rejects(waiting, error => error instanceof RecoveryWaitError && error.reason === 'cancelled')
  fail(new Error('late failure'))
  await Promise.resolve()
})

it('does not leave a timeout after immediate success or a pre-cancelled owner', async () => {
  assert.equal(await waitForRecovery(Promise.resolve(3), 1000), 3)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(waitForRecovery(Promise.resolve(4), 1000, abort.signal), RecoveryWaitError)
})
