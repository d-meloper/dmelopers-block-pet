/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { it } from 'node:test'

import { clonePreset, createDefaultPresetSnapshot } from './model'
import { preparePresetSkin } from './skin'
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
