/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runViewportResetFlow } from './viewportResetFlow'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('main viewport reset flow', () => {
  it('waits for selection settlement before centering', async () => {
    const settlement = createDeferred<boolean>()
    const settlementStarted = createDeferred<void>()
    const events: string[] = []
    let centerCalls = 0

    const reset = runViewportResetFlow({
      async centerViewport() {
        events.push('center')
        centerCalls += 1
        return true
      },
      isCurrent: () => true,
      async settleSelection() {
        events.push('settle-start')
        settlementStarted.resolve()
        const settled = await settlement.promise
        events.push('settle-end')
        return settled
      },
    })

    await settlementStarted.promise
    assert.deepEqual(events, ['settle-start'])
    assert.equal(centerCalls, 0)

    settlement.resolve(true)
    assert.equal(await reset, true)
    assert.deepEqual(events, ['settle-start', 'settle-end', 'center'])
  })

  it('cancels stale work after selection settlement', async () => {
    let current = true
    let centerCalls = 0

    const completed = await runViewportResetFlow({
      async centerViewport() {
        centerCalls += 1
        return true
      },
      isCurrent: () => current,
      async settleSelection() {
        current = false
        return true
      },
    })

    assert.equal(completed, false)
    assert.equal(centerCalls, 0)
  })

  it('reports success only after the full ordered flow completes', async () => {
    const events: string[] = []

    const completed = await runViewportResetFlow({
      async centerViewport() {
        events.push('center')
        return true
      },
      isCurrent: () => true,
      async settleSelection() {
        events.push('settle')
        return true
      },
    })

    assert.equal(completed, true)
    assert.deepEqual(events, ['settle', 'center'])
  })
})
