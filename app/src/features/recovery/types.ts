export type RecoveryState = 'running' | 'recovered' | 'unresolved' | 'unknown' | 'cancelled'

export interface RecoveryStep {
  key: string
  state: 'running' | 'passed' | 'failed' | 'skipped'
}

/** Transient UI evidence only; never store raw exceptions or private request data. */
export interface RecoveryReport {
  status: RecoveryState
  steps: RecoveryStep[]
  summaryKey?: string
  cause?: string
  guidanceKeys?: string[]
}
