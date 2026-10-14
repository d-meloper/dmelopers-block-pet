import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { computed, shallowRef, watch } from 'vue'

import type { ForegroundHidingStatus } from '@/features/foregroundHiding/status'

import { isForegroundHidingSettings } from '@/features/foregroundHiding/settings'
import { createForegroundStatusReceiver, FOREGROUND_HIDING_STATUS, readForegroundHidingStatus } from '@/features/foregroundHiding/status'
import { createLatestAsyncTaskQueue } from '@/utils/latestAsyncTask'

import { reportDiagnostic } from './diagnostics'

export type { ForegroundHidingStatus } from '@/features/foregroundHiding/status'
export interface ForegroundApplication { id?: string, path: string, name: string, icon?: string | null, launchOptions?: boolean }
export const MAX_FOREGROUND_CATALOG_ITEMS = 16384

// Runtime state belongs to this webview, outside Pinia/preset serialization.
export const foregroundHidingStatus = shallowRef<ForegroundHidingStatus>()
const available = shallowRef(false)
export const foregroundHidingSuppressed = computed(() => available.value && foregroundHidingStatus.value?.suppressed === true)
let lifetime = 0
let acceptStatus: ((value: unknown) => boolean) | undefined

/** Called once by App after store restoration, not by an individual settings tab. */
export async function startForegroundHiding(configuration?: () => unknown, desktopVisibility: () => boolean = () => true): Promise<() => void> {
  const generation = ++lifetime
  available.value = false
  foregroundHidingStatus.value = undefined
  let disposed = false
  let subscribed = false
  let configurationFailed = false
  let unlisten: (() => void) | undefined
  let stopSettings: (() => void) | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let resolveStartup: (() => void) | undefined
  let nativeStatus: ForegroundHidingStatus | undefined
  const failed = () => {
    if (disposed || generation !== lifetime) return
    available.value = false
    if (nativeStatus) foregroundHidingStatus.value = { ...nativeStatus, ready: true, suppressed: false, state: 'unavailable' }
  }
  const receiver = createForegroundStatusReceiver((status) => {
    if (generation !== lifetime) return
    if (subscribed && !configurationFailed) available.value = true
    nativeStatus = status
    foregroundHidingStatus.value = available.value ? status : { ...status, suppressed: false, state: 'unavailable' }
    if (status.ready) resolveStartup?.()
  })
  const release = () => {
    if (disposed) return
    disposed = true
    if (generation === lifetime) {
      available.value = false
      acceptStatus = undefined
    }
    receiver.dispose()
    stopSettings?.()
    sync.clear()
    clearTimeout(startupTimer)
    resolveStartup?.()
    const listener = unlisten
    unlisten = undefined
    if (listener) void Promise.resolve(listener()).catch(() => reportDiagnostic('warn', 'foreground_hiding.unsubscribe'))
  }
  const sync = createLatestAsyncTaskQueue(async ({ config, desktopVisible }: { config: unknown, desktopVisible: boolean }) => {
    if (disposed || !subscribed) return
    const runtimeConfig = isForegroundHidingSettings(config)
      ? { enabled: config.enabled, applications: [...config.applications] }
      : null
    const result = await invoke('configure_foreground_hiding', { config: runtimeConfig, desktopVisible })
    if (disposed || generation !== lifetime) return
    if (!readForegroundHidingStatus(result)) throw new Error('FOREGROUND_HIDING_STATUS_INVALID')
    configurationFailed = false
    available.value = true
    receiver.accept(result)
    if (nativeStatus) foregroundHidingStatus.value = nativeStatus
  }, { onError: () => {
    if (!disposed) {
      configurationFailed = true
      failed()
      reportDiagnostic('warn', 'foreground_hiding.configure')
    }
  } })
  try {
    // A timeout retires late registration; no query/configuration is sent after it.
    const registered = (async () => {
      const listener = await listen<unknown>(FOREGROUND_HIDING_STATUS, ({ payload }) => receiver.accept(payload))
      if (disposed) await listener()
      else unlisten = listener
    })()
    const registrationTimeout = new Promise<never>((_resolve, reject) => {
      startupTimer = setTimeout(() => reject(new Error('FOREGROUND_HIDING_SUBSCRIPTION_TIMEOUT')), 1000)
    })
    await Promise.race([registered, registrationTimeout])
    clearTimeout(startupTimer)
    if (disposed) return release
    subscribed = true
    available.value = true
    acceptStatus = receiver.accept
    if (nativeStatus) foregroundHidingStatus.value = nativeStatus
    // The listener is active before the query, so its newer event wins a race.
    const initial = invoke<unknown>('get_foreground_hiding_status').then((value) => {
      if (!readForegroundHidingStatus(value)) throw new Error('FOREGROUND_HIDING_STATUS_INVALID')
      return receiver.accept(value)
    })
    const ready = new Promise<void>((resolve) => {
      resolveStartup = resolve
      startupTimer = setTimeout(resolve, 1000)
    })
    void initial.then(() => {
      if (foregroundHidingStatus.value?.ready) resolveStartup?.()
    }).catch(() => {
      // A newer valid event/configuration already proves this lifetime is live.
      if (!disposed && !nativeStatus) {
        failed()
        resolveStartup?.()
        reportDiagnostic('warn', 'foreground_hiding.query')
      }
    })
    if (configuration) {
      stopSettings = watch(() => ({ config: configuration(), desktopVisible: desktopVisibility() }), value => sync.enqueue({ config: JSON.parse(JSON.stringify(value.config ?? null)), desktopVisible: value.desktopVisible }), { deep: true, immediate: true, flush: 'sync' })
    }
    await ready
    clearTimeout(startupTimer)
    resolveStartup = undefined
    return release
  } catch {
    release()
    reportDiagnostic('warn', 'foreground_hiding.subscribe')
    return release
  }
}

