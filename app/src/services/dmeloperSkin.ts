import { convertFileSrc } from '@tauri-apps/api/core'
import { resolveResource } from '@tauri-apps/api/path'

import { BUILTIN_DMELOPER_SKIN } from '@/config/skinIdentity'
import {
  createSkinFaceThumbnailPngBase64,
  createSkinThumbnailDataUrl,
} from '@/utils/skinThumbnail'
import { decodeVoxelSkin } from '@/utils/three3d/voxelSkin'

export const DEFAULT_DMELOPER_SKIN_RESOURCE = 'assets/models/dmeloper/default.png'
export { BUILTIN_DMELOPER_SKIN } from '@/config/skinIdentity'

let defaultSkinUrl: string | undefined
let pendingDefaultSkinUrl: Promise<string> | undefined
let pendingDefaultThumbnailUrl: Promise<string> | undefined

// Available synchronously after resolveDmeloperSkinUrl() reads the bundled PNG.
// Rendering and saved presets share the exact data URL, so autosave cannot turn
// the same default skin into a second asset/viewport change.
export function getResolvedDmeloperSkinUrl(storedDataUrl?: string): string | undefined {
  return storedDataUrl || defaultSkinUrl
}

// Missing skins always use the bundled image, including legacy settings that
// disabled the development-only default. Keep user skins out of this cache.
export function resolveDmeloperSkinUrl(storedDataUrl?: string): Promise<string> {
  const resolved = getResolvedDmeloperSkinUrl(storedDataUrl)
  if (resolved) return Promise.resolve(resolved)
  pendingDefaultSkinUrl ??= resolveResource(DEFAULT_DMELOPER_SKIN_RESOURCE)
    .then(async (path) => {
      const response = await fetch(convertFileSrc(path))
      if (!response.ok) throw new Error('The bundled skin image could not be read.')
      const blob = new Blob([await response.blob()], { type: 'image/png' })
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('The bundled skin image could not be read.'))
        reader.readAsDataURL(blob)
      })
      defaultSkinUrl = dataUrl
      return dataUrl
    })
    .catch((error: unknown) => {
      pendingDefaultSkinUrl = undefined
      throw error
    })
  return pendingDefaultSkinUrl
}

/** Sample the bundled skin only when the user explicitly selects it. */
export async function resolveDefaultDmeloperPalmColor(): Promise<string> {
  const response = await fetch(await resolveDmeloperSkinUrl())
  if (!response.ok) throw new Error('The bundled skin image could not be read.')
  const decoded = await decodeVoxelSkin(await response.blob(), BUILTIN_DMELOPER_SKIN.model)
  return decoded.suggestedPalmColor
}

/** Build the same face/hat preview as imported skins from the bundled PNG only. */
export function resolveDmeloperSkinThumbnailUrl(): Promise<string> {
  pendingDefaultThumbnailUrl ??= resolveDmeloperSkinUrl()
    .then(async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error('The bundled skin image could not be read.')
      const decoded = await decodeVoxelSkin(await response.blob(), BUILTIN_DMELOPER_SKIN.model)
      const thumbnail = await createSkinFaceThumbnailPngBase64(decoded)
      return createSkinThumbnailDataUrl(thumbnail)
    })
    .catch((error: unknown) => {
      pendingDefaultThumbnailUrl = undefined
      throw error
    })
  return pendingDefaultThumbnailUrl
}
