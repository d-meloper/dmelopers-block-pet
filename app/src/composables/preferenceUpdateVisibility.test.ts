/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPreferenceUpdateVisibility } from './preferenceUpdateVisibility'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('a manual refresh repairs a failed visibility subscription before accepting current state', async () => {
  let calls = 0
  let accept!: (visible: boolean) => void
  let releases = 0
  const states: boolean[] = []
  const errors: unknown[] = []
  const owner = createPreferenceUpdateVisibility({
    listen: async (callback) => {
      if (++calls === 1) throw new Error('failed')
      accept = callback
      return () => {
        releases++
      }
    },
    read: async () => true,
    accept: async (value) => {
      states.push(value)
    },
    report: error => errors.push(error),
  })
  await owner.refresh()
  await owner.refresh()
  accept(false)
  assert.equal(calls, 2)
  assert.deepEqual(states, [true, true, false])
  assert.equal(errors.length, 1)
  owner.dispose()
  accept(true)
  assert.equal(releases, 1)
  assert.deepEqual(states, [true, true, false])
})

test('registration timeout joins actual registration, and disposal releases a late handle', async () => {
  const listener = deferred<() => void>()
  let calls = 0
  let releases = 0
  const owner = createPreferenceUpdateVisibility({
    listen: () => {
      calls++
      return listener.promise
    },
    read: async () => false,
    accept: async () => {},
    report: () => {},
  }, 20)
  await owner.refresh()
  await owner.refresh()
  assert.equal(calls, 1)
  owner.dispose()
  listener.resolve(() => {
    releases++
  })
  await settle()
  assert.equal(releases, 1)
})

test('retry never accepts a timed-out visibility query issued before a newer pushed event', async () => {
  const read = deferred<boolean>()
  let accept!: (visible: boolean) => void
  const states: boolean[] = []
  let reads = 0
  const owner = createPreferenceUpdateVisibility({
    listen: async (callback) => {
      accept = callback
      return () => {}
    },
    read: () => {
      reads++
      return read.promise
    },
    accept: async (value) => {
      states.push(value)
    },
    report: () => {},
  }, 20)
  await owner.refresh()
  accept(false)
  const retry = owner.refresh()
  await settle()
  read.resolve(true)
  await retry
  assert.equal(reads, 1)
  assert.deepEqual(states, [false])
  owner.dispose()
})
