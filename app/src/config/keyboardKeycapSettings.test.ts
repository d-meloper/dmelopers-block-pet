/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { PresetCollection } from '@/features/presets/types'

import { presetSettings, presetSource } from '@/features/presets/compatibility'
import { createDefaultPresetSnapshot, migratePresetCollection } from '@/features/presets/model'

import {
  createDefaultKeyboardKeycapSettings,
  normalizeKeyboardKeycapSettings,
  prepareKeyboardKeycapSettingsForSync,
  reconcileKeyboardKeycapSettings,
  resetKeyboardKeycapSettings,
} from './keyboardKeycapSettings'

describe('common keyboard display preset compatibility', () => {
  it('offers an empty first starter while keeping factory instances independent', () => {
    const first = createDefaultKeyboardKeycapSettings()
    const second = createDefaultKeyboardKeycapSettings()
    assert.equal(first.presets[0]?.id, 'builtin:empty')
    assert.equal(first.presets[0]?.name, '빈 프리셋')
    assert.deepEqual(first.presets[0]?.keys, [])
    assert.equal(first.presets.length, 6)
    first.presets[0]!.name = 'Custom blank'
    first.presets[1]!.keys.push('KeyZ')
    assert.equal(second.presets[0]?.name, '빈 프리셋')
    assert.notDeepEqual(first.presets[1]?.keys, second.presets[1]?.keys)
  })

  it('adds a new first starter without resurrecting deleted entries or replacing user names', () => {
    const defaults = createDefaultKeyboardKeycapSettings()
    const previous = {
      mode: 'selected' as const,
      selectedKeys: ['KeyW'],
      presets: [
        { id: 'user:one', name: 'My own keys', keys: ['Space'] },
        { id: 'builtin:minecraft', name: 'Renamed Minecraft', keys: ['KeyE'] },
      ],
      seededPresetIds: defaults.seededPresetIds.filter(id => id !== 'builtin:empty'),
      starterRevision: 2,
    }
    const before = JSON.stringify(previous)
    const next = normalizeKeyboardKeycapSettings(previous)
    assert.equal(next.presets[0]?.id, 'builtin:empty')
    assert.deepEqual(next.presets.slice(1), previous.presets)
    assert.deepEqual(next.selectedKeys, ['KeyW'])
    assert.equal(next.mode, 'selected')
    assert.equal(JSON.stringify(previous), before)
    next.presets = next.presets.filter(entry => entry.id !== 'builtin:empty')
    assert.deepEqual(normalizeKeyboardKeycapSettings(next), next)
  })

  it('retains an explicitly empty library after every starter was offered', () => {
    const settings = createDefaultKeyboardKeycapSettings()
    settings.presets = []
    settings.mode = 'selected'
    assert.deepEqual(normalizeKeyboardKeycapSettings(settings), settings)
  })

  it('marks only historical starters before an older General record is merged with new defaults', () => {
    const previous = { mode: 'selected', selectedKeys: [], presets: [] }
    const prepared = prepareKeyboardKeycapSettingsForSync(previous) as Record<string, unknown>
    assert.deepEqual(prepared.seededPresetIds, ['builtin:lol', 'builtin:fps'])
    assert.equal(prepared.starterRevision, 1)
    assert.equal('seededPresetIds' in previous, false)
  })

  it('does not publish changes merely because native JSON object keys were reordered', () => {
    const settings = normalizeKeyboardKeycapSettings(createDefaultKeyboardKeycapSettings())
    settings.presets = settings.presets.map(entry => ({ keys: entry.keys, name: entry.name, id: entry.id }))
    const selected = settings.selectedKeys
    const presets = settings.presets
    const metadata = settings.seededPresetIds
    reconcileKeyboardKeycapSettings(settings)
    assert.equal(settings.selectedKeys, selected)
    assert.equal(settings.presets, presets)
    assert.equal(settings.seededPresetIds, metadata)
  })

  it('adds library starters without changing the active filter reference', () => {
    const settings = createDefaultKeyboardKeycapSettings()
    settings.mode = 'selected'
    settings.selectedKeys = ['KeyW', 'Space']
    settings.presets = settings.presets.filter(entry => entry.id !== 'builtin:empty')
    settings.seededPresetIds = settings.seededPresetIds.filter(id => id !== 'builtin:empty')
    const selected = settings.selectedKeys
    reconcileKeyboardKeycapSettings(settings)
    assert.equal(settings.presets[0]?.id, 'builtin:empty')
    assert.equal(settings.selectedKeys, selected)
    assert.equal(settings.mode, 'selected')
  })

  it('restores the complete common defaults through the shared reset owner', () => {
    const settings = createDefaultKeyboardKeycapSettings()
    settings.presets = [{ id: 'user:one', name: 'My keys', keys: ['KeyW'] }]
    settings.mode = 'selected'
    settings.selectedKeys = ['KeyW']
    resetKeyboardKeycapSettings(settings)
    assert.deepEqual(settings, createDefaultKeyboardKeycapSettings())
  })

  it('retires prototype pet-owned filters from execution while preserving their original archive', () => {
    const snapshot = createDefaultPresetSnapshot()
    Object.assign(snapshot.preset, { keyboardKeycapInputMode: 'selected', keyboardKeycapSelectedKeys: ['KeyW'] })
    const original = JSON.stringify(snapshot)
    const source = {
      schemaVersion: 4,
      activeId: 'saved',
      entries: [{ id: 'saved', name: 'Saved', favorite: false, snapshot }],
    }
    const migrated = migratePresetCollection(source) as PresetCollection
    const entry = migrated.entries[0]!
    assert.equal('keyboardKeycapInputMode' in entry.snapshot.preset, false)
    assert.equal('keyboardKeycapSelectedKeys' in entry.snapshot.preset, false)
    assert.deepEqual(presetSource(entry), presetSettings(snapshot))
    assert.equal(JSON.stringify(snapshot), original)
  })
})
