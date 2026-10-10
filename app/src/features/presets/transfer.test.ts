import assert from 'node:assert/strict'
/* eslint-disable test/no-import-node-test */
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { DEFAULT_DESK_SETTINGS, DESK_SETTING_KEYS, LEGACY_DESK_SETTINGS } from '@/config/desk'
import { MinecraftSkinError } from '@/services/minecraftSkin'

import { inspectPresetCompatibility } from './compatibility'
import { clonePreset, createDefaultPresetSnapshot } from './model'
import { installPresetSkinBrowser } from './skin.test.utils'
import { exportPortablePreset, MAX_PET_PRESET_BYTES, parsePortablePreset, resolvePortablePreset, serializePortablePreset, validatePortablePreset } from './transfer'
import { PRESET_SETTING_KEYS } from './types'

const fixture = readFileSync(new URL('./fixtures/portable-v1.json', import.meta.url))

it('reads the frozen native/frontend v1 fixture with exactly the preset settings allowlist', () => {
  const doc = parsePortablePreset(fixture)
  assert.equal(doc.settings.preset.dmeloperEyebrows.depthPercent, 100)
  for (const key of DESK_SETTING_KEYS) assert.equal(doc.settings.preset[key], LEGACY_DESK_SETTINGS[key])
  assert.deepEqual(Object.keys(doc.settings.preset).sort(), [...PRESET_SETTING_KEYS].sort())
  assert.deepEqual(parsePortablePreset(new TextEncoder().encode(serializePortablePreset(doc))), doc)
  assert.deepEqual(parsePortablePreset(new Uint8Array([0xEF, 0xBB, 0xBF, ...fixture])), doc)
})

it('round-trips automatic padding through 30 and classifies unsupported archived padding', async () => {
  for (const padding of [0, 2, 10, 16, 17, 20, 30]) {
    const snapshot = createDefaultPresetSnapshot()
    snapshot.preset.autoViewportPaddingPixels = padding
    snapshot.appearance.minecraftSkinUsername = 'Fixture_User'
    const exported = await exportPortablePreset('Padding', snapshot, 'nickname')
    const imported = parsePortablePreset(new TextEncoder().encode(serializePortablePreset(exported)))
    assert.equal(imported.settings.preset.autoViewportPaddingPixels, padding)
  }
  for (const padding of [-1, 31, 16.5, '30', null]) {
    const document = JSON.parse(fixture.toString())
    document.settings.preset.autoViewportPaddingPixels = padding
    const restored = parsePortablePreset(new TextEncoder().encode(JSON.stringify(document)))
    assert.ok(inspectPresetCompatibility(restored.sourceSettings!).length)
    assert.equal(restored.sourceSettings!.preset && (restored.sourceSettings!.preset as Record<string, unknown>).autoViewportPaddingPixels, padding)
  }
})

it('projects nickname exports without reading images, issuing network calls or leaking local state', async () => {
  const snapshot = createDefaultPresetSnapshot()
  snapshot.appearance.minecraftSkinUsername = 'Fixture_User'
  snapshot.appearance.dmeloperSkinDataUrl = 'data:image/png;base64,PRIVATE_BYTES'
  snapshot.appearance.activeSkinLibraryEntryId = 'a'.repeat(64)
  Object.assign(snapshot, { privateState: { filename: 'private.png' } })
  const before = clonePreset(snapshot)
  const document = await exportPortablePreset('공유 😶', snapshot, 'nickname')
  assert.deepEqual(document.skin, { mode: 'nickname', nickname: 'Fixture_User' })
  const serialized = serializePortablePreset(document)
  for (const secret of ['PRIVATE_BYTES', 'activeSkinLibraryEntryId', 'privateState', 'filename', 'thumbnail', 'appearance']) assert.ok(!serialized.includes(secret))
  assert.deepEqual(snapshot, before)
  await assert.rejects(exportPortablePreset('Missing', createDefaultPresetSnapshot(), 'nickname'), { code: 'invalidNickname' })
})

