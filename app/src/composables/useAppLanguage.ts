import { computed } from 'vue'

import type { Language } from '@/locales/languageBranch'

import { isKoreanLanguage, selectByLanguage } from '@/locales/languageBranch'
import { useGeneralStore } from '@/stores/general'

/** Branch by the effective app language, including the System preference. */
export function useAppLanguage() {
  const general = useGeneralStore()
  const language = computed<Language>(() => general.resolvedLanguage)
  const isKorean = computed(() => isKoreanLanguage(language.value))
  const isGlobal = computed(() => !isKorean.value)
  const select = <T>(korean: T, global: T): T => selectByLanguage(language.value, korean, global)

  return { language, isKorean, isGlobal, select }
}
