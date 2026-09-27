import type { Locale as AntdLocale } from 'ant-design-vue/es/locale'

import antdEnUS from 'ant-design-vue/locale/en_US'
import antdKoKR from 'ant-design-vue/locale/ko_KR'

import type { Language } from '@/stores/general'

import { LANGUAGE } from '@/constants'

export function getAntdLocale(language: Language = LANGUAGE.EN_US) {
  const antdLanguage: Record<Language, AntdLocale> = {
    [LANGUAGE.KO_KR]: antdKoKR,
    [LANGUAGE.EN_US]: antdEnUS,
  }

  return antdLanguage[language]
}
