<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { resolveResource } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { MainViewportSnapshot } from '@/composables/useWindowState'
import type { PetModelId } from '@/config/model3d'
import type { AntialiasSettingRequest, AntialiasSettingResponse } from '@/config/performance'
import type { MouseSettingResponse } from '@/features/input/types'
import type { PresetApplyRequest, PresetSnapshot } from '@/features/presets/types'
import type { SceneViewportState } from '@/features/scene/types'
import type {
  Pet3dPreset,
  Pet3dPresetSelectionPayload,
} from '@/stores/cat'
import type {
  MainViewportResetComplete,
  MainViewportResetRequest,
} from '@/utils/mainViewportReset'
import type { VisibleContentRect } from '@/utils/three3d'
import type { VoxelSkinModel } from '@/utils/three3d/voxelSkin'

import { useAppMenu } from '@/composables/useAppMenu'
import { useDevice } from '@/composables/useDevice'
import { useTauriListen } from '@/composables/useTauriListen'
import {
  applyMainViewportGeometry,
  centerMainViewportGeometry,
  getMainViewportMonitorSize,
  getMainViewportSnapshot,
  setAutomaticViewportMutationGuard,
  subscribeMainViewportSnapshot,
} from '@/composables/useWindowState'
import { getPetModelOption, MODEL_3D_CONFIG } from '@/config/model3d'
import { ANTIALIAS_SETTING_CANCEL, ANTIALIAS_SETTING_REQUEST, ANTIALIAS_SETTING_RESPONSE, isAntialiasSettingRequest } from '@/config/performance'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { isDesktopPetVisible } from '@/features/broadcast/visibility'
import { isMouseSettingRequest, isSemanticInputEvent } from '@/features/input/types'
import { PET_RUNTIME_RECOVERED, PET_RUNTIME_RECOVERY_QUERY, PET_RUNTIME_RESTART_REQUIRED, PET_RUNTIME_SHOW } from '@/features/petRuntime/types'
import { applyPresetSnapshot, capturePresetSnapshot, isPresetSnapshot } from '@/features/presets/model'
import { PRESET_APPLY_CANCEL, PRESET_APPLY_REQUEST, PRESET_APPLY_RESPONSE, PRESET_EDIT_REQUEST } from '@/features/presets/types'
import { applyPresetVisualSettings } from '@/features/presets/visualSettings'
import { isSceneViewportRequest, SCENE_VIEWPORT_REQUEST, SCENE_VIEWPORT_RESPONSE, SCENE_VIEWPORT_STATE } from '@/features/scene/types'
import { equalViewportRect, normalizeManualViewport, resizeAutoViewportPadding, viewportSizeChanged } from '@/features/scene/viewportSettings'
import { editorsLocked } from '@/features/stateSafety/bridge'
import { registerNativeDrain } from '@/features/stateSafety/runtime'
import {
  dragMainWindow,
  hideWindow,
  setAlwaysOnTop,
  setTaskbarVisibility,
  setWindowMemoryActive,
  showWindow,
} from '@/plugins/window'
import { getResolvedDmeloperSkinUrl, resolveDmeloperSkinUrl } from '@/services/dmeloperSkin'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'
import { createLatestAsyncTaskQueue } from '@/utils/latestAsyncTask'
import three3d from '@/utils/three3d'
import { captureViewportPointer, createViewportInteraction } from '@/utils/viewportInteraction'

import type { ViewportUpdateMode } from './contentBoundsRetry'
import type { VisibleBoundsSelectionSignature } from './viewportSelection'

import {
  createLatestContentBoundsScheduler,
  runBoundedContentBoundsAttempts,
} from './contentBoundsRetry'
import { getRequiredPetAssetMutation } from './petAssetSelection'
import { runViewportResetFlow } from './viewportResetFlow'
import {
  createVisibleBoundsSelectionSignature,
  visibleBoundsCompositionChanged,
  visibleBoundsSelectionChanged,
} from './viewportSelection'

const appWindow = getCurrentWebviewWindow()
const catStore = useCatStore()
const generalStore = useGeneralStore()
const desktopPetVisible = computed(() => isDesktopPetVisible(catStore.window.visible, generalStore.broadcast))
const { getAppMenu } = useAppMenu()
const device = useDevice({ onMouseReset: () => viewportInteraction.resetNativeButtons() })
const inputUnlisteners: Array<() => void> = []
const { t } = useI18n()
const canvas = ref<HTMLCanvasElement>()
const canvasHost = ref<HTMLDivElement>()
const rendererError = ref<string>()
const rendererLoading = ref(false)
const viewportHologramVisible = ref(false)
let viewportHologramInteractionActive = false
let petWindowDragging = false
let petWindowDragGeneration = 0
let rendererReady = false
let activeWindowScalePercent = 100
let activeViewportAutomatic = catStore.activePet3dPreset.autoViewportEnabled
let desiredManualViewportRect = { ...catStore.activePet3dPreset.manualViewportRect }
let manualViewportCorrection: { revision: number, requested: VisibleContentRect, applied: VisibleContentRect } | undefined
let sceneStateGeneration = 0
let sceneModeGeneration = 0
let acceptedViewportMode = captureViewportMode(catStore.activePet3dPreset)
let desiredWindowScalePercent: number | undefined
let appliedBoundsSignature: VisibleBoundsSelectionSignature | undefined
let desiredBoundsSignature: VisibleBoundsSelectionSignature | undefined
let currentContentRect: VisibleContentRect | undefined
let pendingSelection: {
  selection: Pet3dPresetSelectionPayload
  forceReload: boolean
  requestGeneration: number
} | undefined
let selectionRequestGeneration = 0
let rendererLifecycleGeneration = 0
let boundsMeasurementGeneration = 0
let boundsRefreshPending = false
let fullViewportRecoveryPending = false
let viewportUpdatePending = false
let viewportUpdateMode: ViewportUpdateMode = 'settled'
let viewportGeometryGeneration = 0
let visibilityGeneration = 0
let rendererInitialization: {
  generation: number
  promise: Promise<boolean>
} | undefined
let componentMounted = false
let rendererFrame: {
  generation: number
  status: 'pending' | 'rendered' | 'cancelled'
  promise: Promise<boolean>
  resolve: (success: boolean) => void
} | undefined
let pendingRuntimeFailure: { generation: number, error: unknown } | undefined
let runtimeRecovery: Promise<void> | undefined
let recoveryUsed = false
let restartIncident: number | undefined
let incidentSequence = 0
const presentationWaiters = new Set<() => void>()

function recordRuntimeFailure(error: unknown, generation = rendererLifecycleGeneration) {
  if (!componentMounted || generation !== rendererLifecycleGeneration || !desktopPetVisible.value) return
  if (pendingRuntimeFailure?.generation !== generation) console.error('The pet renderer failed unexpectedly.', error)
  pendingRuntimeFailure = { generation, error }
  rendererFrame?.resolve(false)
  rendererError.value = t('pages.main.errors.rendererStart')
  suspendInput()
  void Promise.resolve().then(processRuntimeFailure).catch(error => console.error('Failed to recover the pet renderer.', error))
}

async function publishRestartRequired() {
  if (restartIncident === undefined || !componentMounted) return
  await emitTo(WINDOW_LABEL.PREFERENCE, PET_RUNTIME_RESTART_REQUIRED, { incident: restartIncident })
}

async function processRuntimeFailure(): Promise<void> {
  const failure = pendingRuntimeFailure
  if (!failure || failure.generation !== rendererLifecycleGeneration || !componentMounted
    || !desktopPetVisible.value || presetApplyInProgress || editorsLocked.value || runtimeRecovery) {
    return
  }
  if (recoveryUsed) {
    rendererLoading.value = false
    if (restartIncident === undefined) {
      restartIncident = ++incidentSequence
      await publishRestartRequired()
    }
    return
  }
  const operation = (async () => {
    // The initialization owner must finish unwinding before its replacement begins.
    await rendererInitialization?.promise
    if (!componentMounted || failure.generation !== rendererLifecycleGeneration
      || !desktopPetVisible.value || presetApplyInProgress || editorsLocked.value) {
      return
    }
    recoveryUsed = true
    pendingRuntimeFailure = undefined
    destroyRendererResources()
    rendererLoading.value = true
    const generation = rendererLifecycleGeneration
    try {
      await hideWindow()
      if (!componentMounted || generation !== rendererLifecycleGeneration || !desktopPetVisible.value) return
      await synchronizeWindowVisibility()
    } catch (error) {
      recordRuntimeFailure(error, generation)
    }
  })()
  runtimeRecovery = operation
  try {
    await operation
  } finally {
    if (runtimeRecovery === operation) runtimeRecovery = undefined
    if (pendingRuntimeFailure !== failure) void processRuntimeFailure().catch(error => console.error('Failed to report pet recovery.', error))
  }
}

