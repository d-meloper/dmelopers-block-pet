/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactive } from 'vue'

import type { ElevatedRestartPreparation, ElevationStatus } from './types'

import { createPreferenceElevation } from './preferenceElevation'

const ordinary: ElevationStatus = { supported: true, elevated: false }
const ticket = 'a'.repeat(64)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function harness() {
  const calls: string[] = []
  const errors: string[] = []
  let status = async () => ordinary
  let prepare = async (): Promise<ElevatedRestartPreparation> => ({ outcome: 'ready', ticket })
  let restart = async (_ticket: string, _isCurrent: () => boolean) => {}
  const preferences = reactive({ alwaysRunAsAdministrator: false, administratorReminderDismissed: false })
  let persist = async (key: keyof typeof preferences, enabled: boolean, _isCurrent: () => boolean) => {
    preferences[key] = enabled
  }
  const owner = createPreferenceElevation({
    status: () => {
      calls.push('status')
      return status()
    },
    prepare: () => {
      calls.push('prepare')
      return prepare()
    },
    cancel: async (value) => {
      assert.equal(value, ticket)
      calls.push('cancel')
    },
    restart: async (value, isCurrent) => {
      assert.equal(value, ticket)
      calls.push('restart')
      await restart(value, isCurrent)
    },
    reminderDismissed: () => preferences.administratorReminderDismissed,
    persist: async (key, enabled, isCurrent) => {
      calls.push('save')
      await persist(key, enabled, isCurrent)
    },
    report: operation => errors.push(operation),
  })
  return {
    owner,
    calls,
    errors,
    preferences,
    persist: (save: typeof persist) => {
      persist = save
    },
    status: (read: typeof status) => {
      status = read
    },
    prepare: (read: typeof prepare) => {
      prepare = read
    },
    restart: (action: typeof restart) => {
      restart = action
    },
  }
}

test('hidden startup is inert; accepted opening checks once and waits for other reminders', async () => {
  const h = harness()
  await h.owner.setVisible(false)
  await h.owner.restart()
  assert.deepEqual(h.calls, [])
  await h.owner.setVisible(true)
  await h.owner.setVisible(true)
  assert.deepEqual(h.calls, ['status'])
  assert.equal(h.owner.open.value, false)
  h.owner.setBlocked(false)
  assert.equal(h.owner.open.value, true)
  h.owner.setBlocked(true)
  assert.equal(h.owner.open.value, false)
  h.owner.dispose()
})

for (const status of [
  { supported: false, elevated: false },
  { supported: false, elevated: true },
  { supported: true, elevated: true },
]) {
  test(`unsupported/elevated status offers no action: ${JSON.stringify(status)}`, async () => {
    const h = harness()
    h.status(async () => status)
    h.owner.setBlocked(false)
    await h.owner.setVisible(true)
    await h.owner.restart()
    assert.equal(h.owner.open.value, false)
    assert.deepEqual(h.calls, ['status'])
    h.owner.dispose()
  })
}

test('continuing normally suppresses the reminder for this owner session without another status read', async () => {
  const h = harness()
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  h.owner.continueNormally()
  assert.equal(h.owner.continued.value, true)
  assert.equal(h.owner.open.value, false)
  await h.owner.setVisible(false)
  await h.owner.setVisible(true)
  await h.owner.restart()
  assert.deepEqual(h.calls, ['status'])
  h.owner.dispose()
  const nextSession = harness()
  nextSession.owner.setBlocked(false)
  await nextSession.owner.setVisible(true)
  assert.equal(nextSession.owner.open.value, true)
  nextSession.owner.dispose()
})

test('a hidden or disposed status reply cannot show a reminder', async () => {
  for (const retire of ['hide', 'dispose']) {
    const h = harness()
    const read = deferred<ElevationStatus>()
    h.status(() => read.promise)
    h.owner.setBlocked(false)
    const opening = h.owner.setVisible(true)
    if (retire === 'hide') await h.owner.setVisible(false)
    else h.owner.dispose()
    read.resolve(ordinary)
    await opening
    assert.equal(h.owner.open.value, false)
    assert.equal(h.owner.status.value, undefined)
    h.owner.dispose()
  }
})

