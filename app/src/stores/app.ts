import { getVersion } from '@tauri-apps/api/app'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import type { WindowState } from '@/composables/useWindowState'

import { APP_DISPLAY_NAME } from '@/constants'

/** Pinia deep-merges incoming objects; a complete geometry map also owns deletions. */
export function reconcileAppWindowState(local: Record<string, unknown>, incoming: Record<string, unknown>): void {
  const next = incoming.windowState
  const current = local.windowState
  if (!next || typeof next !== 'object' || Array.isArray(next)
    || !current || typeof current !== 'object' || Array.isArray(current)) {
    return
  }
  for (const key of Object.keys(current)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) delete (current as Record<string, unknown>)[key]
  }
}

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
