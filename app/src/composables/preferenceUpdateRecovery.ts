import { ref, shallowRef } from 'vue'

import type { RecoveryReport } from '@/features/recovery/types'

import { RecoveryWaitError, waitForRecovery } from '@/features/recovery/wait'
import { createPreferenceUpdates } from '@/features/updates/preferenceUpdates'
import { diagnosticCode } from '@/services/diagnosticsCore'

type Dependencies = Parameters<typeof createPreferenceUpdates>[0]

class SafeUpdateFailure extends Error {
  constructor(readonly code: string, readonly original: unknown) {
    super(code)
  }
}

/** Transient evidence for the current signed updater; no installer replay. */
export function createPreferenceUpdateRecovery(deps: Dependencies, timeoutMs = 150_000) {
  const recovery = shallowRef<RecoveryReport>()
  const handoffUnconfirmed = ref(false)
  const lifetime = new AbortController()
  let disposed = false
  let visible = false
  let observationGeneration = 0
  let channelRead: ReturnType<Dependencies['channel']> | undefined
  let updateRead: { force: boolean, promise: ReturnType<Dependencies['checkApp']> } | undefined

  const failure = (error: unknown) => new SafeUpdateFailure(diagnosticCode(error), error)
  const reportFailure = (error: unknown) => {
    if (disposed) return
    const cause = error instanceof SafeUpdateFailure ? error.code : diagnosticCode(error)
    const guidance = updateRecoveryGuidance(cause)
    recovery.value = {
      status: cause === 'timeout' ? 'unknown' : 'unresolved',
      summaryKey: cause === 'timeout' ? 'recovery.summary.updateWaitUnknown' : 'recovery.summary.updateFailed',
      cause,
      steps: (recovery.value?.steps ?? [{ key: 'recovery.steps.checkUpdates', state: 'running' as const }])
        .map(step => step.state === 'running' && cause !== 'timeout' ? { ...step, state: 'failed' as const } : step),
      guidanceKeys: [...new Set([
        guidance,
        'recovery.guidance.retryUpdateCheck',
        'recovery.guidance.contactSupport',
        ...(['timeout', 'unclassified_failure', 'unreadable_error'].includes(cause) ? ['recovery.guidance.lastResort'] : []),
      ])],
    }
  }

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
      if (!disposed) recovery.value = { status: 'running', steps: [{ key: 'recovery.steps.checkUpdates', state: 'running' }] }
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
      recovery.value = { status: 'running', steps: [{ key: 'recovery.steps.downloadUpdate', state: 'running' }] }
      const phaseSteps = ['downloadUpdate', 'verifyUpdate', 'saveUpdate', 'handoffUpdate']
      const phases = ['downloading', 'verifying', 'saving', 'installing']
      const operation = deps.install((value) => {
        if (disposed) return
        const index = phases.indexOf(value)
        recovery.value = {
          status: 'running',
          steps: phaseSteps.slice(0, index + 1).map((key, step) => ({
            key: `recovery.steps.${key}`,
            state: step === index ? 'running' : 'passed',
          })),
        }
        phase(value)
      }, value => !disposed && progress(value))
      // Only observation is bounded. Saving/installing retain their existing
      // locks until the actual service releases them; never replay on timeout.
      void waitForRecovery(operation, timeoutMs, lifetime.signal).catch((error) => {
        if (!disposed && diagnosticCode(error) === 'timeout') reportFailure(error)
      })
      try {
        await operation
        if (!disposed) {
          handoffUnconfirmed.value = true
          recovery.value = {
            status: 'unknown',
            summaryKey: 'recovery.summary.updateHandoffUnknown',
            steps: (recovery.value?.steps ?? []).map(step => ({ ...step, state: 'passed' })),
            guidanceKeys: ['recovery.guidance.confirmUpdate', 'recovery.guidance.contactSupport', 'recovery.guidance.lastResort'],
          }
        }
      } catch (error) {
        if (!disposed && diagnosticCode(error) === 'UPDATE_CANCELLED') {
          recovery.value = { status: 'cancelled', steps: [] }
        }
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
      reportFailure(error)
      deps.report(operation, error instanceof SafeUpdateFailure ? error.original : error)
    },
  })

  const acceptedCheck = async (work: () => Promise<void>) => {
    const current = observationGeneration
    await work()
    if (!disposed && visible && current === observationGeneration && updates.appInfo.value
      && !updates.failed.value && !updates.busy.value && recovery.value?.status === 'running') {
      recovery.value = {
        status: 'recovered',
        summaryKey: 'recovery.summary.updateCheckComplete',
        steps: [{ key: 'recovery.steps.checkUpdates', state: 'passed' }],
      }
    }
  }
  return {
    ...updates,
    recovery,
    handoffUnconfirmed,
    recordVisibilityFailure: (error: unknown) => {
      if (disposed) return
      const cause = diagnosticCode(error)
      updates.failed.value = true
      recovery.value = {
        status: 'unknown',
        cause,
        summaryKey: 'recovery.summary.updateWindowUnknown',
        steps: [{ key: 'recovery.steps.observeUpdateWindow', state: 'failed' }],
        guidanceKeys: [
          'recovery.guidance.checkAppWindow',
          'recovery.guidance.retryUpdateCheck',
          'recovery.guidance.contactSupport',
          ...(['timeout', 'STATE_UNKNOWN', 'unclassified_failure', 'unreadable_error'].includes(cause) ? ['recovery.guidance.lastResort'] : []),
        ],
      }
    },
    check: (force = true) => handoffUnconfirmed.value ? Promise.resolve() : acceptedCheck(() => updates.check(force)),
    setVisible: (value: boolean) => {
      if (handoffUnconfirmed.value || disposed) return Promise.resolve()
      if (visible !== value) observationGeneration += 1
      visible = value
      return acceptedCheck(() => updates.setVisible(value))
    },
    update: async () => {
      if (disposed || handoffUnconfirmed.value || updates.failed.value) return
      const current = observationGeneration
      await updates.update()
      if (!disposed && visible && current === observationGeneration && updates.appInfo.value
        && !updates.failed.value && recovery.value?.status === 'running' && !updates.busy.value) {
        recovery.value = {
          status: 'recovered',
          summaryKey: 'recovery.summary.updateCheckComplete',
          steps: [{ key: 'recovery.steps.checkUpdates', state: 'passed' }],
        }
      }
    },
    dispose: () => {
      disposed = true
      lifetime.abort()
      updates.dispose()
      recovery.value = undefined
    },
  }
}

