import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exit } from '@tauri-apps/plugin-process'

import { cancelPresetNativeQueries } from '@/features/presets/operations'
import { editorsLocked, quiesceEditors, releaseEditors } from '@/features/stateSafety'
import { reportDiagnostic } from '@/services/diagnostics'

type ProcessAction = 'quit' | 'restart' | 'restart-elevated' | 'save-settings'
let pendingProcess: { action: ProcessAction, ticket?: string, promise: Promise<void> } | undefined
const elevationGuards = new Map<string, () => boolean>()
let processOwnerGeneration = 0
const PROCESS_REQUEST = 'app-process-request'
const PROCESS_RESPONSE = 'app-process-response'
export const APP_PROCESS_FAILED = 'app-process-failed'
const PROCESS_TIMEOUT_MS = 30_000

interface ProcessRequest {
  action: ProcessAction
  ticket?: string
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

/** Preferences' authoritative owner saves both windows without exiting. */
export function saveAppSettings(isCurrent: () => boolean = () => true): Promise<void> {
  if (getCurrentWebviewWindow().label !== 'preference') return Promise.reject(new Error('APP_PROCESS_FORBIDDEN'))
  return requestProcess('save-settings', undefined, isCurrent)
}

function guarded(action: ProcessAction): boolean {
  return action === 'restart-elevated' || action === 'save-settings'
}

/** UAC preparation has completed; activate input without replacing the data owner. */
export function restartAppAsAdministrator(ticket: string, isCurrent: () => boolean = () => true): Promise<void> {
  if (getCurrentWebviewWindow().label !== 'preference') return Promise.reject(new Error('APP_PROCESS_FORBIDDEN'))
  if (!isElevationTicket(ticket)) return Promise.reject(new Error('APP_PROCESS_INVALID'))
  return requestProcess('restart-elevated', ticket, isCurrent)
}

function isElevationTicket(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

async function discardElevation(ticket: string) {
  try {
    await invoke('cancel_elevated_restart', { ticket })
  } catch (error) {
    reportDiagnostic('warn', 'elevation.cancel', error)
  }
}

function requestProcess(action: ProcessAction, ticket?: string, isCurrent?: () => boolean): Promise<void> {
  if (pendingProcess) {
    if (pendingProcess.action === action && pendingProcess.ticket === ticket) return pendingProcess.promise
    if (ticket) {
      return discardElevation(ticket).then(() => {
        throw new Error('APP_PROCESS_BUSY')
      })
    }
    return Promise.reject(new Error('APP_PROCESS_BUSY'))
  }
  const promise = requestProcessAction(action, ticket, isCurrent).catch(async (error) => {
    if (ticket) await discardElevation(ticket)
    throw error
  }).finally(() => {
    pendingProcess = undefined
  })
  pendingProcess = { action, ticket, promise }
  return promise
}

async function requestProcessAction(action: ProcessAction, ticket?: string, isCurrent?: () => boolean): Promise<void> {
  const request: ProcessRequest = {
    action,
    ...(ticket ? { ticket } : {}),
    requestId: crypto.randomUUID(),
    requester: getCurrentWebviewWindow().label,
    deadline: Date.now() + PROCESS_TIMEOUT_MS,
  }
  if (guarded(action)) elevationGuards.set(request.requestId, isCurrent ?? (() => true))
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
    elevationGuards.delete(request.requestId)
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
      || !['quit', 'restart', 'restart-elevated', 'save-settings'].includes(payload.action)
      || !['main', 'preference'].includes(payload.requester)
      || !Number.isFinite(payload.deadline) || payload.deadline > Date.now() + PROCESS_TIMEOUT_MS) {
      return
    }
    if (guarded(payload.action)
      && (payload.requester !== 'preference' || !elevationGuards.has(payload.requestId)
        || (payload.action === 'restart-elevated' && !isElevationTicket(payload.ticket)))) {
      return
    }
    if (busy) return
    busy = true
    let current = true
    let exited = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      if (!active || !current || generation !== processOwnerGeneration || Date.now() >= payload.deadline) throw new Error('APP_PROCESS_CANCELLED')
      if (guarded(payload.action) && !elevationGuards.get(payload.requestId)?.()) throw new Error('APP_PROCESS_CANCELLED')
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
      if (payload.action === 'save-settings') {
        await releaseEditors(payload.requestId)
        check()
        return
      }
      if (payload.action === 'restart-elevated') {
        const result = await invoke<{ outcome?: unknown } | null>('restart_elevated_application', { requestId: payload.requestId, ticket: payload.ticket })
        if (result?.outcome !== 'inputReady') throw new Error('ELEVATION_INVALID_ACTIVATION')
        await releaseEditors(payload.requestId)
        return
      } else if (payload.action === 'restart') {
        await invoke('restart_application', { requestId: payload.requestId })
      } else {
        await exit(0)
      }
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
        reportDiagnostic('error', payload.action === 'save-settings' ? 'process.save' : payload.action === 'quit' ? 'process.quit' : 'process.restart', error)
      }
      current = false
      await releaseEditors(payload.requestId).catch(error => console.error('Process editor lease cleanup is pending.', error))
      await emitTo(payload.requester, PROCESS_RESPONSE, { ...payload, success: false })
        .catch(error => reportDiagnostic('warn', 'process.failure_response', error))
    } finally {
      current = false
      if (timer !== undefined) clearTimeout(timer)
      // Exit/restart keep writers frozen; save-only released its lease above.
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