/** Preferences resolves manual intent; this command never changes durable settings. */
export async function showForegroundHidingVisit(): Promise<void> {
  if (foregroundHidingStatus.value?.matchedRule == null) return
  const generation = lifetime
  const status = readForegroundHidingStatus(await invoke<unknown>('get_foreground_hiding_status'))
  if (generation !== lifetime || !status || typeof status.visit !== 'number' || status.matchedRule === null) return
  const result = await invoke<unknown>('show_foreground_hiding_visit', { revision: status.revision, visit: status.visit })
  if (generation === lifetime) acceptStatus?.(result)
}

function readApplications(result: unknown, limit = MAX_FOREGROUND_CATALOG_ITEMS): ForegroundApplication[] {
  if (!Array.isArray(result) || result.length > limit
    || result.some(row => !row || typeof row.path !== 'string' || typeof row.name !== 'string'
      || (row.id != null && (typeof row.id !== 'string' || !row.id || row.id.length > 128))
      || (row.launchOptions != null && typeof row.launchOptions !== 'boolean')
      || (row.icon != null && (typeof row.icon !== 'string' || !row.icon.startsWith('data:image/png;base64,'))))) {
    throw new Error('FOREGROUND_APPLICATIONS_INVALID')
  }
  return result as ForegroundApplication[]
}

export async function listForegroundApplications(onApplication?: (item: ForegroundApplication) => void, onIncomplete?: (incomplete: boolean) => void): Promise<ForegroundApplication[]> {
  if (!onApplication) return readApplications(await invoke<unknown>('list_foreground_applications'))
  let active = true
  let invalidItem = false
  const channel = new Channel<unknown>((value) => {
    if (!active || invalidItem) return
    try {
      onApplication(readApplications([value])[0])
    } catch {
      invalidItem = true
    }
  })
  try {
    const result = await invoke<unknown>('stream_foreground_programs', { onApplication: channel })
    if (!result || typeof result !== 'object'
      || typeof (result as { incomplete?: unknown }).incomplete !== 'boolean'
      || typeof (result as { truncated?: unknown }).truncated !== 'boolean') {
      throw new Error('FOREGROUND_APPLICATIONS_INVALID')
    }
    const catalog = result as { items: unknown, incomplete: boolean, truncated: boolean }
    const rows = readApplications(catalog.items)
    if (invalidItem) throw new Error('FOREGROUND_APPLICATIONS_INVALID')
    onIncomplete?.(catalog.incomplete || catalog.truncated)
    return rows
  } finally {
    active = false
    channel.onmessage = () => {}
  }
}

export async function describeForegroundApplications(paths: string[]): Promise<ForegroundApplication[]> {
  return readApplications(await invoke<unknown>('describe_foreground_applications', { paths }))
}

export async function selectForegroundApplication(): Promise<ForegroundApplication | undefined> {
  const result = await invoke<unknown>('select_foreground_application')
  return result == null ? undefined : readApplications([result])[0]
}
