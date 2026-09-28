/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DistributionChannel } from '@/services/distribution'
import type { AppUpdateInfo } from '@/services/inAppUpdates'

import { createPreferenceUpdates, UPDATE_REMINDER_WEEK } from './preferenceUpdates'

const available = (version = '1.0.2'): AppUpdateInfo => ({ available: true, currentVersion: '1.0.1', version, bytes: 123 })
function harness(channel: DistributionChannel = 'github', storage = { deadline: 0 }) {
  let time = 1_800_000_000_000
  let result = available()
  let request = async () => result
  const calls: string[] = []
  const freshness: boolean[] = []
  const errors: string[] = []
  const updates = createPreferenceUpdates({
    channel: async () => {
      calls.push('profile')
      return channel
    },
    checkApp: async (force) => {
      freshness.push(force)
      calls.push('check')
      return request()
    },
    install: async (phase, progress) => {
      calls.push('install')
      phase('downloading')
      progress(50)
      phase('saving')
      phase('installing')
    },
    cancel: async () => {
      calls.push('cancel')
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
    freshness,
    errors,
    storage,
    setTime: (value: number) => {
      time = value
    },
    result: (value: AppUpdateInfo) => {
      result = value
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
  const restarted = harness('github', h.storage)
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

test('Store and development never enter the GitHub check or installation path', async () => {
  for (const channel of ['store', 'development'] as const) {
    const h = harness(channel)
    await h.updates.setVisible(true)
    await h.updates.check()
    await h.updates.update()
    assert.deepEqual(h.calls, ['profile'])
    assert.equal(h.updates.reminderVersion.value, undefined)
  }
})

test('opening allows a display cache; explicit checks and installation always refresh', async () => {
  const h = harness()
  await h.updates.setVisible(true)
  await h.updates.check()
  await h.updates.update()
  assert.deepEqual(h.freshness, [false, true, true])
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
