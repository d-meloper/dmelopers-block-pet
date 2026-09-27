/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { UpdateFailure } from './failure'

import { failureReasonKey, observeUpdateFailure } from './failure'

const failure: UpdateFailure = { notificationId: 'first', requestId: 'request', reason: 'INSTALLER_FAILED', outcome: 'recovering', sourceVersion: '1.0.0', targetVersion: '1.1.0' }

test('a recovery result push supersedes a delayed initial failure query', async () => {
  let notify!: (failure: UpdateFailure | null) => void
  let read!: (failure: UpdateFailure | null) => void
  const accepted: Array<UpdateFailure | null> = []
  let closed = 0
  const observing = observeUpdateFailure({
    listen: async (accept) => {
      notify = accept
      return () => {
        closed++
      }
    },
    read: () => new Promise((resolve) => {
      read = resolve
    }),
    accept: value => accepted.push(value),
    active: () => true,
  })
  await Promise.resolve()
  const recovered = { ...failure, notificationId: 'second', outcome: 'rolledBack' } as const
  notify(recovered)
  read(failure)
  const stop = await observing
  assert.deepEqual(accepted, [recovered])
  stop()
  assert.equal(closed, 1)
})

test('closed failure dialogs do not receive a late initial query and release their subscription', async () => {
  let active = true
  let read!: (failure: UpdateFailure | null) => void
  let closed = 0
  const observing = observeUpdateFailure({
    listen: async () => () => {
      closed++
    },
    read: () => new Promise((resolve) => {
      read = resolve
    }),
    accept: () => assert.fail('disposed dialog changed'),
    active: () => active,
  })
  await Promise.resolve()
  active = false
  read(failure)
  const stop = await observing
  stop()
  assert.equal(closed, 1)
})

test('failure explanations distinguish validation, install, startup and storage boundaries', () => {
  for (const [code, key] of [['SIGNATURE_INVALID', 'verification'], ['INSTALLER_FAILED', 'installer'], ['PROGRAM_COMMIT_FAILED', 'installer'], ['PROGRAM_COMMIT_STATE_UNKNOWN', 'installer'], ['RENDER_FAILED', 'startup'], ['WRITE_FAILED', 'storage'], ['SNAPSHOT_FAILED:READ_FAILED', 'preparation'], ['ROLLBACK_FAILED', 'recovery'], ['unrecognized', 'unknown']]) {
    assert.equal(failureReasonKey(code!), key)
  }
})
