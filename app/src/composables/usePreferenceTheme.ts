import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { onBeforeUnmount, onMounted, watch } from 'vue'

import { useGeneralStore } from '@/stores/general'
import { createLatestAsyncTaskQueue } from '@/utils/latestAsyncTask'

/** Keep native appearance and CSS alive while individual settings tabs unmount. */
export function usePreferenceTheme() {
  const store = useGeneralStore()
  const appWindow = getCurrentWebviewWindow()
  let disposed = false
  let generation = 0
  let unlisten: (() => void) | undefined

  const appearanceQueue = createLatestAsyncTaskQueue<{
    request: number
    nativeTheme?: 'light' | 'dark' | null
    observed?: 'light' | 'dark'
  }>(async ({ request, nativeTheme, observed }) => {
    const current = () => !disposed && request === generation
    if (!current()) return
    if (nativeTheme !== undefined) await appWindow.setTheme(nativeTheme)
    if (!current()) return
    const nextTheme = observed ?? nativeTheme ?? await appWindow.theme()
    if (!current()) return
    const dark = nextTheme === 'dark'
    store.appearance.isDark = dark
    await invoke('plugin:custom-window|set_preference_caption_color', { dark })
  }, {
    // A late OS event must not replace a queued request to restore native auto mode.
    mergePending: (pending, incoming) => incoming.nativeTheme === undefined && pending.nativeTheme !== undefined
      ? { ...incoming, nativeTheme: pending.nativeTheme, observed: undefined }
      : incoming,
    onError: (error) => {
      if (!disposed) console.error('Failed to apply the preference theme.', error)
    },
  })

  watch(() => store.appearance.theme, (value) => {
    appearanceQueue.enqueue({ request: ++generation, nativeTheme: value === 'auto' ? null : value })
  }, { immediate: true })

  watch(() => store.appearance.isDark, (value) => {
    document.documentElement.classList.toggle('dark', value)
  }, { immediate: true })

  onMounted(async () => {
    try {
      const release = await appWindow.onThemeChanged(({ payload }) => {
        if (disposed || store.appearance.theme !== 'auto') return
        appearanceQueue.enqueue({ request: ++generation, observed: payload })
      })
      if (disposed) release()
      else unlisten = release
    } catch (error) {
      console.error('Failed to observe the system theme.', error)
    }
  })

  onBeforeUnmount(() => {
    disposed = true
    generation++
    appearanceQueue.clear()
    unlisten?.()
  })
}