test('status failure stays silent and does not repeat until a later opening', async () => {
  const h = harness()
  h.status(async () => {
    throw new Error('unavailable')
  })
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.setVisible(true)
  assert.deepEqual(h.calls, ['status'])
  assert.deepEqual(h.errors, ['status'])
  assert.equal(h.owner.open.value, false)
  h.status(async () => ordinary)
  await h.owner.setVisible(false)
  await h.owner.setVisible(true)
  assert.equal(h.owner.open.value, true)
  h.owner.dispose()
})

test('double clicks share one UAC preparation and start the save/commit owner only after ready', async () => {
  const h = harness()
  const preparation = deferred<ElevatedRestartPreparation>()
  h.prepare(() => preparation.promise)
  h.restart(async (_ticket, isCurrent) => assert.equal(isCurrent(), true))
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.restart()
  assert.deepEqual(h.calls, ['status'])
  const first = h.owner.confirmRestart()
  const second = h.owner.confirmRestart()
  assert.equal(first, second)
  assert.equal(h.owner.phase.value, 'preparing')
  h.owner.continueNormally()
  assert.equal(h.owner.continued.value, false)
  assert.deepEqual(h.calls, ['status', 'prepare'])
  preparation.resolve({ outcome: 'ready', ticket })
  await first
  assert.deepEqual(h.calls, ['status', 'prepare', 'restart'])
  assert.equal(h.owner.handoffUnconfirmed.value, true)
  assert.equal(h.owner.open.value, false)
  await h.owner.restart()
  assert.deepEqual(h.calls, ['status', 'prepare', 'restart'])
  h.owner.dispose()
})

test('UAC cancellation retains the ordinary status and requires another explicit action', async () => {
  const h = harness()
  h.prepare(async () => ({ outcome: 'cancelled' }))
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.restart()
  await h.owner.confirmRestart()
  assert.deepEqual(h.calls, ['status', 'prepare'])
  assert.deepEqual(h.errors, [])
  assert.equal(h.owner.feedback.value, 'cancelled')
  assert.deepEqual(h.owner.status.value, ordinary)
  assert.equal(h.owner.open.value, true)
  assert.equal(h.owner.busy.value, false)
  h.owner.continueNormally()
  await h.owner.setVisible(false)
  await h.owner.setVisible(true)
  assert.deepEqual(h.calls, ['status', 'prepare'])
  h.owner.dispose()
})

for (const operation of ['prepare', 'restart'] as const) {
  test(`${operation} failure retains token knowledge and does not retry or cancel an owner-owned ticket`, async () => {
    const h = harness()
    const fail = async () => {
      throw new Error('failed')
    }
    if (operation === 'prepare') h.prepare(fail)
    else h.restart(fail)
    h.owner.setBlocked(false)
    await h.owner.setVisible(true)
    await h.owner.restart()
    await h.owner.confirmRestart()
    assert.deepEqual(h.calls, operation === 'prepare' ? ['status', 'prepare'] : ['status', 'prepare', 'restart'])
    assert.deepEqual(h.errors, [operation])
    assert.deepEqual(h.owner.status.value, ordinary)
    assert.equal(h.owner.feedback.value, 'failed')
    assert.equal(h.owner.handoffUnconfirmed.value, false)
    assert.equal(h.owner.open.value, true)
    assert.equal(h.owner.busy.value, false)
    h.owner.dispose()
  })
}

for (const retire of ['hide', 'dispose', 'block'] as const) {
  test(`a ready reply after ${retire} cancels the prepared child without starting persistence`, async () => {
    const h = harness()
    const preparation = deferred<ElevatedRestartPreparation>()
    h.prepare(() => preparation.promise)
    h.owner.setBlocked(false)
    await h.owner.setVisible(true)
    await h.owner.restart()
    const action = h.owner.confirmRestart()
    if (retire === 'hide') await h.owner.setVisible(false)
    else if (retire === 'dispose') h.owner.dispose()
    else h.owner.setBlocked(true)
    preparation.resolve({ outcome: 'ready', ticket })
    await action
    assert.deepEqual(h.calls, ['status', 'prepare', 'cancel'])
    assert.equal(h.owner.feedback.value, undefined)
    assert.equal(h.owner.handoffUnconfirmed.value, false)
    h.owner.dispose()
  })
}

