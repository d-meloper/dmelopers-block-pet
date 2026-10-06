import type { BlockStore, Pet3dPreset } from '@/stores/block'
import type { GeneralStore } from '@/stores/general'
import type { HotKey } from '@/stores/shortcut'
import type { VoxelSkinModel } from '@/utils/three3d/voxelSkin'

import defaults from './defaultSettings.json'
import { BLOCK_VISIBILITY_STORAGE_KEY } from './persistedNames'

// Edit defaultSettings.json for authored values shared by TypeScript and Rust.
// Keep this module free of runtime domain imports to avoid circular dependencies.
// JSON string unions are narrowed here and exercised by defaultSettings.test.ts.
export const DEFAULT_MODEL_SETTINGS = {
  ...defaults.model,
  shadowQuality: defaults.model.shadowQuality as BlockStore['model']['shadowQuality'],
} as const satisfies BlockStore['model']

export const DEFAULT_WINDOW_SETTINGS = defaults.window satisfies BlockStore['window']

export const DEFAULT_SKIN_APPEARANCE = {
  ...defaults.skinAppearance,
  selectedModelId: defaults.skinAppearance.selectedModelId as BlockStore['customization3d']['selectedModelId'],
  dmeloperSkinModel: defaults.skinAppearance.dmeloperSkinModel as VoxelSkinModel,
} as const satisfies Pick<BlockStore['customization3d'], 'selectedModelId' | 'dmeloperSkinModel' | 'useDefaultDmeloperSkin'>

export const DEFAULT_PET_PRESET = {
  ...defaults.preset,
  keyboardLegendLanguage: defaults.preset.keyboardLegendLanguage as Pet3dPreset['keyboardLegendLanguage'],
} as const satisfies Pet3dPreset

// Theme resolution still follows the OS. autoUpdateCheck is an inert stored key;
// the preference window owns checks when opened; startup never checks versions.
export const DEFAULT_GENERAL_SETTINGS = {
  ...defaults.general,
  appearance: {
    ...defaults.general.appearance,
    theme: defaults.general.appearance.theme as GeneralStore['appearance']['theme'],
    language: defaults.general.appearance.language as GeneralStore['appearance']['language'],
  },
} as const satisfies GeneralStore

const { [BLOCK_VISIBILITY_STORAGE_KEY]: visibleBlock, ...shortcutDefaults } = defaults.shortcuts
export const DEFAULT_SHORTCUT_SETTINGS = { ...shortcutDefaults, visibleBlock } satisfies Record<HotKey, string>
