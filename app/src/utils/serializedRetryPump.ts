export type SerializedRetryPumpResult = 'blocked' | 'complete' | 'retry'

export interface SerializedRetryPump {
  clear: () => void
  hasPendingRequest: () => boolean
  request: () => void
  resume: () => void
  whenIdle: () => Promise<void>
}

export interface SerializedRetryPumpOptions {
  onError?: (error: unknown) => void
  yieldBeforeRetry?: () => Promise<void>
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Runs one sticky request at a time until it completes.
 *
 * A retry keeps the request and yields before trying again. A blocked result
 * also keeps the request, but waits for `resume()` or another `request()` so a
 * caller can wake the pump after an external instability has settled.
 */
export function createSerializedRetryPump(
  worker: () => Promise<SerializedRetryPumpResult>,
  options: SerializedRetryPumpOptions = {},
): SerializedRetryPump {
  let blocked = false
  let requestGeneration = 0
  let requested = false
  let running: Promise<void> | undefined
  const yieldBeforeRetry = options.yieldBeforeRetry ?? yieldToEventLoop

  const drain = async (): Promise<void> => {
    while (requested) {
      const attemptGeneration = requestGeneration
      let result: SerializedRetryPumpResult
      try {
        result = await worker()
      } catch (error) {
        options.onError?.(error)
        if (attemptGeneration === requestGeneration && requested) {
          blocked = true
          return
        }
        continue
      }

      if (!requested) continue
      if (result === 'complete') {
        if (attemptGeneration === requestGeneration) requested = false
        continue
      }
      if (result === 'blocked') {
        if (attemptGeneration === requestGeneration) {
          blocked = true
          return
        }
        continue
      }

      await yieldBeforeRetry()
    }
  }

  const start = (): void => {
    if (running || blocked || !requested) return
    running = drain().finally(() => {
      running = undefined
      if (requested && !blocked) start()
    })
  }

  const waitForIdle = async (): Promise<void> => {
    const current = running
    if (!current) return
    await current
    await waitForIdle()
  }

  return {
    clear() {
      requestGeneration += 1
      requested = false
      blocked = false
    },
    hasPendingRequest() {
      return requested
    },
    request() {
      requestGeneration += 1
      requested = true
      blocked = false
      start()
    },
    resume() {
      if (!requested) return
      requestGeneration += 1
      blocked = false
      start()
    },
    whenIdle: waitForIdle,
  }
}
