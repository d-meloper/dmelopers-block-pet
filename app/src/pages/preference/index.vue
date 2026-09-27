<script setup lang="ts">
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEventListener } from '@vueuse/core'
import { ConfigProvider, Flex, message } from 'ant-design-vue'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { BROADCAST_CONTROLLER, useBroadcast } from '@/composables/useBroadcast'
import { cancelShortcutRecording, useKeyPress } from '@/composables/useKeyPress'
import { usePetRuntimeRecovery } from '@/composables/usePetRuntimeRecovery'
import { usePreferenceTheme } from '@/composables/usePreferenceTheme'
import { providePreferenceUpdates } from '@/composables/usePreferenceUpdates'
import { usePresetManager } from '@/composables/usePresetManager'
import { useSceneViewport } from '@/composables/useSceneViewport'
import { useTauriListen } from '@/composables/useTauriListen'
import { useThemeVars } from '@/composables/useThemeVars'
import { useTray } from '@/composables/useTray'
import { ANTIALIAS_CHANGE_FAILED } from '@/config/performance'
import { appDarkAlgorithm, appLightAlgorithm } from '@/config/theme'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { APP_DISPLAY_NAME } from '@/constants/branding'
import { isMouseSettingResponse } from '@/features/input/types'
import { confirmPresetUserEdit, onPresetSelectionChange } from '@/features/presets/editIntent'
import { beginPresetNativeEdit, presetOperationInProgress, presetResetInProgress } from '@/features/presets/operations'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'
import { SCENE_VIEWPORT_REQUEST } from '@/features/scene/types'
import { getAntdLocale } from '@/locales/antd'
import { APP_PROCESS_FAILED } from '@/plugins/process'
import { toggleWindowVisible } from '@/plugins/window'
import { reportDiagnostic } from '@/services/diagnostics'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'
import { usePerformanceStore } from '@/stores/performance'
import { useShortcutStore } from '@/stores/shortcut'
import { captureViewportPointer } from '@/utils/viewportInteraction'

import About from './components/about/index.vue'
import Cat from './components/cat/index.vue'
import Environment from './components/environment/index.vue'
import General from './components/general/index.vue'
import Performance from './components/performance/index.vue'
import Presets from './components/presets/index.vue'
import Scene from './components/scene/index.vue'
import Shortcut from './components/shortcut/index.vue'
import SkinLibrary from './components/skin-library/index.vue'
import UpdateReminder from './components/UpdateReminder.vue'
import { usePreferenceNavigation } from './navigation'
import { shouldMonitorPreferencePerformance } from './performanceLifecycle'

import 'ant-design-vue/dist/reset.css'

