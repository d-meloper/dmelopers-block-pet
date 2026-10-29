import type { LocaleRegistry } from './registry'

import { FALLBACK_LOCALE, localeRegistry } from './registry'

function intlLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? FALLBACK_LOCALE
  } catch {
    return FALLBACK_LOCALE
  }
}

/** Display-only formatting; callers retain numeric inputs and stored values. */
export function formatLocaleNumber(locale: string, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value)
}

export function formatLocaleDateTime(locale: string, value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlLocale(locale), options).format(value)
}

export function createPluralRules(registry: LocaleRegistry = localeRegistry) {
  return Object.fromEntries(Object.entries(registry.locales).map(([locale, definition]) => [
    locale,
    (choice: number, choicesLength: number) => {
      if (choicesLength <= 1) return 0
      const category = new Intl.PluralRules(intlLocale(locale)).select(choice)
      const index = definition.pluralCategories.indexOf(category)
      const other = definition.pluralCategories.indexOf('other')
      return Math.min(choicesLength - 1, index >= 0 ? index : Math.max(0, other))
    },
  ]))
}
