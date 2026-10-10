export interface LatestAsyncTaskQueue<T> {
  enqueue: (value: T) => void
  clear: () => void
  whenIdle: () => Promise<void>
}

interface LatestAsyncTaskOptions<T> {
  /** Bounds successful fast work as well as delayed work; the final value still runs. */
  minIntervalMs?: number
  mergePending?: (pending: T, incoming: T) => T
  onError?: (error: unknown) => void
}

export function createLatestAsyncTaskQueue<T>(
  worker: (value: T) => Promise<void>,
  options: LatestAsyncTaskOptions<T> = {},
): LatestAsyncTaskQueue<T> {
  let pending: T | undefined
  let running: Promise<void> | undefined
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 0)
  let lastStartedAt = Number.NEGATIVE_INFINITY
  let releaseIntervalWait: (() => void) | undefined

  const drain = async () => {
    while (pending !== undefined) {
      if (minIntervalMs > 0) {
        let delay = minIntervalMs - (performance.now() - lastStartedAt)
        while (delay > 0) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer)
              releaseIntervalWait = undefined
              resolve()
            }
            const timer = setTimeout(finish, Math.ceil(delay))
            releaseIntervalWait = finish
          })
          if (pending === undefined) return
          delay = minIntervalMs - (performance.now() - lastStartedAt)
        }
        lastStartedAt = performance.now()
      }
      const current = pending
      pending = undefined
      try {
        await worker(current)
      } catch (error) {
        options.onError?.(error)
      }
    }
  }

  const start = () => {
    if (running) return
    running = drain().finally(() => {
      running = undefined
      if (pending !== undefined) start()
    })
  }

  const waitForIdle = async (): Promise<void> => {
    const current = running
    if (!current) return
    await current
    return waitForIdle()
  }

  return {
    enqueue(value) {
      pending = pending === undefined || !options.mergePending
        ? value
        : options.mergePending(pending, value)
      start()
    },
    clear() {
      pending = undefined
      releaseIntervalWait?.()
    },
    whenIdle: waitForIdle,
  }
}
