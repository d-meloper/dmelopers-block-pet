import type { SystemKeyboardLanguageStatus } from '@/config/keyboardLanguage'

import { isSystemKeyboardLanguageStatus } from '@/config/keyboardLanguage'

/** Subscribe before configuring. Serialize native effects through final teardown. */
export function createSystemKeyboardLanguageObserver(deps: {
  listen: (accept: (value: unknown) => void) => Promise<() => void>
  configure: (enabled: boolean) => Promise<unknown>
  changed: (status: SystemKeyboardLanguageStatus) => void
  failed: () => void
}) {
  let desired = false
  let disposed = false
  let release: (() => void) | undefined
  let revision = -1
  let work = Promise.resolve()
  const accept = (value: unknown) => {
    if (disposed || !isSystemKeyboardLanguageStatus(value) || value.revision <= revision) return
    revision = value.revision
    deps.changed(value)
  }
  const configure = () => {
    work = work.then(async () => {
      if (!release) return
      try {
        accept(await deps.configure(!disposed && desired))
      } catch {
        if (!disposed) deps.failed()
      }
    })
    return work
  }
  return {
    async start() {
      try {
        const unlisten = await deps.listen(accept)
        if (disposed) {
          unlisten()
          return
        }
        release = unlisten
        await configure()
      } catch {
        if (!disposed) deps.failed()
      }
    },
    setEnabled(enabled: boolean) {
      desired = enabled
      if (!disposed && release) void configure()
    },
    async dispose() {
      disposed = true
      // An already issued enable must finish before the final native disable.
      await configure()
      release?.()
      release = undefined
    },
  }
}