useTray()
usePreferenceTheme()
const { generateColorVars } = useThemeVars()
const { current, innerView, closeInnerView, openSkinLibrary } = usePreferenceNavigation()
const scrollContainer = ref<HTMLElement>()
// Window-local state survives tab changes and hide/show, but resets on app restart.
const tabScrollPositions = new Map<number, number>()
const scrollTab = computed(() => innerView.value ? undefined : current.value)
watch(scrollTab, (_tab, previousTab) => {
  // Save before shorter content can clamp the shared container's scroll position.
  if (previousTab !== undefined && scrollContainer.value) {
    tabScrollPositions.set(previousTab, scrollContainer.value.scrollTop)
  }
})
watch([scrollTab, scrollContainer], ([tab, container]) => {
  // Restore after the tab content or the container returning from an inner view mounts.
  if (tab !== undefined && container) container.scrollTop = tabScrollPositions.get(tab) ?? 0
}, { flush: 'post' })
const { t } = useI18n()
const updates = providePreferenceUpdates()
usePetRuntimeRecovery(t)
// Keep errors visible when a reset or tab change unmounts the Performance page.
useTauriListen(ANTIALIAS_CHANGE_FAILED, () => message.error(t('pages.preference.performance.errors.antialiasFailed')))
useTauriListen<{ action: 'quit' | 'restart' }>(APP_PROCESS_FAILED, ({ payload }) => {
  const action = payload?.action === 'restart' ? 'restart' : 'quit'
  message.error(t(`composables.useAppMenu.errors.${action}`), 8)
})
const catStore = useCatStore()
const { visibleCat, visiblePreference, mirrorMode, cycleZoom, cycleRotation, penetrable, alwaysOnTop, toggleBroadcast, showDisplayArea, mouseEnabled, keepInScreen, hideOnHover } = storeToRefs(useShortcutStore())
const generalStore = useGeneralStore()
const performanceStore = usePerformanceStore()
const appWindow = getCurrentWebviewWindow()
const closing = ref(false)
const { viewportState, viewportPending, viewportError, requestViewportMode, refreshViewport } = useSceneViewport(
  (payload, isCurrent) => emitMainEvent(SCENE_VIEWPORT_REQUEST, payload, isCurrent),
)
let performanceLifecycleGeneration = 0
const performanceLifecycleUnlisteners: Array<() => void> = []
let interactionButtons = 0
let mainEventQueue = Promise.resolve()
const presetManager = usePresetManager(emitMainEvent)
provide(BROADCAST_CONTROLLER, useBroadcast(presetManager.ready, presetManager.busy))
// Global shortcuts belong to the window, which stays mounted across tabs and hide/show.
useKeyPress(visibleCat, () => {
  void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { visible: !catStore.window.visible })
})
useKeyPress(visiblePreference, () => {
  void toggleWindowVisible(WINDOW_LABEL.PREFERENCE)
})
useKeyPress(mirrorMode, () => {
  void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { mirror: !catStore.model.mirror })
})
useKeyPress(cycleZoom, () => {
  void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { cycle: 'cameraZoomPercent' })
})
useKeyPress(cycleRotation, () => {
  void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { cycle: 'sceneRotationOffsetDegrees' })
})
useKeyPress(penetrable, () => {
  catStore.window.passThrough = !catStore.window.passThrough
})
useKeyPress(alwaysOnTop, () => {
  catStore.window.alwaysOnTop = !catStore.window.alwaysOnTop
})
useKeyPress(toggleBroadcast, () => {
  generalStore.broadcast.enabled = !generalStore.broadcast.enabled
})
useKeyPress(showDisplayArea, () => {
  void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { showDisplayArea: !catStore.activePet3dPreset.showDisplayArea })
})
useKeyPress(mouseEnabled, async () => {
  if (mousePending.value) return
  if (!mouseReady.value && !await requestMouseEnabled(undefined, true)) return
  await requestMouseEnabled(!catStore.activePet3dPreset.mouseEnabled, true)
})
useKeyPress(keepInScreen, () => {
  catStore.window.keepInScreen = !catStore.window.keepInScreen
})
useKeyPress(hideOnHover, () => {
  catStore.window.hideOnHover = !catStore.window.hideOnHover
})
const { busy: presetBusy, ready: presetReady } = presetManager
const mousePending = ref(false)
const mouseReady = ref(false)
const mouseError = ref<'unsupported' | 'unavailable' | 'timeout'>()
let mouseRequestSequence = 0
const mouseRequestSession = crypto.randomUUID()
let mouseResponseUnlisten: (() => void) | undefined
let preferenceDisposed = false
let mouseRequest: {
  id: string
  desired?: boolean
  querying: boolean
  allowHidden: boolean
  resolve: (success: boolean) => void
  releaseNative: () => void
  timer?: ReturnType<typeof setTimeout>
} | undefined
const stopMouseSelectionListener = onPresetSelectionChange(() => {
  if (mouseRequest) mouseReady.value = false
  finishMouseRequest(false)
})

// Preserve down -> settings -> release ordering across the two webviews.
function emitMainEvent(event: string, payload: unknown, isCurrent = () => true) {
  mainEventQueue = mainEventQueue
    .then(() => isCurrent() ? emitTo(WINDOW_LABEL.MAIN, event, typeof payload === 'function' ? payload() : payload) : undefined)
    .catch(error => console.error('Failed to send preference changes.', error))
  return mainEventQueue
}

function finishMouseRequest(success: boolean) {
  const request = mouseRequest
  mouseRequest = undefined
  mousePending.value = false
  clearTimeout(request?.timer)
  request?.releaseNative()
  request?.resolve(success)
}

