/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { useBlockStore } from '@/stores/block'

import type { PresetCollection, PresetSnapshot } from './types'

import { inspectPresetCompatibility, migratedPresetSettings, PRESET_SUPPORT_CONTRACT, presetSettings, presetSource } from './compatibility'
import { historicalCurrentSettings, historicalFixtures, historicalGet, historicalManifest, historicalSet } from './fixtures/historicalFixtures'
import { applyPresetSnapshot, capturePresetSnapshot, clonePreset, isExecutablePresetSnapshot, migratePresetCollection, validatePresetCollection } from './model'
import { parsePortablePreset, serializePortablePreset } from './transfer'

const releases = historicalFixtures.filter(({ binding }) => binding.kind === 'official-release')
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const renderedValue = (value: unknown) => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value.toLowerCase() : value

it('historical fixture identities and immutable content match the authenticated producer bindings', () => {
  assert.equal(historicalManifest.fixtureVersion, 1)
  assert.deepEqual(historicalManifest.sources.map(({ version, producerCommit, publicCommit }) => [version, producerCommit, publicCommit]), [
    ['1.0.1', 'd23a9ef8bd765c5cd7a279ffee81def4231c9ec6', 'd8e05d2489dacaf4288f3fc6e156c9bfddab0537'],
    ['1.1.0', '11ef429f009be7b537587f3406617a02e591f2ff', '6281f430c04cee0d0282b20c9411017a18c257da'],
    ['1.1.1', 'cd7548c0edbe331e20a4c3b0d1c6d5919d0a392c', '7a11ca8ee364da43b58293288b5e5bd11e2783a7'],
    ['1.1.2', 'e725c15b6fa6a0f52f20a8f29d09f024402348e1', 'd4f2f109706b22e81fc8fc0444143ce5f8575c67'],
    ['fixed-development', 'f99e9e6ae2a705355345ae9820d482b1ea386b54', null],
  ])
  for (const { binding, text, fixture } of historicalFixtures) {
    assert.equal(createHash('sha256').update(text).digest('hex'), binding.sha256, binding.file)
    assert.equal(fixture.provenance.producerCommit, binding.producerCommit)
    assert.equal(fixture.provenance.publicCommit, binding.publicCommit)
    for (const source of Object.values(fixture.provenance.sources)) {
      assert.match(source.gitBlob, /^[a-f0-9]{40}$/)
      assert.match(source.sha256, /^[a-f0-9]{64}$/)
    }
    assert.equal(fixture.catalogVersion, binding.kind === 'official-release' ? 4 : 3)
    if (binding.kind === 'official-release') {
      assert.equal(fixture.portableVersion, 1)
      assert.equal(fixture.valueCases.length, 53)
      assert.equal(fixture.cases.length, 4)
    }
  }
})

it('historical released portable fixtures load with exact missing-only defaults and retain original skin and settings', () => {
  for (const { fixture } of releases) {
    for (const scenario of fixture.cases) {
      const original = clonePreset(scenario.portable!)
      const parsed = parsePortablePreset(bytes(original))
      const expected = historicalCurrentSettings(scenario.expectedLegacySettings ?? original.settings)
      assert.deepEqual(inspectPresetCompatibility(parsed.sourceSettings!), [], `${fixture.provenance.version}/${scenario.id}`)
      assert.deepEqual(parsed.settings, expected)
      assert.deepEqual(parsed.skin, original.skin)
      assert.deepEqual(parsed.sourceSettings, original.settings)
      const wire = JSON.parse(serializePortablePreset(parsed))
      assert.deepEqual(wire, original)
      assert.deepEqual(parsePortablePreset(bytes(wire)), parsed)
      assert.deepEqual(scenario.portable, original, 'source fixture must remain unchanged')
    }
  }
})

