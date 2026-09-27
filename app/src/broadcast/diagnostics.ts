/** Only these failure categories may cross the authenticated browser socket. */
export type BrowserDiagnosticCode
  = | 'renderer_warning' | 'renderer_error' | 'context_lost' | 'shader_compile_failed'
    | 'skin_read_failed' | 'skin_decode_failed' | 'model_load_failed'
    | 'viewport_measurement_failed' | 'rig_contract_missing' | 'viewport_fallback'
    | 'script_error' | 'unhandled_rejection' | 'server_message_invalid' | 'heartbeat_timeout'

const categories = new Map<string, BrowserDiagnosticCode>([
  ['The active pet WebGL context was lost.', 'context_lost'],
  ['The pet renderer shader could not compile.', 'shader_compile_failed'],
  ['Failed to decode the selected pet skin.', 'skin_decode_failed'],
  ['Failed to read the selected pet skin.', 'skin_read_failed'],
  ['Failed to load the fixed 3D pet model.', 'model_load_failed'],
  ['Failed to render the visible-content measurement.', 'viewport_measurement_failed'],
  ['Failed to restore the renderer after content measurement.', 'viewport_measurement_failed'],
  ['Failed to read the visible-content measurement.', 'viewport_measurement_failed'],
  ['Dmeloper eyebrows are disabled because the generated eyebrow contract is missing.', 'rig_contract_missing'],
  ['Pet animation is disabled because required nodes are missing.', 'rig_contract_missing'],
  ['Pet animation is disabled because the mouse hand anchor is missing.', 'rig_contract_missing'],
  ['The broadcast viewport is using conservative fallback bounds.', 'viewport_fallback'],
])

export function installBroadcastDiagnostics(
  send: (code: BrowserDiagnosticCode) => boolean,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  logger: Pick<Console, 'warn' | 'error'> = console,
  now: () => number = Date.now,
) {
  const lastSent = new Map<BrowserDiagnosticCode, number>()
  const pending = new Set<BrowserDiagnosticCode>()
  let disposed = false
  const report = (code: BrowserDiagnosticCode) => {
    if (disposed) return
    const time = now()
    const previous = lastSent.get(code)
    if (previous !== undefined && time - previous < 60000) return
    // Pending state contains at most the fixed code vocabulary, never messages,
    // stack traces, scene contents, URLs or input events. Transport failure cannot
    // interrupt the renderer or cause a recursive console failure.
    try {
      if (send(code)) {
        pending.delete(code)
        lastSent.set(code, time)
        return
      }
    } catch { /* Retry a bounded category after the authenticated socket opens. */ }
    pending.add(code)
  }
  const originalWarn = logger.warn
  const originalError = logger.error
  const warn = (...args: unknown[]) => {
    report(categories.get(typeof args[0] === 'string' ? args[0] : '') ?? 'renderer_warning')
    originalWarn.apply(logger, args)
  }
  const error = (...args: unknown[]) => {
    report(categories.get(typeof args[0] === 'string' ? args[0] : '') ?? 'renderer_error')
    originalError.apply(logger, args)
  }
  const onError = () => report('script_error')
  const onRejection = (event: PromiseRejectionEvent) => {
    if (event.reason?.name !== 'PetModelLoadCancelledError' && event.reason?.name !== 'AbortError') report('unhandled_rejection')
  }
  logger.warn = warn
  logger.error = error
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return {
    report,
    flush: () => [...pending].forEach(report),
    dispose() {
      disposed = true
      pending.clear()
      lastSent.clear()
      if (logger.warn === warn) logger.warn = originalWarn
      if (logger.error === error) logger.error = originalError
      target.removeEventListener('error', onError)
      target.removeEventListener('unhandledrejection', onRejection)
    },
  }
}