test('hide and show cannot revive an older preparation even when ordinary status is confirmed again', async () => {
  const h = harness()
  const preparation = deferred<ElevatedRestartPreparation>()
  h.prepare(() => preparation.promise)
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.restart()
  const action = h.owner.confirmRestart()
  await h.owner.setVisible(false)
  await h.owner.setVisible(true)
  preparation.resolve({ outcome: 'ready', ticket })
  await action
  assert.deepEqual(h.calls, ['status', 'prepare', 'status', 'cancel'])
  assert.equal(h.owner.open.value, true)
  assert.equal(h.owner.busy.value, false)
  h.owner.dispose()
})

for (const retire of ['hide', 'dispose'] as const) {
  test(`${retire} invalidates the owner guard after handoff without a competing cancellation`, async () => {
    const h = harness()
    const committing = deferred<void>()
    let guard = () => false
    h.restart(async (_ticket, isCurrent) => {
      guard = isCurrent
      await committing.promise
    })
    h.owner.setBlocked(false)
    await h.owner.setVisible(true)
    await h.owner.restart()
    const action = h.owner.confirmRestart()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(guard(), true)
    if (retire === 'hide') await h.owner.setVisible(false)
    else h.owner.dispose()
    assert.equal(guard(), false)
    committing.reject(new Error('APP_PROCESS_CANCELLED'))
    await action
    assert.deepEqual(h.calls, ['status', 'prepare', 'restart'])
    assert.deepEqual(h.errors, [])
    assert.equal(h.owner.feedback.value, undefined)
    h.owner.dispose()
  })
}
for (const startupAttempt of ['cancelled', 'failed'] as const) {
  test(`startup ${startupAttempt} suppresses session offers but retains General controls`, async () => {
    const h = harness()
    h.status(async () => ({ ...ordinary, startupAttempt }))
    h.prepare(async () => ({ outcome: 'cancelled' }))
    h.owner.setBlocked(false)
    await h.owner.setVisible(true)
    assert.equal(h.owner.open.value, false)
    assert.equal(h.owner.canManage.value, true)
    assert.equal(h.owner.feedback.value, startupAttempt)
    await h.owner.setVisible(false)
    await h.owner.setVisible(true)
    assert.deepEqual(h.calls, ['status'])
    await h.owner.setAlways(true)
    assert.equal(h.owner.open.value, true)
    await h.owner.restartAlways()
    await h.owner.confirmRestart()
    assert.deepEqual(h.calls, ['status', 'save', 'prepare'])
    h.owner.dispose()
  })
}

test('Always run saves the choice before UAC and preserves it when approval is cancelled', async () => {
  const h = harness()
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  h.prepare(async () => {
    assert.equal(h.preferences.alwaysRunAsAdministrator, true)
    return { outcome: 'cancelled' }
  })
  const action = h.owner.restartAlways()
  assert.equal(action, h.owner.restartAlways())
  await action
  assert.deepEqual(h.calls, ['status', 'save'])
  assert.equal(h.owner.restartConfirmation.value, true)
  await h.owner.confirmRestart()
  assert.deepEqual(h.calls, ['status', 'save', 'prepare'])
  assert.equal(h.preferences.alwaysRunAsAdministrator, true)
  assert.equal(h.owner.feedback.value, 'cancelled')
  assert.equal(h.owner.busy.value, false)
  h.owner.dispose()
})

test('a failed preference save cannot request UAC or hand off the app', async () => {
  const h = harness()
  h.persist(async () => {
    throw new Error('disk unavailable')
  })
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.restartAlways()
  assert.deepEqual(h.calls, ['status', 'save'])
  assert.equal(h.owner.feedback.value, 'saveFailed')
  assert.equal(h.owner.open.value, true)
  h.owner.dispose()
})

