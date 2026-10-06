<script setup lang="ts">
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEventListener } from '@vueuse/core'
import { Button, ConfigProvider, Flex, message, Modal } from 'ant-design-vue'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAntialiasSetting } from '@/composables/useAntialiasSetting'
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
import { useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'
import { usePerformanceStore } from '@/stores/performance'
import { useShortcutStore } from '@/stores/shortcut'
import { captureViewportPointer } from '@/utils/viewportInteraction'

import About from './components/about/index.vue'
import Block from './components/block/index.vue'
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
useTauriListen<{ action: 'quit' | 'restart' }>(APP_PROCESS_FAILED, ({ payload }) => {
  const action = payload?.action === 'restart' ? 'restart' : 'quit'
  message.error(t(`composables.useAppMenu.errors.${action}`), 8)
})
const blockStore = useBlockStore()
const { visibleBlock, visiblePreference, mirrorMode, cycleZoom, cycleRotation, penetrable, alwaysOnTop, toggleBroadcast, showDisplayArea, mouseEnabled, keepInScreen, hideOnHover } = storeToRefs(useShortcutStore())
const generalStore = useGeneralStore()
const performanceStore = usePerformanceStore()
const appWindow = getCurrentWebviewWindow()
const closing = ref(false)
const { viewportState, viewportPending, viewportError, requestViewportMode, refreshViewport } = useSceneViewport(
  (payload, isCurrent) => emitMainEvent(SCENE_VIEWPORT_REQUEST, payload, isCurrent),
)
let performanceLifecycleGeneration = 0
let nativePreferenceVisible: boolean | undefined
const performanceLifecycleUnlisteners: Array<() => void> = []
let interactionButtons = 0
let mainEventQueue = Promise.resolve()
useAntialiasSetting(emitMainEvent, reason => message.error(t(`pages.preference.performance.errors.${reason === 'failed' ? 'antialiasFailed' : 'antialiasUnconfirmed'}`)))
const presetManager = usePresetManager(emitMainEvent)
const tray = useTray(() => presetManager.ready.value && !presetManager.busy.value)
provide(BROADCAST_CONTROLLER, useBroadcast(presetManager.ready, presetManager.busy))
// Global shortcuts belong to the window, which stays mounted across tabs and hide/show.
useKeyPress(visibleBlock, () => {
  void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { visible: !blockStore.window.visible })
})
useKeyPress(visiblePreference, () => {
  void toggleWindowVisible(WINDOW_LABEL.PREFERENCE)
})
useKeyPress(mirrorMode, () => {
  void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { mirror: !blockStore.model.mirror })
})
useKeyPress(cycleZoom, () => {
  void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { cycle: 'cameraZoomPercent' })
})
useKeyPress(cycleRotation, () => {
  void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { cycle: 'sceneRotationOffsetDegrees' })
})
useKeyPress(penetrable, () => {
  blockStore.window.passThrough = !blockStore.window.passThrough
})
useKeyPress(alwaysOnTop, () => {
  blockStore.window.alwaysOnTop = !blockStore.window.alwaysOnTop
})
useKeyPress(toggleBroadcast, () => {
  generalStore.broadcast.enabled = !generalStore.broadcast.enabled
})
useKeyPress(showDisplayArea, () => {
  void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { showDisplayArea: !blockStore.activePet3dPreset.showDisplayArea })
})
useKeyPress(mouseEnabled, async () => {
  if (mousePending.value) return
  if (!mouseReady.value && !await requestMouseEnabled(undefined, true)) return
  await requestMouseEnabled(!blockStore.activePet3dPreset.mouseEnabled, true)
})
useKeyPress(keepInScreen, () => {
  blockStore.window.keepInScreen = !blockStore.window.keepInScreen
})
useKeyPress(hideOnHover, () => {
  blockStore.window.hideOnHover = !blockStore.window.hideOnHover
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
  }, () => !preferenceDisposed && mouseRequest?.id === id)
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
    mouseRequest = { id: '', desired: enabled, querying: enabled === undefined, resolve, releaseNative: beginPresetNativeEdit() }
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
    if (preferenceDisposed || !isMouseSettingResponse(payload)
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
        blockStore.activePet3dPreset.mouseEnabled = payload.state.mouseEnabled
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
// Tauri's bubble listener maximizes on the second mousedown, before dblclick.
// Keep the existing ACL denial and intercept only direct bare drag-region clicks.
useEventListener(document, 'mousedown', (event) => {
  if (event.button !== 0 || event.detail !== 2 || !(event.target instanceof HTMLElement)) return
  const region = event.target.getAttribute('data-tauri-drag-region')
  if (region !== '' && region !== 'true') return
  event.preventDefault()
  event.stopPropagation()
}, { capture: true })
useEventListener(document, 'visibilitychange', () => {
  if (document.hidden) cancelInteraction()
  void reconcilePerformanceMonitoring()
})
useTauriListen<boolean>('preference-visibility-changed', ({ payload }) => {
  if (preferenceDisposed || typeof payload !== 'boolean') return
  nativePreferenceVisible = payload
  if (payload) closing.value = false
  else cancelInteraction()
  void reconcilePerformanceMonitoring()
})

function locallyAllowsPerformanceMonitoring() {
  return !preferenceDisposed && !closing.value && !document.hidden
    && !innerView.value && current.value === 4 && nativePreferenceVisible !== false
}

async function reconcilePerformanceMonitoring() {
  const generation = ++performanceLifecycleGeneration
  // Cancel pending native primes before waiting for visibility IPC. Tab exits
  // and explicit hide/close events already prove this session is inactive.
  const stopping = locallyAllowsPerformanceMonitoring() ? undefined : performanceStore.stop()
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
  if (generation !== performanceLifecycleGeneration || preferenceDisposed) return

  const shouldMonitor = locallyAllowsPerformanceMonitoring() && shouldMonitorPreferencePerformance({
    activeTab: innerView.value ? -1 : current.value,
    performanceTab: 4,
    visible,
    minimized,
    closing: closing.value,
  })
  presetManager.setListVisible(visible && nativePreferenceVisible !== false && !minimized && !closing.value && !document.hidden
    && !innerView.value && current.value === 0)
  if (shouldMonitor) await performanceStore.start()
  else await (stopping ?? performanceStore.stop())
}

function emitPet3dPresetSelection() {
  if (presetManager.busy.value) return
  emitMainEvent(LISTEN_KEY.PET_PRESET_CHANGED, () => {
    const preset = blockStore.activePet3dPreset
    return {
      modelId: blockStore.customization3d.selectedModelId,
      dmeloperSkinDataUrl: blockStore.customization3d.dmeloperSkinDataUrl,
      dmeloperSkinModel: blockStore.customization3d.dmeloperSkinModel,
      useDefaultDmeloperSkin: blockStore.customization3d.useDefaultDmeloperSkin,
      preset: {
        ...preset,
        manualViewportRect: { ...preset.manualViewportRect },
        dmeloperEyebrows: { ...preset.dmeloperEyebrows },
      },
    }
  })
}

async function retainPerformanceLifecycleListener(registration: Promise<() => void>): Promise<boolean> {
  const unlisten = await registration
  if (preferenceDisposed) {
    await releasePerformanceLifecycleListener(unlisten)
    return false
  }
  performanceLifecycleUnlisteners.push(unlisten)
  return true
}

async function releasePerformanceLifecycleListener(unlisten: () => void): Promise<void> {
  try {
    await unlisten()
  } catch (error) {
    reportDiagnostic('warn', 'preference.lifecycle_unsubscribe', error)
  }
}

onMounted(async () => {
  generateColorVars()
  await listenForMouseResponses()
  if (preferenceDisposed) return
  refreshMouseSetting()
  if (!await retainPerformanceLifecycleListener(appWindow.onResized(() => {
    if (!preferenceDisposed) void reconcilePerformanceMonitoring()
  }))) {
    return
  }
  if (!await retainPerformanceLifecycleListener(appWindow.onFocusChanged(({ payload: focused }) => {
    if (preferenceDisposed) return
    if (!focused) cancelInteraction()
    if (focused) {
      closing.value = false
      refreshMouseSetting()
    }
    void reconcilePerformanceMonitoring()
  }))) {
    return
  }
  if (!await retainPerformanceLifecycleListener(appWindow.onCloseRequested((event) => {
    // Rust hides this persistent window. Tauri's JS default would destroy it.
    event.preventDefault()
    if (preferenceDisposed) return
    cancelInteraction()
    closing.value = true
    mouseReady.value = false
    // This persistent window still owns requests accepted before hiding.
    // Keep their save lease until native acknowledgement or timeout.
    void reconcilePerformanceMonitoring()
  }))) {
    return
  }
  await reconcilePerformanceMonitoring()
})

onBeforeUnmount(() => {
  preferenceDisposed = true
  stopMouseSelectionListener()
  mouseResponseUnlisten?.()
  finishMouseRequest(false)
  cancelInteraction()
  performanceLifecycleGeneration += 1
  performanceLifecycleUnlisteners.splice(0).forEach(unlisten => void releasePerformanceLifecycleListener(unlisten))
  presetManager.setListVisible(false)
  void performanceStore.stop()
})

watch([current, innerView], () => void reconcilePerformanceMonitoring(), { flush: 'sync' })

watch(() => generalStore.appearance.language, () => {
  appWindow.setTitle(`${APP_DISPLAY_NAME} — ${t('pages.preference.title')}`)
}, { immediate: true })

watch(
  [
    () => presetManager.busy.value,
    () => blockStore.customization3d.selectedModelId,
    () => blockStore.customization3d.dmeloperSkinDataUrl,
    () => blockStore.customization3d.dmeloperSkinModel,
    () => blockStore.customization3d.useDefaultDmeloperSkin,
    () => blockStore.activePet3dPreset,
    () => blockStore.model.mirror,
  ],
  emitPet3dPresetSelection,
  { deep: true, immediate: true },
)

const menus = computed(() => [
  {
    id: 1,
    label: t('pages.preference.block.title'),
    icon: 'i-solar:user-hands-linear',
    component: Block,
  },
  {
    id: 2,
    label: t('pages.preference.scene.title'),
    icon: 'i-solar:display-outline',
    component: Scene,
  },
  {
    id: 3,
    label: t('pages.preference.environment.title'),
    icon: 'i-solar:mouse-minimalistic-outline',
    component: Environment,
  },
  {
    id: 0,
    label: t('pages.preference.presets.title'),
    icon: 'i-solar:layers-linear',
    component: Presets,
  },
  {
    id: 4,
    label: t('pages.preference.performance.title'),
    icon: 'i-solar:chart-square-linear',
    component: Performance,
  },
  {
    id: 6,
    label: t('pages.preference.general.title'),
    icon: 'i-solar:settings-linear',
    component: General,
  },
  {
    id: 5,
    label: t('pages.preference.shortcut.title'),
    icon: 'i-solar:keyboard-linear',
    component: Shortcut,
  },
  {
    id: 7,
    label: t('pages.preference.about.title'),
    icon: 'i-solar:info-circle-linear',
    component: About,
  },
])
// Route IDs remain stable when the visual order changes, including retained tabs
// and existing numeric deep links.
const activeMenu = computed(() => menus.value.find(item => item.id === current.value))
</script>

<template>
  <ConfigProvider
    :dropdown-match-select-width="false"
    :locale="getAntdLocale(generalStore.appearance.language)"
    :theme="{
      algorithm: generalStore.appearance.isDark ? appDarkAlgorithm : appLightAlgorithm,
    }"
  >
    <Modal
      :after-close="tray.finishBroadcastPrompt"
      :cancel-text="t('pages.preference.broadcastRestore.cancel')"
      centered
      :closable="false"
      :mask-closable="false"
      :ok-button-props="{ disabled: tray.broadcastRestoreDisabled.value }"
      :ok-text="t('pages.preference.broadcastRestore.enable')"
      :open="tray.broadcastPromptOpen.value"
      :title="t('pages.preference.broadcastRestore.title')"
      @cancel="tray.cancelBroadcastRestore"
      @ok="tray.confirmBroadcastRestore"
    >
      {{ t('pages.preference.broadcastRestore.body') }}
      <template #footer>
        <Flex
          :gap="8"
          justify="end"
          wrap="wrap"
        >
          <Button
            :disabled="tray.broadcastRestoreDisabled.value"
            @click="tray.dismissBroadcastRestore"
          >
            {{ t('pages.preference.broadcastRestore.dismiss') }}
          </Button>
          <Button @click="tray.cancelBroadcastRestore">
            {{ t('pages.preference.broadcastRestore.cancel') }}
          </Button>
          <Button
            :disabled="tray.broadcastRestoreDisabled.value"
            type="primary"
            @click="tray.confirmBroadcastRestore"
          >
            {{ t('pages.preference.broadcastRestore.enable') }}
          </Button>
        </Flex>
      </template>
    </Modal>
    <UpdateReminder
      :busy="updates.busy.value"
      :can-cancel="updates.canCancel.value"
      :cancelling="updates.cancelling.value"
      :status="updates.phase.value ? t(`inAppUpdates.${updates.phase.value}`) : undefined"
      :version="tray.broadcastPromptActive.value ? undefined : updates.reminderVersion.value"
      @cancel="updates.cancel"
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
        class="preference-sidebar"
        data-tauri-drag-region
      >
        <div
          aria-orientation="vertical"
          class="preference-tabs"
          role="tablist"
        >
          <button
            v-for="item in menus"
            :key="item.id"
            :aria-label="item.label"
            :aria-selected="current === item.id"
            class="preference-tab"
            role="tab"
            :title="item.label"
            type="button"
            @click="current = item.id"
          >
            <div
              aria-hidden="true"
              class="preference-tab-icon"
              :class="item.icon"
            />

            <span class="preference-tab-label">{{ item.label }}</span>
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
            :is="activeMenu?.component"
            v-bind="activeMenu?.component === Environment ? {
              mousePending,
              mouseReady,
              mouseError,
              requestMouseEnabled,
              refreshMouseSetting,
            } : activeMenu?.component === Scene ? {
              viewportState,
              viewportPending,
              viewportError,
              requestViewportMode,
              refreshViewport,
            } : activeMenu?.component === Presets ? { manager: presetManager } : {}"
            v-on="activeMenu?.component === Block ? { openSkinLibrary } : {}"
          />
        </div>
      </div>
    </Flex>
  </ConfigProvider>
