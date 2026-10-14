import type { RecoveryReport } from '@/features/recovery/types'

import { RecoveryWaitError, waitForRecovery } from '@/features/recovery/wait'

import type { BroadcastStatus } from './types'

import { isBroadcastStatus } from './types'

const NATIVE_FAILURES = new Set([
  'scene_invalid',
  'scene_required',
  'skin_invalid',
  'skin_too_large',
  'port_in_use',
  'server_unavailable',
  'input_unavailable',
  'render_failed',
  'endpoint_conflict',
  'endpoint_invalid',
  'endpoint_unavailable',
  'endpoint_backup_unavailable',
  'broadcast_preference_only',
])

/** Accept exact known protocol codes, never substrings from raw paths/messages. */
export function broadcastFailureCode(error: unknown): string {
  const code = typeof error === 'string'
    ? error
    : error instanceof Error ? error.message : undefined
  return typeof code === 'string' && NATIVE_FAILURES.has(code) ? code : 'unavailable'
}

export function broadcastRecoveryGuidance(cause: string): string[] {
  const common = ['recovery.guidance.logs', 'recovery.guidance.support']
  switch (cause) {
    case 'port_in_use':
      return ['recovery.broadcast.guidance.port', 'recovery.broadcast.guidance.address', ...common]
    case 'endpoint_conflict':
    case 'endpoint_invalid':
      return ['recovery.broadcast.guidance.identity', 'recovery.broadcast.guidance.noReset', ...common]
    case 'endpoint_unavailable':
    case 'endpoint_backup_unavailable':
      return ['recovery.guidance.storage', 'recovery.broadcast.guidance.noReset', ...common]
    case 'scene_invalid':
    case 'scene_required':
      return ['recovery.broadcast.guidance.scene', 'recovery.guidance.restart', ...common]
    case 'skin_invalid':
    case 'skin_too_large':
      return ['recovery.broadcast.guidance.skin', 'recovery.broadcast.guidance.previousScene', ...common]
    case 'render_failed':
      return ['recovery.broadcast.guidance.refresh', 'recovery.broadcast.guidance.acceleration', ...common]
    case 'render_pending':
      return ['recovery.broadcast.guidance.refresh', 'recovery.broadcast.guidance.address', ...common]
    case 'readiness_unavailable':
      return ['recovery.guidance.restart', ...common, 'recovery.guidance.lastResort']
    case 'input_unavailable':
      return ['recovery.broadcast.guidance.input', 'recovery.guidance.restart', ...common]
    case 'server_unavailable':
      return ['recovery.broadcast.guidance.server', 'recovery.guidance.restart', ...common]
    case 'not_ready':
      return ['recovery.broadcast.guidance.ready', ...common]
    case 'settings_changed':
      return ['recovery.guidance.changed']
    case 'disabled':
      return ['recovery.broadcast.guidance.disabled']
    case 'waiting':
      return ['recovery.broadcast.guidance.refresh', 'recovery.broadcast.guidance.address']
    case 'timeout':
      return ['recovery.guidance.timeout', 'recovery.guidance.restart', ...common, 'recovery.guidance.lastResort']
    default:
      return ['recovery.broadcast.guidance.bridge', 'recovery.guidance.restart', ...common, 'recovery.guidance.lastResort']
  }
}

export function finishBroadcastRecovery(report: RecoveryReport, status: RecoveryReport['status'], cause: string, summaryKey?: string): RecoveryReport {
  return {
    ...report,
    status,
    cause,
    summaryKey,
    steps: report.steps.map(step => step.state === 'running' ? { ...step, state: 'skipped' } : step),
    guidanceKeys: status === 'recovered' && cause !== 'waiting' ? [] : broadcastRecoveryGuidance(cause),
  }
}

export function hasConfirmedBroadcastScene(value: BroadcastStatus, expectedRevision = value.sceneRevision): boolean {
  return expectedRevision !== undefined && value.sceneRevision === expectedRevision
    && (value.confirmedClients ?? 0) > 0 && !value.error
}

