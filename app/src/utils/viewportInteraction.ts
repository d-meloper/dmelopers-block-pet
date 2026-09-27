/** Retain outside-window release for mouse buttons without native semantic events. */
export function captureViewportPointer(event: PointerEvent): void {
  if (!(event.target instanceof Element)) return
  try {
    event.target.setPointerCapture(event.pointerId)
  } catch {
    // A cancelled/inactive pointer can no longer be captured; cancel/blur cleans it up.
  }
}

/** DOM button masks plus native primary/secondary events (including outside release). */
export function createViewportInteraction(onHeldChange: (held: boolean) => void) {
  const sources = new Map<string, number>()
  let nativeButtons = 0
  let held = false

  const notify = () => {
    const next = nativeButtons !== 0 || [...sources.values()].some(buttons => buttons !== 0)
    if (next === held) return
    held = next
    onHeldChange(held)
  }

  return {
    isHeld: () => held,
    isSourceHeld: (source: string) => (sources.get(source) ?? 0) !== 0,
    setButtons(source: string, buttons: number) {
      if (!Number.isSafeInteger(buttons) || buttons < 0 || buttons > 31) return
      sources.set(source, buttons)
      notify()
    },
    setNativeButton(button: 1 | 2, active: boolean) {
      nativeButtons = active ? nativeButtons | button : nativeButtons & ~button
      if (!active) {
        for (const [source, buttons] of sources) sources.set(source, buttons & ~button)
      }
      notify()
    },
    resetNativeButtons() {
      nativeButtons = 0
      notify()
    },
    cancel(source: string) {
      sources.delete(source)
      notify()
    },
    clear() {
      sources.clear()
      nativeButtons = 0
      notify()
    },
  }
}
