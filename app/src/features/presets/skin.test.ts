/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { it } from 'node:test'

import type { SkinLibraryEntry, SkinLibraryStoreRequest } from '@/services/skinLibrary'

import { clonePreset, createDefaultPresetSnapshot } from './model'
import { preparePresetSkin, restorePresetSkin } from './skin'
import { installPresetSkinBrowser } from './skin.test.utils'

it('migrates unregistered legacy default snapshots while retaining registered imports and failed reads', async () => {
  const browser = installPresetSkinBrowser()
  try {
    const snapshot = createDefaultPresetSnapshot()
    const id = 'a'.repeat(64)
    snapshot.appearance.activeSkinLibraryEntryId = id
    snapshot.appearance.dmeloperSkinDataUrl = browser.dataUrl
    snapshot.preset.dmeloperEyebrows.color = '#123456'
    snapshot.preset.dmeloperPalmColor = '#abcdef'
    const before = JSON.stringify(snapshot)

    browser.failCatalog(true)
    assert.equal((await preparePresetSkin(snapshot)).appearance.activeSkinLibraryEntryId, id)
    browser.failCatalog(false)
    browser.setEntries([{
      id,
      source: 'local',
      displayName: 'My skin',
      originalFilename: 'my-skin.png',
      model: 'wide',
      pngSha256: id,
      width: 64,
      height: 64,
      thumbnailPngBase64: 'iVBORw0KGgo=',
      addedAt: 0,
    }])
    assert.equal((await preparePresetSkin(snapshot)).appearance.activeSkinLibraryEntryId, id)
    browser.setEntries([])
    const migrated = await preparePresetSkin(snapshot)
    assert.equal(migrated.appearance.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.equal(migrated.appearance.dmeloperSkinDataUrl, browser.dataUrl)
    assert.equal(migrated.preset.dmeloperEyebrows.color, '#123456')
    assert.equal(migrated.preset.dmeloperPalmColor, '#abcdef')
    assert.deepEqual(migrated.preset, snapshot.preset)
    assert.equal(JSON.stringify(snapshot), before, 'prepare must not mutate the saved source')
    assert.deepEqual(await preparePresetSkin(migrated), migrated)
  } finally {
    browser.restore()
  }
})

it('validates default PNG bytes without replacing preset colors with sampled colors', async () => {
  const browser = installPresetSkinBrowser()
  try {
    const defaults = createDefaultPresetSnapshot()
    const prepared = await preparePresetSkin(defaults)
    assert.equal(browser.decoded(), 1)
    assert.deepEqual(prepared.preset, defaults.preset)
    assert.equal(prepared.appearance.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.equal(prepared.appearance.dmeloperSkinDataUrl, browser.dataUrl)
    assert.ok(Object.keys(prepared.appearance).every(key => !/Profiles|Colors|Migration/.test(key)))
  } finally {
    browser.restore()
  }
})

it('keeps independent saved appearance through delayed preparation of the same PNG', async () => {
  const browser = installPresetSkinBrowser()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const snapshot = createDefaultPresetSnapshot()
    snapshot.appearance.activeSkinLibraryEntryId = 'builtin:dmeloper'
    snapshot.appearance.dmeloperSkinDataUrl = browser.dataUrl
    snapshot.preset.dmeloperEyebrows.color = '#123456'
    snapshot.preset.dmeloperPalmColor = '#abcdef'
    const before = clonePreset(snapshot)
    const fetchSkin = globalThis.fetch
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (...args: Parameters<typeof fetch>) => {
      await held
      return fetchSkin(...args)
    } })
    const preparation = preparePresetSkin(snapshot)
    snapshot.preset.dmeloperEyebrows.color = '#654321'
    snapshot.preset.dmeloperPalmColor = '#fedcba'
    release()
    const prepared = await preparation
    const later = await preparePresetSkin(snapshot)
    assert.deepEqual(prepared.preset, before.preset)
    assert.deepEqual(later.preset, snapshot.preset)
    assert.equal(prepared.appearance.dmeloperSkinDataUrl, later.appearance.dmeloperSkinDataUrl)
    assert.notEqual(prepared.preset.dmeloperEyebrows.color, later.preset.dmeloperEyebrows.color)
    assert.notEqual(prepared.preset.dmeloperPalmColor, later.preset.dmeloperPalmColor)
  } finally {
    release()
    browser.restore()
  }
})

