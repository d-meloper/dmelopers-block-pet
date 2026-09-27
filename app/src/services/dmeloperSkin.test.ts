/* eslint-disable test/no-import-node-test */
import { mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { useCatStore } from '@/stores/cat'

import {
  DEFAULT_DMELOPER_SKIN_RESOURCE,
  getResolvedDmeloperSkinUrl,
  resolveDmeloperSkinThumbnailUrl,
  resolveDmeloperSkinUrl,
} from './dmeloperSkin'

it('uses the bundled skin through first run, legacy disable, removal, reset and restart', async () => {
  const globals = ['window', 'fetch', 'FileReader'] as const
  const originals = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  const installedPath = 'C:/FixtureProfiles/사용자 安★/OneDrive - 회사 [팀] #100% & O\'Brien/Pet/assets/models/dmeloper/default.png'
  const assetUrl = `http://asset.localhost/${encodeURIComponent(installedPath)}`
  const bytes = readFileSync(new URL('../../src-tauri/assets/models/dmeloper/default.png', import.meta.url))
  const expectedUrl = `data:image/png;base64,${bytes.toString('base64')}`
  const fetchedUrls: string[] = []
  let encodes = 0
  class TestFileReader {
    result = ''
    onload?: () => void
    onerror?: () => void
    readAsDataURL(blob: Blob) {
      assert.equal(blob.type, 'image/png')
      if (++encodes === 1) {
        this.onerror?.()
        return
      }
      void blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
        this.onload?.()
      })
    }
  }
  Object.defineProperties(globalThis, {
    fetch: {
      configurable: true,
      value: async (url: string) => {
        fetchedUrls.push(url)
        if (fetchedUrls.length === 1) return new Response(null, { status: 404 })
        // Asset responses need not supply a PNG MIME type; persisted data must.
        return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })
      },
    },
    FileReader: { configurable: true, value: TestFileReader },
  })
  const userSkin = 'data:image/png;base64,iVBORw0KGgo='
  let resolutions = 0
  mockConvertFileSrc('windows')
  mockIPC((command, args) => {
    assert.equal(command, 'plugin:path|resolve_directory')
    assert.ok(args && 'path' in args)
    assert.equal(args.path, DEFAULT_DMELOPER_SKIN_RESOURCE)
    resolutions += 1
    if (resolutions === 1) throw new Error('resource path unavailable')
    return installedPath
  })
  const createStore = () => {
    setActivePinia(createPinia())
    return useCatStore()
  }
  try {
    // User skins must not depend on resolving an unused default resource.
    assert.equal(await resolveDmeloperSkinUrl(userSkin), userSkin)
    assert.equal(resolutions, 0)
    await assert.rejects(resolveDmeloperSkinUrl(), /resource path unavailable/)
    await assert.rejects(resolveDmeloperSkinUrl(), /bundled skin image/)
    assert.equal(getResolvedDmeloperSkinUrl(), undefined, 'failed reads must not publish an intermediate asset URL')
    await assert.rejects(resolveDmeloperSkinUrl(), /bundled skin image/)
    assert.equal(getResolvedDmeloperSkinUrl(), undefined, 'failed encoding must remain retryable')
    const first = resolveDmeloperSkinUrl()
    assert.equal(resolveDmeloperSkinUrl(), first, 'concurrent callers share the same PNG read')
    assert.equal(await first, expectedUrl)

    const store = createStore()
    assert.equal(await resolveDmeloperSkinUrl(store.customization3d.dmeloperSkinDataUrl), expectedUrl)
    store.customization3d.useDefaultDmeloperSkin = false
    assert.equal(await resolveDmeloperSkinUrl(store.customization3d.dmeloperSkinDataUrl), expectedUrl)
    store.setDmeloperSkinDataUrl(userSkin)
    assert.equal(await resolveDmeloperSkinUrl(store.customization3d.dmeloperSkinDataUrl), userSkin)
    store.setDmeloperSkinDataUrl(undefined)
    assert.equal(store.customization3d.useDefaultDmeloperSkin, false)
    assert.equal(await resolveDmeloperSkinUrl(store.customization3d.dmeloperSkinDataUrl), expectedUrl)

    const restored = createStore()
    Object.assign(restored.customization3d, JSON.parse(JSON.stringify(store.customization3d)))
    restored.init()
    assert.equal(await resolveDmeloperSkinUrl(restored.customization3d.dmeloperSkinDataUrl), expectedUrl)
    restored.setDmeloperSkinDataUrl(userSkin)
    restored.resetDmeloperSkinToDefault()
    assert.equal(await resolveDmeloperSkinUrl(restored.customization3d.dmeloperSkinDataUrl), expectedUrl)
    assert.equal(restored.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(restored.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.equal(restored.getPendingSkinLibraryMigration(), undefined)
    assert.equal(getResolvedDmeloperSkinUrl(), expectedUrl)
    assert.equal(getResolvedDmeloperSkinUrl(userSkin), userSkin)
    assert.equal(resolutions, 4)
    assert.deepEqual(fetchedUrls, [assetUrl, assetUrl, assetUrl])
    assert.equal(encodes, 2)
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

it('retries and caches a face thumbnail decoded only from the bundled PNG', async () => {
  const bundledPng = new Uint8Array(readFileSync(new URL('../../src-tauri/assets/models/dmeloper/default.png', import.meta.url)))
  const globals = ['fetch', 'createImageBitmap', 'OffscreenCanvas'] as const
  const originals = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const fetchedUrls: string[] = []
  let decodedImages = 0
  let disposedImages = 0
  let encodedThumbnails = 0
  const pixels = new Uint8ClampedArray(64 * 64 * 4)
  for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255
  class TestCanvas {
    constructor(readonly width: number, readonly height: number) {}

    getContext() {
      return {
        clearRect() {},
        drawImage() {},
        getImageData: () => ({ width: 64, height: 64, data: pixels }),
        createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: (imageData: { data: Uint8ClampedArray }) => {
          assert.equal(imageData.data.length, 64 * 64 * 4)
        },
      }
    }

    async convertToBlob() {
      assert.equal(this.width, 64)
      assert.equal(this.height, 64)
      encodedThumbnails += 1
      return new Blob([bundledPng], { type: 'image/png' })
    }
  }
  Object.defineProperties(globalThis, {
    fetch: {
      configurable: true,
      value: async (url: string) => {
        fetchedUrls.push(url)
        if (fetchedUrls.length === 1) return new Response(null, { status: 404 })
        return new Response(bundledPng, { headers: { 'content-type': 'image/png' } })
      },
    },
    createImageBitmap: {
      configurable: true,
      value: async (source: Blob) => {
        assert.deepEqual(new Uint8Array(await source.arrayBuffer()), bundledPng)
        decodedImages += 1
        return {
          width: 64,
          height: 64,
          close: () => {
            disposedImages += 1
          },
        }
      },
    },
    OffscreenCanvas: { configurable: true, value: TestCanvas },
  })
  try {
    await assert.rejects(resolveDmeloperSkinThumbnailUrl(), /bundled skin image/)
    const first = resolveDmeloperSkinThumbnailUrl()
    const simultaneous = resolveDmeloperSkinThumbnailUrl()
    assert.equal(first, simultaneous)
    const result = await first
    assert.ok(result.startsWith('data:image/png;base64,iVBORw0KGgo'))
    assert.equal(await resolveDmeloperSkinThumbnailUrl(), result)
    assert.deepEqual(fetchedUrls, [getResolvedDmeloperSkinUrl(), getResolvedDmeloperSkinUrl()])
    assert.equal(decodedImages, 1)
    assert.equal(disposedImages, 1)
    assert.equal(encodedThumbnails, 1)
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
