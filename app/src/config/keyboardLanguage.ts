export type KeyboardLanguageSelection = 'ko' | 'en' | 'system'
export type ResolvedKeyboardLanguage = 'ko' | 'en'

export interface SystemKeyboardLanguageStatus {
  revision: number
  language: ResolvedKeyboardLanguage
}

export function resolveKeyboardLanguage(selection: KeyboardLanguageSelection, system: ResolvedKeyboardLanguage = 'ko'): ResolvedKeyboardLanguage {
  return selection === 'system' ? system : selection
}

export function isSystemKeyboardLanguageStatus(value: unknown): value is SystemKeyboardLanguageStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as SystemKeyboardLanguageStatus
  return Number.isSafeInteger(status.revision) && status.revision >= 0
    && (status.language === 'ko' || status.language === 'en')
}