function sendMouseRequest(querying: boolean) {
  const request = mouseRequest
  if (!request) return
  clearTimeout(request.timer)
  request.id = `${mouseRequestSession}:${++mouseRequestSequence}`
  request.querying = querying
  const id = request.id
  void emitMainEvent(LISTEN_KEY.MOUSE_SETTING_REQUEST, {
    requestId: id,
    ...(!querying && request.desired !== undefined ? { enabled: request.desired } : {}),
  }, () => !preferenceDisposed && (!closing.value || request.allowHidden) && mouseRequest?.id === id)
  request.timer = setTimeout(() => {
    if (mouseRequest?.id !== id) return
    mouseError.value = 'timeout'
    mouseReady.value = false
    if (!querying) sendMouseRequest(true)
    else finishMouseRequest(false)
  }, 5000)
}

function requestMouseEnabled(enabled?: boolean, allowHidden = false): Promise<boolean> {
  if (mousePending.value || preferenceDisposed || (closing.value && !allowHidden)
    || presetOperationInProgress.value || presetResetInProgress.value) {
    return Promise.resolve(false)
  }
  mousePending.value = true
  mouseError.value = undefined
  return new Promise((resolve) => {
    mouseRequest = { id: '', desired: enabled, allowHidden, querying: enabled === undefined, resolve, releaseNative: beginPresetNativeEdit() }
    sendMouseRequest(enabled === undefined)
  })
}

function refreshMouseSetting() {
  void requestMouseEnabled()
}

watch([presetOperationInProgress, presetResetInProgress], ([operating, resetting], [wasOperating, wasResetting]) => {
  if (!operating && !resetting && (wasOperating || wasResetting)
    && !preferenceDisposed && !closing.value) {
    refreshMouseSetting()
  }
})

async function listenForMouseResponses() {
  const unlisten = await listen<unknown>(LISTEN_KEY.MOUSE_SETTING_RESPONSE, ({ payload }) => {
    if (preferenceDisposed || (closing.value && !mouseRequest?.allowHidden) || !isMouseSettingResponse(payload)
      || !mouseRequest || mouseRequest.id !== payload.requestId) {
      return
    }
    const success = payload.success && (mouseRequest.desired === undefined
      || payload.state?.mouseEnabled === mouseRequest.desired)
    if (payload.state) {
      if (!presetOperationInProgress.value && !presetResetInProgress.value) {
        // This write is backed by the main window's native acknowledgement.
        const userEdit = success && mouseRequest.desired !== undefined && !mouseRequest.querying
        if (userEdit) presetManager.markUserEdit()
        catStore.activePet3dPreset.mouseEnabled = payload.state.mouseEnabled
        if (userEdit) confirmPresetUserEdit()
      }
      mouseReady.value = true
    }
    mouseError.value = success ? undefined : payload.error ?? 'unavailable'
    finishMouseRequest(success)
  })
  if (preferenceDisposed) unlisten()
  else mouseResponseUnlisten = unlisten
}

function updateInteractionButtons(buttons: number) {
  if (interactionButtons === buttons) return
  interactionButtons = buttons
  emitMainEvent(LISTEN_KEY.VIEWPORT_INTERACTION_CHANGED, { buttons })
}

function trackInteraction(event: MouseEvent) {
  updateInteractionButtons(event.buttons)
}

function cancelInteraction(event?: Event) {
  // The capture listener also receives input blur before its recorder can commit.
  if (!event || event.target === window) cancelShortcutRecording()
  updateInteractionButtons(0)
}

function markPresetUserEdit(event: Event) {
  if (current.value < 1 || current.value > 3) return
  if (event.target instanceof Element && event.target.closest('[data-preset-common-setting]')) return
  if (event.type === 'pointermove' && !(event as PointerEvent).buttons) return
  presetManager.markUserEdit()
}

