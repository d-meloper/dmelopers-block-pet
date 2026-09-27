import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { SceneViewportRequest, SceneViewportResponse, SceneViewportState } from '@/features/scene/types'

import { WINDOW_LABEL } from '@/constants'
import { confirmPresetUserEdit, markPresetUserEdit, onPresetSelectionChange } from '@/features/presets/editIntent'
import { beginPresetNativeEdit, presetOperationInProgress, presetResetInProgress } from '@/features/presets/operations'
import { isSceneViewportState, SCENE_VIEWPORT_REQUEST, SCENE_VIEWPORT_RESPONSE, SCENE_VIEWPORT_STATE } from '@/features/scene/types'
import { useCatStore } from '@/stores/cat'

export function useSceneViewport(
  emitRequest: (request: SceneViewportRequest, isCurrent?: () => boolean) => Promise<unknown> = payload => emitTo(WINDOW_LABEL.MAIN, SCENE_VIEWPORT_REQUEST, payload),
) {
  const store = useCatStore()
  const { t } = useI18n()
  const viewportState = ref<SceneViewportState>()
  const viewportPending = ref(false)
  const viewportError = ref<string>()
  const stops: Array<() => void> = []
  let disposed = false
  let selectionGeneration = 0
  let refreshFailed = false
  let pending: { id: string, automatic?: boolean, resolve: (success: boolean) => void, releaseNative: () => void, timer: ReturnType<typeof setTimeout> } | undefined
  let ready: Promise<void> = Promise.resolve()
  const isCurrentState = (value: unknown): value is SceneViewportState => isSceneViewportState(value)
    && value.revision >= Math.max(viewportState.value?.revision ?? 0, store.activePet3dPreset.viewportModeRevision)
  const acceptState = (value: unknown) => {
    if (disposed || !isCurrentState(value)) return
    viewportState.value = value
  }
  const finish = (success: boolean) => {
    if (!pending) return
    const request = pending
    refreshFailed = !success && request.automatic === undefined
    pending = undefined
    clearTimeout(request.timer)
    viewportPending.value = false
    request.releaseNative()
    request.resolve(success)
  }
  stops.push(onPresetSelectionChange(() => {
    selectionGeneration++
    finish(false)
    refreshFailed = false
  }))
  const requestViewportMode = async (automatic?: boolean): Promise<boolean> => {
    const generation = selectionGeneration
    await ready
    if (disposed || pending || generation !== selectionGeneration
      || presetOperationInProgress.value || presetResetInProgress.value) {
      return false
    }
    refreshFailed = false
    viewportPending.value = true
    viewportError.value = undefined
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID()
      pending = {
        id: requestId,
        automatic,
        resolve,
        releaseNative: beginPresetNativeEdit(),
        timer: setTimeout(() => {
          console.warn('The scene viewport acknowledgement timed out.')
          viewportError.value = t('pages.preference.scene.errors.timeout')
          finish(false)
        }, 10000),
      }
      void emitRequest({ requestId, automatic }, () => !disposed && pending?.id === requestId
        && generation === selectionGeneration && !presetOperationInProgress.value && !presetResetInProgress.value).catch(() => {
        if (disposed || pending?.id !== requestId) return
        console.warn('Failed to send the scene viewport request.')
        viewportError.value = t('pages.preference.scene.errors.unavailable')
        finish(false)
      })
    })
  }
  const refreshViewport = () => {
    void requestViewportMode()
  }
  stops.push(watch([presetOperationInProgress, presetResetInProgress], ([operating, resetting], [wasOperating, wasResetting]) => {
    if (!operating && !resetting && (wasOperating || wasResetting) && !disposed) refreshViewport()
  }))
  onMounted(() => {
    ready = (async () => {
      const registered = await Promise.all([
        listen<unknown>(SCENE_VIEWPORT_STATE, ({ payload }) => {
          if (disposed || !isCurrentState(payload)) return
          acceptState(payload)
          // A native update can arrive after a failed/timed-out initial query.
          // Recheck through the acknowledgement path; a snapshot alone cannot
          // prove that initialization or a requested mode change succeeded.
          if (refreshFailed && !pending) refreshViewport()
        }),
        listen<SceneViewportResponse>(SCENE_VIEWPORT_RESPONSE, ({ payload }) => {
          if (!payload || !pending || pending.id !== payload.requestId) return
          const success = payload.success === true && isCurrentState(payload.state)
            && (pending.automatic === undefined || pending.automatic === payload.state.automatic)
          if (success && isSceneViewportState(payload.state)) {
            acceptState(payload.state)
            // Adopt the main window's atomic mode + rectangle selection before
            // the preference watcher publishes its next full preset snapshot.
            if (pending.automatic !== undefined) markPresetUserEdit()
            Object.assign(store.activePet3dPreset, {
              autoViewportEnabled: payload.state.automatic,
              viewportModeRevision: payload.state.revision,
              ...(pending.automatic !== undefined ? { cameraHorizontalOffset: 0, cameraVerticalOffset: 0 } : {}),
              ...(!payload.state.automatic ? { manualViewportRect: { ...payload.state.rect } } : {}),
            })
            if (pending.automatic !== undefined) confirmPresetUserEdit()
          } else {
            console.warn('The scene viewport acknowledgement was rejected.')
            viewportError.value = t('pages.preference.scene.errors.unavailable')
          }
          finish(success)
        }),
        getCurrentWebviewWindow().onFocusChanged(({ payload }) => {
          if (payload) refreshViewport()
        }),
      ])
      if (disposed) registered.forEach(stop => stop())
      else stops.push(...registered)
    })()
    void ready.then(refreshViewport).catch(() => {
      if (disposed) return
      console.warn('Failed to subscribe to scene viewport state.')
      viewportError.value = t('pages.preference.scene.errors.unavailable')
    })
  })
  onBeforeUnmount(() => {
    disposed = true
    stops.splice(0).forEach(stop => stop())
    finish(false)
  })
  return { viewportState, viewportPending, viewportError, requestViewportMode, refreshViewport }
}
