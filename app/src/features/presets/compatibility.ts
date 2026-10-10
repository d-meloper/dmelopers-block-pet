import { DEFAULT_MODEL_SETTINGS, DEFAULT_PET_PRESET, DEFAULT_WINDOW_SETTINGS } from '@/config/defaultSettings'
import { migrateDeskSettings } from '@/config/desk'
import { migrateDmeloperEyebrowDepth } from '@/config/dmeloperEyebrows'
import { migratePresetLighting } from '@/config/lighting'
import contractData from '@/config/presetCompatibility.json'
import ranges from '@/config/presetRanges.json'

import type { PresetEntry, PresetSnapshot } from './types'

import { PRESET_SETTING_KEYS } from './types'

export type PresetSettings = Omit<PresetSnapshot, 'appearance'>
export type PresetSourceSettings = Record<string, unknown>
export interface PresetFieldContract {
  path: string[]
  type: string
  label: string
  min?: number
  max?: number
  integer?: boolean
  values?: string[]
  rangeRef?: string[]
}
export interface PresetSupportContract {
  version: number
  fields: PresetFieldContract[]
  atomicGroups: string[][]
  migrations: string[]
}
export const PRESET_SUPPORT_CONTRACT: PresetSupportContract = contractData
export interface PresetCompatibilityIssue {
  path: string[]
  value: unknown
  reason: 'missing' | 'type' | 'range' | 'integer' | 'choice' | 'color' | 'unknown' | 'structure'
  field?: PresetFieldContract
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isPresetSourceSettings(value: unknown): value is PresetSourceSettings {
  if (!record(value)) return false
  // Leave headroom for the surrounding native command and recovery journal.
  const valid = (item: unknown, depth: number): boolean => depth <= 64
    && (item === null || typeof item === 'string' || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item))
      || (Array.isArray(item) && item.every(child => valid(child, depth + 1)))
      || (record(item) && Object.values(item).every(child => valid(child, depth + 1))))
  return valid(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4 * 1024 * 1024
}

export function presetSettings(snapshot: PresetSnapshot): PresetSettings {
  // Existing catalogs can carry future root fields as well as preset leaves.
  // Exclude only appearance so the reader never silently loses an unknown option.
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'appearance')) as PresetSettings
}

export function defaultPresetSettings(): PresetSettings {
  return JSON.parse(JSON.stringify({
    preset: Object.fromEntries(PRESET_SETTING_KEYS.map(key => [key, DEFAULT_PET_PRESET[key]])),
    mirror: DEFAULT_MODEL_SETTINGS.mirror,
    opacity: DEFAULT_WINDOW_SETTINGS.opacity,
    eyebrowAnimationEnabled: DEFAULT_MODEL_SETTINGS.eyebrowAnimationEnabled,
  })) as PresetSettings
}

export function fieldBounds(field: PresetFieldContract): { min: number, max: number } {
  if (field.rangeRef) {
    const source = ranges as Record<string, Record<string, { min: number, max: number }>>
    return source[field.rangeRef[0]][field.rangeRef[1]]
  }
  return { min: field.min!, max: field.max! }
}

