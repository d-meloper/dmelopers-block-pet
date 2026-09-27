// The bundled skin has a selection identity independent of its saved PNG bytes.
export const BUILTIN_DMELOPER_SKIN = {
  id: 'builtin:dmeloper',
  source: 'builtin',
  model: 'wide',
} as const

export const DEFAULT_DMELOPER_SKIN_PROFILE_ID = 'default'

export function isSkinSelectionId(value: unknown): value is string {
  return typeof value === 'string'
    && (value === BUILTIN_DMELOPER_SKIN.id || /^[0-9a-f]{64}$/.test(value))
}

export function getSkinSelectionId(selection: {
  activeSkinLibraryEntryId?: string
  dmeloperSkinDataUrl?: string
}): string | undefined {
  return selection.dmeloperSkinDataUrl
    ? selection.activeSkinLibraryEntryId
    : BUILTIN_DMELOPER_SKIN.id
}
