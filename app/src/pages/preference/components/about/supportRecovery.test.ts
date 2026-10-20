/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSupportRecovery } from './supportRecovery'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('support timeout retains actual ownership and blocks late preparation from opening or copying', async () => {
  const owner = createSupportRecovery(20)
  const preparation = deferred<void>()
  let opened = 0
  const errors: unknown[] = []
  const run = () => owner.run(async (current) => {
    await preparation.promise
    if (current()) opened++
  }, error => errors.push(error))
  assert.equal(await run(), false)
  assert.equal(owner.busy.value, true)
  assert.equal(await run(), false)
  preparation.resolve()
  await settle()
  assert.equal(opened, 0)
  assert.equal(owner.busy.value, false)
  assert.equal(errors.length, 1)
  assert.equal(await run(), true)
  assert.equal(opened, 1)
  owner.dispose()
})

test('a failed clipboard write forwards the original failure and cannot claim success', async () => {
  const owner = createSupportRecovery()
  const original = new Error('C:/PRIVATE_USER/TOKEN')
  let received: unknown
  const copied = await owner.run(async () => {
    throw original
  }, (error) => {
    received = error
  })
  assert.equal(copied, false)
  assert.equal(received, original)
  assert.equal('report' in owner, false, 'support actions no longer produce persistent feedback')
  assert.equal(owner.busy.value, false)
  owner.dispose()
})

test('disposal suppresses late support effects, failure feedback and new operations', async () => {
  const owner = createSupportRecovery()
  const preparation = deferred<void>()
  let effects = 0
  let reports = 0
  const running = owner.run(async (current) => {
    await preparation.promise
    if (current()) effects++
  }, () => reports++)
  await settle()
  owner.dispose()
  assert.equal(await running, false)
  preparation.resolve()
  await settle()
  assert.equal(effects, 0)
  assert.equal(reports, 0)
  assert.equal(await owner.run(async () => {
    effects++
  }, () => reports++), false)
})

test('a definite late native failure is still reported after the observation timeout', async () => {
  const owner = createSupportRecovery(20)
  const effect = deferred<void>()
  let reports = 0
  let lastError: unknown
  await owner.run(() => effect.promise, (error) => {
    reports++
    lastError = error
  })
  assert.equal(owner.busy.value, true)
  const failure = new Error('LOG_DIRECTORY_FORBIDDEN')
  effect.reject(failure)
  await settle()
  assert.equal(owner.busy.value, false)
  assert.equal(lastError, failure)
  assert.equal(reports, 2)
  owner.dispose()
})
