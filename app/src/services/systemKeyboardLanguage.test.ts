/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'

import { resolveKeyboardLanguage } from '@/config/keyboardLanguage'

import { createSystemKeyboardLanguageObserver } from './systemKeyboardLanguage'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

it('resolves only system selections; manual languages and input-free previews stay deterministic', () => {
  assert.equal(resolveKeyboardLanguage('system', 'en'), 'en')
  assert.equal(resolveKeyboardLanguage('system', 'ko'), 'ko')
  assert.equal(resolveKeyboardLanguage('en', 'ko'), 'en')
  assert.equal(resolveKeyboardLanguage('ko', 'en'), 'ko')
  assert.equal(resolveKeyboardLanguage('system', 'ja'), 'ja')
  assert.equal(resolveKeyboardLanguage('ja', 'en'), 'ja')
  assert.equal(resolveKeyboardLanguage('en', 'ja'), 'en')
  assert.equal(resolveKeyboardLanguage('system'), 'ko')
})

it('subscribes before enabling, ignores stale snapshots and serializes final disable after pending enable', async () => {
  const registration = deferred<() => void>()
  const reply = deferred<unknown>()
  const calls: boolean[] = []
  const changes: string[] = []
  let accept!: (value: unknown) => void
  let released = 0
  const observer = createSystemKeyboardLanguageObserver({
    listen: (callback) => {
      accept = callback
      return registration.promise
    },
    configure: async (enabled) => {
      calls.push(enabled)
      if (calls.length === 1) return reply.promise
      return { revision: 4, language: 'ko' }
    },
    changed: status => changes.push(status.language),
    failed: () => assert.fail('unexpected observer error'),
  })
  observer.setEnabled(true)
  const started = observer.start()
  assert.deepEqual(calls, [])
  registration.resolve(() => released++)
  await flush()
  assert.deepEqual(calls, [true])
  accept({ revision: 3, language: 'ja' })
  accept({ revision: 2, language: 'ko' })
  accept({ revision: 4, language: 'system' })
  const disposed = observer.dispose()
  reply.resolve({ revision: 1, language: 'ko' })
  await Promise.all([started, disposed])
  accept({ revision: 5, language: 'ko' })
  assert.deepEqual(calls, [true, false])
  assert.deepEqual(changes, ['ja'])
  assert.equal(released, 1)
})

it('releases a late subscription without issuing native demand after its owner ends', async () => {
  const registration = deferred<() => void>()
  let released = 0
  const observer = createSystemKeyboardLanguageObserver({
    listen: () => registration.promise,
    configure: async () => assert.fail('retired owner must not enable'),
    changed: () => assert.fail('retired owner must not receive'),
    failed: () => assert.fail('unexpected observer error'),
  })
  observer.setEnabled(true)
  const started = observer.start()
  await observer.dispose()
  registration.resolve(() => released++)
  await started
  assert.equal(released, 1)
})

it('recovers from a native failure and applies the latest queued intent', async () => {
  let errors = 0
  const calls: boolean[] = []
  const changes: string[] = []
  const observer = createSystemKeyboardLanguageObserver({
    listen: async () => () => {},
    configure: async (enabled) => {
      calls.push(enabled)
      if (calls.length === 1) throw new Error('native unavailable')
      return { revision: 7, language: 'en' }
    },
    changed: status => changes.push(status.language),
    failed: () => errors++,
  })
  await observer.start()
  observer.setEnabled(true)
  await flush()
  assert.deepEqual(calls, [false, true])
  assert.deepEqual(changes, ['en'])
  assert.equal(errors, 1)
  await observer.dispose()
})
