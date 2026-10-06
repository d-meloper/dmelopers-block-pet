import type { ObjectDirective } from 'vue'

const paneSelector = ':scope > .ant-tabs-content-holder > .ant-tabs-content > .ant-tabs-tabpane'
const optionSelector = '[data-detail-height-option]'
const variantAttribute = 'data-detail-height-variant'
const disposers = new WeakMap<HTMLElement, () => void>()

// DOM-only copies preserve real widths/theme/wrapping without duplicate Vue owners
// or temporarily changing a persisted setting just to measure its expanded rows.
export function reserveDetailHeight(root: HTMLElement): () => void {
  // ProList places Tabs and its reset button together in this vertical group.
  // Reserve space after both; never stretch the pane above its reset button.
  const group = root.parentElement!
  const originalMinHeight = group.style.minHeight
  let frame = 0
  let lastWidth = 0
  let disposed = false

  function measure() {
    frame = 0
    const width = group.getBoundingClientRect().width
    if (!root.isConnected || !width) return
    const copy = group.cloneNode(true) as HTMLElement
    copy.inert = true
    copy.setAttribute('aria-hidden', 'true')
    Object.assign(copy.style, { position: 'fixed', left: '0', top: '0', width: `${width}px`, height: 'auto', minHeight: '0', visibility: 'hidden', pointerEvents: 'none' })
    for (const element of copy.querySelectorAll('[id]')) element.removeAttribute('id')
    for (const option of copy.querySelectorAll<HTMLElement>(optionSelector)) {
      option.style.removeProperty('display')
    }
    group.after(copy)
    try {
      let height = 0
      const tabs = copy.querySelector<HTMLElement>(':scope > .preference-detail-tabs')!
      const panes = [...tabs.querySelectorAll<HTMLElement>(paneSelector)]
      for (const pane of panes) pane.style.display = 'none'
      for (const pane of panes) {
        pane.style.display = 'block'
        pane.style.height = 'auto'
        const branches = [...pane.querySelectorAll<HTMLElement>(`[${variantAttribute}]`)]
        const variants = new Set(branches.map(element => element.getAttribute(variantAttribute)))
        for (const variant of variants.size ? variants : [null]) {
          for (const branch of branches) {
            branch.style.display = branch.getAttribute(variantAttribute) === variant ? '' : 'none'
          }
          height = Math.max(height, copy.getBoundingClientRect().height)
        }
        pane.style.display = 'none'
      }
      group.style.minHeight = `${Math.ceil(height)}px`
    } finally {
      copy.remove()
    }
  }

  function schedule() {
    if (!disposed && !frame) frame = requestAnimationFrame(measure)
  }

  // Tab selection and slider/switch styles do not affect the fully expanded
  // maximum. Observe only available rows/text and width, not animation frames.
  const mutations = new MutationObserver(schedule)
  mutations.observe(root, { childList: true, characterData: true, subtree: true })
  const resize = new ResizeObserver(() => {
    const width = group.getBoundingClientRect().width
    if (width === lastWidth) return
    lastWidth = width
    schedule()
  })
  resize.observe(group)
  document.fonts.addEventListener('loadingdone', schedule)
  schedule()

  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    mutations.disconnect()
    resize.disconnect()
    document.fonts.removeEventListener('loadingdone', schedule)
    group.style.minHeight = originalMinHeight
  }
}

export const vStableDetailHeight: ObjectDirective<HTMLElement> = {
  mounted(root) {
    disposers.set(root, reserveDetailHeight(root))
  },
  beforeUnmount(root) {
    disposers.get(root)?.()
    disposers.delete(root)
  },
}
