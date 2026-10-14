import type { InjectionKey, Ref } from 'vue'

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { BroadcastStatus } from '@/features/broadcast/types'
import type { RecoveryReport } from '@/features/recovery/types'

import { broadcastFailureCode, hasConfirmedBroadcastScene, runBroadcastRecovery } from '@/features/broadcast/recovery'
import { captureBroadcastScene } from '@/features/broadcast/scene'
import { createBroadcastSynchronizer } from '@/features/broadcast/synchronizer'
import { BROADCAST_STATUS_EVENT, isBroadcastStatus } from '@/features/broadcast/types'
import { waitForRecovery } from '@/features/recovery/wait'
import { useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'

export const BROADCAST_CONTROLLER: InjectionKey<ReturnType<typeof useBroadcast>> = Symbol('broadcast-controller')

/** Owned by the mounted preference page, not its currently selected tab. */
export function useBroadcast(ready: Ref<boolean>, busy: Ref<boolean>) {
  const block = useBlockStore()
  const general = useGeneralStore()
  const status = ref<BroadcastStatus>({ enabled: false, clients: 0 })
  const pending = ref(false)
  const retryGeneration = ref(0)
  const recovery = ref<RecoveryReport>()
  const retryPending = ref(false)
  const lifetime = new AbortController()
  let disposed = false
  let unlisten: (() => void) | undefined
  let subscribing: Promise<void> | undefined
  let subscriptionFailed = false
  let statusRevision = 0
  let nativeRevision = 0
  let nativeStatus: BroadcastStatus = status.value
  let configurationFailure: string | undefined
  let retryAbort: AbortController | undefined
  let retrying: Promise<RecoveryReport | undefined> | undefined
  let intentKey: string | undefined
  const accept = (value: unknown) => {
    if (!disposed && isBroadcastStatus(value)) {
      statusRevision++
      status.value = subscriptionFailed ? { ...value, error: 'unavailable' } : value
    }
  }
  const acceptNative = (value: unknown) => {
    if (!disposed && isBroadcastStatus(value)) {
      nativeRevision++
      nativeStatus = value
      accept(configurationFailure ? { ...value, error: configurationFailure } : value)
    }
  }
  const sync = createBroadcastSynchronizer({
    configure: async (configuration) => {
      configurationFailure = undefined
      const revision = nativeRevision
      const result = await invoke<BroadcastStatus>('configure_broadcast', configuration as unknown as Record<string, unknown>)
      if (!isBroadcastStatus(result)) throw new Error('invalid_broadcast_status')
      // A client can connect or disconnect before this IPC reply reaches the UI.
      return nativeRevision === revision ? result : nativeStatus
    },
    accept: acceptNative,
    failed: (error) => {
      configurationFailure = broadcastFailureCode(error)
      console.error('Failed to synchronize the broadcast scene.')
      accept({ ...status.value, error: configurationFailure })
    },
    pending: (value) => {
      pending.value = value
    },
  })
  watch(() => {
    void retryGeneration.value
    if (!general.broadcast.enabled) return { enabled: false }
    if (!ready.value || busy.value) return undefined
    try {
      return { enabled: true, scene: captureBroadcastScene(block) }
    } catch {
      console.warn('Failed to capture a valid broadcast scene.')
      return null
    }
  }, (configuration) => {
    const nextIntent = JSON.stringify(configuration ?? (configuration === null ? 'invalid' : 'blocked'))
    if (intentKey !== undefined && nextIntent !== intentKey) {
      retryAbort?.abort()
      if (!retryPending.value) recovery.value = undefined
    }
    intentKey = nextIntent
    if (configuration) sync.update(configuration)
    else sync.invalidate()
    if (configuration === null) {
      configurationFailure = 'skin_invalid'
      accept({ ...status.value, error: configurationFailure })
    }
  }, { deep: true, immediate: true, flush: 'post' })

  async function registerStatus() {
    const registration = listen<unknown>(BROADCAST_STATUS_EVENT, ({ payload }) => acceptNative(payload))
    const stop = await waitForRecovery(registration, 8000, lifetime.signal).catch(() => undefined)
    if (!stop) {
      // Timing out does not cancel Tauri registration. Retire its late handle;
      // this failed attempt must not issue a later initial-status query.
      void registration.then(lateStop => lateStop()).catch(() => {})
      if (!disposed) {
        console.warn('Failed to subscribe to broadcast status.')
        subscriptionFailed = true
        accept({ ...status.value, error: 'unavailable' })
      }
      return
    }
    if (disposed) {
      stop()
      return
    }
    unlisten = stop
    subscriptionFailed = false
    // Read after listener registration so an event cannot be missed in the gap.
    const queryRevision = statusRevision
    await waitForRecovery(invoke<BroadcastStatus>('get_broadcast_status'), 8000, lifetime.signal).then((value) => {
      // A pushed status or completed configuration can overtake this IPC reply.
      if (statusRevision === queryRevision) acceptNative(value)
    }).catch(() => {
      if (!disposed) console.warn('Failed to query broadcast status.')
    })
  }
  async function readStatus(): Promise<BroadcastStatus> {
    const revision = nativeRevision
    const value = await invoke<BroadcastStatus>('get_broadcast_status')
    if (!isBroadcastStatus(value)) throw new Error('invalid_broadcast_status')
    const observed = nativeRevision === revision ? value : nativeStatus
    acceptNative(observed)
    if (configurationFailure) accept({ ...observed, error: configurationFailure })
    return observed
  }
  function waitRendered(revision?: number): { result: Promise<BroadcastStatus>, dispose: () => void } {
    let stop = () => {}
    let release: (() => void) | undefined
    const result = new Promise<BroadcastStatus>((resolve) => {
      release = () => resolve(nativeStatus)
      stop = watch(() => status.value, () => {
        if (nativeStatus.enabled && hasConfirmedBroadcastScene(nativeStatus, revision)) {
          stop()
          resolve(nativeStatus)
        }
      }, { flush: 'sync' })
      // The ready push may arrive before this observer is installed.
      if (nativeStatus.enabled && hasConfirmedBroadcastScene(nativeStatus, revision)) {
        stop()
        resolve(nativeStatus)
      }
    })
    return { result, dispose: () => {
      stop()
      release?.()
    } }
  }
  function retry(): Promise<RecoveryReport | undefined> {
    if (disposed) return Promise.resolve(undefined)
    if (retrying) return retrying
    const abort = new AbortController()
    retryAbort = abort
    retryPending.value = true
    const selectedEnabled = general.broadcast.enabled
    retrying = runBroadcastRecovery({
      enabled: selectedEnabled,
      ready: ready.value && !busy.value,
      signal: abort.signal,
      subscribe: async () => {
        await ensureStatusSubscription()
        return !!unlisten && !subscriptionFailed
      },
      apply: async () => {
        sync.invalidate()
        retryGeneration.value++
        await nextTick()
        await sync.idle()
        return configurationFailure ?? (nativeStatus.error === 'render_failed' ? undefined : nativeStatus.error)
      },
      read: readStatus,
      rendered: waitRendered,
      report: (value) => {
        if (!disposed && retryAbort === abort) recovery.value = value
      },
    }).finally(() => {
      if (retryAbort === abort) retryAbort = undefined
      retrying = undefined
      if (!disposed) retryPending.value = false
    })
    return retrying
  }
  function ensureStatusSubscription() {
    if (disposed || unlisten) return Promise.resolve()
    subscribing ??= registerStatus().finally(() => {
      subscribing = undefined
    })
    return subscribing
  }
  onMounted(ensureStatusSubscription)
  onBeforeUnmount(() => {
    disposed = true
    lifetime.abort()
    retryAbort?.abort()
    unlisten?.()
    sync.dispose()
  })
  return {
    status,
    pending,
    recovery,
    retryPending,
    retry,
  }
}
