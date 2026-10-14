import { DEFAULT_GENERAL_SETTINGS } from '@/config/defaultSettings'

export interface ForegroundHidingSettings {
  enabled: boolean
  applications: string[]
}

export const MAX_FOREGROUND_HIDING_RULES = 128

export function isForegroundApplicationPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32767 || !/\.exe$/i.test(value)) return false
  if (/[<>"|?*/]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32)) return false
  const drive = /^[a-z]:\\/i.test(value)
  const unc = value.startsWith('\\\\')
  if (!drive && !unc) return false
  const segments = value.slice(drive ? 3 : 2).split('\\')
  if (segments.length < (unc ? 3 : 1)) return false
  return segments.every(segment => !!segment && !segment.includes(':') && !/[. ]$/.test(segment))
}

export function isForegroundHidingSettings(value: unknown): value is ForegroundHidingSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const settings = value as Partial<ForegroundHidingSettings>
  return typeof settings.enabled === 'boolean'
    && Array.isArray(settings.applications) && settings.applications.length <= MAX_FOREGROUND_HIDING_RULES
    && settings.applications.every(isForegroundApplicationPath)
}

/** Reset only known fields, preserving unknown extensions without sharing arrays. */
export function createForegroundHidingSettings(previous?: unknown): ForegroundHidingSettings {
  return {
    ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
    ...DEFAULT_GENERAL_SETTINGS.app.foregroundHiding,
    applications: [...DEFAULT_GENERAL_SETTINGS.app.foregroundHiding.applications],
  }
}
