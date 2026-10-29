import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { getRuntimeLocaleDirection } from '@/locales'
import { formatLocaleDateTime, formatLocaleNumber } from '@/locales/formatting'

/** Effective presentation state, including isolated development previews. */
export function useAppLocale() {
  const { locale } = useI18n()
  const language = computed(() => locale.value)
  const direction = computed(() => getRuntimeLocaleDirection(language.value))
  const formatNumber = (value: number, options?: Intl.NumberFormatOptions) => formatLocaleNumber(language.value, value, options)
  const formatDateTime = (value: Date | number, options?: Intl.DateTimeFormatOptions) => formatLocaleDateTime(language.value, value, options)
  return { language, direction, formatNumber, formatDateTime }
}
