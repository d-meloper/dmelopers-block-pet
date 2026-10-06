import type { BlockStore } from '@/stores/block'

import { DEFAULT_MODEL_SETTINGS, DEFAULT_SKIN_APPEARANCE, DEFAULT_WINDOW_SETTINGS } from '@/config/defaultSettings'
import { isDeskSettings, migrateDeskSettings } from '@/config/desk'
import { DEFAULT_DEVICE_COLORS, DEVICE_COLOR_KEYS } from '@/config/deviceColors'
import { migrateDmeloperEyebrowDepth } from '@/config/dmeloperEyebrows'
import { isLightingSettings, migratePresetLighting } from '@/config/lighting'
import { DEFAULT_PET_MODEL_ID } from '@/config/model3d'
import { isSkinSelectionId } from '@/config/skinIdentity'
import { createDefaultPet3dPreset } from '@/stores/block'
import { LEGACY_SKIN_APPEARANCE_KEYS, splitLegacySkinAppearance } from '@/stores/petSettingsMigration'

import type { PresetCollection, PresetEntry, PresetSnapshot } from './types'

import { PRESET_APPEARANCE_KEYS, PRESET_COLLECTION_VERSION, PRESET_SETTING_KEYS } from './types'

export function clonePreset<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createDefaultPresetSnapshot(): PresetSnapshot {
  const defaults = createDefaultPet3dPreset()
  const preset = Object.fromEntries(PRESET_SETTING_KEYS.map(key => [key, defaults[key]])) as PresetSnapshot['preset']
  return {
    preset,
    appearance: { ...DEFAULT_SKIN_APPEARANCE },
    mirror: DEFAULT_MODEL_SETTINGS.mirror,
    opacity: DEFAULT_WINDOW_SETTINGS.opacity,
    eyebrowAnimationEnabled: DEFAULT_MODEL_SETTINGS.eyebrowAnimationEnabled,
  }
}

export function capturePresetSnapshot(store: BlockStore): PresetSnapshot {
  const preset = Object.fromEntries(PRESET_SETTING_KEYS.map(key => [key, store.customization3d.preset[key]])) as PresetSnapshot['preset']
  const appearance = Object.fromEntries(PRESET_APPEARANCE_KEYS.map(key => [key, store.customization3d[key]])) as PresetSnapshot['appearance']
  return clonePreset({
    preset,
    appearance,
    mirror: store.model.mirror,
    opacity: store.window.opacity,
    eyebrowAnimationEnabled: store.model.eyebrowAnimationEnabled,
  })
}

export function applyPresetSnapshot(store: BlockStore, snapshot: PresetSnapshot, revision?: number, visible = true): void {
  const next = clonePreset(snapshot)
  next.preset = migratePresetLighting(migrateDeskSettings(next.preset))
  const customization = store.customization3d
  for (const key of PRESET_APPEARANCE_KEYS) delete (customization as unknown as Record<string, unknown>)[key]
  Object.assign(customization, Object.fromEntries(PRESET_APPEARANCE_KEYS.map(key => [key, next.appearance[key]])), { skinLibraryMigrationCompleted: true })
  customization.preset = store.sanitizePet3dPreset({
    ...createDefaultPet3dPreset(),
    ...Object.fromEntries(PRESET_SETTING_KEYS.map(key => [key, next.preset[key]])) as PresetSnapshot['preset'],
    dmeloperEyebrows: migrateDmeloperEyebrowDepth(next.preset.dmeloperEyebrows),
    viewportModeRevision: revision ?? customization.preset.viewportModeRevision + 1,
  })
  store.window.visible = visible
  store.window.opacity = next.opacity
  store.model.mirror = next.mirror
  store.model.eyebrowAnimationEnabled = next.eyebrowAnimationEnabled
}

function matchesShape(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number') return typeof actual === 'number' && Number.isFinite(actual)
  if (expected && typeof expected === 'object') {
    return !!actual && typeof actual === 'object' && !Array.isArray(actual)
      && Object.entries(expected).every(([key, value]) => matchesShape((actual as Record<string, unknown>)[key], value))
  }
  return typeof actual === typeof expected
}