it('exports immutable PNG bytes, resolved arm geometry and nickname provenance while keeping settings intact', async () => {
  const browser = installPresetSkinBrowser()
  try {
    const snapshot = createDefaultPresetSnapshot()
    snapshot.appearance.minecraftSkinUsername = 'Fixture_User'
    snapshot.appearance.dmeloperSkinDataUrl = browser.dataUrl
    snapshot.preset.dmeloperPalmColor = '#112233'
    snapshot.preset.dmeloperEyebrows.color = '#445566'
    snapshot.preset.dmeloperEyebrows.depthPercent = 0
    const document = await exportPortablePreset('Frozen', snapshot, 'image')
    assert.deepEqual(document.skin, { mode: 'image', pngBase64: browser.dataUrl.split(',')[1], model: 'wide', nickname: 'Fixture_User' })
    assert.deepEqual(document.settings.preset, snapshot.preset)
    assert.deepEqual(parsePortablePreset(new TextEncoder().encode(serializePortablePreset(document))), { ...document, sourceSettings: document.settings })
    const builtin = await exportPortablePreset('Default', createDefaultPresetSnapshot(), 'image')
    assert.equal(builtin.skin.mode, 'image')
    assert.ok(!('nickname' in builtin.skin))
  } finally {
    browser.restore()
  }
})

it('exports the bundled default skin and only resets skin colors without reading private skin data', async () => {
  const browser = installPresetSkinBrowser()
  try {
    const snapshot = createDefaultPresetSnapshot()
    snapshot.appearance = {
      ...snapshot.appearance,
      dmeloperSkinDataUrl: 'data:image/png;base64,PRIVATE_BYTES',
      dmeloperSkinModel: 'slim',
      minecraftSkinUsername: 'Private_Name',
      activeSkinLibraryEntryId: 'a'.repeat(64),
      useDefaultDmeloperSkin: false,
    }
    Object.assign(snapshot.preset, { dmeloperPalmColor: '#112233', cameraZoomPercent: 145, keyboardBaseXOffset: 0.4, petHeadScalePercent: 150 })
    Object.assign(snapshot.preset.dmeloperEyebrows, { color: '#445566', enabled: false, depthPercent: 0, widthPixels: 3 })
    snapshot.preset.lighting.key.color = '#778899'
    snapshot.mirror = true
    snapshot.opacity = 73
    snapshot.eyebrowAnimationEnabled = false
    const before = clonePreset(snapshot)
    const document = await exportPortablePreset('Skin-free', snapshot, 'default')
    assert.deepEqual(document.skin, { mode: 'image', pngBase64: browser.dataUrl.split(',')[1], model: 'wide' })
    const defaults = createDefaultPresetSnapshot()
    const expected = clonePreset(snapshot.preset)
    expected.dmeloperEyebrows.color = defaults.preset.dmeloperEyebrows.color
    expected.dmeloperPalmColor = defaults.preset.dmeloperPalmColor
    assert.deepEqual(document.settings, { preset: expected, mirror: true, opacity: 73, eyebrowAnimationEnabled: false })
    const serialized = serializePortablePreset(document)
    for (const secret of ['PRIVATE_BYTES', 'Private_Name', 'activeSkinLibraryEntryId', 'appearance']) assert.ok(!serialized.includes(secret))
    const restored = await resolvePortablePreset(parsePortablePreset(new TextEncoder().encode(serialized)))
    assert.deepEqual(restored.snapshot.preset, expected)
    assert.equal(restored.snapshot.appearance.minecraftSkinUsername, undefined)
    assert.equal(restored.snapshot.appearance.dmeloperSkinModel, 'wide')
    assert.deepEqual(snapshot, before)
  } finally {
    browser.restore()
  }
})