async function revealPreparedRenderer(strict = false): Promise<void> {
  const generation = rendererLifecycleGeneration
  const request = visibilityGeneration
  const current = () => componentMounted && generation === rendererLifecycleGeneration
    && request === visibilityGeneration && desktopPetVisible.value && !viewportResetPending
    && !viewportRevealPending && !viewportUpdatePending
  const check = () => {
    if (current()) return true
    if (strict) throw new Error('The preset presentation was superseded.')
    return false
  }
  if (!check()) return
  try {
    await showWindow(undefined, { focus: false })
    if (!check()) return
    const visible = await appWindow.isVisible()
    if (!check()) return
    if (!visible) throw new Error('The pet window was not shown.')
    if (rendererError.value) {
      rendererLoading.value = false
      if (strict) throw new Error('The preset renderer is unavailable.')
      return
    }
    if (rendererFrame?.generation === generation && rendererFrame.status !== 'rendered') {
      // Saving settings must not depend on RAF running in a hidden/minimized webview.
      // Cancel only this presentation waiter; the real frame proof remains reusable.
      if (editorsLocked.value) {
        if (strict) throw new Error('The preset presentation was suspended for saving.')
        return
      }
      let cancel!: () => void
      const cancelled = new Promise<false>((resolve) => {
        cancel = () => resolve(false)
      })
      presentationWaiters.add(cancel)
      let rendered: boolean
      try {
        rendered = await Promise.race([rendererFrame.promise, cancelled])
      } finally {
        presentationWaiters.delete(cancel)
      }
      if (!check()) return
      if (!rendered) {
        if (strict) throw new Error('The preset renderer did not render a frame.')
        return
      }
    }
    if (!check()) return
    if (!rendererReady || rendererError.value) {
      if (strict) throw new Error('The preset renderer is unavailable.')
      return
    }
    if (!three3d.renderHealthFrame()) throw new Error('The pet renderer could not draw its loaded model.')
    if (!check()) return
    rendererLoading.value = false
    pendingRuntimeFailure = undefined
    const recoveredIncident = restartIncident
    restartIncident = undefined
    recoveryUsed = false
    if (recoveredIncident !== undefined) {
      await emitTo(WINDOW_LABEL.PREFERENCE, PET_RUNTIME_RECOVERED, { incident: recoveredIncident })
        .catch(error => console.error('Failed to acknowledge pet recovery.', error))
    }
  } catch (error) {
    if (strict) throw error
    if (current()) recordRuntimeFailure(error, generation)
  }
}

useTauriListen(PET_RUNTIME_SHOW, () => {
  if (!componentMounted || !desktopPetVisible.value) return
  void synchronizeWindowVisibility().catch(reportWindowShowFailure)
})
useTauriListen(PET_RUNTIME_RECOVERY_QUERY, () => {
  void publishRestartRequired().catch(error => console.error('Failed to publish pet recovery.', error))
})
watch(editorsLocked, (locked) => {
  if (locked) {
    for (const cancel of presentationWaiters) cancel()
    return
  }
  void processRuntimeFailure().catch(error => console.error('Failed to resume pet recovery.', error))
  if (rendererLoading.value && componentMounted && desktopPetVisible.value && !pendingRuntimeFailure) {
    void synchronizeWindowVisibility().catch(reportWindowShowFailure)
  }
})

function reportWindowShowFailure() {
  if (componentMounted) console.warn('Failed to show the pet window.')
}

function reportWindowHideFailure() {
  if (componentMounted) console.warn('Failed to hide the pet window.')
}
let presetApplyInProgress = false
let activePresetRequestId: string | undefined
let managedViewportFailed = false
let presetApplyQueue = Promise.resolve()
const cancelledPresetRequests = new Set<string>()
let unsubscribeMainViewportSnapshot: (() => void) | undefined
let viewportRevealPending = true
let viewportResetPending = false
let viewportResetGeneration = 0
const viewportInteraction = createViewportInteraction((held) => {
  three3d.setInteractionHeld(held)
  viewportHologramInteractionActive = held
  if (!held && !petWindowDragging) viewportHologramVisible.value = false
  refreshAutomaticViewportMutationGuard()
  viewportUpdateScheduler.setHeld(held && !viewportResetPending && !presetApplyInProgress)
  if (!held || (viewportUpdatePending && viewportUpdateMode === 'live-scale')) return
  boundsMeasurementGeneration += 1
  viewportGeometryGeneration += 1
  if (viewportUpdatePending && desiredBoundsSignature) {
    scheduleViewportUpdate(desiredBoundsSignature, boundsRefreshPending)
  }
})

function isViewportInteractionBlocking(): boolean {
  return !presetApplyInProgress && viewportInteraction.isHeld() && !rendererInitialization && !viewportResetPending
    && viewportUpdateMode !== 'live-scale'
}

function refreshAutomaticViewportMutationGuard() {
  setAutomaticViewportMutationGuard(() => componentMounted && desktopPetVisible.value
    && !isViewportInteractionBlocking() && !viewportUpdatePending)
}
refreshAutomaticViewportMutationGuard()

function rememberPendingSelection(
  selection: Pet3dPresetSelectionPayload,
  forceReload = false,
  requestGeneration = selectionRequestGeneration,
) {
  pendingSelection = {
    selection,
    forceReload: Boolean(forceReload || pendingSelection?.forceReload),
    requestGeneration,
  }
}

function getCurrentSelection(): Pet3dPresetSelectionPayload {
  return {
    modelId: catStore.customization3d.selectedModelId,
    dmeloperSkinDataUrl: catStore.customization3d.dmeloperSkinDataUrl,
    dmeloperSkinModel: catStore.customization3d.dmeloperSkinModel,
    useDefaultDmeloperSkin: catStore.customization3d.useDefaultDmeloperSkin,
    preset: { ...catStore.activePet3dPreset, mouseEnabled: confirmedMouseEnabled() },
  }
}

function confirmedMouseEnabled(): boolean {
  try {
    return device.getInputState().mouseEnabled
  } catch {
    return catStore.activePet3dPreset.mouseEnabled
  }
}

function suspendInput() {
  void device.setInputActive(false).catch(error => console.error('Failed to suspend mouse input.', error))
}

async function resumeRendererInput(strict = false) {
  // Loading owns hover suspension; its UI must remain visible even under the pointer.
  if (rendererLoading.value) return
  if (!componentMounted || !rendererReady || rendererError.value
    || !desktopPetVisible.value || viewportRevealPending || viewportResetPending) {
    if (strict) throw new Error('The preset renderer is not ready for input.')
    return
  }
  if (strict) await device.setInputActive(true, true)
  else await device.setInputActive(true).catch(error => console.error('Failed to resume mouse input.', error))
  if (componentMounted && rendererReady && desktopPetVisible.value) {
    three3d.setInteractionHeld(viewportInteraction.isHeld())
  }
}

function getFullContentRect(): VisibleContentRect {
  return activeViewportAutomatic
    ? three3d.getConservativeContentRect()
    : getNativeManualViewportRect(desiredManualViewportRect)
}

function getNativeManualViewportRect(rect: VisibleContentRect): VisibleContentRect {
  // Snap only the applied origin; keep the exact center in the shared preset.
  // Feeding rounded half-pixel origins back into it accumulates drift on every
  // odd/even slider step. Integral applied origins also avoid expanding its size.
  return { ...rect, x: Math.round(rect.x), y: Math.round(rect.y) }
}

function isCurrentSelectionRequest(
  requestGeneration: number,
  lifecycleGeneration: number,
): boolean {
  return requestGeneration === selectionRequestGeneration
    && lifecycleGeneration === rendererLifecycleGeneration
}

function resetActiveRendererState() {
  suspendInput()
  clearViewportHologram()
  rendererReady = false
  appliedBoundsSignature = undefined
  desiredBoundsSignature = undefined
  desiredWindowScalePercent = undefined
  currentContentRect = undefined
  boundsRefreshPending = false
  fullViewportRecoveryPending = false
  viewportUpdatePending = false
  viewportRevealPending = true
}

function destroyRendererResources() {
  rendererFrame?.resolve(false)
  rendererFrame = undefined
  rendererLoading.value = false
  rendererLifecycleGeneration += 1
  selectionRequestGeneration += 1
  boundsMeasurementGeneration += 1
  viewportGeometryGeneration += 1
  pendingSelection = undefined
  selectionTaskQueue.clear()
  viewportUpdateScheduler.clear()
  resetActiveRendererState()
  three3d.destroy()
}

function apply3dPreset(preset: Pet3dPreset) {
  activeViewportAutomatic = preset.autoViewportEnabled
  desiredManualViewportRect = { ...preset.manualViewportRect }
  applyPresetVisualSettings(three3d, preset, confirmedMouseEnabled())
}

function resizeRendererToViewport(snapshot: MainViewportSnapshot): void {
  if (!rendererReady || !componentMounted || !desktopPetVisible.value
    || isViewportInteractionBlocking() || viewportUpdatePending) {
    return
  }
  three3d.setViewportCrop(snapshot.sourceRect, snapshot.realizedSourceRect)
  three3d.resizeOutput(
    snapshot.outputLogicalSize.width,
    snapshot.outputLogicalSize.height,
  )
}

function retainCurrentNativeViewport(): boolean {
  const snapshot = getMainViewportSnapshot()
  if (!snapshot) return false
  currentContentRect = snapshot.sourceRect
  resizeRendererToViewport(snapshot)
  return true
}

async function applyViewportRect(
  rect: VisibleContentRect,
  clampToWorkArea: boolean,
  liveScale?: { value: number, isCurrent: () => boolean },
): Promise<boolean> {
  const canApply = () => liveScale ? liveScale.isCurrent() : !isViewportInteractionBlocking()
  if (!rendererReady || !canApply()) return false
  const generation = ++viewportGeometryGeneration
  const isCurrent = () => componentMounted && (desktopPetVisible.value || viewportResetPending)
    && rendererReady && generation === viewportGeometryGeneration
    && canApply()
  const previousSize = getMainViewportSnapshot()?.physicalSize
  const snapshot = await applyMainViewportGeometry({
    isCurrent,
    clampToWorkArea,
    mirrored: catStore.model.mirror,
    sourceRect: rect,
    virtualSize: three3d.getCompositionSize(),
    windowScalePercent: liveScale?.value ?? activeWindowScalePercent,
  })
  if (
    !snapshot
    || !isCurrent()
  ) {
    return false
  }

  currentContentRect = snapshot.sourceRect
  if (viewportSizeChanged(previousSize, snapshot.physicalSize)) showViewportHologram()
  three3d.setViewportCrop(snapshot.sourceRect, snapshot.realizedSourceRect)
  three3d.resizeOutput(
    snapshot.outputLogicalSize.width,
    snapshot.outputLogicalSize.height,
  )
  return true
}

