import type { UnlistenFn } from '@tauri-apps/api/event'

import { listen } from '@tauri-apps/api/event'
import { onMounted, onUnmounted } from 'vue'

export function useTauriListen<T>(...args: Parameters<typeof listen<T>>) {
  const [eventName, handler, options] = args
  let unlisten: UnlistenFn | undefined
  let disposed = false

  async function releaseListener(release: UnlistenFn): Promise<void> {
    try {
      await release()
    } catch {
      console.warn('Failed to release a native event subscription.')
    }
  }

  onMounted(async () => {
    if (disposed) return
    try {
      const release = await listen<T>(eventName, (event) => {
        // Native removal can fail or lag behind queued delivery during HMR.
        // The retired scope must stop acting before registration/removal replies.
        if (!disposed) return handler(event)
      }, options)
      if (disposed) await releaseListener(release)
      else unlisten = release
    } catch {
      disposed = true
      console.warn('Failed to subscribe to a native event.')
    }
  })

  onUnmounted(() => {
    disposed = true
    const release = unlisten
    unlisten = undefined
    if (release) void releaseListener(release)
  })
}
