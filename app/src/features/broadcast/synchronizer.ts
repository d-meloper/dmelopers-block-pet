import type { BroadcastConfiguration, BroadcastStatus } from './types'

/** Serializes native mutations, coalescing rapid edits and discarding old replies. */
export function createBroadcastSynchronizer(deps: {
  configure: (configuration: BroadcastConfiguration) => Promise<BroadcastStatus>
  accept: (status: BroadcastStatus) => void
  failed: () => void
  pending: (pending: boolean) => void
}) {
  let desired: BroadcastConfiguration | undefined
  let sequence = 0
  let running: Promise<void> | undefined
  let disposed = false
  let acceptedKey: string | undefined

  async function drain() {
    deps.pending(true)
    try {
      while (desired) {
        if (disposed) break
        const configuration = desired
        const request = sequence
        const key = JSON.stringify(configuration)
        desired = undefined
        if (key === acceptedKey) continue
        // An in-flight mutation can replace native state even if its reply becomes stale.
        acceptedKey = undefined
        try {
          const status = await deps.configure(configuration)
          if (disposed || request !== sequence) continue
          acceptedKey = status.error ? undefined : key
          deps.accept(status)
        } catch {
          if (!disposed && request === sequence) deps.failed()
        }
      }
    } finally {
      running = undefined
      if (!disposed) deps.pending(false)
    }
  }

  return {
    update(configuration: BroadcastConfiguration) {
      if (disposed) return
      sequence++
      desired = configuration
      running ??= Promise.resolve().then(drain)
    },
    invalidate() {
      sequence++
      desired = undefined
      acceptedKey = undefined
    },
    idle: () => running ?? Promise.resolve(),
    dispose() {
      disposed = true
      sequence++
      desired = undefined
    },
  }
}
