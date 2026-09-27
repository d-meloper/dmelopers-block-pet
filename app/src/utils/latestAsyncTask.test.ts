/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createLatestAsyncTaskQueue } from './latestAsyncTask'

describe('createLatestAsyncTaskQueue', () => {
  it('keeps only the latest value while a task is in flight', async () => {
    const processed: number[] = []
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const queue = createLatestAsyncTaskQueue<number>(async (value) => {
      processed.push(value)
      if (value === 1) await firstBlocked
    })

    queue.enqueue(1)
    await Promise.resolve()
    queue.enqueue(2)
    queue.enqueue(3)
    releaseFirst?.()
    await queue.whenIdle()

    assert.deepEqual(processed, [1, 3])
  })

  it('can merge sticky state into the latest pending value', async () => {
    const processed: Array<{ id: number, force: boolean }> = []
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const queue = createLatestAsyncTaskQueue(
      async (value: { id: number, force: boolean }) => {
        processed.push(value)
        if (value.id === 1) await firstBlocked
      },
      {
        mergePending: (pending, incoming) => ({
          ...incoming,
          force: pending.force || incoming.force,
        }),
      },
    )

    queue.enqueue({ id: 1, force: false })
    await Promise.resolve()
    queue.enqueue({ id: 2, force: true })
    queue.enqueue({ id: 3, force: false })
    releaseFirst?.()
    await queue.whenIdle()

    assert.deepEqual(processed, [
      { id: 1, force: false },
      { id: 3, force: true },
    ])
  })

  it('continues after a failed task', async () => {
    const errors: unknown[] = []
    const processed: number[] = []
    const queue = createLatestAsyncTaskQueue<number>(async (value) => {
      processed.push(value)
      if (value === 1) throw new Error('expected')
    }, { onError: error => errors.push(error) })

    queue.enqueue(1)
    await queue.whenIdle()
    queue.enqueue(2)
    await queue.whenIdle()

    assert.deepEqual(processed, [1, 2])
    assert.equal(errors.length, 1)
  })
})