useEventListener(window, ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup'], trackInteraction, { capture: true })
useEventListener(window, 'pointerdown', captureViewportPointer, { capture: true })
useEventListener(window, ['blur', 'pointercancel'], cancelInteraction, { capture: true })
useEventListener(document, 'visibilitychange', () => {
  if (document.hidden) cancelInteraction()
  void reconcilePerformanceMonitoring()
})

async function reconcilePerformanceMonitoring() {
  const generation = ++performanceLifecycleGeneration
  const [visible, minimized] = await Promise.all([
    appWindow.isVisible().catch((error) => {
      if (!preferenceDisposed && !closing.value && generation === performanceLifecycleGeneration) {
        reportDiagnostic('warn', 'preference.visibility_query', error)
      }
      return false
    }),
    appWindow.isMinimized().catch((error) => {
      if (!preferenceDisposed && !closing.value && generation === performanceLifecycleGeneration) {
        reportDiagnostic('warn', 'preference.minimized_query', error)
      }
      return true
    }),
  ])
  if (generation !== performanceLifecycleGeneration) return

  const shouldMonitor = shouldMonitorPreferencePerformance({
    activeTab: innerView.value ? -1 : current.value,
    performanceTab: 4,
    visible,
    minimized,
    closing: closing.value,
  })
  presetManager.setListVisible(visible && !minimized && !closing.value && !document.hidden
    && !innerView.value && current.value === 0)
  if (shouldMonitor) await performanceStore.start()
  else await performanceStore.stop()
}

function emitPet3dPresetSelection() {
  if (presetManager.busy.value) return
  emitMainEvent(LISTEN_KEY.PET_PRESET_CHANGED, () => {
    const preset = catStore.activePet3dPreset
    return {
      modelId: catStore.customization3d.selectedModelId,
      dmeloperSkinDataUrl: catStore.customization3d.dmeloperSkinDataUrl,
      dmeloperSkinModel: catStore.customization3d.dmeloperSkinModel,
      useDefaultDmeloperSkin: catStore.customization3d.useDefaultDmeloperSkin,
      preset: {
        ...preset,
        manualViewportRect: { ...preset.manualViewportRect },
        dmeloperEyebrows: { ...preset.dmeloperEyebrows },
      },
    }
  })
}

onMounted(async () => {
  generateColorVars()
  await listenForMouseResponses()
  if (preferenceDisposed) return
  refreshMouseSetting()
  performanceLifecycleUnlisteners.push(
    await appWindow.onResized(() => void reconcilePerformanceMonitoring()),
  )
  performanceLifecycleUnlisteners.push(
    await appWindow.onFocusChanged(({ payload: focused }) => {
      if (!focused) cancelInteraction()
      if (focused) {
        closing.value = false
        refreshMouseSetting()
      }
      void reconcilePerformanceMonitoring()
    }),
  )
  performanceLifecycleUnlisteners.push(
    await appWindow.onCloseRequested((event) => {
      // Rust hides this persistent window. Tauri's JS default would destroy it.
      event.preventDefault()
      cancelInteraction()
      closing.value = true
      mouseReady.value = false
      finishMouseRequest(false)
      void reconcilePerformanceMonitoring()
    }),
  )
  await reconcilePerformanceMonitoring()
})

onBeforeUnmount(() => {
  preferenceDisposed = true
  stopMouseSelectionListener()
  mouseResponseUnlisten?.()
  finishMouseRequest(false)
  cancelInteraction()
  performanceLifecycleGeneration += 1
  performanceLifecycleUnlisteners.splice(0).forEach(unlisten => unlisten())
  presetManager.setListVisible(false)
  void performanceStore.stop()
})

watch([current, innerView], () => void reconcilePerformanceMonitoring())

watch(() => generalStore.appearance.language, () => {
  appWindow.setTitle(`${APP_DISPLAY_NAME} — ${t('pages.preference.title')}`)
}, { immediate: true })

watch(
  [
    () => presetManager.busy.value,
    () => catStore.customization3d.selectedModelId,
    () => catStore.customization3d.dmeloperSkinDataUrl,
    () => catStore.customization3d.dmeloperSkinModel,
    () => catStore.customization3d.useDefaultDmeloperSkin,
    () => catStore.activePet3dPreset,
    () => catStore.model.mirror,
  ],
  emitPet3dPresetSelection,
  { deep: true, immediate: true },
)

const menus = computed(() => [
  {
    label: t('pages.preference.presets.title'),
    icon: 'i-solar:layers-bold',
    component: Presets,
  },
  {
    label: t('pages.preference.cat.title'),
    icon: 'i-solar:user-hands-bold',
    component: Cat,
  },
  {
    label: t('pages.preference.scene.title'),
    icon: 'i-solar:videocamera-bold-duotone',
    component: Scene,
  },
  {
    label: t('pages.preference.environment.title'),
    icon: 'i-solar:box-minimalistic-bold-duotone',
    component: Environment,
  },
  {
    label: t('pages.preference.performance.title'),
    icon: 'i-solar:chart-square-bold',
    component: Performance,
  },
  {
    label: t('pages.preference.shortcut.title'),
    icon: 'i-solar:keyboard-bold',
    component: Shortcut,
  },
  {
    label: t('pages.preference.general.title'),
    icon: 'i-solar:settings-bold',
    component: General,
  },
  {
    label: t('pages.preference.about.title'),
    icon: 'i-solar:info-circle-bold',
    component: About,
  },
])
</script>

<template>
  <ConfigProvider
    :dropdown-match-select-width="false"
    :locale="getAntdLocale(generalStore.appearance.language)"
    :theme="{
      algorithm: generalStore.appearance.isDark ? appDarkAlgorithm : appLightAlgorithm,
    }"
  >
    <UpdateReminder
      :busy="updates.busy.value"
      :status="updates.phase.value ? t(`inAppUpdates.${updates.phase.value}`) : undefined"
      :version="updates.reminderVersion.value"
      @close="updates.dismiss"
      @snooze="updates.snooze"
      @update="updates.update"
    />
    <SkinLibrary
      v-if="innerView === 'skin-library'"
      @back="closeInnerView"
    />

    <Flex
      v-else
      class="h-screen"
    >
      <div
        class="preference-sidebar h-full w-40 flex flex-shrink-0 flex-col items-center bg-gradient-from-primary-1 bg-gradient-to-black/1 bg-gradient-linear px-3 dark:(bg-color-2 bg-none)"
        data-tauri-drag-region
      >
        <div
          class="preference-tabs w-full flex flex-col"
          role="tablist"
        >
          <button
            v-for="(item, index) in menus"
            :key="item.label"
            :aria-selected="current === index"
            class="preference-tab w-full flex flex-col cursor-pointer items-center justify-center gap-1 rounded-lg border-none bg-transparent text-color-3 transition hover:bg-color-7 dark:text-color-2"
            :class="{ 'bg-color-2! text-primary-7 font-bold dark:(bg-primary-3! text-primary-8)': current === index }"
            role="tab"
            type="button"
            @click="current = index"
          >
            <div
              aria-hidden="true"
              class="preference-tab-icon size-7"
              :class="item.icon"
            />

            <span class="text-sm">{{ item.label }}</span>
          </button>
        </div>
      </div>

      <div
        ref="scrollContainer"
        class="min-w-0 flex-1 overflow-auto bg-color-1 p-4"
        data-tauri-drag-region
      >
        <div
          :inert="current >= 1 && current <= 3 && (presetBusy || !presetReady)"
          @change.capture="markPresetUserEdit"
          @click.capture="markPresetUserEdit"
          @input.capture="markPresetUserEdit"
          @keydown.capture="markPresetUserEdit"
          @pointerdown.capture="markPresetUserEdit"
          @pointermove.capture="markPresetUserEdit"
        >
          <component
            :is="menus[current]?.component"
            v-bind="menus[current]?.component === Environment ? {
              mousePending, mouseReady, mouseError, requestMouseEnabled, refreshMouseSetting,
            } : menus[current]?.component === Scene ? {
              viewportState, viewportPending, viewportError, requestViewportMode, refreshViewport,
            } : menus[current]?.component === Presets ? { manager: presetManager } : {}"
            @open-skin-library="openSkinLibrary"
          />
        </div>
      </div>
    </Flex>
  </ConfigProvider>
</template>

<style scoped>
.preference-sidebar {
  overflow-y: auto;
  padding-bottom: 12px;
  padding-top: 16px;
}

.preference-tabs {
  flex: 1;
  gap: 8px;
  min-height: 0;
}

.preference-tab {
  flex: 1 1 72px;
  max-height: 72px;
  min-height: 42px;
}

.preference-tab:focus-visible {
  outline: 2px solid var(--ant-color-primary, #1677ff);
  outline-offset: -2px;
}

@media (max-height: 650px) {
  .preference-sidebar {
    padding-bottom: 8px;
    padding-top: 8px;
  }

  .preference-tabs {
    gap: 4px;
  }

  .preference-tab-icon {
    height: 24px;
    width: 24px;
  }
}

@media (max-height: 480px) {
  .preference-tab {
    flex-direction: row;
    gap: 8px;
    min-height: 32px;
  }
}
</style>
