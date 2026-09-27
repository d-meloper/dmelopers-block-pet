import { listen } from '@tauri-apps/api/event'
import { noop } from '@vueuse/core'
import { onMounted, onUnmounted, ref } from 'vue'

export function useTauriListen<T>(...args: Parameters<typeof listen<T>>) {
  const unlisten = ref(noop)
  let disposed = false

  onMounted(async () => {
    const release = await listen<T>(...args)
    if (disposed) release()
    else unlisten.value = release
  })

  onUnmounted(() => {
    disposed = true
    unlisten.value()
  })
}
