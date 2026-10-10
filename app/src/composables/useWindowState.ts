import type { Monitor } from '@tauri-apps/api/window'

import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { availableMonitors } from '@tauri-apps/api/window'
import { useDebounceFn } from '@vueuse/core'
import { onMounted, onScopeDispose, ref, watch } from 'vue'

import type {
  ResolvedViewportGeometry,
  ViewportMonitor,
  ViewportPoint,
  ViewportRect,
  ViewportSize,
} from '@/utils/viewportGeometry'

import { MODEL_3D_CONFIG } from '@/config/model3d'
import { DEFAULT_PREFERENCE_SIZE, MIN_PREFERENCE_SIZE } from '@/config/window'
import { WINDOW_LABEL } from '@/constants'
import { editorsLocked } from '@/features/stateSafety/bridge'
import { useAppStore } from '@/stores/app'
import { useBlockStore } from '@/stores/block'
import { createLatestAsyncTaskQueue } from '@/utils/latestAsyncTask'
import {
  classifyNativePositionEvent,
  classifyNativeSizeEvent,
  selectCurrentProgrammaticGeneration,
} from '@/utils/nativeGeometryEvent'
import { createSerializedRetryPump } from '@/utils/serializedRetryPump'
import {
  clampViewportToMonitors,
  createViewportGeometry,
  getCenteredViewportPosition,
  getRealizedViewportSourceRect,
  getRectIntersectionArea,
  getViewportVirtualOrigin,
  selectViewportMonitor,
} from '@/utils/viewportGeometry'

export interface PersistedWindowGeometry {
  x?: number
  y?: number
  width?: number
  height?: number
  viewportOriginX?: number
  viewportOriginY?: number
}

export type WindowState = Record<string, PersistedWindowGeometry | undefined>

export interface ApplyMainViewportGeometryInput {
  /** Checked again after every asynchronous boundary, including deferred replay. */
  isCurrent?: () => boolean
  clampToWorkArea?: boolean
  mirrored: boolean
  sourceRect: ViewportRect
  virtualSize?: ViewportSize
  windowScalePercent: number
}

export interface MainViewportSnapshot extends ResolvedViewportGeometry {
  generation: number
  monitorId?: string
}

export type MainViewportSnapshotListener = (
  snapshot: MainViewportSnapshot,
) => void

interface MainWindowContext {
  appStore: ReturnType<typeof useAppStore>
  blockStore: ReturnType<typeof useBlockStore>
}

interface PendingProgrammaticValue<T> {
  expiresAt: number
  generation: number
  value: T
}

interface DeferredMainViewportApply {
  input: ApplyMainViewportGeometryInput
  reject: (reason?: unknown) => void
  resolve: (snapshot: MainViewportSnapshot | undefined) => void
}

const appWindow = getCurrentWebviewWindow()
const { label } = appWindow
const PROGRAMMATIC_EVENT_TOLERANCE = 1
const PROGRAMMATIC_EVENT_TTL_MS = 2000
const SCALE_FACTOR_TOLERANCE = 1e-6
const MAX_SCALE_FACTOR_RECONCILIATIONS = 3
const pendingProgrammaticPositions: Array<PendingProgrammaticValue<ViewportPoint>> = []
const pendingProgrammaticSizes: Array<PendingProgrammaticValue<ViewportSize>> = []
let mainWindowContext: MainWindowContext | undefined
let mainViewportGeneration = 0
let mainViewportSnapshot: MainViewportSnapshot | undefined
type MainNativeGeometryInstability = 'drag' | 'drag-system' | 'none' | 'system'

let mainNativeGeometryInstability: MainNativeGeometryInstability = 'none'
let mainNativeEventSequence = 0
let latestMainViewportApplyGeneration = 0
let activeMainViewportApplyGeneration: number | undefined
let pendingMainViewportGeneration: number | undefined
let latestExternalMainPosition: ViewportPoint | undefined
let deferredMainViewportApply: DeferredMainViewportApply | undefined
const mainViewportSnapshotListeners = new Set<MainViewportSnapshotListener>()
let automaticViewportMutationAllowed = () => true
let disposeWindowState: (() => void) | undefined

// HMR can replace this module before Vue finishes unmounting the old App.
import.meta.hot?.dispose(() => disposeWindowState?.())

