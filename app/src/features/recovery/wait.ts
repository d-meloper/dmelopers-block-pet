export class RecoveryWaitError extends Error {
  constructor(public readonly reason: 'timeout' | 'cancelled') {
    super(reason)
    this.name = 'RecoveryWaitError'
  }
}

/** Bound observation only. The operation owner must retain issued-work ownership. */
export function waitForRecovery<T>(operation: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      action()
    }
    const cancel = () => finish(() => reject(new RecoveryWaitError('cancelled')))
    // Attach both handlers even after cancellation; a late operation rejection
    // remains observed without changing the already completed recovery report.
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    if (signal?.aborted) {
      cancel()
      return
    }
    signal?.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => finish(() => reject(new RecoveryWaitError('timeout'))), milliseconds)
  })
}
