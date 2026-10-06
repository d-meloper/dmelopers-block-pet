import type { AntialiasSettingRequest } from '@/config/performance'

import { ANTIALIAS_SETTING_CANCEL, ANTIALIAS_SETTING_REQUEST, isAntialiasSettingResponse } from '@/config/performance'

interface AntialiasOwnerSteps {
  current: () => boolean
  restore: (value: boolean) => void
  beginNativeEdit: () => () => void
  send: (event: string, payload: AntialiasSettingRequest) => Promise<unknown>
  failed: (reason: 'failed' | 'unconfirmed') => void
  report: (error: unknown) => void
  timeoutMs?: number
  sessionId?: string
}

/** One optimistic setting request, held under the existing native-edit lease. */
export function createAntialiasSettingOwner(steps: AntialiasOwnerSteps) {
  const session = steps.sessionId ?? crypto.randomUUID()
  let sequence = 0
  let disposed = false
  let restoring = false
  let pending: {
    request: AntialiasSettingRequest
    release: () => void
    timer: ReturnType<typeof setTimeout>
  } | undefined

  const send = (event: string, request: AntialiasSettingRequest) => {
    // Delivery can succeed before its IPC response fails. Only the matching
    // acknowledgement or timeout decides this request's outcome.
    void steps.send(event, request).catch(steps.report)
  }
  const release = () => {
    const request = pending
    pending = undefined
    if (!request) return
    clearTimeout(request.timer)
    request.release()
  }
  const restore = (requested: boolean, actual: boolean) => {
    if (steps.current() !== requested || actual === requested) return
    restoring = true
    try {
      steps.restore(actual)
    } finally {
      restoring = false
    }
  }
  const accept = (value: unknown) => {
    if (disposed || !pending || !isAntialiasSettingResponse(value)
      || value.requestId !== pending.request.requestId || value.requested !== pending.request.requested) {
      return
    }
    try {
      restore(value.requested, value.actual)
      if (!value.success) steps.failed('failed')
    } finally {
      release()
    }
  }
  return {
    request(requested: boolean) {
      if (disposed || restoring) return
      // Acquire the replacement before releasing its predecessor: the owner's
      // readiness must not briefly permit a save between consecutive toggles.
      const finishNative = steps.beginNativeEdit()
      if (pending) send(ANTIALIAS_SETTING_CANCEL, pending.request)
      release()
      const request = { requestId: `${session}:${++sequence}`, requested }
      const timer = setTimeout(() => {
        if (pending?.request !== request) return
        send(ANTIALIAS_SETTING_CANCEL, request)
        // A lost reply does not prove failure. Keep the user's desired value;
        // guessing a rollback would start another unacknowledged native edit.
        try {
          steps.failed('unconfirmed')
        } finally {
          release()
        }
      }, steps.timeoutMs ?? 5000)
      pending = { request, release: finishNative, timer }
      send(ANTIALIAS_SETTING_REQUEST, request)
    },
    accept,
    isPending: (requestId: string) => !disposed && pending?.request.requestId === requestId,
    dispose() {
      if (disposed) return
      disposed = true
      if (pending) send(ANTIALIAS_SETTING_CANCEL, pending.request)
      release()
    },
  }
}