it('keeps saved built-in PNG bytes and rejects invalid data without changing the snapshot', async () => {
  const browser = installPresetSkinBrowser()
  try {
    const snapshot = createDefaultPresetSnapshot()
    snapshot.appearance.activeSkinLibraryEntryId = 'builtin:dmeloper'
    // PNG trailing data models distinct saved bytes; preparation must not refetch defaults.
    const savedBytes = Buffer.concat([Buffer.from(browser.dataUrl.split(',')[1], 'base64'), Buffer.from([0])])
    snapshot.appearance.dmeloperSkinDataUrl = `data:image/png;base64,${savedBytes.toString('base64')}`
    assert.equal((await preparePresetSkin(snapshot)).appearance.dmeloperSkinDataUrl, snapshot.appearance.dmeloperSkinDataUrl)
    snapshot.appearance.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
    const before = JSON.stringify(snapshot)
    await assert.rejects(preparePresetSkin(snapshot), /valid PNG signature/)
    assert.equal(JSON.stringify(snapshot), before)
  } finally {
    browser.restore()
  }
})

it('restores a removed user skin only on explicit application and reuses identical bytes on later applies', async () => {
  const writes: SkinLibraryStoreRequest[] = []
  let entries: SkinLibraryEntry[] = []
  const browser = installPresetSkinBrowser((command, args) => {
    assert.equal(command, 'store_skin_library_entry')
    const request = args!.request as SkinLibraryStoreRequest
    writes.push(request)
    const stored: SkinLibraryEntry = {
      id: 'd'.repeat(64),
      source: 'local',
      displayName: request.displayName,
      originalFilename: request.originalFilename,
      model: request.model,
      pngSha256: createHash('sha256').update(Buffer.from(request.pngBase64, 'base64')).digest('hex'),
      width: 64,
      height: 64,
      thumbnailPngBase64: request.thumbnailPngBase64,
      addedAt: 0,
    }
    entries = [stored]
    browser.setEntries(entries)
    return stored
  })
  try {
    const snapshot = createDefaultPresetSnapshot()
    // A user import remains a user skin even when its pixels equal the default.
    snapshot.appearance.activeSkinLibraryEntryId = 'a'.repeat(64)
    snapshot.appearance.dmeloperSkinDataUrl = browser.dataUrl
    snapshot.appearance.minecraftSkinUsername = 'Saved_Name'
    snapshot.preset.dmeloperEyebrows.color = '#123456'
    snapshot.preset.dmeloperPalmColor = '#abcdef'
    const before = clonePreset(snapshot)
    await preparePresetSkin(snapshot)
    assert.equal(writes.length, 0, 'pure preparation and thumbnail work cannot recreate the library')
    const restored = await restorePresetSkin(snapshot, 'Retained scene')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].overwriteExisting, false)
    assert.equal(writes[0].source, 'local', 'saved PNG restoration must never resolve a nickname over the network')
    assert.equal(restored.appearance.activeSkinLibraryEntryId, entries[0].id)
    assert.equal(restored.appearance.dmeloperSkinDataUrl, browser.dataUrl)
    assert.equal(restored.appearance.minecraftSkinUsername, 'Saved_Name')
    assert.deepEqual(restored.preset, snapshot.preset)
    assert.deepEqual(snapshot, before)
    const repeated = await restorePresetSkin(snapshot, 'Another scene name')
    assert.equal(writes.length, 1)
    assert.equal(repeated.appearance.activeSkinLibraryEntryId, restored.appearance.activeSkinLibraryEntryId)
  } finally {
    browser.restore()
  }
})

it('does not register bundled skins and surfaces failed user-library acknowledgement before applying', async () => {
  const browser = installPresetSkinBrowser(() => {
    throw new Error('library write unavailable')
  })
  try {
    assert.equal((await restorePresetSkin(createDefaultPresetSnapshot(), 'Bundled')).appearance.activeSkinLibraryEntryId, 'builtin:dmeloper')
    const snapshot = createDefaultPresetSnapshot()
    snapshot.appearance.dmeloperSkinDataUrl = browser.dataUrl
    snapshot.appearance.activeSkinLibraryEntryId = 'c'.repeat(64)
    const before = clonePreset(snapshot)
    await assert.rejects(restorePresetSkin(snapshot, 'User'), /IO_ERROR/)
    assert.deepEqual(snapshot, before)
    browser.failCatalog(true)
    await assert.rejects(restorePresetSkin(snapshot, 'User'), /IO_ERROR/)
    assert.deepEqual(snapshot, before)
  } finally {
    browser.restore()
  }
})