it('historical supported field boundaries survive parsing serialization application and settings reload', () => {
  setActivePinia(createPinia())
  const store = useBlockStore()
  for (const { fixture } of releases) {
    for (const field of fixture.valueCases) {
      for (const value of field.values) {
        const document = clonePreset(fixture.cases[0].portable!)
        historicalSet(document.settings, field.path, value)
        const parsed = parsePortablePreset(bytes(document))
        assert.deepEqual(inspectPresetCompatibility(parsed.sourceSettings!), [], `${fixture.provenance.version}/${field.path.join('.')}/${value}`)
        assert.equal(historicalGet(parsed.settings, field.path), value)
        assert.deepEqual(JSON.parse(serializePortablePreset(parsed)), document)
        // Native viewport fitting depends on the monitor; its source/serialization
        // is checked above, while every other accepted leaf must survive apply.
        if (field.path.includes('manualViewportRect')) continue
        const snapshot = { ...parsed.settings, appearance: clonePreset(fixture.cases[0].snapshot.appearance) } as PresetSnapshot
        applyPresetSnapshot(store, snapshot)
        const saved = JSON.parse(JSON.stringify(capturePresetSnapshot(store))) as PresetSnapshot
        // The established color normalizer changes case without changing RGB.
        // Source and portable comparisons above remain exact, including case.
        assert.equal(renderedValue(historicalGet(saved, field.path)), renderedValue(value), field.path.join('.'))
        applyPresetSnapshot(store, saved)
        assert.equal(renderedValue(historicalGet(capturePresetSnapshot(store), field.path)), renderedValue(value))
      }
    }
  }
})

it('historical released local catalogs retain order selection names favorite flags and custom skin identity after migration and reload', () => {
  for (const { fixture } of releases) {
    const original = clonePreset(fixture.catalog)
    const migrated = migratePresetCollection(original) as PresetCollection
    validatePresetCollection(migrated)
    assert.equal(migrated.schemaVersion, 4)
    assert.equal(migrated.activeId, original.activeId)
    assert.deepEqual(migrated.entries.map(({ id, name, favorite }) => ({ id, name, favorite })), original.entries.map(({ id, name, favorite }) => ({ id, name, favorite })))
    for (let index = 0; index < migrated.entries.length; index++) {
      const entry = migrated.entries[index]
      assert.deepEqual(entry.snapshot.appearance, original.entries[index].snapshot.appearance)
      assert.deepEqual(presetSettings(entry.snapshot), historicalCurrentSettings(presetSettings(original.entries[index].snapshot)))
      assert.equal(isExecutablePresetSnapshot(entry.snapshot), true)
    }
    const reloaded = migratePresetCollection(JSON.parse(JSON.stringify(migrated)))
    validatePresetCollection(reloaded)
    assert.deepEqual(reloaded, migrated)
    assert.deepEqual(original, fixture.catalog)
  }
})

it('historical fixed-development wider catalog values remain source-preserved with an executable partial projection after reload', () => {
  const { fixture } = historicalFixtures.find(({ binding }) => binding.kind === 'fixed-development')!
  const original = clonePreset(fixture.catalog)
  const migrated = migratePresetCollection(original) as PresetCollection
  validatePresetCollection(migrated)
  assert.equal(migrated.schemaVersion, 4)
  assert.deepEqual(migrated.entries.map(entry => entry.id), ['initial'])
  const entry = migrated.entries[0]
  const old = fixture.catalog.entries.find(entry => entry.id === 'initial')!
  assert.deepEqual(entry.snapshot.appearance, old.snapshot.appearance)
  assert.deepEqual(presetSource(entry), presetSettings(old.snapshot))
  assert.deepEqual(inspectPresetCompatibility(presetSource(entry)).map(issue => issue.path).sort(), fixture.unsupportedCurrentPaths!.slice().sort())
  assert.equal(isExecutablePresetSnapshot(entry.snapshot), true, 'stored execution projection must not silently clamp the historical source')
  const reloaded = migratePresetCollection(JSON.parse(JSON.stringify(migrated))) as PresetCollection
  validatePresetCollection(reloaded)
  assert.deepEqual(reloaded, migrated)
  assert.deepEqual(original, fixture.catalog)
})

