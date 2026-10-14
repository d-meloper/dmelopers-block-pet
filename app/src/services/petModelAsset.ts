import { convertFileSrc } from '@tauri-apps/api/core'
import { resolveResource } from '@tauri-apps/api/path'

import type { PetModelId } from '@/config/model3d'

import { getPetModelOption } from '@/config/model3d'

// One revision per loaded module preserves thumbnail reuse while a hot reload
// fetches the regenerated shoulder/hip/knee rig instead of a copied native resource.
const developmentModelRevision = Date.now()

/** Development reads regenerated source assets; installed builds use resources. */
export async function resolvePetModelUrl(modelId: PetModelId): Promise<string> {
  const { resourcePath } = getPetModelOption(modelId)
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    const url = new URL(`/src-tauri/${resourcePath}`, window.location.href)
    url.searchParams.set('rig', String(developmentModelRevision))
    return url.href
  }
  return convertFileSrc(await resolveResource(resourcePath))
}
