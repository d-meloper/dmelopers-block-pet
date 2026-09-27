import { LANGUAGE } from '@/constants'

export function isKoreanLanguage(locale: string): boolean {
  return locale === LANGUAGE.KO_KR
}

export function selectByLanguage<T>(locale: string, korean: T, other: T): T {
  return isKoreanLanguage(locale) ? korean : other
}
