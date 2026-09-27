import { isEqual } from 'es-toolkit'

import type { CatStore } from '@/stores/cat'

import { DEFAULT_MODEL_SETTINGS, DEFAULT_SKIN_APPEARANCE, DEFAULT_WINDOW_SETTINGS } from '@/config/defaultSettings'
import { isDeskSettings, migrateDeskSettings } from '@/config/desk'
import { DEFAULT_DEVICE_COLORS, DEVICE_COLOR_KEYS } from '@/config/deviceColors'
import { migrateDmeloperEyebrowDepth } from '@/config/dmeloperEyebrows'
import { DEFAULT_PET_MODEL_ID } from '@/config/model3d'
import { BUILTIN_DMELOPER_SKIN, isSkinSelectionId } from '@/config/skinIdentity'
import { createDefaultPet3dPreset } from '@/stores/cat'
import { LEGACY_SKIN_APPEARANCE_KEYS, splitLegacySkinAppearance } from '@/stores/petSettingsMigration'

import type { PresetCollection, PresetEntry, PresetSnapshot } from './types'

import { BUILTIN_PRESET_ID, PRESET_APPEARANCE_KEYS, PRESET_COLLECTION_VERSION, PRESET_SETTING_KEYS } from './types'

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

// Only untouched authored defaults begin with a single built-in entry. Existing
// settings without a catalog still get a preserved editable initial snapshot.
export function isInitialDefaultSnapshot(snapshot: PresetSnapshot): boolean {
  const candidate = clonePreset(snapshot)
  if (candidate.appearance.activeSkinLibraryEntryId === BUILTIN_DMELOPER_SKIN.id) {
    delete candidate.appearance.activeSkinLibraryEntryId
  }
  return isEqual(candidate, createDefaultPresetSnapshot())
}

export function capturePresetSnapshot(store: CatStore): PresetSnapshot {
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

export function applyPresetSnapshot(store: CatStore, snapshot: PresetSnapshot, revision?: number, visible = true): void {
  const next = clonePreset(snapshot)
  next.preset = migrateDeskSettings(next.preset)
  const customization = store.customization3d
  for (const key of PRESET_APPEARANCE_KEYS) delete (customization as unknown as Record<string, unknown>)[key]
  Object.assign(customization, Object.fromEntries(PRESET_APPEARANCE_KEYS.map(key => [key, next.appearance[key]])), { skinLibraryMigrationCompleted: true })
  customization.preset = {
    ...createDefaultPet3dPreset(),
    ...Object.fromEntries(PRESET_SETTING_KEYS.map(key => [key, next.preset[key]])) as PresetSnapshot['preset'],
    dmeloperEyebrows: migrateDmeloperEyebrowDepth(next.preset.dmeloperEyebrows),
    viewportModeRevision: revision ?? customization.preset.viewportModeRevision + 1,
  }
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
    && isDeskSettings(migrateDeskSettings(snapshot.preset))
    && matchesShape({
      ...migrateDeskSettings(snapshot.preset),
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

export function createPresetCollection(current?: PresetSnapshot, initialName = 'Preset 1'): PresetCollection {
  const entries: PresetEntry[] = [{
    id: BUILTIN_PRESET_ID,
    name: '',
    builtin: true,
    favorite: false,
    snapshot: createDefaultPresetSnapshot(),
  }]
  if (current) entries.push({ id: 'initial', name: initialName, builtin: false, favorite: false, snapshot: clonePreset(current) })
  return { schemaVersion: PRESET_COLLECTION_VERSION, activeId: current ? 'initial' : BUILTIN_PRESET_ID, entries }
}

/** Upgrade supported catalogs without letting old skin memory replace a saved appearance. */
export function migratePresetCollection(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const source = value as PresetCollection
  if (![1, 2, 3].includes(source.schemaVersion) || !Array.isArray(source.entries)) return value
  if (source.schemaVersion === PRESET_COLLECTION_VERSION
    && source.entries.every(entry => entry?.snapshot?.preset && typeof entry.snapshot.preset === 'object' && 'petHeadScalePercent' in entry.snapshot.preset
      && entry.snapshot.preset.dmeloperEyebrows === migrateDmeloperEyebrowDepth(entry.snapshot.preset.dmeloperEyebrows)
      && entry.snapshot.preset === migrateDeskSettings(entry.snapshot.preset))) {
    return value
  }
  const archive = { ...source.legacyAppearanceArchive }
  const migrated = {
    ...source,
    schemaVersion: PRESET_COLLECTION_VERSION,
    entries: source.entries.map((entry) => {
      if (!entry?.snapshot?.preset || typeof entry.snapshot.preset !== 'object') return entry
      const snapshot = { ...entry.snapshot } as PresetSnapshot & { visible?: unknown }
      delete snapshot.visible
      if (snapshot.appearance && typeof snapshot.appearance === 'object' && !Array.isArray(snapshot.appearance)) {
        const legacy = splitLegacySkinAppearance(snapshot.appearance as Record<string, unknown>)
        snapshot.appearance = legacy.appearance as PresetSnapshot['appearance']
        if (legacy.archive && typeof entry.id === 'string') archive[entry.id] = clonePreset({ ...legacy.archive, ...archive[entry.id] })
      }
      return {
        ...entry,
        snapshot: {
          ...snapshot,
          preset: {
            ...(source.schemaVersion === 1 ? DEFAULT_DEVICE_COLORS : {}),
            ...migrateDeskSettings(snapshot.preset),
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
    || !Array.isArray(collection.entries) || collection.entries.length === 0
    || collection.entries.some(entry => !entry || typeof entry !== 'object')
    || new Set(collection.entries.map(entry => entry.id)).size !== collection.entries.length
    || !collection.entries.some(entry => entry.id === collection.activeId)
    || collection.entries.filter(entry => entry.id === BUILTIN_PRESET_ID && entry.builtin).length !== 1
    || !collection.entries.every(entry => typeof entry.id === 'string' && entry.id.length > 0
      && typeof entry.name === 'string' && typeof entry.favorite === 'boolean'
      && entry.builtin === (entry.id === BUILTIN_PRESET_ID) && isPresetSnapshot(entry.snapshot))) {
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

export function updateActivePreset(collection: PresetCollection, snapshot: PresetSnapshot, userEdit: boolean, copyName: string): boolean {
  const entry = collection.entries.find(entry => entry.id === collection.activeId)!
  if (isEqual(entry.snapshot, snapshot)) return false
  if (entry.builtin) {
    if (!userEdit) return false
    const copy: PresetEntry = { id: crypto.randomUUID(), name: uniquePresetName(collection, copyName), favorite: false, builtin: false, snapshot: clonePreset(snapshot) }
    collection.entries.push(copy)
    collection.activeId = copy.id
  } else {
    entry.snapshot = clonePreset(snapshot)
  }
  return true
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

export function nextPresetAfterDelete(collection: PresetCollection, id: string): PresetEntry | undefined {
  const entries = orderedPresets(collection)
  const index = entries.findIndex(entry => entry.id === id)
  return entries[index + 1] ?? entries[index - 1]
}
