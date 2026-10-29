import { invoke } from '@tauri-apps/api/core'
import { shallowRef } from 'vue'

import type { Language } from '@/locales/languageBranch'

import { LANGUAGE } from '@/constants'
import { FALLBACK_LOCALE, resolveSystemLocale } from '@/locales/registry'

import { reportDiagnostic } from './diagnostics'

// Runtime observation belongs to each webview module, never a persisted Pinia store.
const systemLanguage = shallowRef<Language>(LANGUAGE.EN_US)
let initialization: Promise<void> | undefined

export function getSystemLanguage(): Language {
  return systemLanguage.value
}

/** Normal startup awaits safety first; failure UI may read this without a store. */
export function initializeSystemLanguage(): Promise<void> {
  initialization ??= (async () => {
    try {
      const language = await invoke<unknown>('get_system_ui_locale')
      if (typeof language !== 'string' || language.length > 85 || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(language)) throw new Error('SYSTEM_UI_LANGUAGE_INVALID')
      systemLanguage.value = resolveSystemLocale(language) as Language
    } catch (error) {
      systemLanguage.value = FALLBACK_LOCALE
      reportDiagnostic('warn', 'language.system_ui', error)
    }
  })()
  return initialization
}
