import { listen } from '@tauri-apps/api/event'
import { onBeforeUnmount, onMounted, watch } from 'vue'

import type { AntialiasSettingRequest } from '@/config/performance'

import { ANTIALIAS_SETTING_REQUEST, ANTIALIAS_SETTING_RESPONSE } from '@/config/performance'
import { createAntialiasSettingOwner } from '@/features/performance/antialiasSetting'
import { beginPresetNativeEdit } from '@/features/presets/operations'
import { reportDiagnostic } from '@/services/diagnostics'
import { useBlockStore } from '@/stores/block'
import { usePerformanceStore } from '@/stores/performance'

/** Preferences stays the sole setting writer, including renderer rollback. */
export function useAntialiasSetting(
  send: (event: string, payload: AntialiasSettingRequest) => Promise<unknown>,
  failed: (reason: 'failed' | 'unconfirmed') => void,
) {
  const block = useBlockStore()
  const performance = usePerformanceStore()
  let disposed = false
  let unlisten: (() => void) | undefined
  let subscription: Promise<boolean> | undefined
  const ensureSubscription = () => {
    if (disposed) return Promise.resolve(false)
    if (unlisten) return Promise.resolve(true)
    subscription ??= listen<unknown>(ANTIALIAS_SETTING_RESPONSE, ({ payload }) => owner.accept(payload))
      .then((release) => {
        if (disposed) {
          release()
          return false
        }
        unlisten = release
        return true
      })
      .catch((error) => {
        reportDiagnostic('warn', 'performance.antialias_subscription', error)
        return false
      })
      .finally(() => {
        subscription = undefined
      })
    return subscription
  }
  const owner = createAntialiasSettingOwner({
    current: () => block.model.antialiasEnabled,
    restore: (actual) => {
      block.model.antialiasEnabled = actual
      void performance.reset()
    },
    send: async (event, request) => {
      if (event === ANTIALIAS_SETTING_REQUEST
        && (!await ensureSubscription() || !owner.isPending(request.requestId))) {
        return
      }
      return send(event, request)
    },
    failed,
    beginNativeEdit: beginPresetNativeEdit,
    report: error => reportDiagnostic('warn', 'performance.antialias_request', error),
  })
  let mounted = false
  watch(() => block.model.antialiasEnabled, (requested) => {
    if (mounted) owner.request(requested)
  }, { flush: 'sync' })
  onMounted(() => {
    mounted = true
    owner.request(block.model.antialiasEnabled)
  })
  onBeforeUnmount(() => {
    disposed = true
    mounted = false
    unlisten?.()
    owner.dispose()
  })
}