/** The main page owns interaction/debounce timing; automatic clamp work shares it. */
export function setAutomaticViewportMutationGuard(guard: () => boolean): void {
  automaticViewportMutationAllowed = guard
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPositiveDimension(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}

function cloneMainViewportSnapshot(
  snapshot: MainViewportSnapshot | undefined,
): MainViewportSnapshot | undefined {
  if (!snapshot) return undefined
  return {
    ...snapshot,
    nativeRect: { ...snapshot.nativeRect },
    outputLogicalSize: { ...snapshot.outputLogicalSize },
    physicalOffset: { ...snapshot.physicalOffset },
    physicalSize: { ...snapshot.physicalSize },
    placementRect: { ...snapshot.placementRect },
    realizedSourceRect: { ...snapshot.realizedSourceRect },
    sourceRect: { ...snapshot.sourceRect },
    virtualOrigin: { ...snapshot.virtualOrigin },
    virtualSize: { ...snapshot.virtualSize },
  }
}

export function getMainViewportSnapshot(): MainViewportSnapshot | undefined {
  return cloneMainViewportSnapshot(mainViewportSnapshot)
}

export function subscribeMainViewportSnapshot(
  listener: MainViewportSnapshotListener,
): () => void {
  mainViewportSnapshotListeners.add(listener)
  const snapshot = getMainViewportSnapshot()
  if (snapshot) listener(snapshot)
  return () => mainViewportSnapshotListeners.delete(listener)
}

function notifyMainViewportSnapshotListeners(): void {
  const snapshot = getMainViewportSnapshot()
  if (!snapshot) return
  for (const listener of mainViewportSnapshotListeners) {
    try {
      listener(snapshot)
    } catch (error) {
      console.error('Failed to notify a main viewport listener.', error)
    }
  }
}

function getMonitorId(monitor: Monitor): string {
  const { position, size } = monitor
  return [
    monitor.name ?? '',
    position.x,
    position.y,
    size.width,
    size.height,
  ].join(':')
}

function toViewportMonitors(monitors: readonly Monitor[]): ViewportMonitor[] {
  return monitors.map(monitor => ({
    id: getMonitorId(monitor),
    workArea: {
      x: monitor.workArea.position.x,
      y: monitor.workArea.position.y,
      width: monitor.workArea.size.width,
      height: monitor.workArea.size.height,
    },
  }))
}

export async function getMainViewportMonitorSize(): Promise<ViewportSize> {
  const monitors = await availableMonitors()
  const rect = mainViewportSnapshot?.nativeRect ?? {
    ...await appWindow.outerPosition(),
    ...await appWindow.outerSize(),
  }
  const selected = selectViewportMonitor(rect, monitors.map(monitor => ({
    id: getMonitorId(monitor),
    workArea: { ...monitor.position, ...monitor.size },
  })), mainViewportSnapshot?.monitorId)
  const monitor = monitors.find(item => getMonitorId(item) === selected?.id) ?? monitors[0]
  if (!monitor) throw new Error('No display is available for the pet viewport.')
  return {
    width: Math.max(100, Math.floor(monitor.size.width / monitor.scaleFactor)),
    height: Math.max(100, Math.floor(monitor.size.height / monitor.scaleFactor)),
  }
}

function persistMainViewportSnapshot(snapshot: MainViewportSnapshot): void {
  const context = mainWindowContext
  if (!context) return
  const state = context.appStore.windowState[WINDOW_LABEL.MAIN] ??= {}
  Object.assign(state, {
    x: snapshot.nativeRect.x,
    y: snapshot.nativeRect.y,
    width: snapshot.nativeRect.width,
    height: snapshot.nativeRect.height,
    viewportOriginX: snapshot.virtualOrigin.x,
    viewportOriginY: snapshot.virtualOrigin.y,
  })
}

function prunePendingProgrammaticValues<T>(
  pending: Array<PendingProgrammaticValue<T>>,
): void {
  const now = Date.now()
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index].expiresAt < now) pending.splice(index, 1)
  }
}

function rememberProgrammaticValue<T>(
  pending: Array<PendingProgrammaticValue<T>>,
  generation: number,
  value: T,
): void {
  prunePendingProgrammaticValues(pending)
  pending.push({
    expiresAt: Date.now() + PROGRAMMATIC_EVENT_TTL_MS,
    generation,
    value,
  })
}

function consumeProgrammaticPoint(
  pending: Array<PendingProgrammaticValue<ViewportPoint>>,
  value: ViewportPoint,
): number | undefined {
  prunePendingProgrammaticValues(pending)
  let index = -1
  for (let candidateIndex = pending.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = pending[candidateIndex]
    if (
      Math.abs(candidate.value.x - value.x) <= PROGRAMMATIC_EVENT_TOLERANCE
      && Math.abs(candidate.value.y - value.y) <= PROGRAMMATIC_EVENT_TOLERANCE
    ) {
      index = candidateIndex
      break
    }
  }
  if (index < 0) return undefined
  return pending.splice(index, 1)[0].generation
}

function consumeProgrammaticSize(
  pending: Array<PendingProgrammaticValue<ViewportSize>>,
  value: ViewportSize,
): number | undefined {
  prunePendingProgrammaticValues(pending)
  let index = -1
  for (let candidateIndex = pending.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = pending[candidateIndex]
    if (
      Math.abs(candidate.value.width - value.width) <= PROGRAMMATIC_EVENT_TOLERANCE
      && Math.abs(candidate.value.height - value.height) <= PROGRAMMATIC_EVENT_TOLERANCE
    ) {
      index = candidateIndex
      break
    }
  }
  if (index < 0) return undefined
  return pending.splice(index, 1)[0].generation
}

function updateMainSnapshotPosition(position: ViewportPoint): void {
  const snapshot = mainViewportSnapshot
  if (!snapshot) return
  mainViewportSnapshot = {
    ...snapshot,
    nativeRect: { ...snapshot.nativeRect, ...position },
    virtualOrigin: getViewportVirtualOrigin(position, snapshot.physicalOffset),
  }
  persistMainViewportSnapshot(mainViewportSnapshot)
}

function resolvePersistedVirtualOrigin(
  state: PersistedWindowGeometry | undefined,
): ViewportPoint | undefined {
  if (
    isFiniteNumber(state?.viewportOriginX)
    && isFiniteNumber(state.viewportOriginY)
  ) {
    return { x: state.viewportOriginX, y: state.viewportOriginY }
  }
  if (isFiniteNumber(state?.x) && isFiniteNumber(state.y)) {
    return { x: state.x, y: state.y }
  }
}