function get(source: unknown, path: string[]): unknown {
  return path.reduce<unknown>((value, key) => record(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined, source)
}

function set(source: Record<string, unknown>, path: string[], value: unknown) {
  let target = source
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>
  target[path[path.length - 1]] = value
}

export function migratedPresetSettings(source: PresetSourceSettings, contract = PRESET_SUPPORT_CONTRACT): PresetSourceSettings {
  const next = JSON.parse(JSON.stringify(source)) as PresetSourceSettings
  if (record(next.preset)) {
    if (contract.migrations.includes('legacy-desk-v1')) next.preset = migrateDeskSettings(next.preset)
    if (contract.migrations.includes('lighting-v1')) next.preset = migratePresetLighting(next.preset)
    const preset = next.preset as Record<string, unknown>
    if (contract.migrations.includes('eyebrow-depth-v1') && record(preset.dmeloperEyebrows)) preset.dmeloperEyebrows = migrateDmeloperEyebrowDepth(preset.dmeloperEyebrows)
  }
  return next
}

export function inspectPresetCompatibility(source: PresetSourceSettings, contract = PRESET_SUPPORT_CONTRACT): PresetCompatibilityIssue[] {
  const migrated = migratedPresetSettings(source, contract)
  const issues: PresetCompatibilityIssue[] = []
  const structures = new Set(contract.fields.flatMap(field => field.path.slice(0, -1).map((_, index) => field.path.slice(0, index + 1).join('.'))))
  const blocked: string[] = []
  for (const structure of [...structures].sort((a, b) => a.split('.').length - b.split('.').length)) {
    if (blocked.some(parent => structure === parent || structure.startsWith(`${parent}.`))) continue
    const path = structure.split('.')
    if (!record(get(migrated, path))) {
      issues.push({ path, value: get(migrated, path), reason: get(migrated, path) === undefined ? 'missing' : 'structure' })
      blocked.push(structure)
    }
  }
  for (const field of contract.fields) {
    if (blocked.some(parent => field.path.join('.').startsWith(`${parent}.`))) continue
    const value = get(migrated, field.path)
    let reason: PresetCompatibilityIssue['reason'] | undefined
    if (value === undefined) {
      reason = 'missing'
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) reason = 'type'
      else if (value < fieldBounds(field).min || value > fieldBounds(field).max) reason = 'range'
      else if (field.integer && !Number.isInteger(value)) reason = 'integer'
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') reason = 'type'
    } else if (field.type === 'color') {
      if (typeof value !== 'string') reason = 'type'
      else if (!/^#[0-9a-f]{6}$/i.test(value)) reason = 'color'
    } else if (field.type === 'enum') {
      if (typeof value !== 'string') reason = 'type'
      else if (!field.values?.includes(value)) reason = 'choice'
    }
    if (reason) issues.push({ path: field.path, value, reason, field })
  }
  // Preserve path segments: an imported key may contain literal dots.
  const leaves = new Set(contract.fields.map(field => JSON.stringify(field.path)))
  const structuralPaths = new Set(contract.fields.flatMap(field => field.path.slice(0, -1).map((_, index) => JSON.stringify(field.path.slice(0, index + 1)))))
  const unknowns = (value: unknown, path: string[]) => {
    if (!record(value)) return
    for (const key of Object.keys(value).sort()) {
      const next = [...path, key]
      const id = JSON.stringify(next)
      if (!leaves.has(id) && !structuralPaths.has(id)) issues.push({ path: next, value: value[key], reason: 'unknown' })
      else if (structuralPaths.has(id)) unknowns(value[key], next)
    }
  }
  unknowns(migrated, [])
  return issues
}

export function compatiblePresetFields(source: PresetSourceSettings, contract = PRESET_SUPPORT_CONTRACT): PresetFieldContract[] {
  const issues = inspectPresetCompatibility(source, contract)
  const blocked = issues.filter(issue => issue.reason !== 'unknown').map(issue => issue.path.join('.'))
  for (const group of contract.atomicGroups) {
    const id = group.join('.')
    if (blocked.some(path => path === id || path.startsWith(`${id}.`))) blocked.push(id)
  }
  return contract.fields.filter((field) => {
    const id = field.path.join('.')
    return !blocked.some(path => id === path || id.startsWith(`${path}.`))
  })
}

export function projectPresetSettings(source: PresetSourceSettings, fallback = defaultPresetSettings(), contract = PRESET_SUPPORT_CONTRACT): PresetSettings {
  const migrated = migratedPresetSettings(source, contract)
  const output = JSON.parse(JSON.stringify(fallback)) as PresetSettings
  for (const field of compatiblePresetFields(source, contract)) {
    set(output as unknown as Record<string, unknown>, field.path, get(migrated, field.path))
  }
  return output
}

export function presetSource(entry: PresetEntry): PresetSourceSettings {
  return entry.sourceSettings ?? presetSettings(entry.snapshot) as unknown as PresetSourceSettings
}

export function presetSourceKey(entry: PresetEntry, serialize = JSON.stringify): string {
  return serialize({ ...entry.snapshot, sourceSettings: entry.sourceSettings })
}