export function isPresetSnapshot(value: unknown): value is PresetSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as PresetSnapshot
  return !!snapshot.preset && typeof snapshot.preset === 'object'
    && !!snapshot.appearance && typeof snapshot.appearance === 'object'
    && snapshot.appearance.selectedModelId === DEFAULT_PET_MODEL_ID
    && !('visible' in snapshot) && typeof snapshot.mirror === 'boolean'
    && typeof snapshot.eyebrowAnimationEnabled === 'boolean'
    && Number.isFinite(snapshot.opacity) && snapshot.opacity >= 0 && snapshot.opacity <= 100
    && Object.keys(snapshot.preset).every(key => (PRESET_SETTING_KEYS as readonly string[]).includes(key))
    && isLightingSettings(migratePresetLighting(snapshot.preset).lighting)
    && isDeskSettings(migrateDeskSettings(snapshot.preset))
    && matchesShape({
      ...migratePresetLighting(migrateDeskSettings(snapshot.preset)),
      dmeloperEyebrows: migrateDmeloperEyebrowDepth(snapshot.preset.dmeloperEyebrows),
    }, createDefaultPresetSnapshot().preset)
    && matchesShape(snapshot.appearance, createDefaultPresetSnapshot().appearance)
    && !LEGACY_SKIN_APPEARANCE_KEYS.some(key => key in snapshot.appearance)
    && snapshot.preset.cameraZoomPercent > 0
    && snapshot.preset.manualViewportRect.width > 0 && snapshot.preset.manualViewportRect.height > 0
    && ['ko', 'en'].includes(snapshot.preset.keyboardLegendLanguage)
    && DEVICE_COLOR_KEYS.every(key => /^#[0-9a-f]{6}$/i.test(snapshot.preset[key]))
    && (snapshot.appearance.activeSkinLibraryEntryId === undefined || isSkinSelectionId(snapshot.appearance.activeSkinLibraryEntryId))
    && /^#[0-9a-f]{6}$/i.test(snapshot.preset.dmeloperPalmColor)
    && /^#[0-9a-f]{6}$/i.test(snapshot.preset.dmeloperEyebrows.color)
    && ['wide', 'slim', 'auto'].includes(snapshot.appearance.dmeloperSkinModel)
    && (snapshot.appearance.dmeloperSkinDataUrl === undefined
      || (typeof snapshot.appearance.dmeloperSkinDataUrl === 'string'
        && snapshot.appearance.dmeloperSkinDataUrl.startsWith('data:image/png;base64,')
        && snapshot.appearance.dmeloperSkinDataUrl.length <= 4 * Math.ceil(2 * 1024 * 1024 / 3) + 22))
}

export function createPresetCollection(): PresetCollection {
  return { schemaVersion: PRESET_COLLECTION_VERSION, activeId: null, entries: [] }
}

