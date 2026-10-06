const DURATION_MS = 220
const properties = ['height', 'opacity', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom'] as const
type Frame = Record<typeof properties[number], string>
interface State {
  animation?: Animation
  interrupted?: Frame
  overflow: string
  boxSizing: string
  inert: boolean
}
const states = new WeakMap<HTMLElement, State>()

function frame(element: HTMLElement): Frame {
  const computed = getComputedStyle(element)
  return Object.fromEntries(properties.map(key => [key, computed[key]])) as Frame
}

function restore(element: HTMLElement, state: State) {
  element.style.overflow = state.overflow
  element.style.boxSizing = state.boxSizing
  element.inert = state.inert
}

export function cancelOptionTransition(element: Element) {
  if (!(element instanceof HTMLElement)) return
  const state = states.get(element)
  if (!state?.animation) return
  state.interrupted = frame(element)
  state.animation.onfinish = null
  state.animation.cancel()
  state.animation = undefined
  restore(element, state)
}

export function animateOptionTransition(element: Element, showing: boolean, done: () => void) {
  if (!(element instanceof HTMLElement)) return done()
  cancelOptionTransition(element)
  const state = states.get(element) ?? {
    overflow: element.style.overflow,
    boxSizing: element.style.boxSizing,
    inert: element.inert,
  }
  states.set(element, state)
  if (!showing && element.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur()
  element.inert = !showing || state.inert
  if (!element.animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    restore(element, state)
    states.delete(element)
    done()
    return
  }
  element.style.boxSizing = 'border-box'
  const expanded = frame(element)
  const collapsed = Object.fromEntries(properties.map(key => [key, '0'])) as Frame
  const from = state.interrupted ?? (showing ? collapsed : expanded)
  state.interrupted = undefined
  element.style.overflow = 'hidden'
  const animation = element.animate([from, showing ? expanded : collapsed], {
    duration: DURATION_MS,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    fill: 'both',
  })
  state.animation = animation
  animation.onfinish = () => {
    if (state.animation !== animation) return
    animation.cancel()
    restore(element, state)
    states.delete(element)
    done()
  }
}
