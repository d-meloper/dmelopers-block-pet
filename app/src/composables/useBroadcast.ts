import type { InjectionKey, Ref } from 'vue'

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { BroadcastStatus } from '@/features/broadcast/types'

import { captureBroadcastScene } from '@/features/broadcast/scene'
import { createBroadcastSynchronizer } from '@/features/broadcast/synchronizer'
import { BROADCAST_STATUS_EVENT, isBroadcastStatus } from '@/features/broadcast/types'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'

export const BROADCAST_CONTROLLER: InjectionKey<ReturnType<typeof useBroadcast>> = Symbol('broadcast-controller')

/** Owned by the mounted preference page, not its currently selected tab. */
export function useBroadcast(ready: Ref<boolean>, busy: Ref<boolean>) {
  const cat = useCatStore()
  const general = useGeneralStore()
  const status = ref<BroadcastStatus>({ enabled: false, clients: 0 })
  const pending = ref(false)
  const retryGeneration = ref(0)
  let disposed = false
  let unlisten: (() => void) | undefined
  let subscribing: Promise<void> | undefined
  let subscriptionFailed = false
  let statusRevision = 0
  const accept = (value: unknown) => {
    if (!disposed && isBroadcastStatus(value)) {
      statusRevision++
      status.value = subscriptionFailed ? { ...value, error: 'unavailable' } : value
    }
  }
  const sync = createBroadcastSynchronizer({
    configure: async (configuration) => {
      const revision = statusRevision
      const result = await invoke<BroadcastStatus>('configure_broadcast', configuration as unknown as Record<string, unknown>)
      // A client can connect or disconnect before this IPC reply reaches the UI.
      return statusRevision === revision ? result : status.value
    },
    accept,
    failed: () => {
      console.error('Failed to synchronize the broadcast scene.')
      accept({ ...status.value, error: 'unavailable' })
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
      return { enabled: true, scene: captureBroadcastScene(cat) }
    } catch {
      console.warn('Failed to capture a valid broadcast scene.')
      return null
    }
  }, (configuration) => {
    if (configuration) sync.update(configuration)
    else sync.invalidate()
    if (configuration === null) accept({ ...status.value, error: 'render_failed' })
  }, { deep: true, immediate: true, flush: 'post' })

  async function registerStatus() {
    const stop = await listen<unknown>(BROADCAST_STATUS_EVENT, ({ payload }) => accept(payload)).catch(() => undefined)
    if (!stop) {
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
    await invoke<BroadcastStatus>('get_broadcast_status').then((value) => {
      // A pushed status or completed configuration can overtake this IPC reply.
      if (statusRevision === queryRevision) accept(value)
    }).catch(() => {
      if (!disposed) console.warn('Failed to query broadcast status.')
    })
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
    unlisten?.()
    sync.dispose()
  })
  return {
    status,
    pending,
    retry: () => {
      void ensureStatusSubscription().then(() => {
        if (disposed) return
        sync.invalidate()
        retryGeneration.value++
      })
    },
  }
}
