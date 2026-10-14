import { ref, shallowRef } from 'vue'

import type { RecoveryReport } from '@/features/recovery/types'

import { waitForRecovery } from '@/features/recovery/wait'
import { diagnosticCode } from '@/services/diagnosticsCore'

type SupportAction = 'open' | 'copy' | 'notice'

/** A timed-out opener/clipboard call still owns its issued native effect. */
export function createSupportRecovery(timeoutMs = 10_000) {
  const report = shallowRef<RecoveryReport>()
  const busy = ref(false)
  const lifetime = new AbortController()
  let disposed = false
  let generation = 0

  async function run(action: SupportAction, work: (current: () => boolean) => Promise<void>, failed: (error: unknown) => void) {
    if (disposed || busy.value) return false
    const currentGeneration = ++generation
    let accepting = true
    const current = () => !disposed && accepting && generation === currentGeneration
    const key = `recovery.steps.${action === 'open' ? 'openSupport' : action === 'copy' ? 'copySupport' : 'loadNotice'}`
    busy.value = true
    report.value = { status: 'running', steps: [{ key, state: 'running' }] }
    const failureReport = (error: unknown) => {
      const cause = diagnosticCode(error)
      const timedOut = cause === 'timeout'
      report.value = {
        status: timedOut ? 'unknown' : 'unresolved',
        summaryKey: timedOut ? 'recovery.summary.supportWaitUnknown' : 'recovery.summary.supportFailed',
        cause,
        steps: [{ key, state: timedOut ? 'running' : 'failed' }],
        guidanceKeys: [
          timedOut
            ? 'recovery.guidance.waitForOperation'
            : ['LOG_DIRECTORY_FORBIDDEN', 'LOG_DIRECTORY_UNAVAILABLE', 'LOG_DIRECTORY_CREATE_FAILED', 'permission_denied', 'storage_full'].includes(cause)
                ? 'recovery.guidance.checkStorage'
                : `recovery.guidance.${action === 'open' ? 'checkWindowsOpener' : action === 'copy' ? 'copySupportManually' : 'retrySupport'}`,
          'recovery.guidance.contactSupport',
          ...(['timeout', 'unclassified_failure', 'unreadable_error'].includes(cause) ? ['recovery.guidance.lastResort'] : []),
        ],
      }
      failed(error)
    }
    const operation = Promise.resolve().then(() => current() ? work(current) : undefined)
    const settled = () => {
      // Release serialization only when actual work settles, even on timeout.
      if (!disposed && generation === currentGeneration) {
        busy.value = false
        if (!accepting && report.value?.status === 'unknown') {
          report.value = { ...report.value, steps: [{ key, state: 'skipped' }] }
        }
      }
    }
    void operation.then(settled, (error) => {
      settled()
      // Preserve a definite late native failure separately from an observation
      // timeout. A late success still cannot establish incident repair.
      if (!disposed && !accepting && generation === currentGeneration) failureReport(error)
    })
    try {
      await waitForRecovery(operation, timeoutMs, lifetime.signal)
      if (!current()) return false
      // Opener acknowledgement cannot prove the destination appeared. A copy
      // acknowledgement likewise does not establish that any incident is fixed.
      report.value = action === 'notice'
        ? undefined
        : {
            status: 'unknown',
            summaryKey: `recovery.summary.${action === 'open' ? 'supportOpened' : 'supportCopied'}`,
            steps: [{ key, state: 'passed' }],
          }
      return true
    } catch (error) {
      if (!current()) return false
      accepting = false
      failureReport(error)
      return false
    }
  }

  return {
    report,
    busy,
    run,
    dispose: () => {
      disposed = true
      generation += 1
      lifetime.abort()
      report.value = undefined
    },
  }
}
