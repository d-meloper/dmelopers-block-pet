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
  let inputActive = false
  let status = async () => ordinary
  let prepare = async (): Promise<ElevatedRestartPreparation> => ({ outcome: 'ready', ticket })
  let restart = async (_ticket: string, _isCurrent: () => boolean) => {}
  let disableInput = async (): Promise<ElevationStatus> => {
    inputActive = false
    return { ...await status(), inputElevated: false }
  }
  const preferences = reactive({ alwaysRunAsAdministrator: false, administratorReminderDismissed: false })
  let persist = async (key: keyof typeof preferences, enabled: boolean, _isCurrent: () => boolean) => {
    preferences[key] = enabled
  }
  const owner = createPreferenceElevation({
    status: async () => {
      calls.push('status')
      return { ...await status(), ...(inputActive ? { inputElevated: true } : {}) }
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
      inputActive = true
    },
    disableInput: async () => {
      calls.push('disable')
      return disableInput()
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
    disableInput: (stop: typeof disableInput) => {
      disableInput = stop
    },
    persist: (save: typeof persist) => {
      persist = save
    },
    status: (read: typeof status) => {
      inputActive = false
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

async function open(h: ReturnType<typeof harness>) {
  h.owner.setBlocked(false)
  await h.owner.setVisible(true)
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}

test('hidden startup is inert and the existing visibility/reminder priority still gates activation', async () => {
  const h = harness()
  await h.owner.enable()
  assert.deepEqual(h.calls, [])
  await h.owner.setVisible(true)
  assert.deepEqual(h.calls, ['status'])
  assert.equal(h.owner.open.value, false)
  await h.owner.enable()
  h.owner.setBlocked(false)
  assert.equal(h.owner.open.value, true)
  h.owner.continueNormally()
  await h.owner.setVisible(false)
  await h.owner.setVisible(true)
  assert.equal(h.owner.open.value, false)
  assert.deepEqual(h.calls, ['status', 'status'])
  h.owner.dispose()
})

test('one click and repeated clicks share one UAC, remembered save and immediate activation without a second dialog', async () => {
  const h = harness()
  const ready = deferred<ElevatedRestartPreparation>()
  h.prepare(() => ready.promise)
  await open(h)
  const first = h.owner.enable()
  assert.equal(first, h.owner.enable())
  assert.equal(h.owner.phase.value, 'preparing')
  assert.deepEqual(h.calls, ['status', 'prepare'])
  h.owner.continueNormally()
  assert.equal(h.owner.open.value, true)
  ready.resolve({ outcome: 'ready', ticket })
  await first
  assert.deepEqual(h.calls, ['status', 'prepare', 'save', 'restart', 'status'])
  assert.equal(h.preferences.alwaysRunAsAdministrator, true)
  assert.equal(h.owner.isActive.value, true)
  assert.equal(h.owner.status.value?.elevated, false)
  assert.equal(h.owner.open.value, false)
  assert.equal(h.owner.canManage.value, true)
  await h.owner.enable()
  assert.equal(h.calls.filter(x => x === 'prepare').length, 1)
  h.owner.dispose()
})

test('UAC cancellation neither changes remembered preferences nor claims activation; retry is explicit', async () => {
  for (const remembered of [false, true]) {
    const h = harness()
    h.preferences.alwaysRunAsAdministrator = remembered
    h.prepare(async () => ({ outcome: 'cancelled' }))
    await open(h)
    await h.owner.enable()
    assert.deepEqual(h.calls, ['status', 'prepare'])
    assert.equal(h.preferences.alwaysRunAsAdministrator, remembered)
    assert.equal(h.owner.feedback.value, 'cancelled')
    assert.equal(h.owner.isActive.value, false)
    assert.equal(h.owner.open.value, true)
    h.owner.dispose()
  }
})

for (const operation of ['prepare', 'save', 'restart'] as const) {
  test(`${operation} failure retains the app and saved data and retires only an untransferred ticket`, async () => {
    const h = harness()
    const fail = async () => {
      throw new Error('unavailable')
    }
    if (operation === 'prepare') h.prepare(fail)
    if (operation === 'save') h.persist(fail)
    if (operation === 'restart') h.restart(fail)
    await open(h)
    await h.owner.enable()
    assert.deepEqual(h.errors, [operation])
    assert.equal(h.owner.feedback.value, operation === 'save' ? 'saveFailed' : 'failed')
    assert.equal(h.owner.isActive.value, false)
    assert.equal(h.owner.open.value, true)
    assert.equal(h.owner.busy.value, false)
    assert.equal(h.calls.includes('cancel'), operation === 'save')
    assert.equal(h.preferences.alwaysRunAsAdministrator, operation === 'restart')
    h.owner.dispose()
  })
}

for (const retire of ['hide', 'dispose', 'block'] as const) {
  test(`a UAC ready reply after ${retire} cannot save or activate and cancels the exact prepared child`, async () => {
    const h = harness()
    const ready = deferred<ElevatedRestartPreparation>()
    h.prepare(() => ready.promise)
    await open(h)
    const action = h.owner.enable()
    if (retire === 'hide') await h.owner.setVisible(false)
    else if (retire === 'dispose') h.owner.dispose()
    else h.owner.setBlocked(true)
    ready.resolve({ outcome: 'ready', ticket })
    await action
    assert.deepEqual(h.calls, ['status', 'prepare', 'cancel'])
    assert.equal(h.preferences.alwaysRunAsAdministrator, false)
    h.owner.dispose()
  })
}

test('hide/show cannot revive old UAC intent or a deferred save', async () => {
  for (const phase of ['prepare', 'save']) {
    const h = harness()
    const pending = deferred<any>()
    if (phase === 'prepare') h.prepare(() => pending.promise)
    else h.persist(() => pending.promise)
    await open(h)
    const action = h.owner.enable()
    await settle()
    await h.owner.setVisible(false)
    await h.owner.setVisible(true)
    pending.resolve(phase === 'prepare' ? { outcome: 'ready', ticket } : undefined)
    await action
    assert.equal(h.calls.includes('restart'), false)
    assert.equal(h.calls.filter(x => x === 'cancel').length, 1)
    h.owner.dispose()
  }
})

test('hiding after transfer invalidates the process owner guard without competing cancellation', async () => {
  const h = harness()
  const commit = deferred<void>()
  let current = () => false
  h.restart(async (_ticket, guard) => {
    current = guard
    await commit.promise
  })
  await open(h)
  const action = h.owner.enable()
  await settle()
  assert.equal(current(), true)
  await h.owner.setVisible(false)
  assert.equal(current(), false)
  commit.reject(new Error('APP_PROCESS_CANCELLED'))
  await action
  assert.equal(h.calls.includes('cancel'), false)
  assert.deepEqual(h.errors, [])
  h.owner.dispose()
})

test('a remembered preference alone never marks ordinary input active', async () => {
  const h = harness()
  h.preferences.alwaysRunAsAdministrator = true
  await open(h)
  assert.equal(h.owner.isActive.value, false)
  assert.equal(h.owner.open.value, true)
  h.owner.dispose()
})

test('actual UI or worker elevation suppresses offers and activation without writing preferences', async () => {
  for (const value of [{ ...ordinary, elevated: true }, { ...ordinary, inputElevated: true }]) {
    const h = harness()
    h.status(async () => value)
    await open(h)
    h.owner.requestEnable()
    await h.owner.enable()
    assert.equal(h.owner.isActive.value, true)
    assert.equal(h.owner.open.value, false)
    assert.deepEqual(h.calls, ['status'])
    h.owner.dispose()
  }
})

test('manual enable reopens a dismissed recommendation without the checkbox or changing saved state', async () => {
  const h = harness()
  h.preferences.administratorReminderDismissed = true
  await open(h)
  assert.equal(h.owner.open.value, false)
  h.owner.requestEnable()
  assert.equal(h.owner.open.value, true)
  assert.equal(h.owner.showDismiss.value, false)
  await h.owner.setReminderDismissed(false)
  assert.equal(h.preferences.administratorReminderDismissed, true)
  h.owner.continueNormally()
  assert.equal(h.owner.open.value, false)
  assert.deepEqual(h.calls, ['status'])
  h.owner.dispose()
})

test('automatic reminder checkbox saves in place and preserves the independent remembered choice', async () => {
  const h = harness()
  await open(h)
  await h.owner.setReminderDismissed(true)
  assert.equal(h.owner.open.value, true)
  await h.owner.setReminderDismissed(false)
  assert.equal(h.owner.open.value, true)
  assert.equal(h.preferences.administratorReminderDismissed, false)
  assert.equal(h.preferences.alwaysRunAsAdministrator, false)
  assert.deepEqual(h.calls, ['status', 'save', 'save'])
  h.owner.dispose()
})

test('worker loss updates live status without forgetting the choice or reopening consent', async () => {
  const h = harness()
  h.status(async () => ({ ...ordinary, inputElevated: true }))
  h.preferences.alwaysRunAsAdministrator = true
  await open(h)
  h.status(async () => ordinary)
  await h.owner.refreshStatus()
  assert.equal(h.owner.isActive.value, false)
  assert.equal(h.owner.open.value, false)
  assert.equal(h.preferences.alwaysRunAsAdministrator, true)
  h.owner.requestEnable()
  assert.equal(h.owner.open.value, true)
  h.owner.dispose()
})

test('status errors and late hidden replies never infer a privilege state or request UAC', async () => {
  for (const mode of ['error', 'late']) {
    const h = harness()
    const read = deferred<ElevationStatus>()
    h.status(mode === 'error'
      ? async () => {
        throw new Error('unavailable')
      }
      : () => read.promise)
    h.owner.setBlocked(false)
    const opening = h.owner.setVisible(true)
    if (mode === 'late') {
      await h.owner.setVisible(false)
      read.resolve(ordinary)
    }
    await opening
    h.owner.requestEnable()
    await h.owner.enable()
    assert.equal(h.owner.status.value, undefined)
    assert.equal(h.owner.open.value, false)
    assert.deepEqual(h.calls, ['status'])
    h.owner.dispose()
  }
})

for (const startupAttempt of ['cancelled', 'failed'] as const) {
  test(`startup ${startupAttempt} keeps the existing session reminder suppression and permits explicit retry`, async () => {
    const h = harness()
    h.status(async () => ({ ...ordinary, startupAttempt }))
    await open(h)
    assert.equal(h.owner.open.value, false)
    h.owner.requestEnable()
    assert.equal(h.owner.open.value, true)
    await h.owner.enable()
    assert.equal(h.owner.isActive.value, true)
    h.owner.dispose()
  })
}

test('verified identity errors keep their specific feedback and arbitrary failures stay generic', async () => {
  for (const error of [new Error('ELEVATION_IDENTITY_MISMATCH'), new Error('unavailable')]) {
    const h = harness()
    h.prepare(async () => {
      throw error
    })
    await open(h)
    await h.owner.enable()
    assert.equal(h.owner.feedback.value, error.message === 'ELEVATION_IDENTITY_MISMATCH' ? 'identityMismatch' : 'failed')
    h.owner.dispose()
  }
})

test('disable saves the future choice off, retires input immediately and permits a fresh explicit enable', async () => {
  const h = harness()
  await open(h)
  await h.owner.enable()
  assert.equal(h.owner.isActive.value, true)
  await h.owner.disable()
  assert.equal(h.preferences.alwaysRunAsAdministrator, false)
  assert.equal(h.owner.isActive.value, false)
  assert.equal(h.owner.open.value, false)
  assert.deepEqual(h.calls.slice(-2), ['save', 'disable'])
  h.owner.requestEnable()
  await h.owner.enable()
  assert.equal(h.owner.isActive.value, true)
  assert.equal(h.preferences.alwaysRunAsAdministrator, true)
  h.owner.dispose()
})

for (const failure of ['save', 'stop', 'stillActive']) {
  test(`disable ${failure} never claims that administrator input has stopped`, async () => {
    const h = harness()
    await open(h)
    await h.owner.enable()
    if (failure === 'save') {
      h.persist(async () => {
        throw new Error('SAVE_FAILED')
      })
    } else {
      h.disableInput(async () => {
        if (failure === 'stop') throw new Error('ELEVATION_CHILD_NOT_READY')
        return { ...ordinary, inputElevated: true }
      })
    }
    await assert.rejects(h.owner.disable())
    assert.equal(h.owner.isActive.value, true)
    assert.equal(h.owner.feedback.value, failure === 'save' ? 'saveFailed' : 'disableFailed')
    assert.equal(h.preferences.alwaysRunAsAdministrator, failure === 'save')
    assert.equal(h.calls.includes('disable'), failure !== 'save')
    h.owner.dispose()
  })
}

test('an externally elevated UI stays honestly active and explains that an ordinary launch is needed', async () => {
  const h = harness()
  h.status(async () => ({ ...ordinary, elevated: true }))
  h.preferences.alwaysRunAsAdministrator = true
  await open(h)
  await h.owner.disable()
  assert.equal(h.preferences.alwaysRunAsAdministrator, false)
  assert.equal(h.owner.isActive.value, true)
  assert.equal(h.owner.feedback.value, 'requiresNormalLaunch')
  h.owner.dispose()
})

test('hide while saving disable intent cannot retire the worker after the UI request was invalidated', async () => {
  const h = harness()
  await open(h)
  await h.owner.enable()
  const saved = deferred<void>()
  h.persist(() => saved.promise)
  const action = h.owner.disable()
  await h.owner.setVisible(false)
  saved.resolve()
  await action
  assert.equal(h.calls.includes('disable'), false)
  h.owner.dispose()
})
