/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'

import { BLOCK_STORE_ID } from '@/config/persistedNames'
import { WINDOW_LABEL } from '@/constants'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'
import { SCENE_VIEWPORT_STATE } from '@/features/scene/types'
import { equalViewportRect, normalizeManualViewport } from '@/features/scene/viewportSettings'

const source = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content
const fragment = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function run(source: string, context: Record<string, unknown>) {
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
}

describe('desktop native settings confirmations', () => {
  it('routes live skin resolution to the owner while managed applies include it in their response snapshot', () => {
    const sent: unknown[][] = []
    const local: string[] = []
    const context = {
      presetApplyInProgress: false,
      WINDOW_LABEL,
      PRESET_EDIT_REQUEST,
      blockStore: { setDmeloperSkinModel: (model: string) => local.push(model) },
      emitTo: (...args: unknown[]) => {
        sent.push(clone(args))
        return Promise.resolve()
      },
      persist: undefined as undefined | ((selection: object, resolved?: string) => void),
    }
    run(`${fragment('function persistResolvedDmeloperSkinModel(', 'async function applyPet3dPresetSelection(')}\nglobalThis.persist = persistResolvedDmeloperSkinModel`, context)
    const selection = { modelId: 'dmeloper', dmeloperSkinModel: 'auto', dmeloperSkinDataUrl: 'data:image/png;base64,YQ==' }
    context.persist!(selection, 'slim')
    assert.deepEqual(local, [])
    assert.deepEqual(sent, [['preference', PRESET_EDIT_REQUEST, { resolvedSkinModel: { modelId: 'dmeloper', requested: 'auto', resolved: 'slim', skinDataUrl: selection.dmeloperSkinDataUrl } }]])
    context.persist!({ ...selection, dmeloperSkinModel: 'wide' }, 'wide')
    context.persist!(selection, undefined)
    assert.equal(sent.length, 1)
    context.presetApplyInProgress = true
    context.persist!(selection, 'wide')
    assert.deepEqual(local, ['wide'])
    assert.equal(sent.length, 1)
  })

  it('publishes the requested and corrected manual crop without replaying it over a newer crop', async () => {
    const requested = { x: -100.5, y: -90.5, width: 2400, height: 1600 }
    const monitorSize = { width: 1920, height: 1080 }
    const applied = normalizeManualViewport(requested, monitorSize)
    const events: unknown[][] = []
    const context = {
      desiredManualViewportRect: { ...requested },
      acceptedViewportMode: { automatic: false, revision: 7, rect: { ...requested } },
      manualViewportCorrection: undefined,
      blockStore: { activePet3dPreset: { manualViewportRect: { ...requested } } },
      getMainViewportMonitorSize: async () => monitorSize,
      getMainViewportSnapshot: () => undefined,
      getFullContentRect: () => requested,
      getNativeManualViewportRect: (rect: typeof requested) => ({ ...rect, x: Math.round(rect.x), y: Math.round(rect.y) }),
      equalViewportRect,
      normalizeManualViewport,
      desktopPetVisible: { value: true },
      componentMounted: true,
      sceneStateGeneration: 0,
      WINDOW_LABEL,
      SCENE_VIEWPORT_STATE,
      getCurrentSelection: () => ({}),
      requestPet3dPresetSelection: () => {},
      emitTo: async (...args: unknown[]) => events.push(clone(args)),
      resolve: undefined as undefined | (() => Promise<unknown>),
      publish: undefined as undefined | (() => Promise<void>),
    }
    run(`${fragment('async function resolveManualViewport()', 'useTauriListen<unknown>(SCENE_VIEWPORT_REQUEST')}
      globalThis.resolve = resolveManualViewport
      globalThis.publish = publishSceneViewportState`, context)
    await context.resolve!()
    await context.publish!()
    assert.deepEqual(clone(context.blockStore.activePet3dPreset.manualViewportRect), applied)
    assert.deepEqual((events.at(-1)![2] as { manualCorrection: unknown }).manualCorrection, { requested, applied })
    context.blockStore.activePet3dPreset.manualViewportRect = { ...requested, width: 800, height: 600 }
    await context.publish!()
    assert.equal((events.at(-1)![2] as { manualCorrection?: unknown }).manualCorrection, undefined)
  })

  it('uses only the preference Block snapshot as the durable authority for startup and quit barriers', () => {
    const appSource = parse(readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content
    const registration = appSource.slice(appSource.indexOf('registerStateSnapshots(() =>'), appSource.indexOf('const { isRestored'))
    for (const label of ['main', 'preference']) {
      let read!: () => Array<{ id: string }>
      run(registration, {
        appWindow: { label },
        WINDOW_LABEL,
        BLOCK_STORE_ID,
        ...Object.fromEntries(['app', 'cat', 'general', 'shortcut'].map(id => [`${id === BLOCK_STORE_ID ? 'block' : id}Store`, { $id: id, $state: { value: id } }])),
        registerStateSnapshots: (callback: typeof read) => {
          read = callback
        },
      })
      assert.deepEqual(Array.from(read(), item => item.id), label === 'main' ? ['app', 'general', 'shortcut'] : ['app', 'cat', 'general', 'shortcut'])
    }
  })
})
