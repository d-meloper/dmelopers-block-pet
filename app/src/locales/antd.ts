import { antdLocales } from 'virtual:block-pet-locales'

import { FALLBACK_LOCALE } from './registry'

export function getAntdLocale(language: string = FALLBACK_LOCALE) {
  return antdLocales[language] ?? antdLocales[FALLBACK_LOCALE]
}
