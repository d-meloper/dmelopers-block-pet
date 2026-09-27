import type { WebGLRenderer } from 'three'

const releasedCanvases = new WeakMap<HTMLCanvasElement, () => Promise<void>>()

export function createPetLoadCancelledError(): Error {
  const error = new Error('The fixed model load was superseded or cancelled.')
  error.name = 'PetModelLoadCancelledError'
  return error
}

/** Cancel the caller promptly, but also release results of unabortable decoders. */
export function awaitAssetOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLateResult?: (result: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(createPetLoadCancelledError())
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    operation.then((result) => {
      signal.removeEventListener('abort', cancel)
      if (signal.aborted) {
        disposeLateResult?.(result)
        cancel()
      } else {
        resolve(result)
      }
    }, (error: unknown) => {
      signal.removeEventListener('abort', cancel)
      reject(signal.aborted ? createPetLoadCancelledError() : error)
    })
  })
}

/**
 * A canvas owns its context even after WebGLRenderer.dispose(). Keep the loss
 * event restorable after Three removes its listeners, and restore on demand.
 * The weak entry retains no renderer, scene, model, or animation loop.
 */
export function disposeRendererForReuse(
  renderer: WebGLRenderer,
  pendingReadbacks: Promise<unknown> = Promise.resolve(),
  restoreTimeoutMs = 5000,
): void {
  const canvas = renderer.domElement
  const context = renderer.getContext()
  const extension = context.getExtension('WEBGL_lose_context')
  if (!extension) {
    renderer.dispose()
    return
  }

  let lossObserved = context.isContextLost()
  let requested = false
  let recovery: Promise<void> | undefined
  let resolveRecovery: (() => void) | undefined
  let rejectRecovery: ((error: Error) => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let lossEventTimer: ReturnType<typeof setTimeout> | undefined

  const cleanup = () => {
    canvas.removeEventListener('webglcontextlost', onLost)
    canvas.removeEventListener('webglcontextrestored', onRestored)
    clearTimeout(timeout)
    clearTimeout(lossEventTimer)
    if (releasedCanvases.get(canvas) === restore) releasedCanvases.delete(canvas)
  }
  const fail = () => {
    cleanup()
    rejectRecovery?.(new Error('The pet WebGL context could not be restored.'))
  }
  const requestRestore = () => {
    if (!lossObserved || !requested) return
    try {
      extension.restoreContext()
    } catch {
      fail()
    }
  }
  const onLost = (event: Event) => {
    // Without preventDefault the browser need not allow restoration at all.
    event.preventDefault()
    // Chromium decides whether restoration is allowed AFTER event dispatch.
    // Even calling restoreContext inside this handler is too early.
    lossEventTimer = setTimeout(() => {
      lossObserved = true
      requestRestore()
    }, 0)
  }
  const onRestored = () => {
    cleanup()
    resolveRecovery?.()
  }
  const restore = () => {
    recovery ??= new Promise<void>((resolve, reject) => {
      resolveRecovery = resolve
      rejectRecovery = reject
      requested = true
      timeout = setTimeout(fail, restoreTimeoutMs)
      // loseContext is synchronous; its event is not. Restoring before that
      // event is an INVALID_OPERATION, so rapid hide/show must wait for it.
      requestRestore()
    })
    return recovery
  }

  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  releasedCanvases.set(canvas, restore)
  try {
    renderer.dispose()
    // A readback owns raw GL fences/buffers beyond renderer.dispose(). Finish
    // those before losing/restoring the canvas, so none touches a new context.
    void pendingReadbacks.then(() => {
      if (!lossObserved) extension.loseContext()
    }, () => {
      if (!lossObserved) extension.loseContext()
    })
  } catch (error) {
    cleanup()
    throw error
  }
}

export async function restoreRendererCanvas(
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw createPetLoadCancelledError()
  const restore = releasedCanvases.get(canvas)
  if (restore) await awaitAssetOperation(restore(), signal)
  if (signal.aborted) throw createPetLoadCancelledError()
}

/** A replaced canvas will never be reused. Release its context after outstanding reads. */
export function disposeReplacedRenderer(renderer: WebGLRenderer, pendingReadbacks: Promise<unknown>): void {
  try {
    renderer.dispose()
  } catch (error) {
    // A cleanup error cannot undo a successfully displayed replacement.
    console.warn('Failed to dispose the replaced WebGL renderer.', error)
  }
  void pendingReadbacks.finally(() => renderer.forceContextLoss()).catch((error: unknown) => {
    console.warn('Failed to release the replaced WebGL context.', error)
  })
}
