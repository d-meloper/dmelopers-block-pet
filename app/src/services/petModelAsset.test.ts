/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import { getPetModelOption } from '@/config/model3d'

import type { resolvePetModelUrl } from './petModelAsset'

const assetSource = readFileSync(new URL('./petModelAsset.ts', import.meta.url), 'utf8')

function harness(development: boolean, href?: string) {
  const nativePaths: string[] = []
  const convertedPaths: string[] = []
  const installedPath = 'C:/FixtureProfiles/사용자 安★/OneDrive - 회사 [팀] #100% & O\'Brien/Pet/assets/models/dmeloper/dmeloper.glb'
  let failures = 0
  let clock = 1_700_000_000_000
  const exports = {} as { resolvePetModelUrl: typeof resolvePetModelUrl }
  const context = {
    exports,
    URL,
    Date: { now: () => clock },
    ...(href ? { window: { location: { href } } } : {}),
    require: (id: string) => {
      if (id === '@/config/model3d') return { getPetModelOption }
      if (id === '@tauri-apps/api/path') {
        return {
          resolveResource: async (path: string) => {
            nativePaths.push(path)
            if (failures > 0) {
              failures--
              throw new Error('Injected native resource failure')
            }
            return installedPath
          },
        }
      }
      if (id === '@tauri-apps/api/core') {
        return {
          convertFileSrc: (path: string) => {
            convertedPaths.push(path)
            return `http://asset.localhost/${encodeURIComponent(path)}`
          },
        }
      }
      throw new Error(`Unexpected asset import: ${id}`)
    },
  }
  const compiled = ts.transpileModule(assetSource.split('import.meta.env').join(JSON.stringify({ DEV: development })), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const source = `(function () { ${compiled} })()`
  runInNewContext(source, context)
  return {
    get resolve() {
      return exports.resolvePetModelUrl
    },
    nativePaths,
    convertedPaths,
    installedPath,
    advanceClock: () => {
      clock++
    },
    failNextNativeResolution: () => {
      failures++
    },
    reload: () => runInNewContext(source, context),
  }
}

describe('pet model asset resolution', () => {
  it('reads only the known source asset from the Vite origin and shares one revision across callers', async () => {
    const h = harness(true, 'http://127.0.0.1:1423/preference/pet?model=other#editor')
    const first = await h.resolve('dmeloper')
    const url = new URL(first)
    assert.equal(url.origin, 'http://127.0.0.1:1423')
    assert.equal(url.pathname, '/src-tauri/assets/models/dmeloper/dmeloper.glb')
    assert.equal(url.searchParams.size, 1)
    assert.equal(url.searchParams.get('rig'), '1700000000000')
    assert.equal(url.hash, '')
    h.advanceClock()
    assert.equal(await h.resolve('dmeloper'), first, 'a thumbnail batch must reuse its already loaded model')
    assert.equal(await h.resolve('../private.glb' as 'dmeloper'), first, 'model identity cannot become an arbitrary local path')
    assert.deepEqual(h.nativePaths, [])
    assert.deepEqual(h.convertedPaths, [])
    h.reload()
    assert.notEqual(await h.resolve('dmeloper'), first, 'module reload must request the regenerated source rig')
  })

  it('uses native resource resolution in production even with an HTTP window origin', async () => {
    const h = harness(false, 'http://tauri.localhost/main')
    assert.equal(await h.resolve('dmeloper'), `http://asset.localhost/${encodeURIComponent(h.installedPath)}`)
    assert.deepEqual(h.nativePaths, [getPetModelOption('dmeloper').resourcePath])
    assert.deepEqual(h.convertedPaths, [h.installedPath])
  })

  it('keeps the native fallback without a browser and propagates failures without caching them', async () => {
    const h = harness(true)
    h.failNextNativeResolution()
    await assert.rejects(h.resolve('dmeloper'), /Injected native resource failure/)
    assert.deepEqual(h.convertedPaths, [])
    assert.equal(await h.resolve('dmeloper'), `http://asset.localhost/${encodeURIComponent(h.installedPath)}`)
    assert.deepEqual(h.nativePaths, [getPetModelOption('dmeloper').resourcePath, getPetModelOption('dmeloper').resourcePath])
    assert.deepEqual(h.convertedPaths, [h.installedPath])
  })
})
