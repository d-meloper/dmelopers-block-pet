export interface LatestAsyncTaskQueue<T> {
  enqueue: (value: T) => void
  clear: () => void
  whenIdle: () => Promise<void>
}

interface LatestAsyncTaskOptions<T> {
  mergePending?: (pending: T, incoming: T) => T
  onError?: (error: unknown) => void
}

export function createLatestAsyncTaskQueue<T>(
  worker: (value: T) => Promise<void>,
  options: LatestAsyncTaskOptions<T> = {},
): LatestAsyncTaskQueue<T> {
  let pending: T | undefined
  let running: Promise<void> | undefined

  const drain = async () => {
    while (pending !== undefined) {
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
    },
    whenIdle: waitForIdle,
  }
}