test('a hidden intent cannot continue from preference persistence into UAC', async () => {
  const h = harness()
  const saving = deferred<void>()
  h.persist(() => saving.promise)
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  const action = h.owner.restartAlways()
  await h.owner.setVisible(false)
  saving.resolve()
  await action
  assert.deepEqual(h.calls, ['status', 'save'])
  h.owner.dispose()
})

test('permanent dismissal suppresses automatic offers but the settings switch can reopen the dialog', async () => {
  const h = harness()
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.setReminderDismissed(true)
  assert.equal(h.preferences.administratorReminderDismissed, true)
  assert.equal(h.owner.open.value, true)
  h.owner.continueNormally()
  assert.equal(h.owner.open.value, false)
  assert.equal(h.preferences.alwaysRunAsAdministrator, false)
  const next = harness()
  next.preferences.administratorReminderDismissed = true
  next.owner.setBlocked(false)
  await next.owner.setVisible(true)
  assert.equal(next.owner.open.value, false)
  await next.owner.setAlways(true)
  assert.equal(next.owner.open.value, true)
  assert.equal(next.owner.showDismiss.value, false)
  await next.owner.setReminderDismissed(true)
  assert.deepEqual(next.calls, ['status'])
  next.owner.continueNormally()
  assert.equal(next.owner.open.value, false)
  assert.equal(next.owner.showDismiss.value, false)
  assert.equal(next.preferences.administratorReminderDismissed, true)
  assert.equal(next.preferences.alwaysRunAsAdministrator, false)
  assert.deepEqual(next.calls, ['status'])
  h.owner.dispose()
  next.owner.dispose()
})

test('turning the switch off persists immediately and turning it on requires dialog confirmation', async () => {
  const h = harness()
  h.status(async () => ({ supported: true, elevated: true }))
  h.preferences.alwaysRunAsAdministrator = true
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.setAlways(false)
  await h.owner.setAlways(true)
  assert.equal(h.owner.open.value, true)
  assert.equal(h.owner.showDismiss.value, false)
  assert.equal(h.preferences.alwaysRunAsAdministrator, false)
  h.owner.continueNormally()
  assert.equal(h.owner.open.value, false)
  await h.owner.setAlways(true)
  assert.equal(h.owner.open.value, true)
  assert.deepEqual(h.calls, ['status', 'save'])
  assert.equal(h.owner.status.value?.elevated, true)
  assert.equal(h.preferences.alwaysRunAsAdministrator, false)
  h.owner.dispose()
})

test('an already elevated app confirms Always without preparing or restarting another process', async () => {
  const h = harness()
  h.status(async () => ({ supported: true, elevated: true }))
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.setAlways(true)
  await h.owner.restartAlways()
  assert.deepEqual(h.calls, ['status', 'save'])
  assert.equal(h.preferences.alwaysRunAsAdministrator, true)
  assert.equal(h.owner.open.value, false)
  assert.equal(h.owner.busy.value, false)
  assert.equal(h.owner.restartConfirmation.value, false)
  assert.equal(h.owner.handoffUnconfirmed.value, false)
  h.owner.dispose()
})

test('a manual settings dialog rejects its hidden Run once action', async () => {
  const h = harness()
  h.status(async () => ({ supported: true, elevated: true }))
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.setAlways(true)
  await h.owner.restart()
  assert.deepEqual(h.calls, ['status'])
  assert.equal(h.preferences.alwaysRunAsAdministrator, false)
  assert.equal(h.owner.open.value, true)
  assert.equal(h.owner.restartConfirmation.value, false)
  h.owner.dispose()
})

