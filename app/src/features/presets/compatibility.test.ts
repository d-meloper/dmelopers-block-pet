/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { DEFAULT_PET_PRESET } from '@/config/defaultSettings'
import { useBlockStore } from '@/stores/block'

import { defaultPresetSettings, fieldBounds, inspectPresetCompatibility, PRESET_SUPPORT_CONTRACT, presetSettings, presetSource, projectPresetSettings } from './compatibility'
import cases from './fixtures/compatibility-cases.json'
import { applyPresetSnapshot, clonePreset, createDefaultPresetSnapshot, isExecutablePresetSnapshot } from './model'
import { PRESET_SETTING_KEYS } from './types'

function sorted(issues: Array<{ path: string[], reason: string }>) {
  return issues
    .map(({ path, reason }) => ({ path, reason }))
    .sort((a, b) => JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)))
}

it('matches all shared native/frontend compatibility cases without changing source data', () => {
  for (const scenario of cases) {
    const before = JSON.stringify(scenario.settings)
    assert.deepEqual(sorted(inspectPresetCompatibility(scenario.settings)), sorted(scenario.issues), scenario.name)
    assert.equal(JSON.stringify(scenario.settings), before)
  }
})

it('judges actual values against the current reader, including the 16 to 30 range expansion', () => {
  const old = clonePreset(PRESET_SUPPORT_CONTRACT)
  old.fields.find(field => field.path.join('.') === 'preset.autoViewportPaddingPixels')!.max = 16
  for (const [value, count] of [[12, 0], [30, 1]]) {
    const source = defaultPresetSettings()
    source.preset.autoViewportPaddingPixels = value
    assert.equal(inspectPresetCompatibility(source, old).length, count)
    assert.equal(inspectPresetCompatibility(source).length, 0)
    assert.equal(projectPresetSettings(source).preset.autoViewportPaddingPixels, value)
    assert.equal(projectPresetSettings(source, defaultPresetSettings(), old).preset.autoViewportPaddingPixels, count ? defaultPresetSettings().preset.autoViewportPaddingPixels : value)
  }
})

it('uses only the reading contract migrations without inventing unsupported settings', () => {
  const reader = clonePreset(PRESET_SUPPORT_CONTRACT)
  reader.fields = reader.fields.filter(field => field.path[1] !== 'lighting')
  reader.migrations = reader.migrations.filter(id => id !== 'lighting-v1')
  const source = defaultPresetSettings()
  Reflect.deleteProperty(source.preset, 'lighting')
  assert.deepEqual(inspectPresetCompatibility(source, reader), [])
  assert.deepEqual(inspectPresetCompatibility(source), [], 'current readers retain the verified lighting migration')
})

it('covers every persisted setting and agrees with actual runtime normalization at supported boundaries', () => {
  const keys = new Set(PRESET_SUPPORT_CONTRACT.fields.filter(field => field.path[0] === 'preset').map(field => field.path[1]))
  assert.deepEqual([...keys].sort(), [...PRESET_SETTING_KEYS].sort())
  assert.deepEqual(Object.keys(DEFAULT_PET_PRESET).filter(key => !['windowScalePercent', 'viewportModeRevision'].includes(key)).sort(), [...PRESET_SETTING_KEYS].sort())
  const leafPaths = (value: unknown, path: string[] = []): string[] => value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...path, key]))
    : [JSON.stringify(path)]
  assert.deepEqual(leafPaths(defaultPresetSettings()).sort(), PRESET_SUPPORT_CONTRACT.fields.map(field => JSON.stringify(field.path)).sort(), 'all nested settings need one contract field')
  for (const field of PRESET_SUPPORT_CONTRACT.fields) {
    assert.ok(['number', 'boolean', 'color', 'enum'].includes(field.type), field.path.join('.'))
    if (field.type === 'enum') assert.ok(field.values?.length)
    if (field.type === 'number') {
      const { min, max } = fieldBounds(field)
      assert.ok(Number.isFinite(min) && Number.isFinite(max) && min <= max)
    }
  }
  setActivePinia(createPinia())
  const store = useBlockStore()
  for (const field of PRESET_SUPPORT_CONTRACT.fields.filter(field => field.type === 'number')) {
    const { min, max } = fieldBounds(field)
    for (const value of [min, max, ...(field.integer ? [] : [min + Math.min((max - min) / 2, 0.125)])]) {
      // Huge rectangle boundaries are further limited by the active monitor.
      if (field.path.includes('manualViewportRect')) continue
      const source = createDefaultPresetSnapshot()
      let target = source as unknown as Record<string, any>
      for (const part of field.path.slice(0, -1)) target = target[part]
      target[field.path[field.path.length - 1]] = value
      applyPresetSnapshot(store, source)
      let accepted: any = presetSettings(createDefaultPresetSnapshot())
      accepted = presetSettings({ ...createDefaultPresetSnapshot(), preset: store.activePet3dPreset, mirror: store.model.mirror, opacity: store.window.opacity, eyebrowAnimationEnabled: store.model.eyebrowAnimationEnabled })
      for (const part of field.path) accepted = accepted[part]
      assert.equal(accepted, value, field.path.join('.'))
    }
  }
})

it('retains unknown root options from existing snapshots and refuses them for execution', () => {
  const snapshot = createDefaultPresetSnapshot()
  Reflect.set(snapshot, 'futureOption', true)
  const source = presetSource({ id: 'old', name: 'Old', favorite: false, snapshot })
  assert.equal(source.futureOption, true)
  assert.deepEqual(sorted(inspectPresetCompatibility(source)), [{ path: ['futureOption'], reason: 'unknown' }])
  assert.equal(isExecutablePresetSnapshot(snapshot), false)
})

it('retains current rejected leaves and the entire coupled rectangle; previews use defaults', () => {
  const source = defaultPresetSettings()
  source.preset.autoViewportPaddingPixels = 40
  source.preset.manualViewportRect.width = 1
  source.preset.manualViewportRect.x = 222
  source.preset.dmeloperEyebrows.spacingPixels = 100
  source.preset.dmeloperEyebrows.color = '#123456'
  const current = defaultPresetSettings()
  current.preset.autoViewportPaddingPixels = 12
  current.preset.manualViewportRect.x = 99
  current.preset.dmeloperEyebrows.spacingPixels = 2
  const before = clonePreset(source)
  const applied = projectPresetSettings(source, current)
  assert.equal(applied.preset.autoViewportPaddingPixels, 12)
  assert.deepEqual(applied.preset.manualViewportRect, current.preset.manualViewportRect)
  assert.equal(applied.preset.dmeloperEyebrows.spacingPixels, 2)
  assert.equal(applied.preset.dmeloperEyebrows.color, '#123456')
  assert.equal(projectPresetSettings(source).preset.autoViewportPaddingPixels, defaultPresetSettings().preset.autoViewportPaddingPixels)
  assert.deepEqual(source, before)
})

it('reports literal dotted setting names as unknown instead of aliasing supported paths', () => {
  for (const [path, value] of [
    [['preset', 'lighting.key.color'], '#123456'],
    [['preset', 'manualViewportRect.x'], 123],
    [['preset.lighting'], { key: { color: '#123456' } }],
  ] as const) {
    const source = defaultPresetSettings() as unknown as Record<string, any>
    let target = source
    for (const key of path.slice(0, -1)) target = target[key]
    target[path[path.length - 1]] = value
    assert.deepEqual(sorted(inspectPresetCompatibility(source)), [{ path: [...path], reason: 'unknown' }])
    assert.deepEqual(projectPresetSettings(source), defaultPresetSettings())
  }
})
