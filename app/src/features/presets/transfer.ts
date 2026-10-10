import { DEFAULT_PET_MODEL_ID } from '@/config/model3d'
import { createMinecraftSkinBlob, createMinecraftSkinDataUrl, fetchMinecraftSkin, isMinecraftUsername } from '@/services/minecraftSkin'
import { createSkinFaceThumbnailPngBase64 } from '@/utils/skinThumbnail'
import { decodeVoxelSkin } from '@/utils/three3d/voxelSkin'

import type { PresetSourceSettings } from './compatibility'
import type { PresetSnapshot } from './types'

import { isPresetSourceSettings, projectPresetSettings } from './compatibility'
import { clonePreset, createDefaultPresetSnapshot } from './model'
import { preparePresetSkin } from './skin'
import { PRESET_SETTING_KEYS } from './types'

export const PET_PRESET_FORMAT = 'dmeloper.petpreset'
export const PET_PRESET_VERSION = 1
export const MAX_PET_PRESET_BYTES = 4 * 1024 * 1024
export const MAX_PRESET_PNG_BYTES = 2 * 1024 * 1024
export type PresetExportMode = 'image' | 'nickname' | 'default'
export type PresetTransferPhase = 'reading' | 'skin' | 'applying' | 'saving' | 'exporting'

export interface PortablePetPreset {
  format: typeof PET_PRESET_FORMAT
  version: typeof PET_PRESET_VERSION
  name: string
  settings: Omit<PresetSnapshot, 'appearance'>
  // Internal parsed source only; never serialized as a document field.
  sourceSettings?: PresetSourceSettings
  skin: { mode: 'nickname', nickname: string }
    | { mode: 'image', pngBase64: string, model: 'wide' | 'slim', nickname?: string }
}

export type PortablePresetDocument = Omit<PortablePetPreset, 'settings'> & { settings: PresetSourceSettings }

export class PresetTransferError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'PresetTransferError'
  }
}

function reject(code: string): never {
  throw new PresetTransferError(code)
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return record(value) && required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

export function validatePortableSettings(value: unknown): asserts value is PresetSourceSettings {
  if (!isPresetSourceSettings(value)) reject('invalidSettings')
}

export function validatePortablePreset(value: unknown): asserts value is PortablePresetDocument {
  if (!record(value) || value.format !== PET_PRESET_FORMAT) reject('invalidFormat')
  if (value.version !== PET_PRESET_VERSION) reject('unsupportedVersion')
  if (!exactKeys(value, ['format', 'version', 'name', 'settings', 'skin'], ['sourceSettings'])
    || (value.sourceSettings !== undefined && !isPresetSourceSettings(value.sourceSettings))) {
    reject('invalidFormat')
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim() !== value.name
    || [...value.name].length > 255 || /\p{Cc}/u.test(value.name)) {
    reject('invalidFormat')
  }
  validatePortableSettings(value.settings)
  const skin = value.skin
  if (!record(skin)) reject('invalidSkin')
  if (skin.mode === 'nickname') {
    if (!exactKeys(skin, ['mode', 'nickname'])) reject('invalidSkin')
  } else if (skin.mode === 'image') {
    if (!exactKeys(skin, ['mode', 'pngBase64', 'model'], ['nickname'])
      || !['wide', 'slim'].includes(skin.model as string)) {
      reject('invalidSkin')
    }
    if (typeof skin.pngBase64 !== 'string' || !skin.pngBase64) reject('invalidSkin')
    if (skin.pngBase64.length > 4 * Math.ceil(MAX_PRESET_PNG_BYTES / 3)) reject('tooLarge')
    if (skin.pngBase64.length % 4 !== 0 || !/^[A-Z\d+/]*={0,2}$/i.test(skin.pngBase64)) reject('invalidSkin')
    const bytes = atob(skin.pngBase64)
    if (bytes.length > MAX_PRESET_PNG_BYTES) reject('tooLarge')
    if (!bytes.startsWith('\x89PNG\r\n\x1A\n')) reject('invalidSkin')
  } else {
    reject('invalidSkin')
  }
  if (skin.nickname !== undefined && (typeof skin.nickname !== 'string' || !isMinecraftUsername(skin.nickname))) reject('invalidNickname')
}

export function parsePortablePreset(bytes: Uint8Array): PortablePetPreset {
  if (bytes.byteLength > MAX_PET_PRESET_BYTES) reject('tooLarge')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    reject('invalidFormat')
  }
  if (record(value) && 'sourceSettings' in value) reject('invalidFormat')
  validatePortablePreset(value)
  const sourceSettings = clonePreset(value.settings) as unknown as PresetSourceSettings
  return { ...value, settings: projectPresetSettings(sourceSettings), sourceSettings }
}