test('a manual Always choice keeps its saved value and dialog when UAC is cancelled', async () => {
  const h = harness()
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  h.owner.continueNormally()
  h.prepare(async () => ({ outcome: 'cancelled' }))
  await h.owner.setAlways(true)
  await h.owner.restartAlways()
  assert.deepEqual(h.calls, ['status', 'save'])
  await h.owner.confirmRestart()
  assert.deepEqual(h.calls, ['status', 'save', 'prepare'])
  assert.equal(h.preferences.alwaysRunAsAdministrator, true)
  assert.equal(h.owner.feedback.value, 'cancelled')
  assert.equal(h.owner.open.value, true)
  assert.equal(h.owner.showDismiss.value, false)
  h.owner.dispose()
})

test('hiding Preferences retires an explicit dialog without reopening it on the next visit', async () => {
  const h = harness()
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  h.owner.continueNormally()
  await h.owner.setAlways(true)
  assert.equal(h.owner.open.value, true)
  await h.owner.setVisible(false)
  await h.owner.setAlways(true)
  assert.equal(h.owner.open.value, false)
  await h.owner.setVisible(true)
  assert.equal(h.owner.open.value, false)
  assert.deepEqual(h.calls, ['status'])
  h.owner.dispose()
})

for (const choice of ['once', 'always'] as const) {
  test(`cancelling the restart confirmation for ${choice} keeps the current app and skips UAC`, async () => {
    const h = harness()
    h.owner.setBlocked(false)
    await h.owner.setVisible(true)
    await h.owner.confirmRestart()
    assert.deepEqual(h.calls, ['status'])
    if (choice === 'always') await h.owner.restartAlways()
    else await h.owner.restart()
    assert.equal(h.owner.open.value, true)
    assert.equal(h.owner.restartConfirmation.value, true)
    assert.equal(h.owner.busy.value, false)
    const expected = choice === 'always' ? ['status', 'save'] : ['status']
    assert.deepEqual(h.calls, expected)
    await h.owner.setReminderDismissed(true)
    assert.equal(h.preferences.administratorReminderDismissed, false)
    h.owner.continueNormally()
    // Keep the second dialog's content during its closing animation.
    assert.equal(h.owner.restartConfirmation.value, true)
    assert.equal(h.owner.open.value, false)
    await h.owner.confirmRestart()
    assert.deepEqual(h.calls, expected)
    assert.equal(h.preferences.alwaysRunAsAdministrator, choice === 'always')
    assert.equal(h.owner.status.value?.elevated, false)
    await h.owner.setVisible(false)
    await h.owner.setVisible(true)
    assert.equal(h.owner.open.value, false)
    h.owner.dispose()
  })
}

test('a hidden confirmation loses its restart intent and a fresh automatic visit starts with the choice dialog', async () => {
  const h = harness()
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.restart()
  await h.owner.setVisible(false)
  await h.owner.confirmRestart()
  await h.owner.setVisible(true)
  assert.equal(h.owner.restartConfirmation.value, false)
  await h.owner.confirmRestart()
  assert.deepEqual(h.calls, ['status', 'status'])
  assert.equal(h.owner.open.value, true)
  h.owner.dispose()
})

test('the reminder checkbox can be checked and unchecked without closing the dialog or changing Always', async () => {
  const h = harness()
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.setReminderDismissed(true)
  assert.equal(h.preferences.administratorReminderDismissed, true)
  assert.equal(h.owner.open.value, true)
  await h.owner.setReminderDismissed(false)
  assert.equal(h.preferences.administratorReminderDismissed, false)
  assert.equal(h.preferences.alwaysRunAsAdministrator, false)
  assert.equal(h.owner.open.value, true)
  assert.deepEqual(h.calls, ['status', 'save', 'save'])
  h.owner.dispose()
})

test('a checked reminder is suppressed on the next Preferences visit without retaining the current dialog hold', async () => {
  const h = harness()
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
  await h.owner.setReminderDismissed(true)
  await h.owner.setVisible(false)
  await h.owner.setVisible(true)
  assert.equal(h.owner.open.value, false)
  assert.equal(h.preferences.administratorReminderDismissed, true)
  assert.deepEqual(h.calls, ['status', 'save', 'status'])
  h.owner.dispose()
})
