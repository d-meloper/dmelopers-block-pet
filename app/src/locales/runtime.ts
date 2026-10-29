import { createI18n } from 'vue-i18n'

import { createPluralRules } from './formatting'
import { FALLBACK_LOCALE } from './registry'

export interface MessageCatalog {
  [key: string]: string | MessageCatalog
}

export function createLocaleRuntime(messages: Record<string, MessageCatalog>) {
  // An explicit decision for every loaded ID avoids accidental territory fallback.
  const fallbackLocale: Record<string, string[]> = { default: [FALLBACK_LOCALE] }
  for (const locale of Object.keys(messages)) fallbackLocale[locale] = locale === FALLBACK_LOCALE ? [] : [FALLBACK_LOCALE]
  return createI18n({
    legacy: false,
    locale: FALLBACK_LOCALE as string,
    fallbackLocale,
    messages,
    pluralRules: createPluralRules(),
  })
}