function isPersistedWindowOnAMonitor(
  state: PersistedWindowGeometry | undefined,
  monitors: readonly Monitor[],
): boolean {
  if (!isFiniteNumber(state?.x) || !isFiniteNumber(state.y)) return false
  const hasSize = isFiniteNumber(state.width)
    && state.width > 0
    && isFiniteNumber(state.height)
    && state.height > 0

  return monitors.some((monitor) => {
    const { position, size } = monitor
    if (hasSize) {
      return getRectIntersectionArea({
        x: state.x!,
        y: state.y!,
        width: state.width!,
        height: state.height!,
      }, {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      }) > 0
    }
    return state.x! >= position.x
      && state.x! < position.x + size.width
      && state.y! >= position.y
      && state.y! < position.y + size.height
  })
}

async function getInitialVirtualOrigin(): Promise<ViewportPoint> {
  const context = mainWindowContext
  const currentPosition = await appWindow.outerPosition()
  if (!context) return currentPosition
  const state = context.appStore.windowState[WINDOW_LABEL.MAIN]
  const persisted = resolvePersistedVirtualOrigin(state)
  if (!persisted) return currentPosition
  if (context.blockStore.window.keepInScreen) return persisted

  const monitors = await availableMonitors()
  return isPersistedWindowOnAMonitor(state, monitors) ? persisted : currentPosition
}

function applyContainment(
  geometry: ResolvedViewportGeometry,
  monitors: readonly Monitor[],
  preferredMonitorId?: string,
): { geometry: ResolvedViewportGeometry, monitorId?: string } {
  const clamped = clampViewportToMonitors(
    geometry.nativeRect,
    toViewportMonitors(monitors),
    preferredMonitorId,
  )
  if (!clamped) return { geometry, monitorId: preferredMonitorId }
  return {
    geometry: {
      ...geometry,
      nativeRect: clamped.rect,
      virtualOrigin: {
        x: geometry.virtualOrigin.x + clamped.delta.x,
        y: geometry.virtualOrigin.y + clamped.delta.y,
      },
    },
    monitorId: clamped.monitor.id,
  }
}

export async function applyMainViewportGeometry(
  input: ApplyMainViewportGeometryInput,
): Promise<MainViewportSnapshot | undefined> {
  if (!mainWindowContext || input.isCurrent?.() === false) return undefined
  if (mainNativeGeometryInstability !== 'none') {
    latestMainViewportApplyGeneration = ++mainViewportGeneration
    return new Promise((resolve, reject) => {
      deferredMainViewportApply?.resolve(undefined)
      deferredMainViewportApply = {
        input: {
          ...input,
          sourceRect: { ...input.sourceRect },
          virtualSize: input.virtualSize
            ? { ...input.virtualSize }
            : undefined,
        },
        reject,
        resolve,
      }
    })
  }
  return applyMainViewportGeometryInternal(input)
}

async function replayDeferredMainViewportApply(): Promise<void> {
  if (mainNativeGeometryInstability !== 'none' || !deferredMainViewportApply) return
  const deferred = deferredMainViewportApply
  deferredMainViewportApply = undefined
  try {
    deferred.resolve(await applyMainViewportGeometryInternal(deferred.input))
  } catch (error) {
    deferred.reject(error)
  } finally {
    if (mainNativeGeometryInstability === 'none' && deferredMainViewportApply) {
      await replayDeferredMainViewportApply()
    }
  }
}

interface MainViewportGeometryInternalOptions {
  allowWhileNativeGeometryIsUnstable?: boolean
  anchorCurrentNativePosition?: boolean
  anchorNativePosition?: ViewportPoint
  centerWorkArea?: ViewportRect
  nativeEventSequence?: number
  scaleFactorReconciliations?: number
  scaleFactor?: number
  virtualOrigin?: ViewportPoint
}

function isViewportMutationCurrent(
  generation: number,
  nativeEventSequence?: number,
): boolean {
  return generation === mainViewportGeneration
    && (
      nativeEventSequence === undefined
      || nativeEventSequence === mainNativeEventSequence
    )
}

async function finishMainViewportGeometryAtDragAnchor(
  pendingSnapshot: MainViewportSnapshot,
  pendingGeneration: number,
  isCurrent: () => boolean = () => true,
): Promise<MainViewportSnapshot | undefined> {
  const canFinish = () => {
    const isDrag = mainNativeGeometryInstability === 'drag'
      || mainNativeGeometryInstability === 'drag-system'
    return isCurrent() && isDrag
      && pendingMainViewportGeneration === pendingGeneration
      && latestMainViewportApplyGeneration === pendingGeneration
  }
  if (!canFinish()) return undefined
  const [actualPosition, actualOuterSize, actualInnerSize] = await Promise.all([
    appWindow.outerPosition(),
    appWindow.outerSize(),
    appWindow.innerSize(),
  ])
  if (!canFinish()) return undefined

  const position = latestExternalMainPosition ?? actualPosition
  const { scaleFactor, windowScalePercent } = pendingSnapshot
  mainViewportSnapshot = {
    ...pendingSnapshot,
    generation: mainViewportGeneration,
    nativeRect: {
      x: position.x,
      y: position.y,
      width: actualOuterSize.width,
      height: actualOuterSize.height,
    },
    outputLogicalSize: {
      width: actualInnerSize.width / scaleFactor,
      height: actualInnerSize.height / scaleFactor,
    },
    physicalSize: {
      width: actualInnerSize.width,
      height: actualInnerSize.height,
    },
    realizedSourceRect: getRealizedViewportSourceRect(
      pendingSnapshot.sourceRect,
      pendingSnapshot.virtualSize,
      pendingSnapshot.mirrored,
      pendingSnapshot.physicalOffset,
      actualInnerSize,
      scaleFactor * windowScalePercent / 100,
    ),
    virtualOrigin: getViewportVirtualOrigin(
      position,
      pendingSnapshot.physicalOffset,
    ),
  }
  persistMainViewportSnapshot(mainViewportSnapshot)
  notifyMainViewportSnapshotListeners()
  return getMainViewportSnapshot()
}

