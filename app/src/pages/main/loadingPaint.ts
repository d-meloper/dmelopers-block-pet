/** Give a DOM loading state a paint opportunity before blocking asset work. */
export function createLoadingPaintBarrier() {
  let pending: { promise: Promise<void>, finish: () => void } | undefined
  function wait(): Promise<void> {
    if (pending) return pending.promise
    if (document.hidden) return Promise.resolve()
    let frame: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      if (frame !== undefined) cancelAnimationFrame(frame)
      clearTimeout(timer)
      if (pending?.promise === promise) pending = undefined
      resolve()
    }
    pending = { promise, finish }
    // RAF callbacks precede paint. Resuming from the first callback's microtask
    // can still block that paint; the second callback permits a paint in between.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(finish)
    })
    // Hidden/minimized webviews may suspend RAF. A save/drain must still finish.
    timer = setTimeout(finish, 150)
    return promise
  }
  return { wait, cancel: () => pending?.finish() }
}
