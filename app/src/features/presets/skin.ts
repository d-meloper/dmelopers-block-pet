import { BUILTIN_DMELOPER_SKIN } from '@/config/skinIdentity'
import { resolveDmeloperSkinUrl } from '@/services/dmeloperSkin'
import { listSkinLibraryEntries, SkinLibraryError, storeSkinLibraryEntry } from '@/services/skinLibrary'
import { createSkinFaceThumbnailPngBase64 } from '@/utils/skinThumbnail'
import { decodeVoxelSkin } from '@/utils/three3d/voxelSkin'

import type { PresetSnapshot } from './types'

import { clonePreset } from './model'

function isOptionalLibraryFailure(cause: unknown): cause is SkinLibraryError {
  return cause instanceof SkinLibraryError && ['STORAGE_UNAVAILABLE', 'IO_ERROR'].includes(cause.code)
}

async function isLegacyBundledSkin(snapshot: PresetSnapshot, entryId: string, blob: Blob): Promise<boolean> {
  if (snapshot.appearance.minecraftSkinUsername) return false
  try {
    // Released materialization used the PNG digest when no selection ID existed.
    // Native local/Java IDs hash their own namespace and filename/username. A
    // removed user entry must keep that identity even when its PNG is bundled.
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    const pngSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (entryId !== pngSha256) return false
    if (snapshot.appearance.dmeloperSkinDataUrl !== await resolveDmeloperSkinUrl()) return false
    // A user import with identical pixels keeps its own editable library identity.
    const entries = await listSkinLibraryEntries()
    return !entries.some(entry => entry.id === entryId)
  } catch (error) {
    if (error instanceof SkinLibraryError && !isOptionalLibraryFailure(error)) throw error
    // Optional resource/catalog reads cannot discard a validated saved skin.
    console.warn('The bundled preset skin identity could not be verified.', error)
    return false
  }
}

async function prepareSkin(snapshot: PresetSnapshot, preserveUserIdentity = false) {
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
  if (!bundled && !preserveUserIdentity && await isLegacyBundledSkin(next, next.appearance.activeSkinLibraryEntryId, blob)) {
    next.appearance.activeSkinLibraryEntryId = BUILTIN_DMELOPER_SKIN.id
  }
  // Decoding validates bytes and resolves compatible geometry; appearance belongs to the preset.
  next.appearance.dmeloperSkinModel = decoded.model
  return { snapshot: next, blob, decoded }
}

/** Pure materialization for previews, saving and rollback; never writes the library. */
export async function preparePresetSkin(snapshot: PresetSnapshot): Promise<PresetSnapshot> {
  return (await prepareSkin(snapshot)).snapshot
}

/** Explicit application alone can restore a removed user skin from retained PNG bytes. */
export async function restorePresetSkin(
  snapshot: PresetSnapshot,
  name: string,
  onUnavailable?: (cause: SkinLibraryError) => void,
): Promise<PresetSnapshot> {
  const prepared = await prepareSkin(snapshot, true)
  if (prepared.snapshot.appearance.activeSkinLibraryEntryId === BUILTIN_DMELOPER_SKIN.id) return prepared.snapshot
  try {
    return await restorePreparedSkin(prepared, name)
  } catch (cause) {
    if (!onUnavailable || !isOptionalLibraryFailure(cause)) throw cause
    // Application can use the validated embedded PNG without claiming a library
    // acknowledgement. Preserve its identity and let the caller report the gap.
    onUnavailable(cause)
    return prepared.snapshot
  }
}

async function restorePreparedSkin(prepared: Awaited<ReturnType<typeof prepareSkin>>, name: string): Promise<PresetSnapshot> {
  const next = prepared.snapshot
  const digest = await crypto.subtle.digest('SHA-256', await prepared.blob.arrayBuffer())
  const pngSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  const entries = await listSkinLibraryEntries()
  const existing = entries.find(entry => entry.id === next.appearance.activeSkinLibraryEntryId && entry.pngSha256 === pngSha256)
    ?? entries.find(entry => entry.pngSha256 === pngSha256)
  if (existing) {
    next.appearance.activeSkinLibraryEntryId = existing.id
    return next
  }

  try {
    const stored = await storeSkinLibraryEntry({
      source: 'local',
      displayName: name,
      originalFilename: `preset-${pngSha256}.png`,
      model: prepared.decoded.model,
      pngBase64: next.appearance.dmeloperSkinDataUrl!.slice('data:image/png;base64,'.length),
      thumbnailPngBase64: await createSkinFaceThumbnailPngBase64(prepared.decoded),
      overwriteExisting: false,
    })
    if (stored.pngSha256 !== pngSha256) throw new SkinLibraryError('INVALID_RESPONSE')
    next.appearance.activeSkinLibraryEntryId = stored.id
  } catch (cause) {
    if (!(cause instanceof SkinLibraryError) || cause.code !== 'ENTRY_ALREADY_EXISTS') throw cause
    // A concurrent/previous acknowledged write may already own these exact bytes.
    const stored = (await listSkinLibraryEntries()).find(entry => entry.pngSha256 === pngSha256)
    if (!stored) throw cause
    next.appearance.activeSkinLibraryEntryId = stored.id
  }
  return next
}