async function applyMainViewportGeometryInternal(
  input: ApplyMainViewportGeometryInput,
  options: MainViewportGeometryInternalOptions = {},
): Promise<MainViewportSnapshot | undefined> {
  const context = mainWindowContext
  const automaticGuard = automaticViewportMutationAllowed
  const requestCurrent = input.isCurrent ?? (() => automaticGuard === automaticViewportMutationAllowed
    && automaticGuard())
  const isCurrent = () => context === mainWindowContext && requestCurrent()
  if (!isCurrent()) return undefined
  if (!context || label !== WINDOW_LABEL.MAIN) return undefined
  if (
    mainNativeGeometryInstability !== 'none'
    && !options.allowWhileNativeGeometryIsUnstable
  ) {
    return undefined
  }
  const generation = ++mainViewportGeneration
  latestMainViewportApplyGeneration = generation
  activeMainViewportApplyGeneration = generation
  try {
    const virtualSize = input.virtualSize ?? MODEL_3D_CONFIG.baseWindow
    const [scaleFactor, monitors, initialVirtualOrigin, currentNativePosition] = await Promise.all([
      options.scaleFactor === undefined
        ? appWindow.scaleFactor()
        : Promise.resolve(options.scaleFactor),
      availableMonitors(),
      options.virtualOrigin
        ? Promise.resolve(options.virtualOrigin)
        : mainViewportSnapshot
          ? Promise.resolve(mainViewportSnapshot.virtualOrigin)
          : getInitialVirtualOrigin(),
      appWindow.outerPosition(),
    ])
    if (!isCurrent()) return undefined
    if (!isViewportMutationCurrent(generation, options.nativeEventSequence)) {
      return undefined
    }
    let anchorPosition = options.anchorNativePosition
      ?? (options.anchorCurrentNativePosition ? currentNativePosition : undefined)

    let geometry = createViewportGeometry({
      mirrored: input.mirrored,
      scaleFactor,
      sourceRect: input.sourceRect,
      virtualOrigin: initialVirtualOrigin,
      virtualSize,
      windowScalePercent: input.windowScalePercent,
    })
    if (options.centerWorkArea) {
      anchorPosition = getCenteredViewportPosition(
        geometry.nativeRect,
        options.centerWorkArea,
      )
    }
    if (anchorPosition) {
      geometry = {
        ...geometry,
        nativeRect: {
          ...geometry.nativeRect,
          x: anchorPosition.x,
          y: anchorPosition.y,
        },
        virtualOrigin: getViewportVirtualOrigin(
          anchorPosition,
          geometry.physicalOffset,
        ),
      }
    }
    let monitorId = mainViewportSnapshot?.monitorId
    if (
      input.clampToWorkArea !== false
      && context.blockStore.window.keepInScreen
    ) {
      const contained = applyContainment(geometry, monitors, monitorId)
      geometry = contained.geometry
      monitorId = contained.monitorId
    }

    const pendingSnapshot: MainViewportSnapshot = {
      ...geometry,
      generation,
      monitorId,
    }
    pendingMainViewportGeneration = generation
    try {
      // Register the pre-resize position so native moves caused by resizing
      // cannot be mistaken for a user drag.
      rememberProgrammaticValue(
        pendingProgrammaticPositions,
        generation,
        currentNativePosition,
      )
      rememberProgrammaticValue(
        pendingProgrammaticSizes,
        generation,
        geometry.physicalSize,
      )
      await appWindow.setSize(new PhysicalSize(
        geometry.physicalSize.width,
        geometry.physicalSize.height,
      ))
      if (!isCurrent()) return undefined
      if (!isViewportMutationCurrent(generation, options.nativeEventSequence)) {
        const interrupted = await finishMainViewportGeometryAtDragAnchor(
          pendingSnapshot,
          generation,
          isCurrent,
        )
        return interrupted
      }

      rememberProgrammaticValue(
        pendingProgrammaticPositions,
        generation,
        geometry.nativeRect,
      )
      await appWindow.setPosition(new PhysicalPosition(
        geometry.nativeRect.x,
        geometry.nativeRect.y,
      ))
      if (!isCurrent()) return undefined
      if (!isViewportMutationCurrent(generation, options.nativeEventSequence)) {
        const interrupted = await finishMainViewportGeometryAtDragAnchor(
          pendingSnapshot,
          generation,
          isCurrent,
        )
        return interrupted
      }

      const [
        actualPosition,
        actualOuterSize,
        actualInnerSize,
        actualScaleFactor,
      ] = await Promise.all([
        appWindow.outerPosition(),
        appWindow.outerSize(),
        appWindow.innerSize(),
        appWindow.scaleFactor(),
      ])
      if (!isCurrent()) return undefined
      if (!isViewportMutationCurrent(generation, options.nativeEventSequence)) {
        const interrupted = await finishMainViewportGeometryAtDragAnchor(
          pendingSnapshot,
          generation,
          isCurrent,
        )
        return interrupted
      }

      if (Math.abs(actualScaleFactor - scaleFactor) > SCALE_FACTOR_TOLERANCE) {
        const reconciliations = options.scaleFactorReconciliations ?? 0
        if (reconciliations >= MAX_SCALE_FACTOR_RECONCILIATIONS) {
          console.warn('The main viewport scale factor did not stabilize.', {
            actualScaleFactor,
            requestedScaleFactor: scaleFactor,
          })
          return undefined
        }
        return applyMainViewportGeometryInternal(input, {
          ...options,
          allowWhileNativeGeometryIsUnstable: true,
          anchorCurrentNativePosition: false,
          anchorNativePosition: !options.centerWorkArea && anchorPosition
            ? {
                x: geometry.nativeRect.x,
                y: geometry.nativeRect.y,
              }
            : undefined,
          scaleFactor: actualScaleFactor,
          scaleFactorReconciliations: reconciliations + 1,
          virtualOrigin: initialVirtualOrigin,
        })
      }

      mainViewportSnapshot = {
        ...pendingSnapshot,
        nativeRect: {
          x: actualPosition.x,
          y: actualPosition.y,
          width: actualOuterSize.width,
          height: actualOuterSize.height,
        },
        outputLogicalSize: {
          width: actualInnerSize.width / scaleFactor,
          height: actualInnerSize.height / scaleFactor,
        },
        physicalSize: {
          width: actualInnerSize.width,
          height: actualInnerSize.height,
        },
        realizedSourceRect: getRealizedViewportSourceRect(
          geometry.sourceRect,
          geometry.virtualSize,
          geometry.mirrored,
          geometry.physicalOffset,
          actualInnerSize,
          scaleFactor * geometry.windowScalePercent / 100,
        ),
        virtualOrigin: getViewportVirtualOrigin(
          actualPosition,
          geometry.physicalOffset,
        ),
      }
      persistMainViewportSnapshot(mainViewportSnapshot)
      notifyMainViewportSnapshotListeners()
      return getMainViewportSnapshot()
    } finally {
      if (pendingMainViewportGeneration === generation) {
        pendingMainViewportGeneration = undefined
      }
    }
  } finally {
    if (activeMainViewportApplyGeneration === generation) {
      activeMainViewportApplyGeneration = undefined
      pendingProgrammaticPositions.length = 0
      pendingProgrammaticSizes.length = 0
    }
    void flushRequestedMainViewportClamp()
  }
}

