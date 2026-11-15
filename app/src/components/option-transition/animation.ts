const DURATION_MS = 220
const axes = {
  height: ['height', 'opacity', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom'],
  width: ['width', 'opacity', 'paddingLeft', 'paddingRight', 'marginLeft', 'marginRight'],
  opacity: ['opacity'],
} as const
export type OptionTransitionAxis = keyof typeof axes
type Frame = Partial<Record<(typeof axes)[OptionTransitionAxis][number], string>>
interface State {
  axis: OptionTransitionAxis
  animation?: Animation
  interrupted?: Frame
  overflow: string
  boxSizing: string
  inert: boolean
}
const states = new WeakMap<HTMLElement, State>()

function frame(element: HTMLElement, axis: OptionTransitionAxis): Frame {
  const computed = getComputedStyle(element)
  return Object.fromEntries(axes[axis].map(key => [key, computed[key]])) as Frame
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
  state.interrupted = frame(element, state.axis)
  state.animation.onfinish = null
  state.animation.cancel()
  state.animation = undefined
  restore(element, state)
}

function begin(element: HTMLElement, axis: OptionTransitionAxis): State {
  cancelOptionTransition(element)
  const state: State = states.get(element) ?? {
    axis,
    overflow: element.style.overflow,
    boxSizing: element.style.boxSizing,
    inert: element.inert,
  }
  if (state.axis !== axis) state.interrupted = undefined
  state.axis = axis
  states.set(element, state)
  return state
}

function play(element: HTMLElement, state: State, from: Frame, to: Frame, done: () => void) {
  if (!element.animate) {
    restore(element, state)
    states.delete(element)
    done()
    return
  }
  element.style.overflow = 'hidden'
  const animation = element.animate([from, to], {
    duration: DURATION_MS,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    fill: 'both',
  })
  state.animation = animation
  animation.onfinish = () => {
    if (state.animation !== animation) return
    state.animation = undefined
    animation.cancel()
    restore(element, state)
    states.delete(element)
    done()
  }
}

export function animateOptionTransition(element: Element, showing: boolean, done: () => void, axis: OptionTransitionAxis = 'height') {
  if (!(element instanceof HTMLElement)) return done()
  const state = begin(element, axis)
  if (!showing && element.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur()
  element.inert = !showing || state.inert
  element.style.boxSizing = 'border-box'
  const expanded = frame(element, axis)
  const collapsed = Object.fromEntries(axes[axis].map(key => [key, '0'])) as Frame
  const from = state.interrupted ?? (showing ? collapsed : expanded)
  state.interrupted = undefined
  play(element, state, from, showing ? expanded : collapsed, done)
}

/** One container owns the height while its mounted variants crossfade. */
export function animateOptionResize(element: Element, from: number, to: number, done: () => void = () => {}) {
  if (!(element instanceof HTMLElement)) return done()
  const state = begin(element, 'height')
  state.interrupted = undefined
  element.style.boxSizing = 'border-box'
  // Even equal endpoints must retain the height until the outgoing variant fades.
  play(element, state, { height: `${from}px` }, { height: `${to}px` }, done)
}