async function applyNativeFullViewport(): Promise<boolean> {
  const lifecycleGeneration = rendererLifecycleGeneration
  const visibilityRequest = visibilityGeneration
  const sourceRect = getFullContentRect()
  activeWindowScalePercent = 100
  const snapshot = await applyMainViewportGeometry({
    isCurrent: () => componentMounted && (desktopPetVisible.value || viewportResetPending)
      && lifecycleGeneration === rendererLifecycleGeneration
      && visibilityRequest === visibilityGeneration,
    clampToWorkArea: true,
    mirrored: catStore.model.mirror,
    sourceRect,
    virtualSize: three3d.getCompositionSize(),
    windowScalePercent: activeWindowScalePercent,
  })
  if (!snapshot) return false
  currentContentRect = snapshot.sourceRect
  return true
}

function clearViewportHologram(): void {
  petWindowDragging = false
  petWindowDragGeneration += 1
  viewportInteraction.cancel('pet-drag')
  viewportHologramVisible.value = false
  viewportHologramInteractionActive = false
}

function showViewportHologram(): void {
  if (componentMounted && rendererReady && desktopPetVisible.value
    && !rendererError.value && !viewportRevealPending && !viewportResetPending
    && viewportHologramInteractionActive && viewportInteraction.isHeld()) {
    viewportHologramVisible.value = true
  }
}

const CONTENT_BOUNDS_MAX_ATTEMPTS = 3
const CONTENT_BOUNDS_RETRY_DELAY_MS = 120

function isCurrentBoundsMeasurement(generation: number): boolean {
  return componentMounted && (desktopPetVisible.value || viewportResetPending) && rendererReady
    && !isViewportInteractionBlocking() && generation === boundsMeasurementGeneration
}

function isDesiredBoundsSignature(
  signature: VisibleBoundsSelectionSignature,
): boolean {
  return Boolean(
    desiredBoundsSignature
    && !visibleBoundsSelectionChanged(desiredBoundsSignature, signature),
  )
}

function restoreContentBoundsAfterFallbackFailure(): boolean {
  console.error(
    'The visible-content fallback could not be applied; keeping the current native viewport.',
  )
  return currentContentRect !== undefined
}

async function applyContentBoundsFallback(
  generation: number,
  signature: VisibleBoundsSelectionSignature,
): Promise<'applied' | 'degraded' | 'failed' | 'stale'> {
  if (
    !isCurrentBoundsMeasurement(generation)
    || !isDesiredBoundsSignature(signature)
  ) {
    return 'stale'
  }
  const fallbackRect = getFullContentRect()
  let applied: boolean
  try {
    applied = await applyViewportRect(fallbackRect, true)
  } catch (error) {
    if (
      !isCurrentBoundsMeasurement(generation)
      || !isDesiredBoundsSignature(signature)
    ) {
      return 'stale'
    }
    console.error('Failed to apply visible-content fallback bounds.', error)
    return restoreContentBoundsAfterFallbackFailure()
      ? 'degraded'
      : 'failed'
  }
  if (
    !isCurrentBoundsMeasurement(generation)
    || !isDesiredBoundsSignature(signature)
  ) {
    return 'stale'
  }
  if (!applied) {
    return restoreContentBoundsAfterFallbackFailure()
      ? 'degraded'
      : 'failed'
  }
  appliedBoundsSignature = signature
  boundsRefreshPending = false
  return 'applied'
}

async function measureAndApplyContentBounds(
  generation: number,
  signature: VisibleBoundsSelectionSignature,
): Promise<'failure' | 'stale' | 'success'> {
  if (
    !isCurrentBoundsMeasurement(generation)
    || !isDesiredBoundsSignature(signature)
  ) {
    return 'stale'
  }

  const measurementResult = activeViewportAutomatic
    ? await three3d.measureVisibleContentRect()
    : { status: 'success' as const, rect: await resolveManualViewport() }
  if (
    !isCurrentBoundsMeasurement(generation)
    || !isDesiredBoundsSignature(signature)
  ) {
    return 'stale'
  }
  if (measurementResult.status === 'stale') return 'stale'
  if (measurementResult.status === 'failure') {
    return 'failure'
  }

  const measuredRect = measurementResult.rect
  const applied = await applyViewportRect(measuredRect, true)
  if (
    !applied
    || !isCurrentBoundsMeasurement(generation)
    || !isDesiredBoundsSignature(signature)
  ) {
    return isCurrentBoundsMeasurement(generation) ? 'failure' : 'stale'
  }

  appliedBoundsSignature = signature
  boundsRefreshPending = false
  return 'success'
}

function waitForContentBoundsRetry(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, CONTENT_BOUNDS_RETRY_DELAY_MS))
}

async function measureContentBoundsWithRetries(
  generation: number,
  signature: VisibleBoundsSelectionSignature,
) {
  let result
  try {
    result = await runBoundedContentBoundsAttempts({
      attempt: async () => measureAndApplyContentBounds(generation, signature),
      maxAttempts: CONTENT_BOUNDS_MAX_ATTEMPTS,
      waitBeforeRetry: waitForContentBoundsRetry,
    })
  } catch (error) {
    console.error('Visible-content measurement failed unexpectedly.', error)
    result = {
      attempts: CONTENT_BOUNDS_MAX_ATTEMPTS,
      outcome: 'failure' as const,
    }
  }

  if (result.outcome !== 'failure') {
    return {
      ...result,
      viewportReady: result.outcome === 'success',
    }
  }

  try {
    const fallback = await applyContentBoundsFallback(generation, signature)
    return {
      ...result,
      outcome: fallback === 'stale' ? 'stale' as const : result.outcome,
      viewportReady: fallback === 'applied' || fallback === 'degraded',
    }
  } catch (error) {
    console.error('Failed to apply visible-content fallback bounds.', error)
    return { ...result, viewportReady: false }
  }
}

const viewportUpdateScheduler = createLatestContentBoundsScheduler(async (request: {
  generation: number
  signature: VisibleBoundsSelectionSignature
  mode: ViewportUpdateMode
  windowScalePercent: number
}) => {
  if (request.mode === 'live-scale') {
    // Manual dimensions and automatic padding share this frame-paced path.
    // A newer value may queue while native readback is in flight. Finish this
    // coherent resize, then apply the latest value, without restarting readback
    // on every pointer move. Content/lifecycle changes still invalidate it.
    const isCurrent = () => componentMounted && rendererReady && desktopPetVisible.value
      && !rendererInitialization && !viewportResetPending && !viewportRevealPending
      && (!boundsRefreshPending || !activeViewportAutomatic) && !fullViewportRecoveryPending
      && viewportUpdateMode === 'live-scale' && !!desiredBoundsSignature
      && !visibleBoundsCompositionChanged(desiredBoundsSignature, request.signature)
    await selectionTaskQueue.whenIdle()
    if (!isCurrent() || !currentContentRect) return
    if (activeViewportAutomatic && !appliedBoundsSignature) return
    const rect = activeViewportAutomatic
      ? resizeAutoViewportPadding(currentContentRect, appliedBoundsSignature!.autoViewportPaddingPixels, request.signature.autoViewportPaddingPixels, request.signature.cameraZoomPercent)
      : await resolveManualViewport()
    let applied = false
    try {
      applied = await applyViewportRect(rect, true, {
        value: request.windowScalePercent,
        isCurrent,
      })
    } finally {
      // Even an intermediate resize becomes the baseline for the next padding delta.
      if (applied && isCurrent()) appliedBoundsSignature = request.signature
      if (isCurrent() && request.generation === boundsMeasurementGeneration) {
        if (applied) {
          viewportUpdatePending = false
          boundsRefreshPending = false
        } else if (presetApplyInProgress) {
          // A preset request must finish with failure so rollback can run.
          managedViewportFailed = true
          viewportUpdatePending = false
          boundsRefreshPending = true
        } else {
          scheduleViewportUpdate(request.signature, activeViewportAutomatic)
        }
      }
    }
    if (applied && isCurrent()) await resumeRendererInput()
    return
  }
  await selectionTaskQueue.whenIdle()
  if (
    !isCurrentBoundsMeasurement(request.generation)
    || !isDesiredBoundsSignature(request.signature)
  ) {
    return
  }
  let viewportReady: boolean
  if (fullViewportRecoveryPending) {
    const recovered = await applyViewportRect(
      getFullContentRect(),
      true,
    ).catch((error) => {
      console.error('Failed to apply the delayed error viewport.', error)
      return false
    })
    viewportReady = recovered || retainCurrentNativeViewport()
    if (viewportReady) {
      appliedBoundsSignature = request.signature
      boundsRefreshPending = false
    }
  } else if (boundsRefreshPending || viewportRevealPending) {
    viewportReady = (await measureContentBoundsWithRetries(
      request.generation,
      request.signature,
    )).viewportReady
  } else {
    viewportReady = Boolean(
      currentContentRect
      && await applyViewportRect(currentContentRect, true),
    )
  }
  if (
    !isCurrentBoundsMeasurement(request.generation)
    || !isDesiredBoundsSignature(request.signature)
  ) {
    return
  }
  fullViewportRecoveryPending = false
  viewportUpdatePending = false
  if (!viewportReady) {
    if (presetApplyInProgress) {
      managedViewportFailed = true
      boundsRefreshPending = true
    }
    return
  }
  const reveal = viewportRevealPending
  viewportRevealPending = false
  await resumeRendererInput()
  if (reveal) {
    if (
      isCurrentBoundsMeasurement(request.generation)
      && desktopPetVisible.value
      && !viewportResetPending
      && !presetApplyInProgress
    ) {
      await revealPreparedRenderer().catch(reportWindowShowFailure)
      await resumeRendererInput()
    }
  }
}, MODEL_3D_CONFIG.renderer.contentBoundsDebounceMs, (error) => {
  console.error('Failed to schedule content bounds.', error)
})