async function refreshMainViewportGeometryInternal(
  options: Pick<
    MainViewportGeometryInternalOptions,
    | 'allowWhileNativeGeometryIsUnstable'
    | 'anchorNativePosition'
    | 'nativeEventSequence'
    | 'scaleFactor'
  > = {},
): Promise<MainViewportSnapshot | undefined> {
  const snapshot = mainViewportSnapshot
  if (!snapshot) return undefined
  return applyMainViewportGeometryInternal({
    mirrored: snapshot.mirrored,
    sourceRect: snapshot.sourceRect,
    virtualSize: snapshot.virtualSize,
    windowScalePercent: snapshot.windowScalePercent,
  }, {
    ...options,
  })
}

export async function refreshMainViewportGeometry(): Promise<MainViewportSnapshot | undefined> {
  return refreshMainViewportGeometryInternal()
}

export async function centerMainViewportGeometry(
  isCurrent: () => boolean = () => true,
): Promise<MainViewportSnapshot | undefined> {
  const context = mainWindowContext
  const canApply = () => !!context && context === mainWindowContext && isCurrent()
  const snapshot = mainViewportSnapshot
  if (!canApply() || !snapshot || label !== WINDOW_LABEL.MAIN) return undefined
  const [position, outerSize, monitors] = await Promise.all([
    appWindow.outerPosition(),
    appWindow.outerSize(),
    availableMonitors(),
  ])
  if (!canApply()) return undefined
  const rect = { x: position.x, y: position.y, ...outerSize }
  const monitor = selectViewportMonitor(
    rect,
    toViewportMonitors(monitors),
    snapshot.monitorId,
  )
  if (!monitor) return undefined

  return applyMainViewportGeometryInternal({
    isCurrent: canApply,
    mirrored: snapshot.mirrored,
    sourceRect: snapshot.sourceRect,
    virtualSize: snapshot.virtualSize,
    windowScalePercent: snapshot.windowScalePercent,
  }, {
    allowWhileNativeGeometryIsUnstable: true,
    centerWorkArea: monitor.workArea,
  })
}

