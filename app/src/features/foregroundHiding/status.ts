export const FOREGROUND_HIDING_STATUS = 'foreground-hiding-status'

export interface ForegroundHidingStatus {
  revision: number
  sequence: number
  visit?: number
  ready: boolean
  suppressed: boolean
  matchedRule: { kind: 'application', index: number } | null
  state: 'off' | 'empty' | 'observing' | 'hidden' | 'bypassed' | 'unavailable' | 'invalid'
}

export function readForegroundHidingStatus(raw: unknown): ForegroundHidingStatus | undefined {
  if (!raw || typeof raw !== 'object') return
  const value = raw as ForegroundHidingStatus
  if (![value.revision, value.sequence].every(number => Number.isSafeInteger(number) && number >= 0)
    || (value.visit !== undefined && (!Number.isSafeInteger(value.visit) || value.visit < 0))
    || typeof value.ready !== 'boolean' || typeof value.suppressed !== 'boolean'
    || !['off', 'empty', 'observing', 'hidden', 'bypassed', 'unavailable', 'invalid'].includes(value.state)) {
    return
  }
  const rule = value.matchedRule
  if (rule !== null && (!rule || rule.kind !== 'application'
    || !Number.isSafeInteger(rule.index) || rule.index < 0 || rule.index >= 128)) {
    return
  }
  if (value.suppressed && (value.state !== 'hidden' || rule === null || !value.ready)) return
  // Publish only the contract, even if an unexpected packet contains extra data.
  return { revision: value.revision, sequence: value.sequence, visit: value.visit, ready: value.ready, suppressed: value.suppressed, state: value.state, matchedRule: rule && { kind: rule.kind, index: rule.index } }
}

export function createForegroundStatusReceiver(publish: (status: ForegroundHidingStatus) => void) {
  let latest: ForegroundHidingStatus | undefined
  let disposed = false
  return {
    accept(raw: unknown): boolean {
      const status = readForegroundHidingStatus(raw)
      if (disposed || !status || (latest && (status.revision < latest.revision
        || status.sequence <= latest.sequence))) {
        return false
      }
      latest = status
      publish(status)
      return true
    },
    dispose() {
      disposed = true
    },
  }
}