export async function runBroadcastRecovery(options: {
  enabled: boolean
  ready: boolean
  signal: AbortSignal
  subscribe: () => Promise<boolean>
  apply: () => Promise<string | undefined>
  read: () => Promise<BroadcastStatus>
  rendered: (revision?: number) => { result: Promise<BroadcastStatus>, dispose: () => void }
  report: (value: RecoveryReport) => void
  timeoutMs?: number
}): Promise<RecoveryReport> {
  let report: RecoveryReport = { status: 'running', steps: [] }
  const timeout = options.timeoutMs ?? 8000
  const publish = () => options.report({ ...report, steps: report.steps.map(step => ({ ...step })) })
  const finish = (status: RecoveryReport['status'], cause: string, summaryKey?: string) => {
    report = finishBroadcastRecovery(report, status, cause, summaryKey)
    publish()
    return report
  }
  const step = async <T>(key: string, work: () => Promise<T>, passed: (value: T) => boolean = () => true) => {
    if (options.signal.aborted) throw new RecoveryWaitError('cancelled')
    const current = { key, state: 'running' as 'running' | 'passed' | 'failed' }
    report.steps.push(current)
    publish()
    try {
      const result = await waitForRecovery(work(), timeout, options.signal)
      current.state = passed(result) ? 'passed' : 'failed'
      publish()
      return result
    } catch (error) {
      current.state = 'failed'
      publish()
      throw error
    }
  }
  publish()
  try {
    if (!options.ready && options.enabled) {
      report.steps.push({ key: 'recovery.broadcast.steps.ready', state: 'failed' })
      return finish('unresolved', 'not_ready')
    }
    const subscribed = await step('recovery.broadcast.steps.subscribe', options.subscribe, Boolean)
    const failure = await step('recovery.broadcast.steps.configure', options.apply, value => !value)
    let observed = await step('recovery.broadcast.steps.verify', options.read, isBroadcastStatus)
    if (!isBroadcastStatus(observed)) return finish('unknown', 'unavailable')
    const expectedRevision = observed.sceneRevision
    // Retained old transport/readiness cannot acknowledge a rejected new scene.
    if (failure) return finish('unresolved', failure, 'recovery.broadcast.configurationFailed')
    const renderFailed = observed.error === 'render_failed'
    if (renderFailed || (!observed.error && observed.clients > 0 && observed.confirmedClients === 0)) {
      const revision = observed.sceneRevision
      const observation = options.rendered(revision)
      try {
        observed = await step('recovery.broadcast.steps.render', () => observation.result, value => isBroadcastStatus(value) && hasConfirmedBroadcastScene(value, revision))
      } catch (error) {
        if (error instanceof RecoveryWaitError && error.reason === 'timeout') {
          return renderFailed
            ? finish('unresolved', 'render_failed')
            : finish('unknown', 'render_pending', 'recovery.broadcast.renderUnconfirmed')
        }
        throw error
      } finally {
        observation.dispose()
      }
    }
    if (!isBroadcastStatus(observed)) return finish('unknown', 'unavailable')
    if (observed.error) return finish('unresolved', broadcastFailureCode(observed.error))
    if (observed.warning) return finish('unresolved', 'endpoint_backup_unavailable', 'recovery.broadcast.backupWarning')
    if (!subscribed) return finish('unresolved', 'unavailable')
    if (observed.enabled !== options.enabled) return finish('unknown', 'unavailable')
    if (!observed.enabled) return finish('recovered', 'disabled', 'recovery.broadcast.off')
    if (observed.clients > 0 && !hasConfirmedBroadcastScene(observed, expectedRevision)) {
      return finish('unknown', 'readiness_unavailable', 'recovery.broadcast.renderUnconfirmed')
    }
    return observed.clients > 0
      ? finish('recovered', 'connected', 'recovery.broadcast.connected')
      : finish('recovered', 'waiting', 'recovery.broadcast.waiting')
  } catch (error) {
    if (error instanceof RecoveryWaitError) {
      return error.reason === 'cancelled'
        ? finish('cancelled', 'settings_changed')
        : finish('unknown', 'timeout')
    }
    return finish('unresolved', broadcastFailureCode(error))
  }
}