async function clampMainViewportInternal(
  allowWhileNativeGeometryIsUnstable = false,
  nativeEventSequence?: number,
  nativePositionOverride?: ViewportPoint,
  forceContainment = false,
): Promise<MainViewportSnapshot | undefined> {
  const context = mainWindowContext
  const automaticGuard = automaticViewportMutationAllowed
  const isCurrent = () => context === mainWindowContext
    && automaticGuard === automaticViewportMutationAllowed && automaticGuard()
  if (!isCurrent()) return undefined
  const snapshot = mainViewportSnapshot
  if (!context || !snapshot || label !== WINDOW_LABEL.MAIN) return undefined
  if (
    mainNativeGeometryInstability !== 'none'
    && !allowWhileNativeGeometryIsUnstable
  ) {
    return undefined
  }
  const generation = ++mainViewportGeneration
  const [position, outerSize, innerSize, monitors] = await Promise.all([
    appWindow.outerPosition(),
    appWindow.outerSize(),
    appWindow.innerSize(),
    availableMonitors(),
  ])
  if (!isCurrent()
    || !isViewportMutationCurrent(generation, nativeEventSequence)) {
    return undefined
  }
  const effectivePosition = nativePositionOverride ?? position

  const currentGeometry: ResolvedViewportGeometry = {
    ...snapshot,
    nativeRect: {
      x: effectivePosition.x,
      y: effectivePosition.y,
      width: outerSize.width,
      height: outerSize.height,
    },
    outputLogicalSize: {
      width: innerSize.width / snapshot.scaleFactor,
      height: innerSize.height / snapshot.scaleFactor,
    },
    physicalSize: { width: innerSize.width, height: innerSize.height },
    realizedSourceRect: getRealizedViewportSourceRect(
      snapshot.sourceRect,
      snapshot.virtualSize,
      snapshot.mirrored,
      snapshot.physicalOffset,
      innerSize,
      snapshot.scaleFactor * snapshot.windowScalePercent / 100,
    ),
    virtualOrigin: getViewportVirtualOrigin(
      effectivePosition,
      snapshot.physicalOffset,
    ),
  }
  const contained = (forceContainment || context.blockStore.window.keepInScreen)
    ? applyContainment(currentGeometry, monitors, snapshot.monitorId)
    : { geometry: currentGeometry, monitorId: snapshot.monitorId }
  mainViewportSnapshot = {
    ...contained.geometry,
    generation,
    monitorId: contained.monitorId,
  }

  if (
    mainViewportSnapshot.nativeRect.x !== position.x
    || mainViewportSnapshot.nativeRect.y !== position.y
  ) {
    rememberProgrammaticValue(
      pendingProgrammaticPositions,
      generation,
      mainViewportSnapshot.nativeRect,
    )
    await appWindow.setPosition(new PhysicalPosition(
      mainViewportSnapshot.nativeRect.x,
      mainViewportSnapshot.nativeRect.y,
    ))
    if (!isCurrent()
      || !isViewportMutationCurrent(generation, nativeEventSequence)) {
      return undefined
    }
  }

  persistMainViewportSnapshot(mainViewportSnapshot)
  notifyMainViewportSnapshotListeners()
  return getMainViewportSnapshot()
}

export async function clampMainViewportForRecovery(): Promise<MainViewportSnapshot | undefined> {
  return clampMainViewportInternal(false, undefined, undefined, true)
}

export async function clampMainViewport(): Promise<MainViewportSnapshot | undefined> {
  return clampMainViewportInternal()
}

function isMainViewportClampBlocked(): boolean {
  return !automaticViewportMutationAllowed()
    || !mainWindowContext
    || !mainViewportSnapshot
    || activeMainViewportApplyGeneration !== undefined
    || pendingMainViewportGeneration !== undefined
    || Boolean(deferredMainViewportApply)
    || mainNativeGeometryInstability !== 'none'
}

const mainViewportClampPump = createSerializedRetryPump(async () => {
  const context = mainWindowContext
  if (!context || label !== WINDOW_LABEL.MAIN) return 'blocked'
  if (!context.blockStore.window.keepInScreen) return 'complete'
  if (isMainViewportClampBlocked()) return 'blocked'

  const snapshot = await clampMainViewportInternal()
  if (snapshot) return 'complete'
  return isMainViewportClampBlocked() ? 'blocked' : 'retry'
}, {
  onError: error => console.error(
    'Failed to apply the requested main viewport clamp.',
    error,
  ),
})

async function flushRequestedMainViewportClamp(): Promise<void> {
  mainViewportClampPump.resume()
  await mainViewportClampPump.whenIdle()
}

function requestMainViewportClamp(): void {
  mainViewportClampPump.request()
}

