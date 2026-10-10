/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import type * as LatestAsyncTaskModule from './latestAsyncTask'

const compiled = ts.transpileModule(readFileSync(new URL('./latestAsyncTask.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

function fixture<T>(worker: (value: T) => Promise<void>, options: {
  mergePending?: (pending: T, incoming: T) => T
  onError?: (error: unknown) => void
} = {}) {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { at: number, run: () => void }>()
  const api = {} as typeof LatestAsyncTaskModule
  runInNewContext(compiled, {
    exports: api,
    performance: { now: () => now },
    setTimeout: (run: () => void, delay: number) => {
      const id = ++nextId
      timers.set(id, { at: now + delay, run })
      return id
    },
    clearTimeout: (id: number) => timers.delete(id),
  })
  const queue = api.createLatestAsyncTaskQueue(worker, { minIntervalMs: 16, ...options })
  return {
    queue,
    now: () => now,
    timers: () => timers.size,
    async advance(target: number) {
      while (true) {
        const ready = [...timers].sort((first, second) => first[1].at - second[1].at)[0]
        if (!ready || ready[1].at > target) break
        now = ready[1].at
        timers.delete(ready[0])
        ready[1].run()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

describe('latest async task cadence', () => {
  it('bounds fast work and delivers the final pending value without another event', async () => {
    const processed: Array<{ value: number, at: number }> = []
    const h = fixture<number>(async (value) => {
      processed.push({ value, at: h.now() })
    })
    for (let at = 0; at < 1000; at++) {
      await h.advance(at)
      h.queue.enqueue(at)
      await flush()
    }
    assert.equal(processed[0].at, 0, 'first work is immediate')
    assert.equal(processed.length, 63)
    assert.equal(h.timers(), 1)
    let idle = false
    const completion = h.queue.whenIdle().then(() => {
      idle = true
    })
    await h.advance(1007)
    assert.equal(idle, false)
    await h.advance(1008)
    await completion
    assert.equal(processed.length, 64)
    assert.equal(processed.at(-1)?.value, 999)
    assert.ok(processed.every((entry, index) => index === 0 || entry.at - processed[index - 1].at >= 16))
    assert.equal(h.timers(), 0)
  })

  it('keeps one delayed task and uses the newest pending value immediately once the interval elapsed', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const processed: Array<{ value: number, at: number }> = []
    let active = 0
    let maximum = 0
    const h = fixture<number>(async (value) => {
      active++
      maximum = Math.max(maximum, active)
      processed.push({ value, at: h.now() })
      if (value === 1) await blocked
      active--
    })
    h.queue.enqueue(1)
    await flush()
    for (let value = 2; value <= 1000; value++) h.queue.enqueue(value)
    await h.advance(20)
    release()
    await h.queue.whenIdle()
    assert.deepEqual(processed, [{ value: 1, at: 0 }, { value: 1000, at: 20 }])
    assert.equal(maximum, 1)
    assert.equal(h.timers(), 0)
  })

  it('does not retain a polling timer while idle or delay an isolated later task', async () => {
    const processed: number[] = []
    const h = fixture<number>(async (value) => {
      processed.push(h.now() + value)
    })
    h.queue.enqueue(1)
    await h.queue.whenIdle()
    assert.equal(h.timers(), 0)
    await h.advance(100)
    h.queue.enqueue(2)
    assert.deepEqual(processed, [1, 102])
    await h.queue.whenIdle()
    assert.equal(h.timers(), 0)
  })

  it('continues the newest pending value after an error without replaying superseded values', async () => {
    const processed: number[] = []
    const errors: unknown[] = []
    const h = fixture<number>(async (value) => {
      processed.push(value)
      if (value === 1) throw new Error('expected')
    }, { onError: error => errors.push(error) })
    h.queue.enqueue(1)
    await flush()
    h.queue.enqueue(2)
    h.queue.enqueue(3)
    await h.advance(16)
    await h.queue.whenIdle()
    assert.deepEqual(processed, [1, 3])
    assert.equal(errors.length, 1)
  })

  it('preserves sticky merge state while pending behind the cadence deadline', async () => {
    const processed: Array<{ value: number, force: boolean }> = []
    const h = fixture<{ value: number, force: boolean }>(async (value) => {
      processed.push(value)
    }, {
      mergePending: (pending, incoming) => ({ ...incoming, force: pending.force || incoming.force }),
    })
    h.queue.enqueue({ value: 1, force: false })
    await h.queue.whenIdle()
    h.queue.enqueue({ value: 2, force: true })
    h.queue.enqueue({ value: 3, force: false })
    await h.advance(16)
    await h.queue.whenIdle()
    assert.deepEqual(processed, [{ value: 1, force: false }, { value: 3, force: true }])
  })

  it('cancels a pending interval wait and lets idle completion settle promptly', async () => {
    const processed: number[] = []
    const h = fixture<number>(async (value) => {
      processed.push(value)
    })
    h.queue.enqueue(1)
    await h.queue.whenIdle()
    h.queue.enqueue(2)
    const completion = h.queue.whenIdle()
    assert.equal(h.timers(), 1)
    h.queue.clear()
    await completion
    assert.equal(h.timers(), 0)
    await h.advance(100)
    assert.deepEqual(processed, [1])
  })

  it('rechecks the deadline if new work arrives just after clearing the previous wait', async () => {
    const processed: number[] = []
    const h = fixture<number>(async (value) => {
      processed.push(value)
    })
    h.queue.enqueue(1)
    await h.queue.whenIdle()
    h.queue.enqueue(2)
    h.queue.clear()
    h.queue.enqueue(3)
    await flush()
    assert.deepEqual(processed, [1])
    await h.advance(16)
    await h.queue.whenIdle()
    assert.deepEqual(processed, [1, 3])
    assert.equal(h.timers(), 0)
  })
})