</template>

<style scoped>
.preference-sidebar {
  background: var(--ant-color-bg-layout);
  box-sizing: border-box;
  display: flex;
  flex: 0 0 64px;
  flex-direction: column;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 16px 10px 12px;
  transition:
    flex-basis 220ms cubic-bezier(0.2, 0, 0, 1),
    width 220ms cubic-bezier(0.2, 0, 0, 1);
  width: 64px;
}

.preference-tabs {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 7px;
  width: 100%;
}

.preference-tab {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 5px;
  box-sizing: border-box;
  color: var(--ant-color-text);
  cursor: pointer;
  display: flex;
  flex: 0 0 40px;
  font-family: inherit;
  font-size: 13.2px;
  font-weight: 400;
  gap: 0;
  height: 40px;
  justify-content: flex-start;
  line-height: 20px;
  padding: 0 11px;
  position: relative;
  text-align: left;
  transition:
    background-color 150ms,
    color 150ms,
    gap 220ms cubic-bezier(0.2, 0, 0, 1),
    padding 220ms cubic-bezier(0.2, 0, 0, 1);
  width: 100%;
}

.preference-tab:hover {
  background: var(--ant-color-fill-tertiary);
}

.preference-tab[aria-selected='true'] {
  background: var(--ant-color-fill);
}

