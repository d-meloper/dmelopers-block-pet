/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AppUpdateInfo } from '@/services/inAppUpdates'
import type { LatestVersionResponse } from '@/services/manualUpdates'

import { createPreferenceUpdates, UPDATE_REMINDER_WEEK } from './preferenceUpdates'

const available = (version = '1.0.2'): AppUpdateInfo => ({ available: true, currentVersion: '1.0.1', version, bytes: 123 })
function harness(automatic = true, storage = { deadline: 0 }) {
  let time = 1_800_000_000_000
  let result = available()
  let request = async () => result
  let manual: LatestVersionResponse = { status: 'available', currentVersion: '1.0.1', latestVersion: '1.0.2', errorCode: null, lastSuccessAt: 1, lastAttemptAt: 1, fromCache: false }
  const calls: string[] = []
  const errors: string[] = []
  const updates = createPreferenceUpdates({
    enabled: async () => {
      calls.push('profile')
      return automatic
    },
    checkApp: async () => {
      calls.push('check')
      return request()
    },
    checkManual: async () => {
      calls.push('manual')
      return manual
    },
    install: async (phase, progress) => {
      calls.push('install')
      phase('downloading')
      progress(50)
      phase('saving')
      phase('installing')
    },
    openDownloads: async () => {
      calls.push('open')
    },
    hiddenUntil: () => storage.deadline,
    hideUntil: (value) => {
      storage.deadline = value
    },
    now: () => time,
    report: (operation) => {
      errors.push(operation)
    },
  })
  return {
    updates,
    calls,
    errors,
    storage,
    setTime: (value: number) => {
      time = value
    },
    result: (value: AppUpdateInfo) => {
      result = value
    },
    manual: (value: Partial<LatestVersionResponse>) => {
      manual = { ...manual, ...value }
    },
    request: (value: () => Promise<AppUpdateInfo>) => {
      request = value
    },
  }
}

test('hidden startup does not check; each opening checks once and closing dismisses only that opening', async () => {
  const h = harness()
  await h.updates.setVisible(false)
  await h.updates.check()
  assert.deepEqual(h.calls, [])
  await h.updates.setVisible(true)
  assert.deepEqual(h.calls, ['profile', 'check'])
  assert.equal(h.updates.reminderVersion.value, '1.0.2')
  h.updates.dismiss()
  await h.updates.setVisible(true)
  assert.equal(h.updates.reminderVersion.value, undefined)
  assert.equal(h.storage.deadline, 0)
  await h.updates.setVisible(false)
  await h.updates.setVisible(true)
  assert.deepEqual(h.calls, ['profile', 'check', 'check'])
  assert.equal(h.updates.reminderVersion.value, '1.0.2')
})

test('a single seven-day expiry survives restart, covers other versions, and expires exactly at its deadline', async () => {
  const h = harness()
  await h.updates.setVisible(true)
  h.updates.snooze()
  assert.equal(h.storage.deadline, 1_800_000_000_000 + UPDATE_REMINDER_WEEK)
  assert.equal(h.updates.reminderVersion.value, undefined)
  const restarted = harness(true, h.storage)
  restarted.result(available('1.0.3'))
  restarted.setTime(h.storage.deadline - 1)
  await restarted.updates.setVisible(true)
  assert.equal(restarted.updates.reminderVersion.value, undefined)
  await restarted.updates.setVisible(false)
  restarted.setTime(h.storage.deadline)
  await restarted.updates.setVisible(true)
  assert.equal(restarted.updates.reminderVersion.value, '1.0.3')
})

test('late responses from a closed opening are discarded and a quick reopen gets one fresh check', async () => {
  const h = harness()
  let resolve!: (value: AppUpdateInfo) => void
  h.request(() => new Promise((yes) => {
    resolve = yes
  }))
  const first = h.updates.setVisible(true)
  await Promise.resolve()
  await h.updates.setVisible(false)
  const second = h.updates.setVisible(true)
  h.request(async () => available('1.0.3'))
  resolve(available('1.0.2'))
  await Promise.all([first, second])
  assert.deepEqual(h.calls, ['profile', 'check', 'check'])
  assert.equal(h.updates.reminderVersion.value, '1.0.3')
  await h.updates.setVisible(false)
  assert.equal(h.updates.reminderVersion.value, undefined)
})

test('failed, current, stale and disposed checks never offer an update', async () => {
  const h = harness()
  h.request(async () => {
    throw new Error('offline')
  })
  await h.updates.setVisible(true)
  assert.equal(h.updates.reminderVersion.value, undefined)
  assert.deepEqual(h.errors, ['check'])
  await h.updates.setVisible(false)
  h.request(async () => ({ ...available(), available: false }))
  await h.updates.setVisible(true)
  assert.equal(h.updates.reminderVersion.value, undefined)
  h.updates.dispose()
  await h.updates.check()
  assert.equal(h.calls.filter(x => x === 'check').length, 2)
  const manual = harness(false)
  manual.manual({ errorCode: 'staleFeed', fromCache: true })
  await manual.updates.setVisible(true)
  assert.equal(manual.updates.reminderVersion.value, undefined)
})

test('the update button rechecks the accepted version and enters the existing install only once', async () => {
  const h = harness()
  await h.updates.setVisible(true)
  await Promise.all([h.updates.update(), h.updates.update()])
  assert.deepEqual(h.calls, ['profile', 'check', 'check', 'install'])
  assert.equal(h.updates.percent.value, 50)
  assert.equal(h.updates.reminderVersion.value, undefined)
})

test('a changed latest version needs another click; a withdrawn or failed update cannot install', async () => {
  const h = harness()
  await h.updates.setVisible(true)
  h.result(available('1.0.3'))
  await h.updates.update()
  assert.equal(h.updates.reminderVersion.value, '1.0.3')
  assert.ok(!h.calls.includes('install'))
  h.request(async () => {
    throw new Error('signature')
  })
  await h.updates.update()
  assert.ok(!h.calls.includes('install'))
  assert.deepEqual(h.errors, ['install'])
  h.request(async () => ({ ...available(), available: false }))
  await h.updates.update()
  assert.ok(!h.calls.includes('install'))
  assert.equal(h.updates.reminderVersion.value, undefined)
})

test('official builds only open the existing Releases page and never invoke the test updater', async () => {
  const h = harness(false)
  await h.updates.setVisible(true)
  await h.updates.update()
  assert.deepEqual(h.calls, ['profile', 'manual', 'open'])
})

test('reopening during install revalidation cancels that intent before a fresh opening check', async () => {
  const h = harness()
  await h.updates.setVisible(true)
  let resolve!: (value: AppUpdateInfo) => void
  h.request(() => new Promise((yes) => {
    resolve = yes
  }))
  const update = h.updates.update()
  await h.updates.setVisible(false)
  await h.updates.setVisible(true)
  assert.deepEqual(h.calls, ['profile', 'check', 'check'])
  h.request(async () => available('1.0.3'))
  resolve(available('1.0.2'))
  await update
  assert.deepEqual(h.calls, ['profile', 'check', 'check', 'check'])
  assert.equal(h.updates.reminderVersion.value, '1.0.3')
})
