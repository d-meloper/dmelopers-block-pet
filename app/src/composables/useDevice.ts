import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isNil } from 'es-toolkit'
import { onMounted, onUnmounted, watch } from 'vue'

import type { DeviceInputState, SemanticInputEvent } from '@/features/input/types'

import { isCurrentSemanticInput, isDeviceInputState, isSemanticInputEvent } from '@/features/input/types'
import { useAppStore } from '@/stores/app'
import { useCatStore } from '@/stores/cat'
import { inBetween } from '@/utils/is'
import { getCursorMonitor } from '@/utils/monitor'
import three3d from '@/utils/three3d'

import { INVOKE_KEY, LISTEN_KEY, WINDOW_LABEL } from '../constants'

export interface CursorPoint {
  x: number
  y: number
}

let nativeSessionOwner: symbol | undefined
let nativeCommandTail: Promise<unknown> = Promise.resolve()

function runNativeCommand<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeCommandTail.then(operation)
  nativeCommandTail = result.catch(() => undefined)
  return result
}

interface DeviceSessionDependencies {
  readSetting: () => boolean
  start: (enabled: boolean) => Promise<unknown>
  configure: (enabled: boolean) => Promise<unknown>
  activity?: (active: boolean, mouseEnabled: boolean) => Promise<unknown>
  stop: () => Promise<unknown>
  onConfirmed: (enabled: boolean) => void
  onGate: (enabled: boolean) => void
}

/** One native command queue; lifecycle suspension never changes the saved option. */
export function createDeviceInputSession(deps: DeviceSessionDependencies) {
  let nativeState: DeviceInputState | undefined
  let confirmed: boolean | undefined
  let active = false
  let nativeActive = false
  let disposed = false
  let pending = 0
  let generation = 0
  let tail: Promise<unknown> = Promise.resolve()

  const checkAlive = () => {
    if (disposed) throw new Error('The input session has ended.')
  }
  const accept = (value: unknown): DeviceInputState => {
    checkAlive()
    if (!isDeviceInputState(value)) throw new Error('Invalid native input acknowledgement.')
    nativeState = { ...value }
    return nativeState
  }
  const invalidate = () => {
    generation += 1
    deps.onGate(false)
  }
  const mouseActive = () => !disposed && active && pending === 0
    && confirmed === true && nativeState?.mouseEnabled === true
  const enqueue = <T>(operation: () => Promise<T>, changesMouse = true): Promise<T> => {
    if (changesMouse) {
      pending += 1
      invalidate()
    }
    const result = tail.then(() => {
      checkAlive()
      return operation()
    }).finally(() => {
      if (changesMouse) {
        pending -= 1
        deps.onGate(mouseActive())
      }
    })
    tail = result.catch(() => undefined)
    return result
  }
  const confirm = (state: DeviceInputState) => {
    confirmed = state.mouseEnabled
    deps.onConfirmed(confirmed)
  }
  const configure = async (enabled: boolean) => {
    if (deps.activity) {
      const state = await applyActivity(active, enabled)
      // The saved mouse setting is independent of an inactive desktop lease.
      return { ...state, mouseEnabled: enabled }
    }
    const state = accept(await deps.configure(enabled))
    if (state.mouseEnabled !== enabled) throw new Error('The native mouse setting was not applied.')
    return state
  }
  const applyActivity = async (requestedActive: boolean, enabled: boolean) => {
    const state = accept(await deps.activity!(requestedActive, enabled))
    if (state.mouseEnabled !== (requestedActive && enabled)) throw new Error('The native input activity was not applied.')
    nativeActive = requestedActive
    return state
  }
  const ensureStarted = async () => {
    if (nativeState) return
    const requested = deps.readSetting()
    if (deps.activity) {
      const state = await applyActivity(active, requested)
      confirm({ ...state, mouseEnabled: requested })
    } else {
      confirm(accept(await deps.start(requested)))
      nativeActive = true
    }
  }
  const reconcile = async () => {
    if (!nativeState) return
    if (deps.activity) {
      const needsUpdate = () => nativeActive !== active || nativeState?.mouseEnabled !== (active && confirmed === true)
      while (needsUpdate()) {
        await applyActivity(active, confirmed === true)
      }
      return
    }
    const enabled = active && confirmed === true
    if (nativeState.mouseEnabled !== enabled) {
      await configure(enabled)
      // Activity may have changed while the native command was pending.
      if (nativeState.mouseEnabled !== (active && confirmed === true)) await reconcile()
    }
  }
  const status = (): DeviceInputState => {
    if (!nativeState || confirmed === undefined) throw new Error('Input listening is unavailable.')
    return { mouseEnabled: confirmed, mouseGeneration: nativeState.mouseGeneration }
  }

  return {
    generation: () => generation,
    status,
    accepts(event: SemanticInputEvent) {
      if (disposed || !active || !nativeActive || !nativeState) return false
      return event.kind === 'typing' || (mouseActive() && isCurrentSemanticInput(event, nativeState))
    },
    start: () => enqueue(async () => {
      await ensureStarted()
      await reconcile()
      return status()
    }),
    request: (enabled?: boolean) => enqueue(async () => {
      if (enabled === undefined && nativeState) return status()
      await ensureStarted()
      if (enabled !== undefined) confirm(await configure(enabled))
      await reconcile()
      return status()
    }, enabled !== undefined || !nativeState),
    // Managed preset application must retry an earlier failed resume/suspend,
    // even when the requested activity flag has already changed in memory.
    setActive(value: boolean, confirmNative = false): Promise<void> {
      if (disposed) return confirmNative ? Promise.reject(new Error('The input session has ended.')) : Promise.resolve()
      if (value === active && !confirmNative) return Promise.resolve()
      active = value
      invalidate()
      if (!nativeState && !confirmNative) return Promise.resolve()
      return enqueue(async () => {
        if (confirmNative) await ensureStarted()
        await reconcile()
        if (confirmNative && (active !== value || nativeState?.mouseEnabled !== (value && confirmed === true))) {
          throw new Error('The native input activity was not applied.')
        }
      })
    },
    dispose(): Promise<void> {
      if (disposed) return tail.then(() => undefined)
      disposed = true
      active = false
      invalidate()
      const stopped = tail.then(() => deps.stop()).then(() => undefined)
      tail = stopped.catch(() => undefined)
      return stopped
    },
  }
}

