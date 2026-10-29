import { ref } from 'vue'

import { RecoveryWaitError, waitForRecovery } from '@/features/recovery/wait'
import { createPreferenceUpdates } from '@/features/updates/preferenceUpdates'
import { diagnosticCode } from '@/services/diagnosticsCore'

type Dependencies = Parameters<typeof createPreferenceUpdates>[0]

class SafeUpdateFailure extends Error {
  constructor(readonly code: string, readonly original: unknown) {
    super(code)
  }
}

/** Bounded metadata reads and installer lifetime guards; no installer replay. */
export function createPreferenceUpdateRecovery(deps: Dependencies, timeoutMs = 150_000) {
  const handoffUnconfirmed = ref(false)
  const lifetime = new AbortController()
  let disposed = false
  let channelRead: ReturnType<Dependencies['channel']> | undefined
  let updateRead: { force: boolean, promise: ReturnType<Dependencies['checkApp']> } | undefined

  const failure = (error: unknown) => new SafeUpdateFailure(diagnosticCode(error), error)

  const updates = createPreferenceUpdates({
    ...deps,
    channel: async () => {
      channelRead ??= Promise.resolve().then(deps.channel)
      const read = channelRead
      void read.then(() => {
        if (channelRead === read) channelRead = undefined
      }, () => {
        if (channelRead === read) channelRead = undefined
      })
      try {
        return await waitForRecovery(read, timeoutMs, lifetime.signal)
      } catch (error) {
        throw failure(error)
      }
    },
    checkApp: async (force) => {
      const deadline = Date.now() + timeoutMs
      const wait = <T>(read: Promise<T>) => waitForRecovery(read, Math.max(0, deadline - Date.now()), lifetime.signal)
      try {
        // A timeout releases observation, not the actual native read. Join the
        // same read; a forced request waits for an older cached request first.
        if (updateRead && updateRead.force !== force) await wait(updateRead.promise.catch(() => {}))
        if (disposed) throw new Error('AbortError')
        if (Date.now() >= deadline) throw new RecoveryWaitError('timeout')
        if (!updateRead) {
          const promise = Promise.resolve().then(() => deps.checkApp(force))
          const current = { force, promise }
          updateRead = current
          void promise.then(() => {
            if (updateRead === current) updateRead = undefined
          }, () => {
            if (updateRead === current) updateRead = undefined
          })
        }
        const result = await wait(updateRead.promise)
        // The controller owns generation checks. Publishing is deferred until
        // that owner accepts the result, rather than from a late read callback.
        return result
      } catch (error) {
        throw failure(error)
      }
    },
    install: async (phase, progress) => {
      if (disposed || handoffUnconfirmed.value) throw new Error('UPDATE_BUSY')
      try {
        // Keep the actual operation's locks through saving and handoff. An
        // elapsed UI wait must never release or replay the installer.
        await deps.install(value => !disposed && phase(value), value => !disposed && progress(value))
        if (!disposed) handoffUnconfirmed.value = true
      } catch (error) {
        throw failure(error)
      }
    },
    cancel: async () => {
      try {
        await deps.cancel()
      } catch (error) {
        throw failure(error)
      }
    },
    report: (operation, error) => {
      if (disposed) return
      deps.report(operation, error instanceof SafeUpdateFailure ? error.original : error)
    },
  })

  return {
    ...updates,
    handoffUnconfirmed,
    recordVisibilityFailure: () => {
      if (disposed) return
      updates.failed.value = true
    },
    check: (force = true) => handoffUnconfirmed.value ? Promise.resolve() : updates.check(force),
    setVisible: (value: boolean) => {
      if (handoffUnconfirmed.value || disposed) return Promise.resolve()
      return updates.setVisible(value)
    },
    update: async () => {
      if (disposed || handoffUnconfirmed.value || updates.failed.value) return
      await updates.update()
    },
    dispose: () => {
      disposed = true
      lifetime.abort()
      updates.dispose()
    },
  }
}

export type PreferenceUpdateRecovery = ReturnType<typeof createPreferenceUpdateRecovery>
