/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MODEL_3D_CONFIG } from '@/config/model3d'

import {
  createLatestContentBoundsScheduler,
  runBoundedContentBoundsAttempts,
} from './contentBoundsRetry'

const CONTENT_BOUNDS_DEBOUNCE_MS
  = MODEL_3D_CONFIG.renderer.contentBoundsDebounceMs

function createManualSchedulerClock() {
  let now = 0
  let nextHandle = 0
  const timers = new Map<number, { callback: () => void, dueAt: number }>()

  return {
    advanceBy(milliseconds: number) {
      now += milliseconds
      while (true) {
        const dueTimer = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= now)
          .sort((left, right) => left[1].dueAt - right[1].dueAt)[0]
        if (!dueTimer) return
        const [handle, timer] = dueTimer
        timers.delete(handle)
        timer.callback()
      }
    },
    clock: {
      clearTimeout(handle: unknown) {
        timers.delete(handle as number)
      },
      setTimeout(callback: () => void, delayMs: number) {
        const handle = ++nextHandle
        timers.set(handle, { callback, dueAt: now + delayMs })
        return handle
      },
    },
    pendingCount: () => timers.size,
  }
}

describe('bounded content-bounds attempts', () => {
  it('retries failures only up to the configured limit', async () => {
    const attempts: number[] = []
    const waits: number[] = []

    const result = await runBoundedContentBoundsAttempts({
      attempt: async (attemptNumber) => {
        attempts.push(attemptNumber)
        return 'failure'
      },
      maxAttempts: 3,
      waitBeforeRetry: async completedAttempts => void waits.push(completedAttempts),
    })

    assert.deepEqual(result, { attempts: 3, outcome: 'failure' })
    assert.deepEqual(attempts, [1, 2, 3])
    assert.deepEqual(waits, [1, 2])
  })

  it('stops immediately after a successful retry', async () => {
    const result = await runBoundedContentBoundsAttempts({
      attempt: async attemptNumber => attemptNumber === 2 ? 'success' : 'failure',
      maxAttempts: 3,
    })

    assert.deepEqual(result, { attempts: 2, outcome: 'success' })
  })

  it('does not retry a superseded measurement', async () => {
    let attempts = 0
    const result = await runBoundedContentBoundsAttempts({
      attempt: async () => {
        attempts += 1
        return 'stale'
      },
      maxAttempts: 3,
    })

    assert.deepEqual(result, { attempts: 1, outcome: 'stale' })
    assert.equal(attempts, 1)
  })
})

