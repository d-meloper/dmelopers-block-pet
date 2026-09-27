import { clearMocks, mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'

import type { SkinLibraryEntry } from '@/services/skinLibrary'

/** Mock only native I/O and browser image APIs, leaving preset preparation intact. */
export function installPresetSkinBrowser(onInvoke?: (command: string, args?: Record<string, unknown>) => unknown) {
  const bytes = readFileSync(new URL('../../../src-tauri/assets/models/dmeloper/default.png', import.meta.url))
  const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
  const globals = ['window', 'fetch', 'FileReader', 'createImageBitmap', 'OffscreenCanvas'] as const
  const originals = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const originalFetch = globalThis.fetch
  let entries: SkinLibraryEntry[] = []
  let catalogFailure = false
  let decoded = 0
  const pixels = new Uint8ClampedArray(64 * 64 * 4)
  for (let index = 0; index < pixels.length; index += 4) pixels.set([68, 85, 102, 255], index)

  class TestFileReader {
    result = ''
    onload?: () => void
    onerror?: () => void
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
        this.onload?.()
      }, () => this.onerror?.())
    }
  }
  class TestCanvas {
    constructor(readonly width: number, readonly height: number) {}
    getContext() {
      return {
        clearRect() {},
        drawImage() {},
        createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData() {},
        getImageData: () => ({ width: 64, height: 64, data: pixels }),
      }
    }

    convertToBlob() {
      return Promise.resolve(new Blob([bytes], { type: 'image/png' }))
    }
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: {} },
    fetch: {
      configurable: true,
      value: (url: string) => url.startsWith('data:')
        ? originalFetch(url)
        : Promise.resolve(new Response(bytes, { headers: { 'content-type': 'image/png' } })),
    },
    FileReader: { configurable: true, value: TestFileReader },
    OffscreenCanvas: { configurable: true, value: TestCanvas },
    createImageBitmap: {
      configurable: true,
      value: async () => {
        decoded++
        return { width: 64, height: 64, close() {} }
      },
    },
  })
  mockConvertFileSrc('windows')
  mockIPC((command, args) => {
    if (command === 'plugin:path|resolve_directory') return 'C:/Pet/assets/models/dmeloper/default.png'
    if (command === 'list_skin_library') {
      if (catalogFailure) throw new Error('Catalog temporarily unavailable')
      return entries
    }
    if (onInvoke) return onInvoke(command, args as Record<string, unknown> | undefined)
    throw new Error(`Unexpected native call: ${command}`)
  })
  return {
    dataUrl,
    decoded: () => decoded,
    setEntries: (value: SkinLibraryEntry[]) => {
      entries = value
    },
    failCatalog: (value: boolean) => {
      catalogFailure = value
    },
    restore() {
      clearMocks()
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}