function scheduleViewportUpdate(
  signature: VisibleBoundsSelectionSignature,
  refreshBounds: boolean,
  mode: ViewportUpdateMode = 'settled',
): void {
  const generation = ++boundsMeasurementGeneration
  boundsRefreshPending ||= refreshBounds
  if ((boundsRefreshPending && signature.autoViewportEnabled) || viewportRevealPending || viewportResetPending
    || fullViewportRecoveryPending || !currentContentRect) {
    mode = 'settled'
  }
  // Successive live requests share the in-flight native operation; all other
  // changes cancel it before measuring or replacing content.
  if (mode !== 'live-scale' || viewportUpdateMode !== mode) viewportGeometryGeneration += 1
  viewportUpdateMode = mode
  viewportUpdatePending = true
  refreshAutomaticViewportMutationGuard()
  viewportUpdateScheduler.schedule({
    generation,
    signature,
    mode,
    windowScalePercent: desiredWindowScalePercent ?? activeWindowScalePercent,
  }, mode)
}

async function resolveManualViewport(): Promise<VisibleContentRect> {
  const requested = desiredManualViewportRect
  const monitorSize = await getMainViewportMonitorSize()
  if (requested !== desiredManualViewportRect) return resolveManualViewport()
  const rect = normalizeManualViewport(requested, monitorSize)
  if (JSON.stringify(rect) !== JSON.stringify(requested)) {
    manualViewportCorrection = { revision: acceptedViewportMode.revision, requested: { ...requested }, applied: { ...rect } }
    desiredManualViewportRect = rect
    acceptedViewportMode.rect = { ...rect }
    catStore.activePet3dPreset.manualViewportRect = { ...rect }
  }
  return getNativeManualViewportRect(rect)
}

async function getSceneViewportState(): Promise<SceneViewportState> {
  const monitorSize = await getMainViewportMonitorSize()
  const snapshot = getMainViewportSnapshot()
  const automatic = acceptedViewportMode.automatic
  const manualRect = normalizeManualViewport(catStore.activePet3dPreset.manualViewportRect, monitorSize)
  const nativeManualRect = getNativeManualViewportRect(manualRect)
  const manualRectApplied = !snapshot || (
    snapshot.sourceRect.x === nativeManualRect.x && snapshot.sourceRect.y === nativeManualRect.y
    && snapshot.sourceRect.width === nativeManualRect.width && snapshot.sourceRect.height === nativeManualRect.height
  )
  // Manual settings retain their exact center; native pixel snapping belongs
  // only to the applied crop. Focus queries must not feed it back into presets.
  // A failed resize still reports the previously acknowledged native rectangle.
  const rect = !automatic && (!desktopPetVisible.value || manualRectApplied)
    ? manualRect
    : snapshot
      ? { ...snapshot.sourceRect, width: Math.round(snapshot.outputLogicalSize.width), height: Math.round(snapshot.outputLogicalSize.height) }
      : getFullContentRect()
  const correction = manualViewportCorrection
  return { automatic, revision: acceptedViewportMode.revision, rect, monitorSize, ...(!automatic && correction && correction.revision === acceptedViewportMode.revision
    && equalViewportRect(catStore.activePet3dPreset.manualViewportRect, correction.applied)
    ? { manualCorrection: { requested: { ...correction.requested }, applied: { ...correction.applied } } }
    : {}) }
}

async function publishSceneViewportState(): Promise<void> {
  const generation = ++sceneStateGeneration
  try {
    const state = await getSceneViewportState()
    if (!componentMounted || generation !== sceneStateGeneration) return
    if (!state.automatic) {
      const current = catStore.activePet3dPreset.manualViewportRect
      const clamped = normalizeManualViewport(current, state.monitorSize)
      if (JSON.stringify(current) !== JSON.stringify(clamped)) {
        manualViewportCorrection = { revision: acceptedViewportMode.revision, requested: { ...current }, applied: { ...clamped } }
        catStore.activePet3dPreset.manualViewportRect = clamped
        requestPet3dPresetSelection(getCurrentSelection())
        state.manualCorrection = { requested: { ...current }, applied: { ...clamped } }
      }
    }
    await emitTo(WINDOW_LABEL.PREFERENCE, SCENE_VIEWPORT_STATE, state)
  } catch (error) {
    console.error('Failed to publish the actual scene viewport.', error)
  }
}

useTauriListen<unknown>(SCENE_VIEWPORT_REQUEST, ({ payload }) => {
  if (!componentMounted || presetApplyInProgress || !isSceneViewportRequest(payload)) return
  const generation = ++sceneModeGeneration
  void (async () => {
    let success = false
    try {
      // Initialization owns its first measurement/native resize outside these
      // queues. An idle queue alone does not mean the viewport has settled.
      if (desktopPetVisible.value) await ensureRendererInitialized()
      if (generation !== sceneModeGeneration || !componentMounted) return
      await selectionTaskQueue.whenIdle()
      await viewportUpdateScheduler.whenIdle()
      if (generation !== sceneModeGeneration || !componentMounted) return
      if (payload.automatic !== undefined && payload.automatic !== acceptedViewportMode.automatic) {
        const state = await getSceneViewportState()
        if (generation !== sceneModeGeneration || !componentMounted) return
        const rect = normalizeManualViewport(state.rect, state.monitorSize)
        Object.assign(catStore.activePet3dPreset, {
          autoViewportEnabled: payload.automatic,
          viewportModeRevision: acceptedViewportMode.revision + 1,
          manualViewportRect: rect,
          cameraHorizontalOffset: 0,
          cameraVerticalOffset: 0,
        })
        requestPet3dPresetSelection(getCurrentSelection())
        await selectionTaskQueue.whenIdle()
        await viewportUpdateScheduler.whenIdle()
      }
      success = !rendererError.value && (!desktopPetVisible.value
        || (!boundsRefreshPending && !viewportUpdatePending && !viewportRevealPending))
    } catch (error) {
      console.error('Failed to change the scene viewport mode.', error)
    }
    if (!componentMounted || generation !== sceneModeGeneration) return
    const state = await getSceneViewportState().catch(() => {
      if (componentMounted) console.warn('Failed to read the scene viewport acknowledgement state.')
      return undefined
    })
    if (!componentMounted || generation !== sceneModeGeneration) return
    await emitTo(WINDOW_LABEL.PREFERENCE, SCENE_VIEWPORT_RESPONSE, { requestId: payload.requestId, success: success && !!state, state })
  })().catch(error => console.error('Failed to acknowledge the scene viewport.', error))
})

function createBundledAssetError(cause: unknown): Error {
  const error = new Error('The bundled pet asset could not be resolved.')
  Object.defineProperty(error, 'cause', { value: cause })
  error.name = 'PetAssetLoadError'
  return error
}

async function resolvePetUrl(modelId: PetModelId): Promise<string> {
  try {
    return convertFileSrc(await resolveResource(getPetModelOption(modelId).resourcePath))
  } catch (error) {
    throw createBundledAssetError(error)
  }
}

function getDesiredPetAssetState(selection: Pet3dPresetSelectionPayload) {
  const skinPreference = selection.dmeloperSkinModel ?? 'auto'
  const skinUrl = getResolvedDmeloperSkinUrl(selection.dmeloperSkinDataUrl)
  return {
    modelId: selection.modelId,
    dmeloperSkinModel: skinPreference,
    dmeloperSkinUrl: skinUrl,
  }
}

function persistResolvedDmeloperSkinModel(
  selection: Pet3dPresetSelectionPayload,
  resolvedModel: VoxelSkinModel | undefined,
) {
  const preference = selection.dmeloperSkinModel ?? 'auto'
  if (resolvedModel && preference !== resolvedModel) {
    if (presetApplyInProgress) {
      // Managed application returns this exact accepted snapshot to its owner.
      catStore.setDmeloperSkinModel(resolvedModel)
    } else {
      // Live loading must not publish the renderer's entire stale Cat snapshot.
      // The owner accepts this derived value only for the same skin selection.
      void emitTo(WINDOW_LABEL.PREFERENCE, PRESET_EDIT_REQUEST, { resolvedSkinModel: {
        modelId: selection.modelId,
        skinDataUrl: selection.dmeloperSkinDataUrl,
        requested: preference,
        resolved: resolvedModel,
      } }).catch(() => console.warn('Failed to synchronize the resolved skin model.'))
    }
  }
}