describe('latest content-bounds scheduling', () => {
  it('updates live scale while held without postponing each frame on pointer moves', async () => {
    const manualClock = createManualSchedulerClock()
    const applied: number[] = []
    const scheduler = createLatestContentBoundsScheduler<number>(
      async value => void applied.push(value),
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      manualClock.clock,
    )
    scheduler.setHeld(true)
    scheduler.schedule(90, 'live-scale')
    manualClock.advanceBy(8)
    scheduler.schedule(80, 'live-scale')
    manualClock.advanceBy(8)
    await scheduler.whenIdle()
    assert.deepEqual(applied, [80])
    scheduler.schedule(70, 'live-scale')
    manualClock.advanceBy(16)
    await scheduler.whenIdle()
    assert.deepEqual(applied, [80, 70])
    scheduler.schedule(60, 'live-scale')
    scheduler.setHeld(false)
    manualClock.advanceBy(16)
    await scheduler.whenIdle()
    assert.deepEqual(applied, [80, 70, 60])
  })

  it('finishes an in-flight live resize and coalesces later frames without overlapping readback', async () => {
    const manualClock = createManualSchedulerClock()
    const started: number[] = []
    const rendered: number[] = []
    let releaseFirst = () => {}
    const readback = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const scheduler = createLatestContentBoundsScheduler<number>(
      async (value) => {
        started.push(value)
        if (value === 90) await readback
        rendered.push(value)
      },
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      manualClock.clock,
    )
    scheduler.setHeld(true)
    scheduler.schedule(90, 'live-scale')
    manualClock.advanceBy(16)
    scheduler.schedule(80, 'live-scale')
    manualClock.advanceBy(16)
    scheduler.schedule(70, 'live-scale')
    manualClock.advanceBy(16)
    scheduler.setHeld(false)
    assert.deepEqual(started, [90])
    releaseFirst()
    await scheduler.whenIdle()
    assert.deepEqual(started, [90, 70])
    assert.deepEqual(rendered, [90, 70])
  })

  it('cancels queued live scale when a content change needs settled measurement', async () => {
    const manualClock = createManualSchedulerClock()
    const applied: string[] = []
    const scheduler = createLatestContentBoundsScheduler<string>(
      async value => void applied.push(value),
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      manualClock.clock,
    )
    scheduler.setHeld(true)
    scheduler.schedule('old scale', 'live-scale')
    scheduler.schedule('new skin')
    manualClock.advanceBy(500)
    assert.deepEqual(applied, [])
    scheduler.setHeld(false)
    manualClock.advanceBy(99)
    assert.deepEqual(applied, [])
    manualClock.advanceBy(1)
    await scheduler.whenIdle()
    assert.deepEqual(applied, ['new skin'])
  })

  it('ignores cancelled animation frames after hide or reset and can resume', async () => {
    const frames: Array<() => void> = []
    const applied: number[] = []
    const scheduler = createLatestContentBoundsScheduler<number>(
      async value => void applied.push(value),
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      {
        clearTimeout: () => {},
        setTimeout: () => assert.fail('Live scale must use animation frames'),
        cancelAnimationFrame: () => {},
        requestAnimationFrame: (callback) => {
          frames.push(callback)
          return frames.length
        },
      },
    )
    scheduler.schedule(90, 'live-scale')
    const idle = scheduler.whenIdle()
    scheduler.clear()
    frames[0]()
    await idle
    assert.deepEqual(applied, [])
    scheduler.schedule(100, 'live-scale')
    frames[0]()
    frames[1]()
    await scheduler.whenIdle()
    assert.deepEqual(applied, [100])
  })

  it('can settle the final value after a failed live readback without stranding idle waiters', async () => {
    const manualClock = createManualSchedulerClock()
    const applied: string[] = []
    const errors: unknown[] = []
    let reportError = () => {}
    const failed = new Promise<void>((resolve) => {
      reportError = resolve
    })
    const scheduler = createLatestContentBoundsScheduler<string>(
      async (value) => {
        if (value === 'live') {
          scheduler.schedule('final')
          throw new Error('Native readback failed')
        }
        applied.push(value)
      },
      CONTENT_BOUNDS_DEBOUNCE_MS,
      (error) => {
        errors.push(error)
        reportError()
      },
      manualClock.clock,
    )
    scheduler.setHeld(true)
    scheduler.schedule('live', 'live-scale')
    manualClock.advanceBy(16)
    await failed
    assert.equal(errors.length, 1)
    assert.deepEqual(applied, [])
    const idle = scheduler.whenIdle()
    scheduler.setHeld(false)
    manualClock.advanceBy(CONTENT_BOUNDS_DEBOUNCE_MS)
    await idle
    assert.deepEqual(applied, ['final'])
  })

  it('cancels the release timer on repress and applies only the final value', async () => {
    const manualClock = createManualSchedulerClock()
    const applied: number[] = []
    const scheduler = createLatestContentBoundsScheduler<number>(
      async value => void applied.push(value),
      100,
      error => assert.fail(String(error)),
      manualClock.clock,
    )
    scheduler.schedule(1)
    manualClock.advanceBy(90)
    scheduler.setHeld(true)
    manualClock.advanceBy(1000)
    scheduler.setHeld(false)
    manualClock.advanceBy(90)
    scheduler.setHeld(true)
    scheduler.schedule(2)
    manualClock.advanceBy(1000)
    assert.deepEqual(applied, [])
    scheduler.setHeld(false)
    manualClock.advanceBy(99)
    assert.deepEqual(applied, [])
    manualClock.advanceBy(1)
    await scheduler.whenIdle()
    assert.deepEqual(applied, [2])
  })

  it('settles idle on clear while held and ignores callbacks delivered after hide', async () => {
    const callbacks: Array<() => void> = []
    const applied: number[] = []
    const scheduler = createLatestContentBoundsScheduler<number>(
      async value => void applied.push(value),
      100,
      error => assert.fail(String(error)),
      {
        clearTimeout: () => {},
        setTimeout: (callback) => {
          callbacks.push(callback)
          return callbacks.length
        },
      },
    )
    scheduler.schedule(1)
    scheduler.setHeld(true)
    let idle = false
    const waiting = scheduler.whenIdle().then(() => {
      idle = true
    })
    await Promise.resolve()
    assert.equal(idle, false)
    scheduler.clear()
    scheduler.setHeld(false)
    callbacks.forEach(callback => callback())
    await waiting
    assert.deepEqual(applied, [])
    assert.equal(idle, true)
  })

  it('holds the latest settings until a full quiet period after release', async () => {
    const manualClock = createManualSchedulerClock()
    const applied: number[] = []
    const scheduler = createLatestContentBoundsScheduler<number>(
      async value => void applied.push(value),
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      manualClock.clock,
    )
    scheduler.setHeld(true)
    scheduler.schedule(1)
    scheduler.schedule(2)
    manualClock.advanceBy(1000)
    await Promise.resolve()
    assert.deepEqual(applied, [])
    scheduler.setHeld(false)
    manualClock.advanceBy(99)
    assert.deepEqual(applied, [])
    manualClock.advanceBy(1)
    await scheduler.whenIdle()
    assert.deepEqual(applied, [2])
  })

  it('reports pending immediately and clears it at exactly 100ms', async () => {
    const manualClock = createManualSchedulerClock()
    const pendingStates: boolean[] = []
    const scheduler = createLatestContentBoundsScheduler<undefined>(
      async () => {},
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      manualClock.clock,
      pending => void pendingStates.push(pending),
    )

    scheduler.schedule(undefined)
    assert.deepEqual(pendingStates, [true])
    manualClock.advanceBy(99)
    assert.deepEqual(pendingStates, [true])
    manualClock.advanceBy(1)
    await scheduler.whenIdle()
    assert.deepEqual(pendingStates, [true, false])
  })

  it('keeps pending true without flicker while rescheduling', async () => {
    const manualClock = createManualSchedulerClock()
    const pendingStates: boolean[] = []
    const scheduler = createLatestContentBoundsScheduler<number>(
      async () => {},
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      manualClock.clock,
      pending => void pendingStates.push(pending),
    )

    scheduler.schedule(1)
    manualClock.advanceBy(99)
    scheduler.schedule(2)
    manualClock.advanceBy(99)
    assert.deepEqual(pendingStates, [true])
    manualClock.advanceBy(1)
    await scheduler.whenIdle()
    assert.deepEqual(pendingStates, [true, false])
  })

  it('clears pending when a scheduled measurement is cancelled', () => {
    const manualClock = createManualSchedulerClock()
    const pendingStates: boolean[] = []
    const scheduler = createLatestContentBoundsScheduler<undefined>(
      async () => {},
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      manualClock.clock,
      pending => void pendingStates.push(pending),
    )

    scheduler.schedule(undefined)
    scheduler.clear()

    assert.deepEqual(pendingStates, [true, false])
    assert.equal(manualClock.pendingCount(), 0)
  })

  it('waits 100ms after the last change and measures only once', async () => {
    assert.equal(CONTENT_BOUNDS_DEBOUNCE_MS, 100)

    const manualClock = createManualSchedulerClock()
    const measured: number[] = []
    const scheduler = createLatestContentBoundsScheduler<number>(
      async value => void measured.push(value),
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      manualClock.clock,
    )

    scheduler.schedule(1)
    manualClock.advanceBy(99)
    assert.deepEqual(measured, [])

    scheduler.schedule(2)
    manualClock.advanceBy(99)
    assert.deepEqual(measured, [])

    scheduler.schedule(3)
    manualClock.advanceBy(99)
    assert.deepEqual(measured, [])
    assert.equal(manualClock.pendingCount(), 1)

    manualClock.advanceBy(1)
    await scheduler.whenIdle()

    assert.deepEqual(measured, [3])
    assert.equal(manualClock.pendingCount(), 0)
  })

  it('cancels a pending measurement when cleared', async () => {
    let callback: (() => void) | undefined
    let measured = false
    const scheduler = createLatestContentBoundsScheduler<undefined>(
      async () => {
        measured = true
      },
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      {
        clearTimeout: () => {
          callback = undefined
        },
        setTimeout: (next) => {
          callback = next
          return 1
        },
      },
    )

    scheduler.schedule(undefined)
    scheduler.clear()
    callback?.()
    await Promise.resolve()

    assert.equal(measured, false)
  })

  it('ignores a cancelled callback even if the timer source delivers it', async () => {
    const callbacks: Array<() => void> = []
    const measured: number[] = []
    const scheduler = createLatestContentBoundsScheduler<number>(
      async value => void measured.push(value),
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      {
        clearTimeout: () => {},
        setTimeout: (callback) => {
          callbacks.push(callback)
          return callbacks.length
        },
      },
    )

    scheduler.schedule(1)
    scheduler.schedule(2)
    callbacks[0]?.()
    await Promise.resolve()
    assert.deepEqual(measured, [])

    callbacks[1]?.()
    await scheduler.whenIdle()
    assert.deepEqual(measured, [2])
  })

  it('waits for scene selection work after the quiet period', async () => {
    const manualClock = createManualSchedulerClock()
    const measured: number[] = []
    let settleSelection: (() => void) | undefined
    const selectionSettled = new Promise<void>((resolve) => {
      settleSelection = resolve
    })
    const scheduler = createLatestContentBoundsScheduler<number>(
      async (value) => {
        await selectionSettled
        measured.push(value)
      },
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      manualClock.clock,
    )

    scheduler.schedule(1)
    manualClock.advanceBy(CONTENT_BOUNDS_DEBOUNCE_MS)
    await Promise.resolve()
    assert.deepEqual(measured, [])

    settleSelection?.()
    await scheduler.whenIdle()
    assert.deepEqual(measured, [1])
  })

  it('serializes readbacks and keeps only the latest request while one is running', async () => {
    const callbacks: Array<() => void> = []
    const measured: number[] = []
    let releaseFirst: (() => void) | undefined
    const firstReadback = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const scheduler = createLatestContentBoundsScheduler<number>(
      async (value) => {
        measured.push(value)
        if (value === 1) await firstReadback
      },
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      {
        clearTimeout: () => {},
        setTimeout: (callback) => {
          callbacks.push(callback)
          return callback
        },
      },
    )

    scheduler.schedule(1)
    callbacks.shift()?.()
    await Promise.resolve()
    scheduler.schedule(2)
    scheduler.schedule(3)
    callbacks.at(-1)?.()
    await Promise.resolve()

    assert.deepEqual(measured, [1])
    releaseFirst?.()
    await scheduler.whenIdle()
    assert.deepEqual(measured, [1, 3])
  })

  it('does not report idle while the quiet-period timer is still pending', async () => {
    let callback: (() => void) | undefined
    let idle = false
    const scheduler = createLatestContentBoundsScheduler<number>(
      async () => {},
      CONTENT_BOUNDS_DEBOUNCE_MS,
      error => assert.fail(String(error)),
      {
        clearTimeout: () => {},
        setTimeout: (next) => {
          callback = next
          return 1
        },
      },
    )

    scheduler.schedule(1)
    const waiting = scheduler.whenIdle().then(() => {
      idle = true
    })
    await Promise.resolve()
    assert.equal(idle, false)
    callback?.()
    await waiting
    assert.equal(idle, true)
  })
})