export function useWindowState() {
  disposeWindowState?.()
  const appStore = useAppStore()
  const blockStore = useBlockStore()
  const isRestored = ref(false)
  const context = { appStore, blockStore }
  if (label === WINDOW_LABEL.MAIN) mainWindowContext = context
  let disposed = false
  const unlisteners: Array<() => void> = []
  const dispose = () => {
    if (disposed) return
    disposed = true
    movedQueue.clear()
    resizedQueue.clear()
    unlisteners.splice(0).forEach(unlisten => unlisten())
    if (disposeWindowState === dispose) disposeWindowState = undefined
    if (mainWindowContext !== context) return
    mainWindowContext = undefined
    mainViewportGeneration++
    mainNativeEventSequence++
    mainNativeGeometryInstability = 'none'
    latestExternalMainPosition = undefined
    deferredMainViewportApply?.resolve(undefined)
    deferredMainViewportApply = undefined
    pendingProgrammaticPositions.length = 0
    pendingProgrammaticSizes.length = 0
    mainViewportClampPump.clear()
  }
  disposeWindowState = dispose
  onScopeDispose(dispose)

  const retainListener = (registration: Promise<() => void>) => {
    void registration.then((unlisten) => {
      if (disposed) unlisten()
      else unlisteners.push(unlisten)
    }).catch((error) => {
      if (!disposed) console.error('Failed to subscribe to native window geometry.', error)
    })
  }

  let regularMovedEventSequence = 0
  let regularResizedEventSequence = 0
  let mainMovedEventSequence = 0
  let mainResizedEventSequence = 0

  const reconcileNativeGeometry = useDebounceFn(async (sequence: number) => {
    if (disposed || sequence !== mainNativeEventSequence) return
    try {
      const snapshot = mainViewportSnapshot
      if (!snapshot) return
      const scaleFactor = await appWindow.scaleFactor()
      if (disposed || sequence !== mainNativeEventSequence) return

      if (
        mainNativeGeometryInstability === 'system'
        || mainNativeGeometryInstability === 'drag-system'
        || Math.abs(scaleFactor - snapshot.scaleFactor) > SCALE_FACTOR_TOLERANCE
      ) {
        await refreshMainViewportGeometryInternal({
          allowWhileNativeGeometryIsUnstable: true,
          anchorNativePosition: latestExternalMainPosition,
          nativeEventSequence: sequence,
          scaleFactor,
        })
      } else {
        await clampMainViewportInternal(
          true,
          sequence,
          latestExternalMainPosition,
        )
      }
    } finally {
      if (!disposed && sequence === mainNativeEventSequence) {
        mainNativeGeometryInstability = 'none'
        latestExternalMainPosition = undefined
        await replayDeferredMainViewportApply()
        await flushRequestedMainViewportClamp()
      }
    }
  }, 500)

  const scheduleNativeGeometryReconciliation = (
    instability: 'drag' | 'system' | undefined = undefined,
  ) => {
    if (disposed) return
    if (instability === 'drag') {
      mainNativeGeometryInstability
        = mainNativeGeometryInstability === 'system'
          || mainNativeGeometryInstability === 'drag-system'
          ? 'drag-system'
          : 'drag'
    } else if (instability === 'system') {
      mainNativeGeometryInstability
        = mainNativeGeometryInstability === 'drag'
          || mainNativeGeometryInstability === 'drag-system'
          ? 'drag-system'
          : 'system'
    }
    const sequence = ++mainNativeEventSequence
    void reconcileNativeGeometry(sequence)
  }

  const persistRegularWindowPosition = (position: PhysicalPosition) => {
    appStore.windowState[label] ??= {}
    Object.assign(appStore.windowState[label], { x: position.x, y: position.y })
  }
  const persistRegularWindowSize = (size: PhysicalSize) => {
    // A delayed minimized/empty resize may arrive after isMinimized() is false.
    // Preserve the last usable size rather than persisting an invisible window.
    if (!isPositiveDimension(size.width) || !isPositiveDimension(size.height)) return
    appStore.windowState[label] ??= {}
    Object.assign(appStore.windowState[label], { width: size.width, height: size.height })
  }

  // Native geometry reads can be delayed by the window's modal move loop.
  // Keep one readback per event kind and only its latest pending value.
  // Fast main-window move replies still need a cadence before reading/persisting.
  const movedQueue = createLatestAsyncTaskQueue(async ({ payload, sequence }: { payload: PhysicalPosition, sequence: number }) => {
    if (disposed) return
    if (label !== WINDOW_LABEL.MAIN) {
      if (await appWindow.isMinimized()) return
      if (disposed || sequence !== regularMovedEventSequence) return
      persistRegularWindowPosition(payload)
      return
    }

    const matchedProgrammaticGeneration = consumeProgrammaticPoint(
      pendingProgrammaticPositions,
      payload,
    )
    const programmaticGeneration = selectCurrentProgrammaticGeneration(
      matchedProgrammaticGeneration,
      activeMainViewportApplyGeneration,
    )
    let actualPosition = payload
    if (programmaticGeneration === undefined) {
      try {
        actualPosition = await appWindow.outerPosition()
      } catch {
        if (!disposed) console.warn('Failed to read the current native window position.')
        return
      }
    }
    if (disposed || sequence !== mainMovedEventSequence) return
    const classification = classifyNativePositionEvent({
      actualValue: actualPosition,
      committedValue: mainViewportSnapshot?.nativeRect,
      eventValue: payload,
      programmaticGeneration,
      tolerance: PROGRAMMATIC_EVENT_TOLERANCE,
    })
    if (classification !== 'external') return
    updateMainSnapshotPosition(actualPosition)
    latestExternalMainPosition = actualPosition
    mainViewportGeneration += 1
    scheduleNativeGeometryReconciliation('drag')
  }, {
    minIntervalMs: label === WINDOW_LABEL.MAIN ? 16 : 0,
    onError: () => {
      if (!disposed) console.warn('Failed to read the current native window position.')
    },
  })

  const resizedQueue = createLatestAsyncTaskQueue(async ({ payload, sequence }: { payload: PhysicalSize, sequence: number }) => {
    if (disposed) return
    if (label !== WINDOW_LABEL.MAIN) {
      if (await appWindow.isMinimized()) return
      if (disposed || sequence !== regularResizedEventSequence) return
      persistRegularWindowSize(payload)
      return
    }

    const matchedProgrammaticGeneration = consumeProgrammaticSize(
      pendingProgrammaticSizes,
      payload,
    )
    const programmaticGeneration = selectCurrentProgrammaticGeneration(
      matchedProgrammaticGeneration,
      activeMainViewportApplyGeneration,
    )
    let actualSize = payload
    if (programmaticGeneration === undefined) {
      try {
        actualSize = await appWindow.innerSize()
      } catch {
        if (!disposed) console.warn('Failed to read the current native window size.')
        return
      }
    }
    if (disposed || sequence !== mainResizedEventSequence) return
    const classification = classifyNativeSizeEvent({
      actualValue: actualSize,
      committedValue: mainViewportSnapshot?.physicalSize,
      eventValue: payload,
      programmaticGeneration,
      tolerance: PROGRAMMATIC_EVENT_TOLERANCE,
    })
    if (classification !== 'external') return
    scheduleNativeGeometryReconciliation('system')
  }, {
    onError: () => {
      if (!disposed) console.warn('Failed to read the current native window size.')
    },
  })

  let movedReadback: Promise<void> | undefined
  let resizedReadback: Promise<void> | undefined
  onMounted(() => {
    if (disposed) return
    retainListener(appWindow.onMoved(({ payload }) => {
      if (disposed) return
      const sequence = label === WINDOW_LABEL.MAIN ? ++mainMovedEventSequence : ++regularMovedEventSequence
      movedQueue.enqueue({ payload, sequence })
      // Share completion as well as work: a burst must not create one native
      // query or a separate drain waiter for every obsolete geometry event.
      return movedReadback ??= movedQueue.whenIdle().finally(() => {
        movedReadback = undefined
      })
    }))
    retainListener(appWindow.onResized(({ payload }) => {
      if (disposed) return
      const sequence = label === WINDOW_LABEL.MAIN ? ++mainResizedEventSequence : ++regularResizedEventSequence
      resizedQueue.enqueue({ payload, sequence })
      return resizedReadback ??= resizedQueue.whenIdle().finally(() => {
        resizedReadback = undefined
      })
    }))
    if (label === WINDOW_LABEL.MAIN) {
      retainListener(appWindow.onScaleChanged(() => {
        scheduleNativeGeometryReconciliation('system')
      }))
    }
  })

  watch(
    () => blockStore.window.keepInScreen,
    (keepInScreen) => {
      if (disposed) return
      if (keepInScreen) requestMainViewportClamp()
      else mainViewportClampPump.clear()
    },
  )

  const restoreState = async () => {
    if (disposed) return
    const state = appStore.windowState[label]
    if (label === WINDOW_LABEL.MAIN) {
      const { width, height } = MODEL_3D_CONFIG.baseWindow
      try {
        await applyMainViewportGeometryInternal({
          isCurrent: () => !disposed,
          clampToWorkArea: false,
          mirrored: blockStore.model.mirror,
          sourceRect: { x: 0, y: 0, width, height },
          windowScalePercent: 100,
        }, {
          allowWhileNativeGeometryIsUnstable: true,
        })
      } catch (error) {
        console.error('Failed to restore the initial main viewport.', error)
      } finally {
        if (!disposed) isRestored.value = true
      }
      return
    }

    const { x, y, width, height } = state ?? {}
    if (isFiniteNumber(x) && isFiniteNumber(y)) {
      const monitors = await availableMonitors()
      if (disposed) return
      const monitor = monitors.find(({ position, size }) => (
        x >= position.x
        && x < position.x + size.width
        && y >= position.y
        && y < position.y + size.height
      ))
      if (monitor || editorsLocked.value) await appWindow.setPosition(new PhysicalPosition(x, y))
      if (disposed) return
    }
    if (label === WINDOW_LABEL.PREFERENCE) {
      const monitors = await availableMonitors()
      const position = await appWindow.outerPosition()
      if (disposed) return
      const monitor = monitors.find(item => position.x >= item.position.x && position.x < item.position.x + item.size.width
        && position.y >= item.position.y && position.y < item.position.y + item.size.height) ?? monitors[0]
      const factor = monitor?.scaleFactor ?? await appWindow.scaleFactor()
      if (disposed) return
      const availableWidth = monitor?.workArea.size.width ?? DEFAULT_PREFERENCE_SIZE.width * factor
      const availableHeight = Math.max(100, (monitor?.workArea.size.height ?? (DEFAULT_PREFERENCE_SIZE.height + 40) * factor) - 40 * factor)
      const desiredWidth = isPositiveDimension(width) ? Math.max(width, MIN_PREFERENCE_SIZE.width * factor) : DEFAULT_PREFERENCE_SIZE.width * factor
      const desiredHeight = isPositiveDimension(height) ? Math.max(height, MIN_PREFERENCE_SIZE.height * factor) : DEFAULT_PREFERENCE_SIZE.height * factor
      await appWindow.setSize(new PhysicalSize(Math.min(desiredWidth, availableWidth), Math.min(desiredHeight, availableHeight)))
      if (disposed) return
      if (monitor) {
        const size = await appWindow.outerSize()
        if (disposed) return
        await appWindow.setPosition(new PhysicalPosition(
          Math.max(monitor.workArea.position.x, Math.min(position.x, monitor.workArea.position.x + availableWidth - size.width)),
          Math.max(monitor.workArea.position.y, Math.min(position.y, monitor.workArea.position.y + monitor.workArea.size.height - size.height)),
        ))
      }
    } else if (isFiniteNumber(width) && isFiniteNumber(height)) {
      await appWindow.setSize(new PhysicalSize(width, height))
    }
    if (!disposed) {
      // Own the initial native readback; an event may arrive after hydration.
      persistRegularWindowPosition(await appWindow.outerPosition())
      persistRegularWindowSize(await appWindow.innerSize())
      isRestored.value = true
    }
  }

  return {
    isRestored,
    restoreState,
  }
}