async function applyPet3dPresetSelection(
  selection: Pet3dPresetSelectionPayload,
  options: {
    forceReload?: boolean
    manageViewport?: boolean
    requestGeneration?: number
  } = {},
  lifecycleGeneration = rendererLifecycleGeneration,
) {
  const requestGeneration = options.requestGeneration ?? selectionRequestGeneration
  if (
    !rendererReady
    || lifecycleGeneration !== rendererLifecycleGeneration
  ) {
    rememberPendingSelection(
      selection,
      options.forceReload,
      requestGeneration,
    )
    return
  }
  const nextBoundsSignature = createVisibleBoundsSelectionSignature(selection)
  try {
    rendererError.value = undefined
    const skinPreference = selection.dmeloperSkinModel ?? 'auto'
    const desiredAssetState = getDesiredPetAssetState(selection)
    const skinUrl = desiredAssetState.dmeloperSkinUrl
    const assetMutation = getRequiredPetAssetMutation(
      three3d.getLoadedPetAssetState(),
      desiredAssetState,
      options.forceReload,
    )
    const modelChanged = assetMutation === 'model'
    const skinChanged = assetMutation === 'skin'
    const assetChanged = modelChanged || skinChanged
    if (assetChanged) suspendInput()
    if (options.manageViewport !== false && assetChanged) {
      viewportRevealPending = true
      clearViewportHologram()
      await hideWindow()
      if (!isCurrentSelectionRequest(requestGeneration, lifecycleGeneration)) return
    }

    if (modelChanged) {
      const petUrl = await resolvePetUrl(selection.modelId)
      if (!isCurrentSelectionRequest(requestGeneration, lifecycleGeneration)) return
      const resolvedSkinModel = await three3d.setPetModel(
        petUrl,
        selection.modelId,
        skinUrl,
        skinPreference,
      )
      if (!isCurrentSelectionRequest(requestGeneration, lifecycleGeneration)) return
      persistResolvedDmeloperSkinModel(selection, resolvedSkinModel)
    } else if (skinChanged) {
      const resolvedSkinModel = await three3d.setDmeloperSkin(
        skinUrl,
        skinPreference,
      )
      if (!isCurrentSelectionRequest(requestGeneration, lifecycleGeneration)) return
      persistResolvedDmeloperSkinModel(selection, resolvedSkinModel)
    }
    if (!isCurrentSelectionRequest(requestGeneration, lifecycleGeneration)) return

    apply3dPreset(selection.preset)
    activeWindowScalePercent = 100
    desiredBoundsSignature = nextBoundsSignature
    if (assetChanged) {
      appliedBoundsSignature = undefined
    }
    if (options.manageViewport !== false && !viewportUpdatePending) await resumeRendererInput()
  } catch (error) {
    if (!isCurrentSelectionRequest(requestGeneration, lifecycleGeneration)) return
    if (error instanceof Error && error.name === 'PetModelLoadCancelledError') return
    clearViewportHologram()
    suspendInput()
    rendererError.value = t('pages.main.errors.modelLoad')
    console.error('Failed to apply the fixed pet selection.', error)
    if (!(error instanceof Error && error.name === 'PetAssetLoadError')) recordRuntimeFailure(error, lifecycleGeneration)
    if (options.manageViewport === false) throw error
    fullViewportRecoveryPending = true
    boundsRefreshPending = false
    if (!viewportUpdatePending) {
      scheduleViewportUpdate(nextBoundsSignature, false)
    }
  }
}

const debouncedResize = useDebounceFn(() => {
  if (!componentMounted || !rendererReady || !desktopPetVisible.value
    || isViewportInteractionBlocking() || viewportUpdatePending) {
    return
  }
  const snapshot = getMainViewportSnapshot()
  if (snapshot) resizeRendererToViewport(snapshot)
  else three3d.resizeOutput(globalThis.innerWidth, globalThis.innerHeight)
}, 100)

interface SelectionTask {
  forceReload: boolean
  requestGeneration: number
  selection: Pet3dPresetSelectionPayload
}

const selectionTaskQueue = createLatestAsyncTaskQueue<SelectionTask>(
  async task => applyPet3dPresetSelection(task.selection, {
    forceReload: task.forceReload,
    requestGeneration: task.requestGeneration,
  }),
  {
    mergePending: (pending, incoming) => ({
      ...incoming,
      forceReload: pending.forceReload || incoming.forceReload,
    }),
    onError: error => console.error('Failed to update the fixed pet runtime.', error),
  },
)

async function initializeRenderer(lifecycleGeneration: number): Promise<boolean> {
  if (
    !componentMounted
    || lifecycleGeneration !== rendererLifecycleGeneration
    || !canvasHost.value
  ) {
    return false
  }

  const initialSelection = getCurrentSelection()
  const initialRequestGeneration = selectionRequestGeneration
  try {
    rendererError.value = undefined
    // Resolve the bundled fallback even when starting with a saved user skin,
    // so later synchronous selection requests can compare exact asset URLs.
    await resolveDmeloperSkinUrl().catch((error) => {
      throw createBundledAssetError(error)
    })
    const skinUrl = getResolvedDmeloperSkinUrl(initialSelection.dmeloperSkinDataUrl)
    const petUrl = await resolvePetUrl(initialSelection.modelId)
    if (!isCurrentSelectionRequest(initialRequestGeneration, lifecycleGeneration)) {
      return false
    }

    three3d.setMouseEnabled(confirmedMouseEnabled())
    // A fresh canvas picks up the latest context choice after hiding the pet.
    canvas.value = document.createElement('canvas')
    canvas.value.className = 'absolute left-0 top-0 block'
    canvas.value.dataset.testid = 'three-canvas'
    canvasHost.value.replaceChildren(canvas.value)
    const frame: NonNullable<typeof rendererFrame> = {
      generation: lifecycleGeneration,
      status: 'pending',
      promise: Promise.resolve(false),
      resolve: (_success: boolean) => {},
    }
    frame.promise = new Promise<boolean>((resolve) => {
      frame.resolve = (success) => {
        if (frame.status !== 'pending') return
        frame.status = success ? 'rendered' : 'cancelled'
        resolve(success)
      }
    })
    rendererFrame = frame
    const resolvedSkinModel = await three3d.init(
      canvas.value,
      petUrl,
      initialSelection.modelId,
      skinUrl,
      initialSelection.dmeloperSkinModel,
      {
        antialiasEnabled: catStore.model.antialiasEnabled,
        onRuntimeFailure: error => recordRuntimeFailure(error, lifecycleGeneration),
        onFrameRendered: () => frame.resolve(true),
      },
    )
    if (lifecycleGeneration !== rendererLifecycleGeneration) return false

    rendererReady = true
    await synchronizeAntialias()
    if (lifecycleGeneration !== rendererLifecycleGeneration) return false
    persistResolvedDmeloperSkinModel(initialSelection, resolvedSkinModel)

    let firstSelection = true
    while (firstSelection || pendingSelection) {
      if (lifecycleGeneration !== rendererLifecycleGeneration) return false
      const latestPending = pendingSelection
      pendingSelection = undefined
      const selection = latestPending?.selection ?? getCurrentSelection()
      const requestGeneration = latestPending?.requestGeneration
        ?? selectionRequestGeneration
      await applyPet3dPresetSelection(
        selection,
        {
          forceReload: latestPending?.forceReload,
          manageViewport: false,
          requestGeneration,
        },
        lifecycleGeneration,
      )
      firstSelection = false
    }
    if (lifecycleGeneration !== rendererLifecycleGeneration) return false

    currentContentRect = getFullContentRect()
    three3d.setViewportCrop(currentContentRect)
    three3d.resizeOutput(
      globalThis.innerWidth,
      globalThis.innerHeight,
    )
    while (true) {
      if (lifecycleGeneration !== rendererLifecycleGeneration) return false
      const signature = desiredBoundsSignature
        ?? createVisibleBoundsSelectionSignature(getCurrentSelection())
      const measurementGeneration = ++boundsMeasurementGeneration
      const measurement = await measureContentBoundsWithRetries(
        measurementGeneration,
        signature,
      )
      if (lifecycleGeneration !== rendererLifecycleGeneration) return false
      if (!pendingSelection) {
        if (measurement.outcome === 'stale') {
          if (!desktopPetVisible.value && !viewportResetPending) return false
          await nextTick()
          continue
        }
        if (!measurement.viewportReady) {
          throw new Error('The initial content viewport could not be prepared.')
        }
        viewportRevealPending = false
        break
      }

      while (pendingSelection) {
        const latestPending = pendingSelection
        pendingSelection = undefined
        await applyPet3dPresetSelection(
          latestPending.selection,
          {
            forceReload: latestPending.forceReload,
            manageViewport: false,
            requestGeneration: latestPending.requestGeneration,
          },
          lifecycleGeneration,
        )
        if (lifecycleGeneration !== rendererLifecycleGeneration) return false
      }
    }
    return true
  } catch (error) {
    if (lifecycleGeneration !== rendererLifecycleGeneration) return false
    if (
      error instanceof Error
      && error.name === 'PetModelLoadCancelledError'
    ) {
      rendererFrame?.resolve(false)
      resetActiveRendererState()
      three3d.destroy()
      return false
    }
    rendererFrame?.resolve(false)
    rendererLoading.value = false
    resetActiveRendererState()
    three3d.destroy()
    pendingSelection = undefined
    rendererError.value = error instanceof Error && error.name === 'PetAssetLoadError'
      ? t('pages.main.errors.modelLoad')
      : t('pages.main.errors.rendererStart')
    console.error('Failed to initialize the fixed 3D pet renderer.', error)
    try {
      const recovered = await applyNativeFullViewport()
      if (lifecycleGeneration !== rendererLifecycleGeneration) return false
      viewportRevealPending = !(recovered || retainCurrentNativeViewport())
    } catch (viewportError) {
      if (lifecycleGeneration !== rendererLifecycleGeneration) return false
      console.error('Failed to prepare the renderer error viewport.', viewportError)
      viewportRevealPending = !retainCurrentNativeViewport()
    }
    if (!(error instanceof Error && error.name === 'PetAssetLoadError')) recordRuntimeFailure(error, lifecycleGeneration)
    return false
  }
}

