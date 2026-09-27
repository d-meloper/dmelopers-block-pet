import type { PetModelId } from '@/config/model3d'
import type { LoadedPetAssetState } from '@/utils/three3d'
import type { VoxelSkinModelPreference } from '@/utils/three3d/voxelSkin'

export interface DesiredPetAssetState {
  modelId: PetModelId
  dmeloperSkinModel?: VoxelSkinModelPreference
  dmeloperSkinUrl?: string
}

export type PetAssetMutation = 'model' | 'none' | 'skin'

export function getRequiredPetAssetMutation(
  loaded: LoadedPetAssetState | undefined,
  desired: DesiredPetAssetState,
  forceReload = false,
): PetAssetMutation {
  if (
    forceReload
    || !loaded
    || loaded.modelId !== desired.modelId
  ) {
    return 'model'
  }

  if (
    desired.modelId === 'dmeloper'
    && (
      loaded.dmeloperSkinUrl !== desired.dmeloperSkinUrl
      || loaded.dmeloperSkinModel !== desired.dmeloperSkinModel
    )
  ) {
    return 'skin'
  }

  return 'none'
}
