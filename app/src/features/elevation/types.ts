export interface ElevationStatus {
  supported: boolean
  elevated: boolean
  /** The input worker is elevated; the UI and data owner can remain ordinary. */
  inputElevated?: boolean
  startupAttempt?: 'notAttempted' | 'cancelled' | 'failed'
  alwaysRunAsAdministrator?: boolean | null
  administratorReminderDismissed?: boolean | null
}

export type ElevatedRestartPreparation
  = | { outcome: 'ready', ticket: string }
    | { outcome: 'cancelled' }

export function isElevationStatus(value: unknown): value is ElevationStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as Partial<ElevationStatus>
  return typeof status.supported === 'boolean' && typeof status.elevated === 'boolean'
    && (status.inputElevated === undefined || typeof status.inputElevated === 'boolean')
    && (status.startupAttempt === undefined || ['notAttempted', 'cancelled', 'failed'].includes(status.startupAttempt))
    && (status.alwaysRunAsAdministrator === undefined || status.alwaysRunAsAdministrator === null || typeof status.alwaysRunAsAdministrator === 'boolean')
    && (status.administratorReminderDismissed === undefined || status.administratorReminderDismissed === null || typeof status.administratorReminderDismissed === 'boolean')
}

export function isElevatedRestartPreparation(value: unknown): value is ElevatedRestartPreparation {
  if (!value || typeof value !== 'object') return false
  const result = value as { outcome?: unknown, ticket?: unknown }
  if (result.outcome === 'cancelled') return result.ticket === undefined
  return result.outcome === 'ready' && typeof result.ticket === 'string'
    && /^[\da-f]{64}$/i.test(result.ticket)
}
