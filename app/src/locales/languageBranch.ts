import { LANGUAGE } from '@/constants'

export type Language = typeof LANGUAGE[keyof typeof LANGUAGE]
export type LanguagePreference = 'system' | Language

export function isLanguage(value: unknown): value is Language {
  return value === LANGUAGE.KO_KR || value === LANGUAGE.EN_US
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || isLanguage(value)
}

export function resolveLanguage(preference: LanguagePreference | undefined, systemLanguage: Language): Language {
  return isLanguage(preference) ? preference : systemLanguage
}

export function isKoreanLanguage(locale: string): boolean {
  return locale === LANGUAGE.KO_KR
}

export function selectByLanguage<T>(locale: string, korean: T, other: T): T {
  return isKoreanLanguage(locale) ? korean : other
}
