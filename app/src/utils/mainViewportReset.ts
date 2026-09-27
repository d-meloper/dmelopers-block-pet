export interface MainViewportResetRequest {
  requestId: string
}

export interface MainViewportResetComplete extends MainViewportResetRequest {
  success: boolean
}

interface MainViewportResetClock {
  clearTimeout: (handle: unknown) => void
  setTimeout: (callback: () => void, delayMs: number) => unknown
}

interface MainViewportResetTransport {
  emit: (request: MainViewportResetRequest) => Promise<unknown>
  listen: (
    handler: (response: MainViewportResetComplete) => void,
  ) => Promise<() => void>
}

interface MainViewportResetOptions {
  clock?: MainViewportResetClock
  createRequestId?: () => string
  timeoutMs?: number
}

export async function requestMainViewportReset(
  transport: MainViewportResetTransport,
  options: MainViewportResetOptions = {},
): Promise<void> {
  const clock = options.clock ?? {
    clearTimeout: handle => globalThis.clearTimeout(
      handle as ReturnType<typeof setTimeout>,
    ),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  }
  const requestId = options.createRequestId?.() ?? crypto.randomUUID()
  const timeoutMs = options.timeoutMs
  let timeout: unknown
  let settled = false
  let resolveCompletion: (() => void) | undefined
  let rejectCompletion: ((error: Error) => void) | undefined
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  const unlisten = await transport.listen((response) => {
    if (settled || response.requestId !== requestId) return
    settled = true
    if (response.success) resolveCompletion?.()
    else rejectCompletion?.(new Error('The main viewport could not be reset.'))
  })

  try {
    if (timeoutMs !== undefined) {
      timeout = clock.setTimeout(() => {
        if (settled) return
        settled = true
        rejectCompletion?.(new Error('The main viewport reset timed out.'))
      }, timeoutMs)
    }
    await transport.emit({ requestId })
    await completion
  } finally {
    settled = true
    if (timeout !== undefined) clock.clearTimeout(timeout)
    unlisten()
  }
}
