import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { onMounted, onUnmounted, ref, watch } from 'vue'

import type { KeyboardLanguageSelection, ResolvedKeyboardLanguage } from '@/config/keyboardLanguage'

import { createSystemKeyboardLanguageObserver } from '@/services/systemKeyboardLanguage'

export function useSystemKeyboardLanguage(selection: () => KeyboardLanguageSelection) {
  const language = ref<ResolvedKeyboardLanguage>('ko')
  const owner = crypto.randomUUID()
  const observer = createSystemKeyboardLanguageObserver({
    listen: accept => listen('system-keyboard-language', event => accept(event.payload)),
    configure: enabled => invoke('configure_system_keyboard_language', { enabled, owner }),
    changed: status => language.value = status.language,
    failed: () => console.warn('Failed to observe the system keyboard language.'),
  })
  watch(() => selection() === 'system', enabled => observer.setEnabled(enabled), { immediate: true })
  onMounted(() => void observer.start())
  onUnmounted(() => void observer.dispose())
  return language
}
