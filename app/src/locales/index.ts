import { createI18n } from 'vue-i18n'

import { LANGUAGE } from '@/constants'

import enUS from './en-US.json'
import koKR from './ko-KR.json'

export const i18n = createI18n({
  legacy: false,
  locale: LANGUAGE.EN_US,
  fallbackLocale: LANGUAGE.EN_US,
  messages: {
    [LANGUAGE.KO_KR]: koKR,
    [LANGUAGE.EN_US]: enUS,
  },
})
