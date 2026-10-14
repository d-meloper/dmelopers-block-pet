import { waitForRecovery } from '@/features/recovery/wait'

/** The update action repairs a failed observer before reading current visibility. */
export function createPreferenceUpdateVisibility(deps: {
  listen: (accept: (visible: boolean) => void) => Promise<() => void>
  read: () => Promise<boolean>
  accept: (visible: boolean) => Promise<void>
  report: (error: unknown) => void
}, timeoutMs = 5000) {
  const lifetime = new AbortController()
  let disposed = false
  let eventCount = 0
  let stop: (() => void) | undefined
  let registration: Promise<void> | undefined
  let read: { before: number, promise: Promise<boolean> } | undefined
  let pending: Promise<void> | undefined

  const release = (unsubscribe: () => void) => {
    try {
      unsubscribe()
    } catch (error) {
      deps.report(error)
    }
  }
  const subscribe = async () => {
    if (stop || disposed) return
    if (!registration) {
      const current = deps.listen((visible) => {
        eventCount += 1
        if (!disposed) void deps.accept(visible)
      }).then((unsubscribe) => {
        if (disposed) release(unsubscribe)
        else stop = unsubscribe
      })
      registration = current
      void current.then(() => {
        if (registration === current) registration = undefined
      }, () => {
        if (registration === current) registration = undefined
      })
    }
    await waitForRecovery(registration, timeoutMs, lifetime.signal)
  }
  async function refresh() {
    if (disposed) return
    if (pending) return pending
    pending = (async () => {
      try {
        await subscribe()
      } catch (error) {
        if (!disposed) deps.report(error)
      }
      if (disposed) return
      read ??= { before: eventCount, promise: Promise.resolve().then(deps.read) }
      const current = read
      void current.promise.then(() => {
        if (read === current) read = undefined
      }, () => {
        if (read === current) read = undefined
      })
      try {
        const visible = await waitForRecovery(current.promise, timeoutMs, lifetime.signal)
        // A newer pushed observation owns the window, including during retry.
        if (!disposed && current.before === eventCount) await deps.accept(visible)
      } catch (error) {
        if (!disposed) deps.report(error)
      }
    })()
    try {
      await pending
    } finally {
      pending = undefined
    }
  }
  return {
    refresh,
    dispose: () => {
      disposed = true
      lifetime.abort()
      const unsubscribe = stop
      stop = undefined
      if (unsubscribe) release(unsubscribe)
    },
  }
}