function wirePreset(value: PortablePetPreset): PortablePresetDocument {
  return {
    format: value.format,
    version: value.version,
    name: value.name,
    settings: value.sourceSettings ?? value.settings as unknown as PresetSourceSettings,
    skin: value.skin,
  }
}

export function serializePortablePreset(value: PortablePetPreset): string {
  const document = wirePreset(value)
  validatePortablePreset(document)
  const text = `${JSON.stringify(document, null, 2)}\n`
  if (new TextEncoder().encode(text).byteLength > MAX_PET_PRESET_BYTES) reject('tooLarge')
  return text
}

export async function exportPortablePreset(name: string, snapshot: PresetSnapshot, mode: PresetExportMode, sourceSettings?: PresetSourceSettings): Promise<PortablePetPreset> {
  const source = mode === 'default' ? clonePreset(snapshot) : snapshot
  if (mode === 'default') {
    const defaults = createDefaultPresetSnapshot()
    source.appearance = defaults.appearance
    source.preset.dmeloperEyebrows.color = defaults.preset.dmeloperEyebrows.color
    source.preset.dmeloperPalmColor = defaults.preset.dmeloperPalmColor
  }
  const { appearance } = source
  // Construct the portable projection explicitly; never serialize a local catalog.
  const settings = clonePreset({
    preset: Object.fromEntries(PRESET_SETTING_KEYS.map(key => [key, source.preset[key]])) as PresetSnapshot['preset'],
    mirror: source.mirror,
    opacity: source.opacity,
    eyebrowAnimationEnabled: source.eyebrowAnimationEnabled,
  })
  const nickname = appearance.minecraftSkinUsername
  let skin: PortablePetPreset['skin']
  if (mode === 'nickname') {
    if (!nickname || !isMinecraftUsername(nickname)) reject('invalidNickname')
    skin = { mode, nickname }
  } else {
    const prepared = await preparePresetSkin(source)
    skin = {
      mode: 'image',
      pngBase64: prepared.appearance.dmeloperSkinDataUrl!.slice('data:image/png;base64,'.length),
      model: prepared.appearance.dmeloperSkinModel === 'slim' ? 'slim' : 'wide',
      ...(nickname ? { nickname } : {}),
    }
  }
  const original = sourceSettings ? clonePreset(sourceSettings) : undefined
  if (original && mode === 'default' && record(original.preset)) {
    const defaults = createDefaultPresetSnapshot()
    original.preset.dmeloperPalmColor = defaults.preset.dmeloperPalmColor
    if (record(original.preset.dmeloperEyebrows)) original.preset.dmeloperEyebrows.color = defaults.preset.dmeloperEyebrows.color
  }
  const result: PortablePetPreset = { format: PET_PRESET_FORMAT, version: PET_PRESET_VERSION, name, settings, skin, ...(original ? { sourceSettings: original } : {}) }
  validatePortablePreset(wirePreset(result))
  return result
}

export async function resolvePortablePreset(value: PortablePetPreset) {
  validatePortablePreset(wirePreset(value))
  const response = value.skin.mode === 'nickname' ? await fetchMinecraftSkin(value.skin.nickname) : undefined
  const pngBase64 = response?.pngBase64 ?? (value.skin.mode === 'image' ? value.skin.pngBase64 : '')
  const model = response?.model ?? (value.skin.mode === 'image' ? value.skin.model : 'wide')
  const nickname = response?.canonicalName ?? value.skin.nickname
  const decoded = await decodeVoxelSkin(createMinecraftSkinBlob(pngBase64), model)
  if (response && decoded.convertedFromLegacy !== (response.height === 32)) reject('invalidSkin')
  const thumbnailPngBase64 = await createSkinFaceThumbnailPngBase64(decoded)
  const digest = await crypto.subtle.digest('SHA-256', await createMinecraftSkinBlob(pngBase64).arrayBuffer())
  const pngSha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
  const snapshot: PresetSnapshot = {
    ...projectPresetSettings(value.sourceSettings ?? value.settings as unknown as PresetSourceSettings),
    appearance: {
      selectedModelId: DEFAULT_PET_MODEL_ID,
      dmeloperSkinDataUrl: createMinecraftSkinDataUrl(pngBase64),
      dmeloperSkinModel: decoded.model,
      useDefaultDmeloperSkin: true,
      ...(nickname ? { minecraftSkinUsername: nickname } : {}),
    },
  }
  return { snapshot, pngBase64, pngSha256, model: decoded.model, thumbnailPngBase64, nickname, source: value.skin.mode }
}
