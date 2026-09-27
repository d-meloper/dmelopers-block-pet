import { BUILTIN_DMELOPER_SKIN } from '@/config/skinIdentity'
import { resolveDmeloperSkinUrl } from '@/services/dmeloperSkin'
import { listSkinLibraryEntries } from '@/services/skinLibrary'
import { decodeVoxelSkin } from '@/utils/three3d/voxelSkin'

import type { PresetSnapshot } from './types'

import { clonePreset } from './model'

async function isLegacyBundledSkin(snapshot: PresetSnapshot, entryId: string): Promise<boolean> {
  if (snapshot.appearance.minecraftSkinUsername) return false
  try {
    if (snapshot.appearance.dmeloperSkinDataUrl !== await resolveDmeloperSkinUrl()) return false
    // A user import with identical pixels keeps its own editable library identity.
    const entries = await listSkinLibraryEntries()
    return !entries.some(entry => entry.id === entryId)
  } catch (error) {
    // Resource/catalog failures cannot discard a saved skin. Retry on the next apply.
    console.warn('The bundled preset skin identity could not be verified.', error)
    return false
  }
}

/** Materialize PNG bytes without replacing the bundled skin's selection identity. */
export async function preparePresetSkin(snapshot: PresetSnapshot): Promise<PresetSnapshot> {
  const next = clonePreset(snapshot)
  const bundled = !next.appearance.dmeloperSkinDataUrl || next.appearance.activeSkinLibraryEntryId === BUILTIN_DMELOPER_SKIN.id
  if (!next.appearance.dmeloperSkinDataUrl) {
    next.appearance.dmeloperSkinDataUrl = await resolveDmeloperSkinUrl()
  }
  const response = await fetch(next.appearance.dmeloperSkinDataUrl)
  if (!response.ok) throw new Error('pages.preference.presets.errors.load')
  const blob = await response.blob()
  const decoded = await decodeVoxelSkin(blob, next.appearance.dmeloperSkinModel)
  if (bundled) next.appearance.activeSkinLibraryEntryId = BUILTIN_DMELOPER_SKIN.id
  if (!next.appearance.activeSkinLibraryEntryId) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    next.appearance.activeSkinLibraryEntryId = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  }
  if (!bundled && await isLegacyBundledSkin(next, next.appearance.activeSkinLibraryEntryId)) {
    next.appearance.activeSkinLibraryEntryId = BUILTIN_DMELOPER_SKIN.id
  }
  // Decoding validates bytes and resolves compatible geometry; appearance belongs to the preset.
  next.appearance.dmeloperSkinModel = decoded.model
  return next
}