function ensureRendererInitialized(): Promise<boolean> {
  const generation = rendererLifecycleGeneration
  // A created renderer still has to apply its pending selection and native bounds.
  // Every caller must share that completion before trusting rendererReady.
  if (rendererInitialization?.generation === generation) {
    return rendererInitialization.promise
  }
  if (rendererReady) return Promise.resolve(true)

  const operation = (async () => {
    if (desktopPetVisible.value) {
      rendererLoading.value = true
      suspendInput()
      await nextTick()
      if (!componentMounted || generation !== rendererLifecycleGeneration || !desktopPetVisible.value) return false
      try {
        await showWindow(undefined, { focus: false })
      } catch (error) {
        recordRuntimeFailure(error, generation)
        return false
      }
      if (!componentMounted || generation !== rendererLifecycleGeneration || !desktopPetVisible.value) return false
    }
    return initializeRenderer(generation)
  })()
  const promise = operation.finally(() => {
    if (rendererInitialization?.promise !== promise || generation !== rendererLifecycleGeneration) return
    rendererInitialization = undefined
    const pending = pendingSelection
    if (rendererReady && pending) {
      pendingSelection = undefined
      selectionTaskQueue.enqueue(pending)
    } else if (
      pending
      && componentMounted
      && desktopPetVisible.value
      && generation === rendererLifecycleGeneration
      && !presetApplyInProgress
    ) {
      viewportRevealPending = true
      visibilityGeneration += 1
      void hideWindow()
        .catch(reportWindowHideFailure)
        .then(() => synchronizeWindowVisibility())
    }
  })
  rendererInitialization = { generation, promise }
  return promise
}

async function synchronizeWindowVisibility(strict = false) {
  // Managed preset application owns visibility and its native acknowledgement.
  if (!strict && presetApplyInProgress) return
  if (!componentMounted) {
    if (strict) throw new Error('The preset window is no longer mounted.')
    return
  }
  const request = ++visibilityGeneration

  if (!desktopPetVisible.value) {
    if (strict) await device.setInputActive(false, true)
    else suspendInput()
    refreshAutomaticViewportMutationGuard()
    boundsMeasurementGeneration += 1
    viewportGeometryGeneration += 1
    clearViewportHologram()
    viewportUpdateScheduler.clear()
    // Cancel immediately: waiting for native hide used to leave the old init reusable.
    destroyRendererResources()
    if (strict) await hideWindow()
    else await hideWindow().catch(reportWindowHideFailure)
    if (
      !componentMounted
      || request !== visibilityGeneration
      || desktopPetVisible.value
    ) {
      if (strict) throw new Error('The preset visibility changed during application.')
      return
    }
    if (strict && await appWindow.isVisible()) throw new Error('The preset window was not hidden.')
    return
  }

  await setWindowMemoryActive(true).catch(() => {
    if (componentMounted) console.warn('Failed to activate pet window memory management.')
  })
  if (!componentMounted || request !== visibilityGeneration || !desktopPetVisible.value) {
    if (strict) throw new Error('The preset visibility changed during memory activation.')
    return
  }
  const initialized = await ensureRendererInitialized()
  if (strict && !initialized) throw new Error('The preset renderer could not be initialized.')

  if (
    !componentMounted
    || request !== visibilityGeneration
    || !desktopPetVisible.value
    || viewportRevealPending
    || viewportResetPending
  ) {
    if (strict) throw new Error('The preset window is not ready to show.')
    return
  }
  await resumeRendererInput(strict)
  if (!componentMounted || request !== visibilityGeneration || !desktopPetVisible.value) {
    if (strict) throw new Error('The preset visibility changed during application.')
    return
  }
  if (strict) await revealPreparedRenderer(true)
  else await revealPreparedRenderer().catch(reportWindowShowFailure)
  if (componentMounted && request === visibilityGeneration && desktopPetVisible.value) await resumeRendererInput(strict)
}

async function registerInputListeners() {
  const results = await Promise.allSettled([
    listen<unknown>(LISTEN_KEY.SEMANTIC_INPUT, ({ payload }) => {
      if (!componentMounted || !isSemanticInputEvent(payload) || !device.acceptsInput(payload)) return
      if (payload.kind === 'mouse_primary' || payload.kind === 'mouse_secondary') {
        viewportInteraction.setNativeButton(payload.kind === 'mouse_primary' ? 1 : 2, payload.active)
      }
    }),
    listen<unknown>(LISTEN_KEY.MOUSE_SETTING_REQUEST, ({ payload }) => {
      if (!componentMounted || presetApplyInProgress || !isMouseSettingRequest(payload)) return
      void (async () => {
        const response: MouseSettingResponse = { requestId: payload.requestId, success: false }
        try {
          response.state = await device.requestMouseSetting(payload.enabled)
          response.success = true
        } catch {
          if (componentMounted) console.warn('Failed to apply the native mouse setting.')
          response.error = 'unavailable'
          try {
            response.state = device.getInputState()
          } catch { /* No confirmed native state yet. */ }
        }
        if (!componentMounted) return
        await emitTo(WINDOW_LABEL.PREFERENCE, LISTEN_KEY.MOUSE_SETTING_RESPONSE, response)
      })().catch(error => console.error('Failed to acknowledge the mouse setting.', error))
    }),
  ])
  const stops = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  const failure = results.find(result => result.status === 'rejected')
  if (!componentMounted || failure) {
    stops.forEach(stop => stop())
    if (failure) throw failure.reason
    return
  }
  inputUnlisteners.push(...stops)
}

onMounted(async () => {
  componentMounted = true
  document.documentElement.classList.add('main-window-shell')
  unsubscribeMainViewportSnapshot = subscribeMainViewportSnapshot((snapshot) => {
    resizeRendererToViewport(snapshot)
    void publishSceneViewportState()
  })
  await registerInputListeners().catch(error => console.error('Failed to subscribe to mouse settings.', error))
  if (!componentMounted) return
  await device.startListening().catch(error => console.error('Failed to start global input.', error))
  registerNativeDrain(async () => {
    await runtimeRecovery
    await rendererInitialization?.promise
    await selectionTaskQueue.whenIdle()
    await viewportUpdateScheduler.whenIdle()
    await antialiasSynchronization
  })
  await synchronizeWindowVisibility()
})

onUnmounted(() => {
  componentMounted = false
  antialiasRequest = undefined
  inputUnlisteners.splice(0).forEach(stop => stop())
  visibilityGeneration += 1
  viewportResetGeneration += 1
  viewportResetPending = false
  unsubscribeMainViewportSnapshot?.()
  unsubscribeMainViewportSnapshot = undefined
  document.documentElement.classList.remove('main-window-shell')
  pendingSelection = undefined
  selectionTaskQueue.clear()
  destroyRendererResources()
})

useEventListener('resize', debouncedResize)
useEventListener(window, 'pointerdown', captureViewportPointer, { capture: true })
useEventListener(window, ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup'], (event: MouseEvent) => {
  if (!petWindowDragging && event.buttons === 0 && !viewportInteraction.isSourceHeld('preference')) clearViewportHologram()
  viewportInteraction.setButtons('main', event.buttons)
}, { capture: true })
useEventListener(window, ['blur', 'pointercancel'], () => {
  // Windows takes focus/capture away from WebView2 while its move loop owns the drag.
  if (petWindowDragging) return
  if (!viewportInteraction.isSourceHeld('preference')) clearViewportHologram()
  viewportInteraction.cancel('main')
}, { capture: true })

useTauriListen<{ buttons: number }>(LISTEN_KEY.VIEWPORT_INTERACTION_CHANGED, ({ payload }) => {
  if (!componentMounted) return
  if (payload.buttons === 0 && !petWindowDragging) clearViewportHologram()
  viewportInteraction.setButtons('preference', payload.buttons)
  // The native mouse hook can establish the aggregate hold before main loses
  // focus. A preference press must arm its own gesture in either event order.
  if (viewportInteraction.isSourceHeld('preference')) viewportHologramInteractionActive = true
})

watch(() => catStore.activePet3dPreset.mouseEnabled, () => {
  if (presetApplyInProgress) return
  const enabled = confirmedMouseEnabled()
  if (catStore.activePet3dPreset.mouseEnabled !== enabled) {
    catStore.activePet3dPreset.mouseEnabled = enabled
  }
  if (componentMounted) requestPet3dPresetSelection(getCurrentSelection())
})