it('rejects invalid file envelopes and preserves incompatible settings before skin resolution', () => {
  const mutations: Array<(doc: Record<string, any>) => void> = [
    d => d.version++,
    d => d.format = 'foreign',
    d => d.name = '',
    d => d.name = 'A\nB',
    d => d.settings.visible = true,
    d => d.settings.preset.viewportModeRevision = 99,
    d => d.settings.preset.cameraZoomPercent = 1e20,
    d => d.settings.preset.mouseEnabled = 'yes',
    d => d.settings.preset.petRightArmBendPercent = -1,
    d => d.settings.preset.dmeloperEyebrows.widthPixels = 100,
    d => d.settings.preset.dmeloperEyebrows.script = 'evil',
    d => d.settings.preset.manualViewportRect.width = 1,
    d => d.settings.preset.manualViewportRect.x = 1e25,
    d => d.skin.nickname = 'bad-name',
    d => d.skin.pngBase64 = 'private',
    d => d.skin.thumbnail = 'private',
    d => d.settings.preset.keyboardColor = 'red',
  ]
  for (const mutate of mutations) {
    const doc = JSON.parse(fixture.toString())
    mutate(doc)
    if (doc.version !== 1 || doc.format !== 'dmeloper.petpreset' || !doc.name || /\n/.test(doc.name) || doc.skin.nickname === 'bad-name' || doc.skin.pngBase64 === 'private' || doc.skin.thumbnail) {
      assert.throws(() => validatePortablePreset(doc), { name: 'PresetTransferError' }, mutate.toString())
    } else {
      validatePortablePreset(doc)
      assert.ok(inspectPresetCompatibility(doc.settings).length, mutate.toString())
    }
  }
  assert.throws(() => parsePortablePreset(new Uint8Array(MAX_PET_PRESET_BYTES + 1)), { code: 'tooLarge' })
  assert.throws(() => parsePortablePreset(new Uint8Array([0xFF])), { code: 'invalidFormat' })
})

it('resolves nickname exactly once, adopts current Wide/Slim and preserves colors through image re-export', async () => {
  let lookups = 0
  let model: 'wide' | 'slim' = 'slim'
  let failLookup = false
  const browser = installPresetSkinBrowser((command, args) => {
    assert.equal(command, 'fetch_minecraft_skin')
    assert.equal(args?.username, 'Fixture_User')
    lookups++
    if (failLookup) throw new MinecraftSkinError({ code: 'NETWORK', retryable: true })
    return {
      canonicalName: 'Fixture_User',
      uuid: 'a'.repeat(32),
      textureKey: 'b'.repeat(64),
      sha256: 'c'.repeat(64),
      model,
      pngBase64: browser.dataUrl.split(',')[1],
      width: 64,
      height: 64,
      cacheHit: false,
    }
  })
  try {
    const document = parsePortablePreset(fixture)
    delete document.sourceSettings
    document.settings.preset.dmeloperPalmColor = '#123456'
    document.settings.preset.dmeloperEyebrows.color = '#654321'
    document.settings.preset.dmeloperEyebrows.depthPercent = 0
    const resolved = await resolvePortablePreset(document)
    assert.equal(lookups, 1)
    assert.equal(resolved.model, 'slim')
    assert.equal(resolved.snapshot.appearance.minecraftSkinUsername, 'Fixture_User')
    assert.deepEqual(resolved.snapshot.preset, document.settings.preset)
    const frozen = await exportPortablePreset(document.name, resolved.snapshot, 'image')
    const restored = await resolvePortablePreset(frozen)
    assert.equal(lookups, 1, 'image restore and re-export never fetch a linked nickname')
    assert.deepEqual(restored.snapshot, resolved.snapshot)
    model = 'wide'
    assert.equal((await resolvePortablePreset(document)).model, 'wide')
    assert.equal(lookups, 2)
    failLookup = true
    await assert.rejects(resolvePortablePreset(document), { code: 'NETWORK' })
    assert.equal(lookups, 3)
    assert.deepEqual(document.settings.preset, resolved.snapshot.preset)
  } finally {
    browser.restore()
  }
})

it('round-trips supported eyebrow depths and classifies unsupported archived depths', () => {
  for (const depthPercent of [0, 100, 200]) {
    const document = parsePortablePreset(fixture)
    delete document.sourceSettings
    document.settings.preset.dmeloperEyebrows.depthPercent = depthPercent
    const parsed = parsePortablePreset(new TextEncoder().encode(serializePortablePreset(document)))
    assert.equal(parsed.settings.preset.dmeloperEyebrows.depthPercent, depthPercent)
  }
  for (const invalid of [-1, 201, Number.NaN, Infinity, null, '0', false]) {
    const document = JSON.parse(fixture.toString())
    document.settings.preset.dmeloperEyebrows.depthPercent = invalid
    if (typeof invalid === 'number' && !Number.isFinite(invalid)) {
      assert.throws(() => validatePortablePreset(document), { code: 'invalidSettings' })
    } else {
      validatePortablePreset(document)
      assert.ok(inspectPresetCompatibility(document.settings).length)
    }
  }
})