export function updateRecoveryGuidance(code: string): string {
  if (['UPDATE_NETWORK_FAILED', 'UPDATE_CHECK_FAILED', 'network_failure'].includes(code)) return 'recovery.guidance.checkNetwork'
  if (['UPDATE_SIGNATURE_INVALID', 'UPDATE_METADATA_INVALID', 'UPDATE_HASH_INVALID', 'UPDATE_SIZE_INVALID', 'UPDATE_IDENTITY_INVALID', 'UPDATE_VERIFY_FAILED', 'UPDATE_VERSION_INVALID', 'UPDATE_CONFIG_INVALID'].includes(code)) return 'recovery.guidance.verifyUpdate'
  if (['UPDATE_CACHE_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'storage_full', 'permission_denied'].includes(code)) return 'recovery.guidance.checkStorage'
  if (['UPDATE_BUSY', 'UPDATE_TOO_LATE', 'OPERATION_BUSY', 'OPERATION_LOCKED', 'timeout'].includes(code)) return 'recovery.guidance.waitForOperation'
  if (['SAVE_VERIFICATION_FAILED', 'STORES_NOT_READY', 'QUIESCE_STATE_CHANGED', 'QUIESCE_CANCELLED', 'settings_acknowledgement_timeout'].includes(code)) return 'recovery.guidance.preserveSettings'
  if (['UPDATE_INSTALL_FAILED', 'UPDATE_INSTALLED_APP_REQUIRED', 'UPDATE_INSTALL_LOCATION_INVALID', 'UPDATE_WINDOW_INVALID'].includes(code)) return 'recovery.guidance.manualUpdate'
  return 'recovery.guidance.retryUpdateCheck'
}

export type PreferenceUpdateRecovery = ReturnType<typeof createPreferenceUpdateRecovery>