watch(() => desktopPetVisible.value, () => {
  if (!presetApplyInProgress) void synchronizeWindowVisibility()
})
watch(() => catStore.window.passThrough, value => appWindow.setIgnoreCursorEvents(value), { immediate: true })
watch(() => catStore.window.alwaysOnTop, setAlwaysOnTop, { immediate: true })
watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })
watch(() => catStore.model.eyebrowAnimationEnabled, three3d.setEyebrowAnimationEnabled.bind(three3d), { immediate: true })
let antialiasSynchronization = Promise.resolve()
let antialiasRequest: (AntialiasSettingRequest & { responding: boolean }) | undefined
async function applyAntialiasSetting() {
  if (!rendererReady || !desktopPetVisible.value) return
  const enabled = catStore.model.antialiasEnabled
  const lifecycle = rendererLifecycleGeneration
  const isCurrent = () => rendererReady && desktopPetVisible.value
    && lifecycle === rendererLifecycleGeneration && catStore.model.antialiasEnabled === enabled
  try {
    const replacement = await three3d.setAntialiasEnabled(enabled, isCurrent)
    if (replacement && isCurrent()) canvas.value = replacement
  } catch (error) {
    if (!isCurrent()) return
    console.error('Failed to change antialiasing.', error)
  }
}
function synchronizeAntialias() {
  antialiasSynchronization = applyAntialiasSetting()
  return antialiasSynchronization
}
async function acknowledgeAntialiasSetting() {
  const request = antialiasRequest
  // The explicit request can beat Pinia's incoming patch. Its existing model
  // watcher retries after the matching value arrives; no mirror write is needed.
  if (!request || request.responding || catStore.model.antialiasEnabled !== request.requested) return
  request.responding = true
  // An in-progress initialization may already be creating the previous
  // context. Its final synchronization must settle before accepting this edit.
  while (true) {
    const initialization = rendererInitialization
    if (!initialization || !desktopPetVisible.value) break
    await initialization.promise
    if (!componentMounted || antialiasRequest !== request) return
  }
  if (rendererReady && desktopPetVisible.value) {
    void synchronizeAntialias()
    while (true) {
      const pending = antialiasSynchronization
      await pending
      if (pending === antialiasSynchronization) break
    }
  }
  if (!componentMounted || antialiasRequest !== request || catStore.model.antialiasEnabled !== request.requested) return
  // Hidden/uninitialized renderers pick up this accepted setting on creation.
  const actual = rendererReady && desktopPetVisible.value ? three3d.getAntialiasEnabled() : request.requested
  antialiasRequest = undefined
  await emitTo<AntialiasSettingResponse>(WINDOW_LABEL.PREFERENCE, ANTIALIAS_SETTING_RESPONSE, {
    requestId: request.requestId,
    requested: request.requested,
    actual,
    success: actual === request.requested,
  }).catch(() => {
    if (componentMounted) console.warn('Failed to acknowledge the antialiasing setting.')
  })
}
useTauriListen<unknown>(ANTIALIAS_SETTING_REQUEST, ({ payload }) => {
  if (!componentMounted || !isAntialiasSettingRequest(payload)) return
  antialiasRequest = { ...payload, responding: false }
  void acknowledgeAntialiasSetting()
})
useTauriListen<unknown>(ANTIALIAS_SETTING_CANCEL, ({ payload }) => {
  if (isAntialiasSettingRequest(payload) && antialiasRequest?.requestId === payload.requestId) antialiasRequest = undefined
})
watch(() => catStore.model.antialiasEnabled, () => {
  void synchronizeAntialias()
  void acknowledgeAntialiasSetting()
})
watch(() => catStore.model.pixelFilterEnabled, three3d.setPixelFilterEnabled.bind(three3d), { immediate: true })
watch(() => catStore.model.maxFPS, three3d.setMaxFPS.bind(three3d), { immediate: true })
watch(
  () => catStore.model.idlePowerSavingEnabled,
  three3d.setIdlePowerSavingEnabled.bind(three3d),
  { immediate: true },
)
watch(
  () => catStore.model.shadowQuality,
  three3d.setShadowQuality.bind(three3d),
  { immediate: true },
)
watch(
  () => catStore.model.shadowsEnabled,
  three3d.setShadowsEnabled.bind(three3d),
  { immediate: true },
)
watch(
  () => catStore.model.renderScalePercent,
  three3d.setRenderScalePercent.bind(three3d),
  { immediate: true },
)
watch(
  [() => catStore.model.mirror, () => catStore.window.keepInScreen],
  () => {
    if (
      rendererReady
      && !rendererInitialization
      && currentContentRect
    ) {
      const signature = desiredBoundsSignature
        ?? createVisibleBoundsSelectionSignature(getCurrentSelection())
      scheduleViewportUpdate(
        signature,
        boundsRefreshPending || viewportRevealPending,
      )
    }
  },
)

function captureViewportMode(preset: Pet3dPresetSelectionPayload['preset']) {
  return {
    automatic: preset.autoViewportEnabled,
    revision: preset.viewportModeRevision,
    rect: { ...preset.manualViewportRect },
    horizontalOffset: preset.cameraHorizontalOffset,
    verticalOffset: preset.cameraVerticalOffset,
  }
}

function requestPet3dPresetSelection(
  selection: Pet3dPresetSelectionPayload,
): number {
  // A delayed full-preset packet must not undo an acknowledged mode change.
  const staleMode = selection.preset.viewportModeRevision < acceptedViewportMode.revision
  if (!staleMode) acceptedViewportMode = captureViewportMode(selection.preset)
  selection = { ...selection, preset: { ...selection.preset, mouseEnabled: confirmedMouseEnabled(), ...(staleMode
    ? {
        autoViewportEnabled: acceptedViewportMode.automatic,
        viewportModeRevision: acceptedViewportMode.revision,
        manualViewportRect: { ...acceptedViewportMode.rect },
        cameraHorizontalOffset: acceptedViewportMode.horizontalOffset,
        cameraVerticalOffset: acceptedViewportMode.verticalOffset,
      }
    : {}) } }
  if (staleMode && catStore.activePet3dPreset.viewportModeRevision < acceptedViewportMode.revision) {
    Object.assign(catStore.activePet3dPreset, {
      autoViewportEnabled: acceptedViewportMode.automatic,
      viewportModeRevision: acceptedViewportMode.revision,
      manualViewportRect: { ...acceptedViewportMode.rect },
      cameraHorizontalOffset: acceptedViewportMode.horizontalOffset,
      cameraVerticalOffset: acceptedViewportMode.verticalOffset,
    })
  }
  const requestGeneration = ++selectionRequestGeneration
  fullViewportRecoveryPending = false
  const nextBoundsSignature = createVisibleBoundsSelectionSignature(selection)
  const boundsInvalidated = visibleBoundsSelectionChanged(
    desiredBoundsSignature ?? appliedBoundsSignature,
    nextBoundsSignature,
  )
  const manualRectChanged = !selection.preset.autoViewportEnabled && JSON.stringify(desiredManualViewportRect) !== JSON.stringify(selection.preset.manualViewportRect)
  desiredWindowScalePercent = 100
  desiredManualViewportRect = { ...selection.preset.manualViewportRect }
  desiredBoundsSignature = nextBoundsSignature
  const desiredAssetState = getDesiredPetAssetState(selection)
  const pendingAssetState = three3d.getPendingPetAssetState()
  const comparedAssetState = pendingAssetState
    ?? three3d.getLoadedPetAssetState()
  const assetMutation = getRequiredPetAssetMutation(
    comparedAssetState,
    desiredAssetState,
  )
  if (assetMutation !== 'none') {
    suspendInput()
    clearViewportHologram()
    viewportRevealPending = true
    void hideWindow().catch(reportWindowHideFailure)
    if (pendingAssetState) three3d.cancelPendingPetAssetLoad()
  }
  const canResizePadding = selection.preset.autoViewportEnabled && !!currentContentRect
    && !boundsRefreshPending && !viewportRevealPending
    && !visibleBoundsCompositionChanged(appliedBoundsSignature, nextBoundsSignature)
  const boundsRefreshRequired = (boundsInvalidated && !canResizePadding)
    || boundsRefreshPending
    || viewportRevealPending
  const viewportUpdateRequired = boundsInvalidated || boundsRefreshRequired
    || manualRectChanged
    || viewportUpdatePending
  if (
    !rendererReady
    || rendererInitialization?.generation === rendererLifecycleGeneration
  ) {
    if (viewportUpdateRequired) {
      boundsMeasurementGeneration += 1
      viewportGeometryGeneration += 1
      boundsRefreshPending ||= boundsRefreshRequired
      viewportUpdatePending = false
      viewportUpdateScheduler.clear()
    }
    rememberPendingSelection(selection, false, requestGeneration)
    if (
      !rendererReady
      && componentMounted
      && desktopPetVisible.value
      && !rendererInitialization
      && !presetApplyInProgress
    ) {
      void hideWindow()
        .catch(reportWindowHideFailure)
        .then(() => synchronizeWindowVisibility())
    }
    return requestGeneration
  }
  if (viewportUpdateRequired) {
    scheduleViewportUpdate(
      nextBoundsSignature,
      boundsRefreshRequired,
      (!selection.preset.autoViewportEnabled || canResizePadding) && assetMutation === 'none'
        ? 'live-scale'
        : 'settled',
    )
  }
  selectionTaskQueue.enqueue({
    forceReload: false,
    requestGeneration,
    selection,
  })
  return requestGeneration
}

async function settleAndCenterResetViewport(): Promise<boolean> {
  acceptedViewportMode = captureViewportMode(catStore.activePet3dPreset)
  const resetGeneration = ++viewportResetGeneration
  viewportResetPending = true
  clearViewportHologram()
  viewportUpdateScheduler.setHeld(false)
  viewportRevealPending = true
  visibilityGeneration += 1
  await hideWindow().catch(reportWindowHideFailure)
  let selectionRequested = false
  let settledSelectionGeneration: number | undefined

  const isCurrentReset = () => componentMounted
    && resetGeneration === viewportResetGeneration
    && (
      settledSelectionGeneration === undefined
      || settledSelectionGeneration === selectionRequestGeneration
    )

  const settleCurrentSelection = async (): Promise<boolean> => {
    if (!isCurrentReset()) return false
    if (!selectionRequested) {
      selectionRequested = true
      requestPet3dPresetSelection(getCurrentSelection())
    }

    const requestGeneration = selectionRequestGeneration
    await ensureRendererInitialized()
    await selectionTaskQueue.whenIdle()
    await viewportUpdateScheduler.whenIdle()
    if (
      resetGeneration !== viewportResetGeneration
      || !componentMounted
    ) {
      return false
    }
    if (
      requestGeneration !== selectionRequestGeneration
      || pendingSelection
      || rendererInitialization
    ) {
      return settleCurrentSelection()
    }
    settledSelectionGeneration = requestGeneration
    return !viewportRevealPending
  }

  try {
    return await runViewportResetFlow({
      centerViewport: async () => Boolean(await centerMainViewportGeometry(isCurrentReset)),
      isCurrent: isCurrentReset,
      settleSelection: settleCurrentSelection,
    })
  } finally {
    if (resetGeneration === viewportResetGeneration) {
      viewportResetPending = false
      viewportUpdateScheduler.setHeld(viewportInteraction.isHeld())
      if (
        componentMounted
        && desktopPetVisible.value
        && !viewportRevealPending
      ) {
        await revealPreparedRenderer().catch(reportWindowShowFailure)
        await resumeRendererInput()
      }
    }
  }
}

