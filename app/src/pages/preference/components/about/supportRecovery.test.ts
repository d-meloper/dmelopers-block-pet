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
  const run = () => owner.run('open', async (current) => {
    await preparation.promise
    if (current()) opened++
  }, error => errors.push(error))
  assert.equal(await run(), false)
  assert.equal(owner.report.value?.status, 'unknown')
  assert.equal(owner.busy.value, true)
  assert.equal(await run(), false)
  preparation.resolve()
  await settle()
  assert.equal(opened, 0)
  assert.equal(owner.busy.value, false)
  assert.equal(owner.report.value?.status, 'unknown')
  assert.equal(owner.report.value?.steps[0]?.state, 'skipped')
  assert.equal(errors.length, 1)
  assert.equal(await run(), true)
  assert.equal(opened, 1)
  assert.equal(owner.report.value?.status, 'unknown', 'opener acknowledgement does not prove appearance or repair')
  owner.dispose()
})

test('failure feedback exposes safe causes only, and a failed clipboard write cannot claim success', async () => {
  const owner = createSupportRecovery()
  const original = new Error('C:/PRIVATE_USER/TOKEN')
  let received: unknown
  const copied = await owner.run('copy', async () => {
    throw original
  }, (error) => {
    received = error
  })
  assert.equal(copied, false)
  assert.equal(received, original)
  assert.equal(owner.report.value?.status, 'unresolved')
  assert.equal(owner.report.value?.cause, 'unclassified_failure')
  assert.ok(owner.report.value?.guidanceKeys?.includes('recovery.guidance.copySupportManually'))
  assert.equal(owner.report.value?.guidanceKeys?.at(-1), 'recovery.guidance.lastResort')
  assert.ok(!JSON.stringify(owner.report.value).includes('PRIVATE'))
  assert.equal(owner.busy.value, false)
  owner.dispose()
})

test('disposal suppresses late support effects, failure feedback and new operations', async () => {
  const owner = createSupportRecovery()
  const preparation = deferred<void>()
  let effects = 0
  let reports = 0
  const running = owner.run('copy', async (current) => {
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
  assert.equal(owner.report.value, undefined)
  assert.equal(await owner.run('open', async () => {
    effects++
  }, () => reports++), false)
})

test('a definite late native failure replaces the observation timeout and retains the actual outcome', async () => {
  const owner = createSupportRecovery(20)
  const effect = deferred<void>()
  let reports = 0
  await owner.run('open', () => effect.promise, () => reports++)
  assert.equal(owner.busy.value, true)
  effect.reject(new Error('LOG_DIRECTORY_FORBIDDEN'))
  await settle()
  assert.equal(owner.busy.value, false)
  assert.equal(owner.report.value?.status, 'unresolved')
  assert.equal(owner.report.value?.cause, 'LOG_DIRECTORY_FORBIDDEN')
  assert.ok(!owner.report.value?.guidanceKeys?.includes('recovery.guidance.lastResort'))
  assert.equal(reports, 2)
  owner.dispose()
})