it('round-trips every desk setting and only supplies absent fields in partial legacy documents', async () => {
  for (const deskHeightOffset of [-1, 0, 1]) {
    for (const deskTransparent of [false, true]) {
      const snapshot = createDefaultPresetSnapshot()
      snapshot.appearance.minecraftSkinUsername = 'Fixture_User'
      Object.assign(snapshot.preset, { deskTransparent, deskHeightOffset, deskWidthOffset: deskHeightOffset, deskDepthOffset: deskHeightOffset === 0 ? 0 : -deskHeightOffset, deskColor: '#123aBC' })
      const exported = await exportPortablePreset('Desk', snapshot, 'nickname')
      const restored = parsePortablePreset(new TextEncoder().encode(serializePortablePreset(exported)))
      assert.deepEqual(restored.settings.preset, snapshot.preset)
      assert.equal(restored.version, 1)
    }
  }
  const legacy = JSON.parse(fixture.toString())
  legacy.settings.preset.deskTransparent = false
  const restored = parsePortablePreset(new TextEncoder().encode(JSON.stringify(legacy)))
  assert.equal(restored.settings.preset.deskTransparent, false)
  assert.equal(restored.settings.preset.deskColor, DEFAULT_DESK_SETTINGS.deskColor)
  assert.equal(restored.settings.preset.deskHeightOffset, 0)
  assert.equal(restored.settings.preset.deskWidthOffset, -1)
  assert.equal(restored.settings.preset.deskDepthOffset, DEFAULT_DESK_SETTINGS.deskDepthOffset)
  assert.equal('deskColor' in legacy.settings.preset, false)
})

it('archives incompatible desk settings while rejecting non-JSON values', () => {
  for (const changes of [
    { deskTransparent: null },
    { deskTransparent: 1 },
    { deskTransparent: 'false' },
    { deskColor: '#12345' },
    { deskColor: '#GGGGGG' },
    { deskColor: null },
    { deskHeightOffset: -1.01 },
    { deskHeightOffset: 1.01 },
    { deskHeightOffset: Number.NaN },
    { deskHeightOffset: Infinity },
    { deskHeightOffset: null },
    { deskHeightOffset: '0' },
    { deskHeightOffset: undefined },
    { deskWidthOffset: -1.01 },
    { deskWidthOffset: 1.01 },
    { deskWidthOffset: Number.NaN },
    { deskWidthOffset: '0' },
    { deskWidthOffset: undefined },
    { deskDepthOffset: -1.01 },
    { deskDepthOffset: 1.01 },
    { deskDepthOffset: null },
    { deskDepthOffset: Infinity },
    { deskDepthOffset: false },
    { deskEnabled: true },
  ]) {
    const legacy = JSON.parse(fixture.toString())
    Object.assign(legacy.settings.preset, changes)
    if (Object.values(changes).some(value => value === undefined || (typeof value === 'number' && !Number.isFinite(value)))) {
      assert.throws(() => validatePortablePreset(legacy), { code: 'invalidSettings' })
    } else {
      validatePortablePreset(legacy)
      assert.ok(inspectPresetCompatibility(legacy.settings).length)
    }
  }
})

it('retains incompatible original values through real parse, resolve, serialize and re-export', async () => {
  const raw = JSON.parse(fixture.toString())
  raw.settings.preset.autoViewportPaddingPixels = 40
  raw.settings.preset.keyboardLegendLanguage = 'unsupported'
  raw.settings.preset.futureOption = { enabled: true }
  const parsed = parsePortablePreset(new TextEncoder().encode(JSON.stringify(raw)))
  assert.deepEqual(parsed.sourceSettings, raw.settings)
  assert.equal(parsed.settings.preset.autoViewportPaddingPixels, createDefaultPresetSnapshot().preset.autoViewportPaddingPixels)
  const serialized = JSON.parse(serializePortablePreset(parsed))
  assert.deepEqual(serialized.settings, raw.settings)
  assert.equal('sourceSettings' in serialized, false)
  const snapshot = { ...createDefaultPresetSnapshot(), ...parsed.settings }
  snapshot.appearance.minecraftSkinUsername = 'Fixture_User'
  const exported = await exportPortablePreset('Preserved', snapshot, 'nickname', parsed.sourceSettings)
  assert.deepEqual(JSON.parse(serializePortablePreset(exported)).settings, raw.settings)
  assert.deepEqual(parsed.sourceSettings, raw.settings)
})