useTauriListen<Pet3dPresetSelectionPayload>(
  LISTEN_KEY.PET_PRESET_CHANGED,
  ({ payload }) => {
    if (!presetApplyInProgress) void requestPet3dPresetSelection(payload)
  },
)

// Catalog changes are acknowledged only after native input and the scene have
// settled. Cancellation and failure restore the previous configuration before
// another request in this queue is allowed to run.
async function applyManagedPreset(snapshot: PresetSnapshot, isCurrent: () => boolean, visible = true): Promise<void> {
  const check = () => {
    if (!componentMounted || !isCurrent()) throw new Error('Preset application was cancelled.')
  }
  check()
  await selectionTaskQueue.whenIdle()
  await viewportUpdateScheduler.whenIdle()
  check()
  managedViewportFailed = false
  await device.requestMouseSetting(snapshot.preset.mouseEnabled)
  check()
  const revision = Math.max(acceptedViewportMode.revision, catStore.activePet3dPreset.viewportModeRevision) + 1
  catStore.$patch(() => applyPresetSnapshot(catStore, snapshot, revision, visible))
  await nextTick()
  check()
  acceptedViewportMode = captureViewportMode(catStore.activePet3dPreset)
  requestPet3dPresetSelection(getCurrentSelection())
  if (desktopPetVisible.value) {
    await ensureRendererInitialized()
    check()
    await selectionTaskQueue.whenIdle()
    await viewportUpdateScheduler.whenIdle()
    check()
    if (rendererError.value || !rendererReady || managedViewportFailed
      || boundsRefreshPending || viewportUpdatePending || viewportRevealPending) {
      throw new Error('The preset scene did not settle.')
    }
  }
  await synchronizeWindowVisibility(true)
  check()
  await publishSceneViewportState()
  if (desktopPetVisible.value) {
    await selectionTaskQueue.whenIdle()
    await viewportUpdateScheduler.whenIdle()
    check()
    if (managedViewportFailed || boundsRefreshPending || viewportUpdatePending || viewportRevealPending) {
      throw new Error('The final preset viewport was not applied.')
    }
  }
}

useTauriListen<{ requestId?: string }>(PRESET_APPLY_CANCEL, ({ payload }) => {
  if (typeof payload?.requestId !== 'string') return
  cancelledPresetRequests.add(payload.requestId)
  if (payload.requestId !== activePresetRequestId) return
  for (const cancel of presentationWaiters) cancel()
  // Clearing the scheduler also releases a held/debounced whenIdle waiter;
  // generations prevent already-issued native readback from being adopted.
  sceneModeGeneration++
  selectionRequestGeneration++
  boundsMeasurementGeneration++
  viewportGeometryGeneration++
  pendingSelection = undefined
  selectionTaskQueue.clear()
  viewportUpdateScheduler.clear()
  viewportUpdatePending = false
  boundsRefreshPending = true
  three3d.cancelPendingPetAssetLoad()
})

useTauriListen<PresetApplyRequest>(PRESET_APPLY_REQUEST, ({ payload }) => {
  if (!payload || typeof payload.requestId !== 'string' || !isPresetSnapshot(payload.snapshot)) return
  if (payload.restoreVisibility !== undefined && typeof payload.restoreVisibility !== 'boolean') return
  presetApplyQueue = presetApplyQueue.catch(() => undefined).then(async () => {
    if (!componentMounted) return
    presetApplyInProgress = true
    activePresetRequestId = payload.requestId
    viewportInteraction.clear()
    viewportUpdateScheduler.setHeld(false)
    sceneModeGeneration++
    const previous = capturePresetSnapshot(catStore)
    const previousVisible = catStore.window.visible
    let success = false
    let restored = false
    try {
      await applyManagedPreset(payload.snapshot, () => !cancelledPresetRequests.has(payload.requestId), payload.restoreVisibility ?? true)
      success = true
    } catch (error) {
      activePresetRequestId = undefined
      console.error('Failed to apply the preset; restoring the previous scene.', error)
      try {
        await applyManagedPreset(previous, () => true, previousVisible)
        restored = true
      } catch (restoreError) {
        console.error('The previous preset requires a retry.', restoreError)
      }
    } finally {
      presetApplyInProgress = false
      activePresetRequestId = undefined
      viewportUpdateScheduler.setHeld(viewportInteraction.isHeld())
      cancelledPresetRequests.delete(payload.requestId)
    }
    await emitTo(WINDOW_LABEL.PREFERENCE, PRESET_APPLY_RESPONSE, {
      requestId: payload.requestId,
      success,
      restored,
      revision: catStore.activePet3dPreset.viewportModeRevision,
      snapshot: capturePresetSnapshot(catStore),
    })
    await processRuntimeFailure()
  }).catch(error => console.error('Failed to acknowledge the preset.', error))
})

useTauriListen<MainViewportResetRequest>(
  LISTEN_KEY.MAIN_VIEWPORT_RESET_REQUEST,
  ({ payload }) => {
    if (!payload.requestId) return
    void (async () => {
      let success = false
      try {
        success = await settleAndCenterResetViewport()
      } catch (error) {
        console.error('Failed to reset the main viewport geometry.', error)
      }
      const completion: MainViewportResetComplete = {
        requestId: payload.requestId,
        success,
      }
      await emitTo(
        WINDOW_LABEL.PREFERENCE,
        LISTEN_KEY.MAIN_VIEWPORT_RESET_COMPLETE,
        completion,
      )
    })()
  },
)

async function handleMouseDown(event: MouseEvent) {
  if (event.button !== 0 || petWindowDragging || rendererLoading.value) return
  const generation = ++petWindowDragGeneration
  petWindowDragging = true
  viewportInteraction.setButtons('pet-drag', 1)
  viewportHologramInteractionActive = true
  showViewportHologram()
  try {
    await nextTick()
    // Give the overlay a paint before entering the native modal move loop.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (generation !== petWindowDragGeneration || !componentMounted || !desktopPetVisible.value) return
    await dragMainWindow(catStore.window.keepInScreen)
  } catch (error) {
    if (generation === petWindowDragGeneration) clearViewportHologram()
    console.error('Failed to start dragging the pet window.', error)
  } finally {
    if (generation === petWindowDragGeneration) {
      clearViewportHologram()
      viewportInteraction.cancel('main')
    }
  }
}

async function showContextMenu() {
  const menu = await getAppMenu()
  const restoreAlwaysOnTop = catStore.window.alwaysOnTop
  if (restoreAlwaysOnTop) setAlwaysOnTop(false)
  try {
    await menu.popup()
  } finally {
    setAlwaysOnTop(catStore.window.alwaysOnTop)
  }
}

function handleContextmenu(event: MouseEvent) {
  event.preventDefault()
  void showContextMenu()
}
</script>

<template>
  <div class="main-window-root relative size-screen">
    <div
      v-show="!rendererLoading"
      class="absolute inset-0"
      :class="{ '-scale-x-100': catStore.model.mirror }"
      :style="{ opacity: catStore.window.opacity / 100 }"
      @contextmenu="handleContextmenu"
      @mousedown="handleMouseDown"
    >
      <div
        aria-hidden="true"
        class="viewport-hologram pointer-events-none absolute inset-0"
        :class="{ 'viewport-hologram-visible': catStore.activePet3dPreset.showDisplayArea || viewportHologramVisible }"
        data-testid="viewport-hologram"
      />
      <div
        ref="canvasHost"
        class="absolute inset-0"
      />
      <div
        v-if="rendererError"
        class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 p-4"
      >
        <span class="text-center text-sm text-white">{{ rendererError }}</span>
      </div>
    </div>
    <div
      v-if="rendererLoading"
      class="pointer-events-none absolute inset-0 flex items-center justify-center"
      data-testid="pet-loading"
      role="status"
    >
      <div class="flex items-center gap-2 rounded-full bg-black/70 px-3 py-2 text-xs text-white">
        <span
          aria-hidden="true"
          class="pet-loading-spinner"
        />
        <span>{{ t('pages.main.loading') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pet-loading-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgb(255 255 255 / 30%);
  border-top-color: white;
  border-radius: 50%;
  animation: pet-loading-spin 800ms linear infinite;
}
@keyframes pet-loading-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .pet-loading-spinner {
    animation: none;
  }
}

.viewport-hologram {
  background-color: rgb(70 210 220 / 8%);
  background-image:
    linear-gradient(rgb(100 225 235 / 12%) 1px, transparent 1px),
    linear-gradient(90deg, rgb(100 225 235 / 12%) 1px, transparent 1px),
    repeating-linear-gradient(0deg, transparent 0 3px, rgb(110 230 240 / 5%) 3px 4px);
  background-size:
    24px 24px,
    24px 24px,
    100% 4px;
  opacity: 0;
  transition: opacity 80ms linear;
}

.viewport-hologram-visible {
  opacity: 1;
}
</style>
