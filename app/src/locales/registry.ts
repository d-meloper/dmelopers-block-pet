import data from './registry.json'

export type Language = keyof typeof data.locales
export type LocaleDirection = 'ltr' | 'rtl'
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

export interface LocaleDefinition {
  nativeName: string
  direction: LocaleDirection
  status: 'draft' | 'ready'
  matches: readonly string[]
  antdLocale: string
  pluralCategories: readonly PluralCategory[]
}

export interface LocaleRegistry {
  version: number
  sourceLocale: string
  fallbackLocale: string
  locales: Record<string, LocaleDefinition>
}

export const localeRegistry = data as LocaleRegistry
export const SOURCE_LOCALE = data.sourceLocale as Language
export const FALLBACK_LOCALE = data.fallbackLocale as Language

/** Stored choices are exact public IDs; aliases belong only to OS observations. */
export function isPublicLanguage(value: unknown): value is Language {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(localeRegistry.locales, value)
    && localeRegistry.locales[value].status === 'ready'
}

export function getPublicLanguageOptions(): Array<{ value: Language, label: string }> {
  return Object.entries(localeRegistry.locales)
    .filter(([, definition]) => definition.status === 'ready')
    .map(([value, definition]) => ({ value: value as Language, label: definition.nativeName }))
}

export function getLocaleDirection(locale: string): LocaleDirection {
  return Object.prototype.hasOwnProperty.call(localeRegistry.locales, locale) ? localeRegistry.locales[locale].direction : 'ltr'
}

function normalizeObservation(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 85 || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(value)) return undefined
  return value.toLowerCase()
}

/** No inferred territory/script fallback: only source-owned, explicit rules. */
export function resolveSystemLocale(value: unknown, registry: LocaleRegistry = localeRegistry): string {
  const observed = normalizeObservation(value)
  if (!observed) return registry.fallbackLocale
  const ready = Object.entries(registry.locales).filter(([, definition]) => definition.status === 'ready')
  const exact = ready.find(([code]) => code.toLowerCase() === observed)
  if (exact) return exact[0]
  for (const [code, definition] of ready) {
    if (definition.matches.some((rule) => {
      const normalized = rule.toLowerCase()
      return normalized.endsWith('-*')
        ? observed.startsWith(normalized.slice(0, -1))
        : observed === normalized
    })) {
      return code
    }
  }
  return registry.fallbackLocale
}
