import { LANGUAGE } from '@/constants'

import type { Language } from './registry'

import { isPublicLanguage } from './registry'

export type { Language } from './registry'
export type LanguagePreference = 'system' | Language

export function isLanguage(value: unknown): value is Language {
  return isPublicLanguage(value)
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
