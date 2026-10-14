/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DistributionChannel } from '@/services/distribution'
import type { AppUpdateInfo } from '@/services/inAppUpdates'
import type { UpdateReminderSnooze } from '@/stores/general'

import { createPreferenceUpdates, UPDATE_REMINDER_WEEK } from './preferenceUpdates'

const available = (version = '1.0.2'): AppUpdateInfo => ({ available: true, currentVersion: '1.0.1', version, bytes: 123 })
function harness(channel: DistributionChannel = 'github', storage: UpdateReminderSnooze = { version: '', hiddenUntil: 0 }) {
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
    reminderSnooze: () => storage,
    snoozeReminder: (value) => {
      Object.assign(storage, value)
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
  assert.deepEqual(h.storage, { version: '', hiddenUntil: 0 })
  await h.updates.setVisible(false)
  await h.updates.setVisible(true)
  assert.deepEqual(h.calls, ['profile', 'check', 'check'])
  assert.equal(h.updates.reminderVersion.value, '1.0.2')
})

test('a seven-day snooze survives restart for its offered version and expires exactly at its deadline', async () => {
  const h = harness()
  await h.updates.setVisible(true)
  h.updates.snooze()
  assert.deepEqual(h.storage, { version: '1.0.2', hiddenUntil: 1_800_000_000_000 + UPDATE_REMINDER_WEEK })
  assert.equal(h.updates.reminderVersion.value, undefined)
  const restarted = harness('github', h.storage)
  restarted.setTime(h.storage.hiddenUntil - 1)
  await restarted.updates.setVisible(true)
  assert.equal(restarted.updates.reminderVersion.value, undefined)
  await restarted.updates.setVisible(false)
  restarted.setTime(h.storage.hiddenUntil)
  await restarted.updates.setVisible(true)
  assert.equal(restarted.updates.reminderVersion.value, '1.0.2')
})

test('a different offered version is visible before the deadline, including after application upgrade', async () => {
  const h = harness()
  await h.updates.setVisible(true)
  h.updates.snooze()
  const saved = { ...h.storage }
  for (const currentVersion of ['1.0.1', '1.0.2', '1.0.3']) {
    const restarted = harness('github', h.storage)
    restarted.result({ ...available('1.0.4'), currentVersion })
    restarted.setTime(saved.hiddenUntil - 1)
    await restarted.updates.setVisible(true)
    assert.equal(restarted.updates.reminderVersion.value, '1.0.4')
    assert.deepEqual(h.storage, saved, 'checking never rebinds a stored target')
  }
})

test('snoozing a later offer replaces the pair; dismissed, busy, hidden and disposed reminders cannot snooze', async () => {
  const h = harness()
  h.updates.snooze()
  assert.deepEqual(h.storage, { version: '', hiddenUntil: 0 })
  await h.updates.setVisible(true)
  h.updates.dismiss()
  h.updates.snooze()
  assert.deepEqual(h.storage, { version: '', hiddenUntil: 0 })
  await h.updates.check()
  let resolve!: (value: AppUpdateInfo) => void
  h.request(() => new Promise((yes) => {
    resolve = yes
  }))
  const pending = h.updates.check()
  h.updates.snooze()
  assert.deepEqual(h.storage, { version: '', hiddenUntil: 0 })
  resolve(available())
  await pending
  h.updates.snooze()
  const first = { ...h.storage }
  h.request(async () => available('1.0.3'))
  await h.updates.check()
  assert.equal(h.updates.reminderVersion.value, '1.0.3')
  h.setTime(1_800_000_000_100)
  h.updates.snooze()
  assert.deepEqual(h.storage, { version: '1.0.3', hiddenUntil: first.hiddenUntil + 100 })
  const saved = { ...h.storage }
  await h.updates.setVisible(false)
  h.updates.snooze()
  h.updates.dispose()
  h.updates.snooze()
  assert.deepEqual(h.storage, saved)
})

test('empty targets and invalid or expired deadlines never suppress an offered update', async () => {
  for (const storage of [
    { version: '', hiddenUntil: 1_800_604_800_000 },
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map(hiddenUntil => ({ version: '1.0.2', hiddenUntil })),
  ]) {
    const h = harness('github', storage)
    await h.updates.setVisible(true)
    assert.equal(h.updates.reminderVersion.value, '1.0.2')
  }
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
