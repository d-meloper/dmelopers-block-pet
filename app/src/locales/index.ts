import { messages, previewLocales } from 'virtual:block-pet-locales'

import { getLocaleDirection } from './registry'
import { createLocaleRuntime } from './runtime'

export const i18n = createLocaleRuntime(messages)

export function getRuntimeLocaleDirection(locale: string) {
  return previewLocales.find(preview => preview.value === locale)?.direction ?? getLocaleDirection(locale)
}
