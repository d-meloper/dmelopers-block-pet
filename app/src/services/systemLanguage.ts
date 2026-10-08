import { invoke } from '@tauri-apps/api/core'
import { shallowRef } from 'vue'

import type { Language } from '@/locales/languageBranch'

import { LANGUAGE } from '@/constants'
import { isLanguage } from '@/locales/languageBranch'

import { reportDiagnostic } from './diagnostics'

// Runtime observation belongs to each webview module, never a persisted Pinia store.
const systemLanguage = shallowRef<Language>(LANGUAGE.EN_US)
let initialization: Promise<void> | undefined

export function getSystemLanguage(): Language {
  return systemLanguage.value
}

/** Await after native startup/safety and before creating stores or mounting the UI. */
export function initializeSystemLanguage(): Promise<void> {
  initialization ??= (async () => {
    try {
      const language = await invoke<unknown>('get_system_ui_language')
      if (!isLanguage(language)) throw new Error('SYSTEM_UI_LANGUAGE_INVALID')
      systemLanguage.value = language
    } catch (error) {
      systemLanguage.value = LANGUAGE.EN_US
      reportDiagnostic('warn', 'language.system_ui', error)
    }
  })()
  return initialization
}
