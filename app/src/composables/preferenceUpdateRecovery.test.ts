/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AppUpdateInfo, UpdatePhase } from '@/services/inAppUpdates'

import { createPreferenceUpdateRecovery, updateRecoveryGuidance } from './preferenceUpdateRecovery'

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
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
const available = (version = '1.1.3'): AppUpdateInfo => ({ available: true, currentVersion: '1.1.2', version, bytes: 10 })
function harness(timeoutMs = 1000) {
  let read = async (_force: boolean) => available()
  let install = async (_phase: (value: UpdatePhase) => void, _progress: (value: number) => void) => {}
  const calls: boolean[] = []
  const errors: unknown[] = []
  let installs = 0
  const owner = createPreferenceUpdateRecovery({
    channel: async () => 'github',
    checkApp: (force) => {
      calls.push(force)
      return read(force)
    },
    install: (phase, progress) => {
      installs++
      return install(phase, progress)
    },
    cancel: async () => {},
    reminderSnooze: () => ({ version: '', hiddenUntil: 0 }),
    snoozeReminder: () => {},
    report: (_operation, error) => errors.push(error),
  }, timeoutMs)
  return {
    owner,
    calls,
    errors,
    installs: () => installs,
    read: (work: typeof read) => {
      read = work
    },
    install: (work: typeof install) => {
      install = work
    },
  }
}

test('a failed signed check retains only safe cause/guidance and retry verifies fresh metadata', async () => {
  const h = harness()
  const error = new Error('UPDATE_SIGNATURE_INVALID')
  h.read(async () => {
    throw error
  })
  await h.owner.setVisible(true)
  assert.equal(h.owner.recovery.value?.status, 'unresolved')
  assert.equal(h.owner.recovery.value?.cause, 'UPDATE_SIGNATURE_INVALID')
  assert.ok(h.owner.recovery.value?.guidanceKeys?.includes('recovery.guidance.verifyUpdate'))
  assert.ok(!h.owner.recovery.value?.guidanceKeys?.includes('recovery.guidance.lastResort'))
  assert.equal(h.errors[0], error, 'the diagnostic owner retains the actual operation failure')
  h.read(async () => available())
  await h.owner.check(true)
  assert.deepEqual(h.calls, [false, true])
  assert.equal(h.owner.recovery.value?.summaryKey, 'recovery.summary.updateCheckComplete')
  assert.equal(h.installs(), 0)
  h.owner.dispose()
})

test('metadata timeout never starts concurrent reads or accepts a late failed attempt as recovery', async () => {
  const h = harness(20)
  const read = deferred<AppUpdateInfo>()
  h.read(() => read.promise)
  await h.owner.setVisible(true)
  assert.equal(h.owner.busy.value, false)
  assert.equal(h.owner.recovery.value?.status, 'unknown')
  assert.equal(h.owner.appInfo.value, undefined)
  await h.owner.check(true)
  assert.deepEqual(h.calls, [false], 'fresh retry is serialized behind the actual timed-out read')
  h.read(async () => available('1.1.4'))
  read.resolve(available('1.1.3'))
  await settle()
  assert.equal(h.owner.appInfo.value, undefined)
  assert.equal(h.owner.recovery.value?.status, 'unknown')
  await h.owner.check(true)
  assert.deepEqual(h.calls, [false, true])
  assert.equal((h.owner.appInfo.value as AppUpdateInfo | undefined)?.version, '1.1.4')
  assert.equal(h.owner.recovery.value?.status, 'recovered')
  h.owner.dispose()
})

test('closed/reopened and disposed owners preserve supersession rather than a stale success report', async () => {
  const h = harness()
  const read = deferred<AppUpdateInfo>()
  h.read(() => read.promise)
  const first = h.owner.setVisible(true)
  await settle()
  await h.owner.setVisible(false)
  const second = h.owner.setVisible(true)
  h.read(async () => available('1.1.4'))
  read.resolve(available('1.1.3'))
  await Promise.all([first, second])
  assert.equal(h.owner.appInfo.value?.version, '1.1.4')
  const retired = deferred<AppUpdateInfo>()
  h.read(() => retired.promise)
  const checking = h.owner.check()
  await settle()
  h.owner.dispose()
  await checking
  retired.reject(new Error('C:/PRIVATE_USER/TOKEN'))
  await settle()
  assert.equal(h.owner.recovery.value, undefined)
  assert.equal(h.errors.length, 0)
})

test('a stalled installer retains its busy gate and its eventual handoff stays unconfirmed without replay', async () => {
  const h = harness(20)
  const install = deferred<void>()
  h.install(async (phase) => {
    phase('saving')
    await install.promise
  })
  await h.owner.setVisible(true)
  const updating = h.owner.update()
  await settle()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(h.owner.recovery.value?.status, 'unknown')
  assert.equal(h.owner.busy.value, true)
  await h.owner.update()
  assert.equal(h.installs(), 1)
  install.resolve()
  await updating
  assert.equal(h.owner.recovery.value?.summaryKey, 'recovery.summary.updateHandoffUnknown')
  assert.equal(h.owner.handoffUnconfirmed.value, true)
  await h.owner.check()
  await h.owner.setVisible(false)
  await h.owner.setVisible(true)
  assert.equal(h.owner.recovery.value?.summaryKey, 'recovery.summary.updateHandoffUnknown')
  await h.owner.update()
  assert.equal(h.installs(), 1)
  h.owner.dispose()
})

test('a hidden opening never calls a discarded metadata reply recovered', async () => {
  const h = harness()
  const read = deferred<AppUpdateInfo>()
  h.read(() => read.promise)
  const opening = h.owner.setVisible(true)
  await settle()
  await h.owner.setVisible(false)
  read.resolve(available())
  await opening
  assert.equal(h.owner.appInfo.value, undefined)
  assert.notEqual(h.owner.recovery.value?.status, 'recovered')
  h.owner.dispose()
})

test('exact cancellation is silent; raw text containing a cancellation code remains a failed operation', async () => {
  for (const error of ['UPDATE_CANCELLED', 'C:/PRIVATE/UPDATE_CANCELLED/TOKEN']) {
    const h = harness()
    h.install(async () => {
      throw error
    })
    await h.owner.setVisible(true)
    await h.owner.update()
    if (error === 'UPDATE_CANCELLED') {
      assert.equal(h.errors.length, 0)
      assert.equal(h.owner.recovery.value?.status, 'cancelled')
    } else {
      assert.deepEqual(h.errors, [error])
      assert.equal(h.owner.recovery.value?.cause, 'unclassified_failure')
      assert.equal(h.owner.recovery.value?.status, 'unresolved')
      assert.equal(h.owner.recovery.value?.guidanceKeys?.at(-1), 'recovery.guidance.lastResort')
      assert.ok(!JSON.stringify(h.owner.recovery.value).includes('PRIVATE'))
    }
    h.owner.dispose()
  }
})

test('cause guidance covers current native signed updater, save barrier and uncertain result codes', () => {
  for (const [code, guidance] of [
    ['UPDATE_NETWORK_FAILED', 'checkNetwork'],
    ['UPDATE_HASH_INVALID', 'verifyUpdate'],
    ['UPDATE_CACHE_UNAVAILABLE', 'checkStorage'],
    ['UPDATE_BUSY', 'waitForOperation'],
    ['SAVE_VERIFICATION_FAILED', 'preserveSettings'],
    ['UPDATE_INSTALL_FAILED', 'manualUpdate'],
    ['unclassified_failure', 'retryUpdateCheck'],
  ]) assert.equal(updateRecoveryGuidance(code!), `recovery.guidance.${guidance}`)
})