/** Upgrade supported catalogs without letting old skin memory replace a saved appearance. */
export function migratePresetCollection(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const source = value as PresetCollection
  if (![1, 2, 3, 4].includes(source.schemaVersion) || !Array.isArray(source.entries)) return value
  if (source.schemaVersion === PRESET_COLLECTION_VERSION
    && source.entries.every(entry => entry?.snapshot?.preset && typeof entry.snapshot.preset === 'object' && 'petHeadScalePercent' in entry.snapshot.preset
      && entry.snapshot.preset.dmeloperEyebrows === migrateDmeloperEyebrowDepth(entry.snapshot.preset.dmeloperEyebrows)
      && entry.snapshot.preset === migratePresetLighting(migrateDeskSettings(entry.snapshot.preset)))) {
    return value
  }
  const archive = { ...source.legacyAppearanceArchive }
  const entries = source.schemaVersion < PRESET_COLLECTION_VERSION
    ? source.entries.filter(entry => entry?.id !== 'builtin:default')
    : source.entries
  const migrated = {
    ...source,
    schemaVersion: PRESET_COLLECTION_VERSION,
    activeId: source.schemaVersion < PRESET_COLLECTION_VERSION && source.activeId === 'builtin:default' ? null : source.activeId,
    entries: entries.map((entry) => {
      if (!entry?.snapshot?.preset || typeof entry.snapshot.preset !== 'object') return entry
      const nextEntry = { ...entry } as PresetEntry & { builtin?: unknown }
      if (source.schemaVersion < PRESET_COLLECTION_VERSION) delete nextEntry.builtin
      const snapshot = { ...entry.snapshot } as PresetSnapshot & { visible?: unknown }
      delete snapshot.visible
      if (snapshot.appearance && typeof snapshot.appearance === 'object' && !Array.isArray(snapshot.appearance)) {
        const legacy = splitLegacySkinAppearance(snapshot.appearance as Record<string, unknown>)
        snapshot.appearance = legacy.appearance as PresetSnapshot['appearance']
        if (legacy.archive && typeof entry.id === 'string') archive[entry.id] = clonePreset({ ...legacy.archive, ...archive[entry.id] })
      }
      return {
        ...nextEntry,
        snapshot: {
          ...snapshot,
          preset: {
            ...(source.schemaVersion === 1 ? DEFAULT_DEVICE_COLORS : {}),
            ...migratePresetLighting(migrateDeskSettings(snapshot.preset)),
            ...('petHeadScalePercent' in snapshot.preset ? {} : { petHeadScalePercent: 100 }),
            dmeloperEyebrows: migrateDmeloperEyebrowDepth(snapshot.preset.dmeloperEyebrows),
          },
        },
      }
    }),
  }
  if (Object.keys(archive).length) return { ...migrated, legacyAppearanceArchive: archive }
  return migrated
}

export function validatePresetCollection(value: unknown): asserts value is PresetCollection {
  const collection = value as PresetCollection | undefined
  if (!collection || collection.schemaVersion !== PRESET_COLLECTION_VERSION
    || !Array.isArray(collection.entries)
    || collection.entries.some(entry => !entry || typeof entry !== 'object')
    || new Set(collection.entries.map(entry => entry.id)).size !== collection.entries.length
    || (collection.activeId !== null && (typeof collection.activeId !== 'string'
      || !collection.entries.some(entry => entry.id === collection.activeId)))
    || !collection.entries.every(entry => typeof entry.id === 'string' && entry.id.length > 0
      && typeof entry.name === 'string' && typeof entry.favorite === 'boolean'
      && !('builtin' in entry) && !('origin' in entry) && !entry.id.startsWith('builtin:') && isPresetSnapshot(entry.snapshot))) {
    throw new Error('pages.preference.presets.errors.load')
  }
}

export function orderedPresets(collection: PresetCollection): PresetEntry[] {
  return [...collection.entries.filter(entry => entry.favorite), ...collection.entries.filter(entry => !entry.favorite)]
}

export function validatePresetName(collection: PresetCollection, name: string, exceptId?: string): string {
  const trimmed = name.trim()
  if (!trimmed || [...trimmed].length > 255 || /\p{Cc}/u.test(trimmed)) throw new Error('pages.preference.presets.errors.invalidName')
  if (collection.entries.some(entry => entry.id !== exceptId && entry.name === trimmed)) throw new Error('pages.preference.presets.errors.duplicateName')
  return trimmed
}

export function uniquePresetName(collection: PresetCollection, base: string, numbered = false): string {
  const names = new Set(collection.entries.map(entry => entry.name))
  const characters = [...base.trim()]
  const withSuffix = (suffix: number) => {
    const ending = ` ${suffix}`
    return `${characters.slice(0, 255 - ending.length).join('')}${ending}`
  }
  let name = numbered ? withSuffix(2) : characters.slice(0, 255).join('')
  for (let suffix = numbered ? 3 : 2; names.has(name); suffix++) {
    name = withSuffix(suffix)
  }
  return name
}

export function movePreset(collection: PresetCollection, id: string, beforeId?: string): void {
  const entry = collection.entries.find(entry => entry.id === id)
  const before = collection.entries.find(entry => entry.id === beforeId)
  if (!entry || id === beforeId || (before && before.favorite !== entry.favorite)) return
  const next = collection.entries.filter(entry => entry.id !== id)
  const position = before ? next.findIndex(entry => entry.id === beforeId) : next.length
  next.splice(position, 0, entry)
  collection.entries = next
}
