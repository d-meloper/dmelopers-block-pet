import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { onBeforeUnmount, onMounted, watch } from 'vue'

import { useGeneralStore } from '@/stores/general'

/** Keep native appearance and CSS alive while individual settings tabs unmount. */
export function usePreferenceTheme() {
  const store = useGeneralStore()
  const appWindow = getCurrentWebviewWindow()
  let disposed = false
  let generation = 0
  let unlisten: (() => void) | undefined

  watch(() => store.appearance.theme, async (value) => {
    const request = ++generation
    try {
      const explicitTheme = value === 'auto' ? null : value
      await appWindow.setTheme(explicitTheme)
      const nextTheme = explicitTheme ?? await appWindow.theme()
      if (!disposed && request === generation) store.appearance.isDark = nextTheme === 'dark'
    } catch (error) {
      console.error('Failed to apply the preference theme.', error)
    }
  }, { immediate: true })

  watch(() => store.appearance.isDark, (value) => {
    document.documentElement.classList.toggle('dark', value)
  }, { immediate: true })

  onMounted(async () => {
    try {
      const release = await appWindow.onThemeChanged(({ payload }) => {
        if (disposed || store.appearance.theme !== 'auto') return
        generation++
        store.appearance.isDark = payload === 'dark'
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
    unlisten?.()
  })
}