it('historical guarantees reject removal of migrations new required fields narrowed ranges and removed enum meanings', () => {
  const source = clonePreset(releases[0].fixture.cases[0].portable!.settings)
  assert.deepEqual(inspectPresetCompatibility(source), [])
  const removed = clonePreset(PRESET_SUPPORT_CONTRACT)
  removed.migrations = removed.migrations.filter(id => id !== 'pet-animation-v1')
  assert.ok(inspectPresetCompatibility(source, removed).some(issue => issue.path.join('.') === 'preset.petAnimationMode' && issue.reason === 'missing'))
  const required = clonePreset(PRESET_SUPPORT_CONTRACT)
  required.fields.push({ path: ['preset', 'unmigratedRequiredOption'], type: 'boolean', label: 'fixture' })
  assert.ok(inspectPresetCompatibility(source, required).some(issue => issue.path[1] === 'unmigratedRequiredOption' && issue.reason === 'missing'))
  const narrowed = clonePreset(PRESET_SUPPORT_CONTRACT)
  const field = narrowed.fields.find(field => field.path.join('.') === 'preset.autoViewportPaddingPixels')!
  delete field.rangeRef
  field.min = 0
  field.max = 15
  historicalSet(source, field.path, 16)
  assert.ok(inspectPresetCompatibility(source, narrowed).some(issue => issue.reason === 'range'))
  const choice = clonePreset(PRESET_SUPPORT_CONTRACT)
  choice.fields.find(field => field.path.join('.') === 'preset.keyboardLegendLanguage')!.values = ['ko']
  source.preset.keyboardLegendLanguage = 'en'
  assert.ok(inspectPresetCompatibility(source, choice).some(issue => issue.reason === 'choice'))
  const original = clonePreset(source)
  migratedPresetSettings(source)
  assert.deepEqual(source, original)
})

it('historical catalog projection retains unknown and invalid source values without granting full restoration or replacing assets', () => {
  for (const changes of [
    { petAnimationMode: 'future-mode' },
    { cameraZoomPercent: 'automatic' },
    { lighting: { key: { color: null, strengthPercent: 999 }, futureLamp: [null, true] } },
    { manualViewportRect: { x: 123, y: 456, width: 1, height: 250 } },
    { unknownNested: { choices: ['future', null, { enabled: true }] } },
  ]) {
    const original = clonePreset(releases[0].fixture.catalog)
    Object.assign(original.entries[1].snapshot.preset, changes)
    Reflect.set(original.entries[1].snapshot, 'futureRoot', { version: 99 })
    const before = clonePreset(original)
    const migrated = migratePresetCollection(original) as PresetCollection
    validatePresetCollection(migrated)
    const entry = migrated.entries[1]
    assert.deepEqual(presetSource(entry), presetSettings(before.entries[1].snapshot))
    assert.ok(inspectPresetCompatibility(presetSource(entry)).length, 'partial source must still be classified as partial')
    assert.equal(isExecutablePresetSnapshot(entry.snapshot), true)
    assert.equal('futureRoot' in entry.snapshot, false)
    assert.deepEqual(entry.snapshot.appearance, before.entries[1].snapshot.appearance)
    assert.deepEqual(migratePresetCollection(JSON.parse(JSON.stringify(migrated))), migrated)
    assert.deepEqual(original, before)
  }
  for (const damage of [
    (snapshot: PresetSnapshot) => snapshot.appearance.dmeloperSkinDataUrl = 'file:///untrusted.png',
    (snapshot: PresetSnapshot) => Reflect.set(snapshot.appearance, 'selectedModelId', 'untrusted-model'),
  ]) {
    const catalog = clonePreset(releases[0].fixture.catalog)
    damage(catalog.entries[1].snapshot)
    Reflect.set(catalog.entries[1].snapshot.preset, 'unknownFuture', true)
    const before = clonePreset(catalog)
    assert.throws(() => validatePresetCollection(migratePresetCollection(catalog)))
    assert.deepEqual(catalog, before)
  }
})
