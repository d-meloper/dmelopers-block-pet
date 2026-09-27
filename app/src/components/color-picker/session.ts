// Module scope: all eight mounted controls share the same popup owner.
export const activeColorPicker: { close?: () => void } = {}

export interface ScreenColorSessionOptions {
  pick: (id: string) => Promise<unknown>
  cancel: (id: string) => Promise<unknown>
  canApply: () => boolean
  selected: (color: string) => void
  failed: () => void
}

/** Keep native completion bound to the color control and preset that opened it. */
export function createScreenColorSession(options: ScreenColorSessionOptions) {
  let request: string | undefined
  return {
    async start(id: string) {
      if (request || !options.canApply()) return
      request = id
      try {
        const color = await options.pick(id)
        if (request !== id || !options.canApply() || color === null) return
        if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Invalid color')
        options.selected(color.toUpperCase())
      } catch {
        if (request === id && options.canApply()) options.failed()
      } finally {
        if (request === id) request = undefined
      }
    },
    cancel() {
      const id = request
      request = undefined
      if (id) void options.cancel(id).catch(() => {})
    },
  }
}