.preference-tab[aria-selected='true']::before {
  background: var(--app-primary);
  border-radius: 2px;
  content: '';
  height: 24px;
  left: 0;
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
}

.preference-tab:focus-visible {
  /* Global button styles suppress outlines; keep focus visible locally. */
  box-shadow: inset 0 0 0 2px var(--app-primary);
}

.preference-tab-icon {
  flex: 0 0 22px;
  height: 22px;
  width: 22px;
}

.preference-tab-label {
  display: block;
  max-width: 0;
  min-width: 0;
  opacity: 0;
  overflow: hidden;
  transform: translateX(-6px);
  transition:
    max-width 220ms cubic-bezier(0.2, 0, 0, 1),
    opacity 150ms,
    transform 220ms cubic-bezier(0.2, 0, 0, 1),
    visibility 0s 220ms;
  visibility: hidden;
  white-space: nowrap;
}

/* The owner-selected breakpoint leaves 500 px for the content pane. */
@media (min-width: 700px) {
  .preference-sidebar {
    flex-basis: 200px;
    width: 200px;
  }

  .preference-tab {
    gap: 12px;
    padding: 0 14px;
  }

  .preference-tab-label {
    max-width: 140px;
    opacity: 1;
    transform: translateX(0);
    transition:
      max-width 220ms cubic-bezier(0.2, 0, 0, 1),
      opacity 150ms 60ms,
      transform 220ms cubic-bezier(0.2, 0, 0, 1),
      visibility 0s;
    visibility: visible;
  }
}

@media (prefers-reduced-motion: reduce) {
  .preference-sidebar,
  .preference-tab,
  .preference-tab-label {
    transition: none;
  }

  .preference-tab-label {
    transform: none;
  }
}
</style>
