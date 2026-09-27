import { getVersion } from '@tauri-apps/api/app'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import type { WindowState } from '@/composables/useWindowState'

import { APP_DISPLAY_NAME } from '@/constants'

export const useAppStore = defineStore('app', () => {
  const name = ref('')
  const version = ref('')
  const windowState = reactive<WindowState>({})

  const init = async () => {
    name.value = APP_DISPLAY_NAME
    version.value = await getVersion()
  }

  const resetWindowState = () => {
    for (const key of Object.keys(windowState)) delete windowState[key]
  }

  return {
    name,
    version,
    windowState,
    init,
    resetWindowState,
  }
})