export function useDevice(options: { onMouseReset?: () => void } = {}) {
  const nativeOwner = Symbol('main-input-session')
  let nativeClaimed = false
  const appWindow = getCurrentWebviewWindow()
  const appStore = useAppStore()
  const catStore = useCatStore()
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let cursorFrameId: number | undefined
  let latestCursorPoint: (CursorPoint & { mouseGeneration?: number }) | undefined
  let pointerSequence = 0
  let disposed = false
  let wasInWindow = false
  let stopInputListener: (() => void) | undefined
  let listenerRegistration: Promise<void> | undefined

  const reportCursorEventsFailure = () => {
    if (!disposed) console.warn('Failed to apply hover click-through.')
  }

  const clearHideTimer = () => {
    if (!hideTimer) return

    clearTimeout(hideTimer)
    hideTimer = undefined
  }

  const restoreHoverState = () => {
    clearHideTimer()
    document.body.style.setProperty('opacity', 'unset')
    void appWindow.setIgnoreCursorEvents(catStore.window.passThrough).catch(reportCursorEventsFailure)
    wasInWindow = false
  }

  const handleHoverPosition = (x: number, y: number) => {
    if (!catStore.window.hideOnHover || catStore.window.passThrough) return

    const { x: winX, y: winY, width, height } = appStore.windowState[WINDOW_LABEL.MAIN] ?? {}

    if (isNil(winX) || isNil(winY) || isNil(width) || isNil(height)) return

    const isInWindow = inBetween(x, winX, winX + width)
      && inBetween(y, winY, winY + height)

    if (isInWindow === wasInWindow) return

    clearHideTimer()

    if (isInWindow) {
      hideTimer = setTimeout(() => {
        if (disposed || !latestCursorPoint || !session.accepts({ kind: 'pointer_activity', ...latestCursorPoint })) return
        document.body.style.setProperty('opacity', '0')
        void appWindow.setIgnoreCursorEvents(true).catch(reportCursorEventsFailure)
      }, catStore.window.hideOnHoverDelay * 1000)
    } else {
      document.body.style.setProperty('opacity', 'unset')
      void appWindow.setIgnoreCursorEvents(catStore.window.passThrough).catch(reportCursorEventsFailure)
    }

    wasInWindow = isInWindow
  }

  const session = createDeviceInputSession({
    readSetting: () => catStore.activePet3dPreset.mouseEnabled,
    start: async (enabled) => {
      await listenerRegistration
      if (disposed) throw new Error('The input session has ended.')
      return runNativeCommand(() => {
        if (disposed) throw new Error('The input session has ended.')
        nativeSessionOwner = nativeOwner
        nativeClaimed = true
        return invoke(INVOKE_KEY.START_DEVICE_LISTENING, { mouseEnabled: enabled })
      })
    },
    configure: enabled => runNativeCommand(() => {
      if (disposed || nativeSessionOwner !== nativeOwner) throw new Error('The input session has ended.')
      return invoke(INVOKE_KEY.SET_DEVICE_MOUSE_ENABLED, { enabled })
    }),
    activity: async (active, mouseEnabled) => {
      await listenerRegistration
      return runNativeCommand(async () => {
        if (disposed || (nativeClaimed && nativeSessionOwner !== nativeOwner)) throw new Error('The input session has ended.')
        nativeSessionOwner = nativeOwner
        nativeClaimed = true
        return invoke(INVOKE_KEY.SET_DEVICE_INPUT_ACTIVE, { active, mouseEnabled })
      })
    },
    stop: () => runNativeCommand(async () => {
      // A retired component must never stop a replacement component's hooks.
      if (nativeSessionOwner !== nativeOwner) return
      await invoke(INVOKE_KEY.STOP_DEVICE_LISTENING)
      nativeSessionOwner = undefined
    }),
    onConfirmed: (enabled) => {
      catStore.activePet3dPreset.mouseEnabled = enabled
      three3d.setMouseEnabled(enabled)
    },
    onGate: (enabled) => {
      if (disposed) return
      three3d.setMouseInputActive(enabled)
      if (enabled) return
      pointerSequence += 1
      latestCursorPoint = undefined
      if (cursorFrameId !== undefined) cancelAnimationFrame(cursorFrameId)
      cursorFrameId = undefined
      restoreHoverState()
      options.onMouseReset?.()
    },
  })

  watch(
    [() => catStore.window.hideOnHover, () => catStore.window.passThrough],
    ([hideOnHover, passThrough]) => {
      if (!hideOnHover || passThrough) restoreHoverState()
    },
  )

  const registerListeners = async () => {
    const stop = await listen<unknown>(LISTEN_KEY.SEMANTIC_INPUT, ({ payload }) => {
      if (!isSemanticInputEvent(payload) || !session.accepts(payload)) return
      if (payload.kind === 'pointer_activity') {
        latestCursorPoint = payload
        pointerSequence += 1
        handleHoverPosition(payload.x, payload.y)
        scheduleMousePositionUpdate()
        return
      }
      three3d.handleSemanticInput(payload)
    })
    if (disposed) stop()
    else stopInputListener = stop
  }

  onMounted(() => {
    listenerRegistration = registerListeners()
    void listenerRegistration.catch(error => console.error('Failed to subscribe to global input.', error))
    return listenerRegistration
  })

  const updateMousePosition = async () => {
    const cursorPoint = latestCursorPoint
    if (!cursorPoint || !session.accepts({ kind: 'pointer_activity', ...cursorPoint })) return
    const generation = session.generation()
    const sequence = pointerSequence

    const monitor = await getCursorMonitor(new PhysicalPosition(cursorPoint.x, cursorPoint.y))
    if (!monitor || generation !== session.generation() || sequence !== pointerSequence
      || !session.accepts({ kind: 'pointer_activity', ...cursorPoint })) {
      return
    }

    const xRatio = (cursorPoint.x - monitor.position.x) / monitor.size.width
    const yRatio = (cursorPoint.y - monitor.position.y) / monitor.size.height

    three3d.handleSemanticInput({
      kind: 'pointer_activity',
      x: Math.min(1, Math.max(0, xRatio)),
      y: Math.min(1, Math.max(0, yRatio)),
      mouseGeneration: cursorPoint.mouseGeneration,
    })
  }

  const scheduleMousePositionUpdate = () => {
    if (cursorFrameId !== undefined) return

    cursorFrameId = requestAnimationFrame(() => {
      cursorFrameId = undefined
      void updateMousePosition().catch(() => {
        if (!disposed) console.warn('Failed to resolve the pointer monitor.')
      })
    })
  }

  onUnmounted(() => {
    disposed = true
    three3d.setInputActive(false)
    restoreHoverState()
    stopInputListener?.()
    void session.dispose().catch(error => console.error('Failed to stop global input.', error))

    if (cursorFrameId !== undefined) {
      cancelAnimationFrame(cursorFrameId)
      cursorFrameId = undefined
    }
  })

  return {
    acceptsInput: session.accepts,
    getInputState: session.status,
    requestMouseSetting: session.request,
    setInputActive: (active: boolean, confirmNative = false) => {
      if (disposed) return confirmNative ? Promise.reject(new Error('The input session has ended.')) : Promise.resolve()
      three3d.setInputActive(active)
      return session.setActive(active, confirmNative)
    },
    startListening: async () => {
      await session.start()
    },
  }
}
