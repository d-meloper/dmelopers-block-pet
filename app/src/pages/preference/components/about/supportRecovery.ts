import { ref } from 'vue'

import { waitForRecovery } from '@/features/recovery/wait'

/** A timed-out opener/clipboard call still owns its issued native effect. */
export function createSupportRecovery(timeoutMs = 10_000) {
  const busy = ref(false)
  const lifetime = new AbortController()
  let disposed = false
  let generation = 0

  async function run(work: (current: () => boolean) => Promise<void>, failed: (error: unknown) => void) {
    if (disposed || busy.value) return false
    const currentGeneration = ++generation
    let accepting = true
    const current = () => !disposed && accepting && generation === currentGeneration
    busy.value = true
    const operation = Promise.resolve().then(() => current() ? work(current) : undefined)
    const settled = () => {
      // Release serialization only when actual work settles, even on timeout.
      if (!disposed && generation === currentGeneration) {
        busy.value = false
      }
    }
    void operation.then(settled, (error) => {
      settled()
      // Preserve a definite late native failure separately from an observation
      // timeout without adding persistent support feedback.
      if (!disposed && !accepting && generation === currentGeneration) failed(error)
    })
    try {
      await waitForRecovery(operation, timeoutMs, lifetime.signal)
      if (!current()) return false
      return true
    } catch (error) {
      if (!current()) return false
      accepting = false
      failed(error)
      return false
    }
  }

  return {
    busy,
    run,
    dispose: () => {
      disposed = true
      generation += 1
      lifetime.abort()
    },
  }
}
