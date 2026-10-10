import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exit } from '@tauri-apps/plugin-process'

import { cancelPresetNativeQueries } from '@/features/presets/operations'
import { editorsLocked, quiesceEditors, releaseEditors } from '@/features/stateSafety'
import { reportDiagnostic } from '@/services/diagnostics'

type ProcessAction = 'quit' | 'restart'
let pendingProcess: { action: ProcessAction, promise: Promise<void> } | undefined
let processOwnerGeneration = 0
const PROCESS_REQUEST = 'app-process-request'
const PROCESS_RESPONSE = 'app-process-response'
export const APP_PROCESS_FAILED = 'app-process-failed'
const PROCESS_TIMEOUT_MS = 30_000

interface ProcessRequest {
  action: ProcessAction
  requestId: string
  requester: string
  deadline: number
}

/** Main never has authority to save a stale copy of Preferences' pending edits. */
export function quitApp(): Promise<void> {
  return requestProcess('quit')
}

export function restartApp(): Promise<void> {
  return requestProcess('restart')
}

function requestProcess(action: ProcessAction): Promise<void> {
  if (pendingProcess) return pendingProcess.action === action ? pendingProcess.promise : Promise.reject(new Error('APP_PROCESS_BUSY'))
  const promise = requestProcessAction(action).finally(() => {
    pendingProcess = undefined
  })
  pendingProcess = { action, promise }
  return promise
}

async function requestProcessAction(action: ProcessAction): Promise<void> {
  const request: ProcessRequest = {
    action,
    requestId: crypto.randomUUID(),
    requester: getCurrentWebviewWindow().label,
    deadline: Date.now() + PROCESS_TIMEOUT_MS,
  }
  let active = true
  let stop: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let finish!: (success: boolean) => void
  const completed = new Promise<void>((resolve, reject) => {
    finish = success => success ? resolve() : reject(new Error('APP_PROCESS_FAILED'))
    timer = setTimeout(() => {
      reportDiagnostic('error', 'process.request_timeout')
      finish(false)
    }, PROCESS_TIMEOUT_MS)
  })
  // A timed-out subscription must dispose its late listener and never send work.
  const subscribed = listen<ProcessRequest & { success: boolean }>(PROCESS_RESPONSE, ({ payload }) => {
    if (active && payload.requestId === request.requestId) finish(payload.success)
  }).then((unlisten) => {
    if (!active) {
      unlisten()
      return
    }
    stop = unlisten
  })
  try {
    await Promise.race([subscribed, completed])
    if (!active || Date.now() >= request.deadline) throw new Error('APP_PROCESS_FAILED')
    // Delivery can complete before its IPC reply fails. The owner's result or
    // shared deadline, rather than that transport reply, decides this request.
    await Promise.race([emitTo('preference', PROCESS_REQUEST, request)
      .catch(error => reportDiagnostic('warn', 'process.request_delivery', error)), completed])
    await completed
  } finally {
    active = false
    if (timer !== undefined) clearTimeout(timer)
    stop?.()
  }
}

/** Registered and disposed by the actual preset owner, including during startup. */
export function registerAppProcessOwner(ready: () => boolean): () => void {
  const generation = ++processOwnerGeneration
  let active = true
  let busy = false
  let stop: (() => void) | undefined
  let subscriptionGeneration = 0
  let registrationTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const isOwner = () => active && generation === processOwnerGeneration
  const handleRequest = async ({ payload }: { payload: ProcessRequest }) => {
    if (!active || generation !== processOwnerGeneration || !payload || typeof payload.requestId !== 'string'
      || !['quit', 'restart'].includes(payload.action)
      || !['main', 'preference'].includes(payload.requester)
      || !Number.isFinite(payload.deadline) || payload.deadline > Date.now() + PROCESS_TIMEOUT_MS) {
      return
    }
    if (busy) return
    busy = true
    let current = true
    let exited = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      if (!active || !current || generation !== processOwnerGeneration || Date.now() >= payload.deadline) throw new Error('APP_PROCESS_CANCELLED')
    }
    const wait = async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
      check()
    }
    const work = async () => {
      check()
      if (editorsLocked.value) throw new Error('APP_PROCESS_BUSY')
      // A background viewport refresh owns no requested setting change. Retire
      // its reply rather than waiting out its ten-second acknowledgement timer.
      // Actual native edits remain counted and must finish before saving.
      cancelPresetNativeQueries()
      while (!ready()) {
        await wait()
        cancelPresetNativeQueries()
      }
      check()
      await quiesceEditors(payload.requestId)
      check()
      if (!ready()) throw new Error('APP_PROCESS_CANCELLED')
      if (payload.action === 'restart') await invoke('restart_application', { requestId: payload.requestId })
      else await exit(0)
      exited = true
    }
    try {
      await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          current = false
          reject(new Error('APP_PROCESS_TIMEOUT'))
        }, Math.max(0, payload.deadline - Date.now()))
      })])
      await emitTo(payload.requester, PROCESS_RESPONSE, { ...payload, success: true }).catch(() => {})
    } catch (error) {
      if (isOwner() && (!(error instanceof Error) || !['APP_PROCESS_CANCELLED', 'APP_PROCESS_BUSY'].includes(error.message))) {
        reportDiagnostic('error', payload.action === 'restart' ? 'process.restart' : 'process.quit', error)
      }
      current = false
      await releaseEditors(payload.requestId).catch(error => console.error('Process editor lease cleanup is pending.', error))
      await emitTo(payload.requester, PROCESS_RESPONSE, { ...payload, success: false })
        .catch(error => reportDiagnostic('warn', 'process.failure_response', error))
    } finally {
      current = false
      if (timer !== undefined) clearTimeout(timer)
      // Both successful actions keep writers frozen until the native Exit hook.
      if (!exited) busy = false
    }
  }
  function subscribe() {
    if (!isOwner()) return
    const attempt = ++subscriptionGeneration
    const retry = (error?: unknown) => {
      if (!isOwner() || attempt !== subscriptionGeneration) return
      reportDiagnostic('warn', 'process.owner_subscription_unavailable', error)
      subscriptionGeneration++
      retryTimer = setTimeout(subscribe, 1000)
    }
    const timer = setTimeout(() => retry(), 5000)
    registrationTimer = timer
    void listen<ProcessRequest>(PROCESS_REQUEST, (event) => {
      if (isOwner() && attempt === subscriptionGeneration) return handleRequest(event)
    }).then((unlisten) => {
      clearTimeout(timer)
      if (!isOwner() || attempt !== subscriptionGeneration) unlisten()
      else stop = unlisten
    }).catch((error) => {
      clearTimeout(timer)
      retry(error)
    })
  }
  subscribe()
  return () => {
    active = false
    if (registrationTimer !== undefined) clearTimeout(registrationTimer)
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    stop?.()
  }
}
