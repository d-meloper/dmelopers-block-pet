import { createLatestAsyncTaskQueue } from '@/utils/latestAsyncTask'

export type ContentBoundsAttemptOutcome = 'failure' | 'stale' | 'success'

export interface ContentBoundsRetryResult {
  attempts: number
  outcome: ContentBoundsAttemptOutcome
}

interface ContentBoundsRetryOptions {
  attempt: (attemptNumber: number) => Promise<ContentBoundsAttemptOutcome>
  maxAttempts: number
  waitBeforeRetry?: (completedAttempts: number) => Promise<void>
}

interface ContentBoundsSchedulerClock {
  clearTimeout: (handle: unknown) => void
  setTimeout: (callback: () => void, delayMs: number) => unknown
  cancelAnimationFrame?: (handle: unknown) => void
  requestAnimationFrame?: (callback: () => void) => unknown
}

export type ViewportUpdateMode = 'settled' | 'live-scale'

export interface LatestContentBoundsScheduler<T> {
  clear: () => void
  schedule: (request: T, mode?: ViewportUpdateMode) => void
  setHeld: (held: boolean) => void
  whenIdle: () => Promise<void>
}

export function createLatestContentBoundsScheduler<T>(
  worker: (request: T) => Promise<void>,
  quietPeriodMs: number,
  onError: (error: unknown) => void,
  clock: ContentBoundsSchedulerClock = {
    clearTimeout: handle => globalThis.clearTimeout(
      handle as ReturnType<typeof setTimeout>,
    ),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    cancelAnimationFrame: handle => globalThis.cancelAnimationFrame(handle as number),
    requestAnimationFrame: callback => globalThis.requestAnimationFrame(callback),
  },
  onPendingChange: (pending: boolean) => void = () => {},
): LatestContentBoundsScheduler<T> {
  let generation = 0
  let pending = false
  let timeout: unknown
  let frame: unknown
  let held = false
  interface Task { request: T, generation: number, mode: ViewportUpdateMode }
  let latest: Task | undefined
  const timeoutWaiters = new Set<() => void>()
  const queue = createLatestAsyncTaskQueue(async (task: Task) => {
    if ((held && task.mode === 'settled') || task.generation !== generation) return
    try {
      await worker(task.request)
    } finally {
      if (latest === task) latest = undefined
    }
  }, { onError })

  const notifyTimeoutSettled = () => {
    for (const resolve of timeoutWaiters) resolve()
    timeoutWaiters.clear()
  }

  const setPending = (nextPending: boolean) => {
    if (pending === nextPending) return
    pending = nextPending
    onPendingChange(pending)
  }

  const cancelTimer = () => {
    generation += 1
    if (timeout !== undefined) clock.clearTimeout(timeout)
    if (frame !== undefined) (clock.cancelAnimationFrame ?? clock.clearTimeout)(frame)
    timeout = undefined
    frame = undefined
    queue.clear()
    notifyTimeoutSettled()
  }

  const clear = () => {
    cancelTimer()
    latest = undefined
    setPending(false)
  }

  const waitForTimeoutToSettle = async (): Promise<void> => {
    if (!pending) return
    await new Promise<void>(resolve => timeoutWaiters.add(resolve))
    await waitForTimeoutToSettle()
  }

  const whenIdle = async (): Promise<void> => {
    await waitForTimeoutToSettle()
    await queue.whenIdle()
    if (pending) await whenIdle()
  }

  const arm = () => {
    if (!latest) return
    setPending(true)
    if (latest.mode === 'live-scale') {
      // Keep the frame deadline while the pointer moves; debounce would starve
      // continuous input. The same queue serializes native resize readbacks.
      if (frame !== undefined) return
      const requestGeneration = generation
      const scheduleFrame = clock.requestAnimationFrame
        ?? ((callback: () => void) => clock.setTimeout(callback, 16))
      const scheduledFrame = scheduleFrame(() => {
        if (requestGeneration !== generation || frame !== scheduledFrame || !latest) return
        frame = undefined
        setPending(false)
        notifyTimeoutSettled()
        queue.enqueue(latest)
      })
      frame = scheduledFrame
      return
    }
    if (held) return
    const task = latest
    const requestGeneration = generation
    const scheduledTimeout = clock.setTimeout(() => {
      if (held || requestGeneration !== generation || timeout !== scheduledTimeout) return
      timeout = undefined
      setPending(false)
      notifyTimeoutSettled()
      queue.enqueue(task)
    }, quietPeriodMs)
    timeout = scheduledTimeout
  }

  return {
    clear,
    setHeld(nextHeld) {
      if (held === nextHeld) return
      held = nextHeld
      if (latest?.mode === 'live-scale') return
      cancelTimer()
      if (latest) latest = { ...latest, generation }
      arm()
    },
    schedule(request, mode = 'settled') {
      if (mode === 'settled' || latest?.mode !== mode) cancelTimer()
      else queue.clear()
      latest = { request, generation, mode }
      arm()
    },
    whenIdle,
  }
}

export async function runBoundedContentBoundsAttempts({
  attempt,
  maxAttempts,
  waitBeforeRetry = async () => {},
}: ContentBoundsRetryOptions): Promise<ContentBoundsRetryResult> {
  const attemptLimit = Number.isFinite(maxAttempts)
    ? Math.max(1, Math.floor(maxAttempts))
    : 1

  for (let attemptNumber = 1; attemptNumber <= attemptLimit; attemptNumber += 1) {
    const outcome = await attempt(attemptNumber)
    if (outcome !== 'failure' || attemptNumber === attemptLimit) {
      return { attempts: attemptNumber, outcome }
    }
    await waitBeforeRetry(attemptNumber)
  }

  return { attempts: attemptLimit, outcome: 'failure' }
}
