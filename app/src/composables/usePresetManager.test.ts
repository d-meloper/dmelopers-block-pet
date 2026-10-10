/* eslint-disable test/no-import-node-test */
import type { EventCallback } from '@tauri-apps/api/event'
import type { _DeepPartial } from 'pinia'

import { Window } from '@tauri-apps/api/window'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { createDefaultPresetSnapshot } from '@/features/presets/model'
import type { PortablePetPreset, PresetExportMode } from '@/features/presets/transfer'
import type { PresetApplyRequest, PresetSnapshot } from '@/features/presets/types'
import type { PresetImportJournal, PresetImportPrevious } from '@/services/presetTransfer'
import type { SkinLibraryStoreRequest } from '@/services/skinLibrary'

import { presetSettings, presetSourceKey, projectPresetSettings } from '@/features/presets/compatibility'
import * as editIntent from '@/features/presets/editIntent'
import { markPresetUserEdit } from '@/features/presets/editIntent'
import * as editRequests from '@/features/presets/editRequests'
import * as presetModel from '@/features/presets/model'
import { applyPresetSnapshot, clonePreset } from '@/features/presets/model'
import * as presetOperations from '@/features/presets/operations'
import { withPresetReset } from '@/features/presets/operations'
import { preparePresetSkin } from '@/features/presets/skin'
import { installPresetSkinBrowser } from '@/features/presets/skin.test.utils'
import { PresetTransferError } from '@/features/presets/transfer'
import { PRESET_APPLY_REQUEST, PRESET_APPLY_RESPONSE } from '@/features/presets/types'
import { editorsLocked, initializePetForStartup, registerPresetFlush, stateOwners } from '@/features/stateSafety/bridge'
import { createQuiescenceOwner } from '@/features/stateSafety/quiescence'
import { getRequiredPetAssetMutation } from '@/pages/main/petAssetSelection'
import { createVisibleBoundsSelectionSignature, visibleBoundsSelectionChanged } from '@/pages/main/viewportSelection'
import { getResolvedDmeloperSkinUrl } from '@/services/dmeloperSkin'
import { MinecraftSkinError } from '@/services/minecraftSkin'
import { preparePetStateForSync, useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'
import { runProgramSettingsReset } from '@/utils/programSettingsReset'
import { saveSynchronizedSettings } from '@/utils/settingsPersistence'

import type { PresetManager } from './usePresetManager'

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('./usePresetManager.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

for (const mode of ['selection', 'analysis'] as const) {
  it(`keeps the save owner unready through asynchronous skin ${mode}`, async () => {
    const h = await harness()
    let holdAnalysis = false
    let resolvePalm!: (color: string) => void
    const palm = new Promise<string>((resolve) => {
      resolvePalm = resolve
    })
    const unmounts: Array<() => void> = []
    const scope = vue.effectScope()
    const component = mode === 'selection' ? 'skin-library' : 'block'
    const { descriptor } = parse(readFileSync(new URL(`../pages/preference/components/${component}/index.vue`, import.meta.url), 'utf8'))
    const compiled = ts.transpileModule(compileScript(descriptor, { id: 'pending-skin-save-owner' }).content, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const module = { exports: {} as { default: { setup: (props: object, context: object) => { selectCard: (id: string) => Promise<void> } } } }
    // The actual SFC and preset manager share their real operation/readiness state.
    // Only framework rendering, native I/O and the delayed asset decoder are stubbed.
    runInNewContext(compiled, {
      module,
      exports: module.exports,
      fetch: async () => ({ ok: true, blob: async () => new Blob() }),
      require: (id: string) => {
        if (id === 'vue') return { ...vue, onMounted: () => {}, onBeforeUnmount: (callback: () => void) => unmounts.push(callback) }
        if (id === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
        if (id === 'ant-design-vue') return {}
        if (id === '@/features/presets/operations') return presetOperations
        if (id === '@/features/stateSafety/bridge') return { editorsLocked }
        if (id === '@/services/petSkinChange') return { beginPetSkinChange: () => ({ ready: Promise.resolve(), finish: async () => {} }) }
        if (id === '@/stores/block') return { ...require(fileURLToPath(new URL('../stores/block.ts', import.meta.url))), useBlockStore: () => h.store }
        if (id.startsWith('@/components/')) return {}
        if (id === '@/utils/three3d/voxelSkin') {
          return { decodeVoxelSkin: async () => {
            if (holdAnalysis) await palm
            return { wideArmLayoutCompatible: true, model: 'wide' }
          } }
        }
        if (id === '@/services/dmeloperSkin') {
          return {
            BUILTIN_DMELOPER_SKIN: { id: 'builtin:dmeloper' },
            resolveDmeloperSkinUrl: async (url: string) => url || 'default',
            resolveDefaultDmeloperPalmColor: () => palm,
            resolveDefaultDmeloperColors: async () => ({ palmColor: await palm, eyebrowColor: '#452A24' }),
          }
        }
        if (id.startsWith('@/')) return require(fileURLToPath(new URL(`../${id.slice(2)}`, import.meta.url)))
        return require(id)
      },
    })
    const control = scope.run(() => module.exports.default.setup({}, { expose: () => {}, emit: () => {} }))!
    type Runtime = typeof import('@/features/stateSafety/runtime')
    type Handler = (event: { payload: any }) => unknown
    const handlers = new Map<string, Handler>()
    const runtime = {} as Runtime
    const saved: Array<ReturnType<typeof useBlockStore>['$state']> = []
    let acknowledged = false
    const runtimeSource = ts.transpileModule(readFileSync(new URL('../features/stateSafety/runtime.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    runInNewContext(runtimeSource, {
      exports: runtime,
      performance,
      console,
      setTimeout,
      clearTimeout,
      document: { addEventListener: () => {}, removeEventListener: () => {} },
      require: (id: string) => {
        if (id === 'vue') return vue
        if (id === './bridge') return { editorsLocked, stateOwners, shortcutWarnings: new Set() }
        if (id === './quiescence') return { createQuiescenceOwner }
        if (id === '@/utils/settingsPersistence') return { saveSynchronizedSettings }
        if (id === '@/plugins/window') return { setWindowMemoryActive: () => {} }
        if (id === '@/services/diagnostics') return { reportDiagnostic: () => {} }
        if (id === '@tauri-apps/api/webviewWindow') return { getCurrentWebviewWindow: () => ({ label: 'preference', isVisible: async () => true }) }
        if (id === '@tauri-apps/api/core') {
          return { invoke: async (command: string) => {
            if (command === 'acknowledge_state_quiescence') acknowledged = true
          } }
        }
        if (id === '@tauri-store/pinia') {
          return {
            getStoreState: async () => clonePreset(h.store.$state),
            saveAllNow: async () => {
              saved.push(clonePreset(h.store.$state))
            },
          }
        }
        if (id === '@tauri-apps/api/event') {
          return {
            listen: async (event: string, handler: Handler) => {
              handlers.set(event, handler)
              return () => handlers.delete(event)
            },
            emit: async (event: string, payload: { requestId: string }) => {
              void handlers.get(event)?.({ payload })
              // The other webview's independent acknowledgement is the native boundary.
              if (event === 'state-quiesce-request') handlers.get('state-quiesce-response')?.({ payload: { ...payload, label: 'main', success: true, warnings: [] } })
            },
          }
        }
        throw new Error(`Unexpected save barrier import: ${id}`)
      },
    })
    await runtime.initializeStateSafety()
    runtime.registerStateSnapshots(() => [{ id: h.store.$id, state: { ...clonePreset(h.store.$state) } }])
    runtime.markStoresReady()
    const selecting = mode === 'selection' ? control.selectCard('builtin:dmeloper') : Promise.resolve()
    let saving: Promise<void> | undefined
    try {
      if (mode === 'analysis') {
        holdAnalysis = true
        h.store.setDmeloperSkinDataUrl('data:image/png;base64,YQ==')
        for (let index = 0; index < 20; index++) await vue.nextTick()
      }
      assert.equal(h.quitReady(), false, 'Quit/restart must not seal a snapshot while the accepted skin edit can still change it')
      assert.equal(stateOwners.presetsReady?.(), false, 'the update save barrier must wait for the same accepted skin edit')
      assert.equal(await stateOwners.flushPresets?.(), false)
      saving = runtime.quiesceEditors('pending-skin-save')
      await vue.nextTick()
      assert.equal(acknowledged, false)
      assert.ok(runtime.filterBackendSync({}), 'the live barrier must not freeze the in-flight result')
      resolvePalm('#123456')
      await selecting
      await saving
      assert.equal(acknowledged, true)
      assert.equal(runtime.filterBackendSync({}), undefined)
      assert.equal(h.quitReady(), true)
      assert.equal(saved.at(-1)?.customization3d.preset.dmeloperPalmColor, mode === 'selection' ? '#123456' : '#FFDFCE')
      assert.deepEqual(saved.at(-1)?.presetCollection, h.store.presetCollection)
    } finally {
      resolvePalm('#123456')
      await selecting
      await saving?.catch(() => {})
      await runtime.releaseEditors('pending-skin-save')
      runtime.disposeStateSafety()
      editorsLocked.value = false
      scope.stop()
      unmounts.forEach(callback => callback())
      h.dispose()
    }
  })
}

interface TransferBoundary {
  document: PortablePetPreset
  journal?: PresetImportJournal
  entryId: string
  failure?: 'read' | 'prepare' | 'prepareAfterJournal' | 'commit'
  skinError?: unknown
  journalReadError?: unknown
  readDocument?: (source: File | string) => PortablePetPreset
  rollbackFails: boolean
  loseCommitReply: boolean
  writeResult: boolean
  writeError?: unknown
  prepareHold?: Promise<void>
  commitHold?: Promise<void>
  nicknamePng: string
  nicknameModel: 'wide' | 'slim'
  reads: Array<File | string>
  resolved: PortablePetPreset[]
  exports: Array<{ name: string, snapshot: PresetSnapshot, mode: PresetExportMode }>
  written: PortablePetPreset[]
  prepared: Array<{ operationId: string, presetId: string, previous: PresetImportPrevious, request: SkinLibraryStoreRequest }>
  finished: Array<{ operationId: string, commit: boolean, expected: PresetImportPrevious, saved: ReturnType<typeof useBlockStore>['$state'] }>
}

function transferBoundary(mode: PortablePetPreset['skin']['mode'] = 'nickname', name = 'Shared'): TransferBoundary {
  const snapshot = presetModel.createDefaultPresetSnapshot()
  snapshot.preset.cameraZoomPercent = 145
  snapshot.preset.dmeloperEyebrows.color = '#123456'
  snapshot.preset.dmeloperPalmColor = '#abcdef'
  return {
    document: {
      format: 'dmeloper.petpreset',
      version: 1,
      name,
      settings: { preset: snapshot.preset, mirror: true, opacity: 73, eyebrowAnimationEnabled: false },
      skin: mode === 'nickname'
        ? { mode, nickname: 'Linked_Name' }
        : { mode, pngBase64: 'Yg==', model: 'wide', nickname: 'Linked_Name' },
    },
    entryId: 'b'.repeat(64),
    rollbackFails: false,
    loseCommitReply: false,
    writeResult: true,
    nicknamePng: 'Yw==',
    nicknameModel: 'slim',
    reads: [],
    resolved: [],
    exports: [],
    written: [],
    prepared: [],
    finished: [],
  }
}

function userEntries(manager: PresetManager) {
  // Bring presentation objects from the isolated manager VM into this realm,
  // retaining their real snapshot references for the live-edit assertions.
  return Array.from(manager.entries.value).filter(entry => entry.origin === 'user').map(entry => ({ ...entry }))
}

const DEFAULT_PRESET_ID = 'default'
function savedCatalog(snapshot: PresetSnapshot = presetModel.createDefaultPresetSnapshot(), name = 'initialName') {
  return {
    ...presetModel.createPresetCollection(),
    activeId: 'initial',
    entries: [
      { id: DEFAULT_PRESET_ID, name: 'Default', favorite: false, snapshot: presetModel.createDefaultPresetSnapshot() },
      { id: 'initial', name, favorite: false, snapshot: clonePreset(snapshot) },
    ],
  }
}

async function harness(
  initialState?: ReturnType<typeof useBlockStore>['$state'],
  skinPreparer?: typeof preparePresetSkin,
  beforeMount?: (dispose: () => void) => void,
  transfer: TransferBoundary = transferBoundary(),
  subscriptionFailures: { response?: number, close?: number } = {},
  freshInstall = false,
  runtimeGlobals: Record<string, unknown> = {},
) {
  setActivePinia(createPinia())
  const store = useBlockStore()
  const general = useGeneralStore()
  if (initialState) store.$patch(clonePreset(initialState) as _DeepPartial<typeof store.$state>)
  // Most cases explicitly seed two user presets; fresh-install cases stay empty.
  const seededCatalog = !initialState && !freshInstall
  if (seededCatalog) store.presetCollection = savedCatalog(presetModel.capturePresetSnapshot(store), 'initialName')
  initializePetForStartup(store)
  if (editorsLocked.value && initialState?.window.visible === false) assert.equal(store.window.visible, false, 'recovery initialization preserves hidden state')
  const mounted: Array<() => Promise<void>> = []
  const unmounted: Array<() => void> = []
  const listeners = new Map<string, (event: { payload: unknown }) => void>()
  let closeListeners = 0
  const closeEventHandlers = new Set<EventCallback<unknown>>()
  let windowDestroyRequests = 0
  let quitReady: (() => boolean) | undefined
  let saveFails = false
  let saveFailureAfter: number | undefined
  let saveFailureOnceAfter: number | undefined
  let applyFails = false
  let applyFailuresRemaining = 0
  let restored = true
  let applyHold: Promise<void> | undefined
  let saveHold: Promise<void> | undefined
  let backendRead: (() => Promise<Record<string, unknown>>) | undefined
  let thumbnailHold: Promise<void> | undefined
  let applies = 0
  let rendered = 0
  let restoredSkins = 0
  let thumbnailBatches = 0
  let activeThumbnailBatches = 0
  let maxActiveThumbnailBatches = 0
  let thumbnailFails = false
  const saves: unknown[] = []
  let applyCorrection: ((snapshot: PresetSnapshot) => PresetSnapshot) | undefined
  const generalSaves: unknown[] = []
  const diagnostics: Array<{ level: string, operation: string }> = []
  const prepare = async (snapshot: ReturnType<typeof createDefaultPresetSnapshot>) => {
    const result = clonePreset(snapshot)
    result.appearance.dmeloperSkinDataUrl ??= 'data:image/png;base64,YQ=='
    return result
  }
  const emit = async (event: string, payload: unknown) => {
    if (event !== PRESET_APPLY_REQUEST) return
    applies++
    const request = payload as PresetApplyRequest
    if (editorsLocked.value && initialState?.window.visible === false) assert.equal(request.restoreVisibility, false, 'native request preserves hidden state')
    await applyHold
    const failed = applyFails || applyFailuresRemaining > 0
    if (applyFailuresRemaining > 0) applyFailuresRemaining--
    const accepted = applyCorrection?.(clonePreset(request.snapshot)) ?? request.snapshot
    applyCorrection = undefined
    if (!failed) store.$patch(() => applyPresetSnapshot(store, accepted, undefined, request.restoreVisibility ?? true))
    listeners.get(PRESET_APPLY_RESPONSE)?.({ payload: {
      requestId: request.requestId,
      success: !failed,
      restored,
      revision: store.activePet3dPreset.viewportModeRevision,
      snapshot: clonePreset(accepted),
    } })
  }
  const module = { exports: {} as { usePresetManager: () => PresetManager } }
  runInNewContext(source, {
    exports: module.exports,
    Error,
    module,
    console,
    crypto: globalThis.crypto,
    performance,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    ...runtimeGlobals,
    require: (id: string) => {
      if (id === '@/services/diagnostics') return { reportDiagnostic: (level: string, operation: string) => diagnostics.push({ level, operation }) }
      if (id === 'vue') return { ...vue, onMounted: (callback: () => Promise<void>) => mounted.push(callback), onBeforeUnmount: (callback: () => void) => unmounted.push(callback) }
      if (id === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key.split('.').at(-1) }) }
      if (id === '@tauri-apps/api/event') {
        return { emitTo: (_window: string, event: string, payload: unknown) => emit(event, payload), listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
          if (subscriptionFailures.response) {
            subscriptionFailures.response--
            throw new Error('response subscription unavailable')
          }
          listeners.set(event, handler)
          return () => listeners.delete(event)
        } }
      }
      if (id === '@tauri-apps/api/webviewWindow') {
        return { getCurrentWebviewWindow: () => ({
          // Use the installed SDK wrapper: it destroys the window after an
          // observer unless that frontend CloseRequestedEvent is prevented.
          onCloseRequested: (handler: Parameters<Window['onCloseRequested']>[0]) => Window.prototype.onCloseRequested.call({
            listen: async (event: string, callback: EventCallback<unknown>) => {
              assert.equal(event, 'tauri://close-requested')
              if (subscriptionFailures.close) {
                subscriptionFailures.close--
                throw new Error('close subscription unavailable')
              }
              closeListeners++
              closeEventHandlers.add(callback)
              return () => {
                closeEventHandlers.delete(callback)
                closeListeners--
              }
            },
            destroy: async () => {
              windowDestroyRequests++
              throw new Error('Window destroy is not permitted')
            },
          } as unknown as Window, handler),
        }) }
      }
      if (id === '@tauri-store/pinia') {
        return {
          getStoreState: async () => backendRead ? backendRead() : clonePreset(store.$state),
          saveAllNow: async () => {
            await saveHold
            if (saveFailureOnceAfter !== undefined && saves.length >= saveFailureOnceAfter) {
              saveFailureOnceAfter = undefined
              throw new Error('disk full once')
            }
            if (saveFails || (saveFailureAfter !== undefined && saves.length >= saveFailureAfter)) throw new Error('disk full')
            saves.push(clonePreset(store.$state))
            generalSaves.push(clonePreset(general.$state))
          },
        }
      }
      if (id === '@/features/stateSafety/bridge') return { editorsLocked, stateOwners, initializePetForStartup, registerPresetFlush }
      if (id === '@/stores/block') return { useBlockStore: () => store }
      if (id === '@/stores/general') return { useGeneralStore: () => general }
      if (id === '@/plugins/process') {
        return { registerAppProcessOwner: (ready: () => boolean) => {
          quitReady = ready
          return () => {
            quitReady = undefined
          }
        } }
      }
      if (id === '@/features/presets/model') return presetModel
      if (id === '@/features/presets/editIntent') return editIntent
      if (id === '@/features/presets/editRequests') return editRequests
      if (id === '@/features/presets/operations') return presetOperations
      if (id === '@/features/presets/skin') {
        return {
          preparePresetSkin: skinPreparer ?? prepare,
          restorePresetSkin: async (snapshot: PresetSnapshot) => {
            restoredSkins++
            return (skinPreparer ?? prepare)(snapshot)
          },
        }
      }
      if (id === '@/features/presets/transfer') {
        return {
          PresetTransferError,
          exportPortablePreset: async (name: string, snapshot: PresetSnapshot, mode: PresetExportMode, sourceSettings?: Record<string, unknown>) => {
            transfer.exports.push({ name, snapshot: clonePreset(snapshot), mode })
            if (mode === 'nickname' && !snapshot.appearance.minecraftSkinUsername) throw new PresetTransferError('invalidNickname')
            return {
              ...clonePreset(transfer.document),
              name,
              ...(sourceSettings ? { sourceSettings: clonePreset(sourceSettings) } : {}),
              settings: clonePreset({ preset: snapshot.preset, mirror: snapshot.mirror, opacity: snapshot.opacity, eyebrowAnimationEnabled: snapshot.eyebrowAnimationEnabled }),
              skin: mode === 'nickname'
                ? { mode, nickname: snapshot.appearance.minecraftSkinUsername! }
                : { mode: 'image', pngBase64: snapshot.appearance.dmeloperSkinDataUrl?.split(',')[1] ?? 'YQ==', model: snapshot.appearance.dmeloperSkinModel === 'slim' ? 'slim' : 'wide' },
            } satisfies PortablePetPreset
          },
          resolvePortablePreset: async (document: PortablePetPreset) => {
            transfer.resolved.push(clonePreset(document))
            if (transfer.skinError) throw transfer.skinError
            const pngBase64 = document.skin.mode === 'nickname' ? transfer.nicknamePng : document.skin.pngBase64
            const model = document.skin.mode === 'nickname' ? transfer.nicknameModel : document.skin.model
            const nickname = document.skin.nickname
            const snapshot: PresetSnapshot = {
              ...clonePreset(document.settings),
              appearance: {
                selectedModelId: 'dmeloper',
                dmeloperSkinDataUrl: `data:image/png;base64,${pngBase64}`,
                dmeloperSkinModel: model,
                useDefaultDmeloperSkin: true,
                ...(nickname ? { minecraftSkinUsername: nickname } : {}),
              },
            }
            return { snapshot, pngBase64, pngSha256: 'c'.repeat(64), model, thumbnailPngBase64: 'ZA==', nickname, source: document.skin.mode }
          },
        }
      }
      if (id === '@/services/presetTransfer') {
        const assertSaved = (expected: PresetImportPrevious) => {
          const saved = saves.at(-1) as ReturnType<typeof useBlockStore>['$state']
          assert.ok(saved, 'the manager must save before requesting native completion')
          assert.deepEqual(saved.presetCollection, expected.collection)
          assert.deepEqual(presetModel.capturePresetSnapshot(saved as ReturnType<typeof useBlockStore>), expected.snapshot)
          assert.equal(saved.window.visible, expected.visible)
          return clonePreset(saved)
        }
        return {
          readPresetImport: async () => {
            if (transfer.journalReadError) throw transfer.journalReadError
            return transfer.journal ? clonePreset(transfer.journal) : undefined
          },
          readPortablePreset: async (file: File | string) => {
            transfer.reads.push(file)
            if (transfer.failure === 'read') throw new PresetTransferError('invalidFormat')
            const doc = clonePreset(transfer.readDocument?.(file) ?? transfer.document)
            return { ...doc, sourceSettings: clonePreset(doc.settings), settings: projectPresetSettings(doc.settings) }
          },
          writePortablePreset: async (document: PortablePetPreset) => {
            transfer.written.push(clonePreset(document))
            if (transfer.writeError) throw transfer.writeError
            return transfer.writeResult
          },
          preparePresetImport: async (operationId: string, presetId: string, previous: PresetImportPrevious, request: SkinLibraryStoreRequest) => {
            assertSaved(previous)
            transfer.prepared.push(clonePreset({ operationId, presetId, previous, request }))
            if (transfer.failure === 'prepare') throw new PresetTransferError('library')
            assert.notEqual(transfer.journal?.phase, 'prepared', 'an import must finish recovery before opening another journal')
            transfer.journal = { operationId, phase: 'prepared', previous: clonePreset(previous) }
            await transfer.prepareHold
            if (transfer.failure === 'prepareAfterJournal') throw new PresetTransferError('library')
            return transfer.entryId
          },
          finishPresetImport: async (operationId: string, commit: boolean, expected: PresetImportPrevious) => {
            const saved = assertSaved(expected)
            transfer.finished.push(clonePreset({ operationId, commit, expected, saved }))
            assert.equal(transfer.journal?.operationId, operationId)
            if (commit) {
              await transfer.commitHold
              if (transfer.failure === 'commit') throw new PresetTransferError('save')
              transfer.journal!.phase = 'committed'
              if (transfer.loseCommitReply) throw new Error('lost native reply')
            } else {
              if (transfer.rollbackFails) throw new PresetTransferError('recovery')
              assert.deepEqual(expected, transfer.journal!.previous, 'rollback must restore the complete prepared state')
              transfer.journal = undefined
            }
          },
        }
      }
      if (id === '@/features/presets/thumbnail') {
        return { createPresetThumbnailBatch: () => {
          thumbnailBatches++
          activeThumbnailBatches++
          maxActiveThumbnailBatches = Math.max(maxActiveThumbnailBatches, activeThumbnailBatches)
          let released = false
          return {
            render: async (snapshot: ReturnType<typeof createDefaultPresetSnapshot>) => {
              rendered++
              await thumbnailHold
              if (released) throw new Error('Thumbnail batch disposed')
              if (thumbnailFails) throw new Error('WebGL unavailable')
              return `data:image/png;base64,preview-${snapshot.preset.cameraZoomPercent}`
            },
            dispose: () => {
              if (released) return
              released = true
              activeThumbnailBatches--
            },
          }
        } }
      }
      if (id.startsWith('@/')) return require(fileURLToPath(new URL(`../${id.slice(2)}`, import.meta.url)))
      return require(id)
    },
  })
  const manager = module.exports.usePresetManager()
  beforeMount?.(() => unmounted.forEach(callback => callback()))
  for (const mount of mounted) await mount()
  return {
    store,
    general,
    generalSaves,
    manager,
    saves,
    diagnostics,
    readBackend: (read?: () => Promise<Record<string, unknown>>) => {
      backendRead = read
    },
    transfer,
    subscriptions: () => ({ response: listeners.size, close: closeListeners }),
    requestWindowClose: async () => {
      for (const handler of [...closeEventHandlers]) {
        await handler({ event: 'tauri://close-requested', id: 1, payload: null })
      }
    },
    windowDestroyRequests: () => windowDestroyRequests,
    quitReady: () => quitReady?.() ?? false,
    applies: () => applies,
    rendered: () => rendered,
    restoredSkins: () => restoredSkins,
    thumbnailBatches: () => ({ total: thumbnailBatches, active: activeThumbnailBatches, maxActive: maxActiveThumbnailBatches }),
    failThumbnail: (value: boolean) => {
      thumbnailFails = value
    },
    emitEdit: editRequests.requestPresetEdit,
    failRestore: (value: boolean) => {
      restored = !value
    },
    failSave: (value: boolean) => {
      saveFails = value
      saveFailureAfter = undefined
    },
    failSaveAfter: (count: number) => {
      saveFailureAfter = saves.length + count
    },
    failSaveOnceAfter: (count: number) => {
      saveFailureOnceAfter = saves.length + count
    },
    failApply: (value: boolean) => {
      applyFails = value
    },
    correctNextApply: (correction: (snapshot: PresetSnapshot) => PresetSnapshot) => {
      applyCorrection = correction
    },
    failNextApply: () => {
      applyFailuresRemaining = 1
    },
    holdSave: () => {
      let release!: () => void
      saveHold = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        saveHold = undefined
        release()
      }
    },
    holdThumbnail: () => {
      let release!: () => void
      thumbnailHold = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        thumbnailHold = undefined
        release()
      }
    },
    holdApply: () => {
      let release!: () => void
      applyHold = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
    },
    dispose: () => unmounted.forEach(callback => callback()),
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate(), 'expected asynchronous preset state')
}

describe('live preset manager', () => {
  it('restores missing skin-library content only when an explicit preset apply is accepted', async () => {
    const h = await harness()
    try {
      h.manager.setListVisible(true)
      await waitFor(() => Object.keys(h.manager.cardPending.value).length === 0)
      assert.equal(h.restoredSkins(), 0, 'startup and visible previews must stay read-only')
      assert.equal(await h.manager.create('Captured'), true)
      assert.equal(await h.manager.duplicate('initial'), true)
      assert.ok(await h.manager.importPreset('shared.petpreset'))
      assert.equal(h.restoredSkins(), 0, 'saving, copying and unapplied imports cannot restore saved user skins')
      assert.equal(await h.manager.activate('initial'), true)
      assert.equal(h.restoredSkins(), 1)
    } finally {
      h.dispose()
    }
  })

  it('keeps bundled scenes available across restarts and protects every catalog mutation while allowing apply and copy', async () => {
    let h = await harness(undefined, undefined, undefined, undefined, undefined, true)
    try {
      const scenes = clonePreset(h.manager.entries.value)
      const source = scenes[2]
      assert.equal(source.origin, 'builtin')
      assert.equal(await h.manager.rename(source.id, 'Renamed'), false)
      assert.equal(await h.manager.remove(source.id), false)
      assert.equal(await h.manager.toggleFavorite(source.id), false)
      assert.equal(await h.manager.move(source.id, -1), false)
      assert.equal(await h.manager.reorder(source.id, scenes[0].id), false)
      assert.equal(await h.manager.exportPreset(source.id, 'image'), 'error')
      assert.equal(await h.manager.create(source.name), false, 'names include the visible bundled registry')
      assert.deepEqual(clonePreset(h.manager.entries.value), scenes)
      assert.equal(await h.manager.activate(source.id), true)
      assert.equal(h.store.activePet3dPreset.petRotationDegrees, -16.8)
      assert.equal(h.store.presetCollection?.entries.length, 0)
      assert.equal(await h.manager.duplicate(source.id), true)
      const copy = userEntries(h.manager)[0]
      assert.equal(copy.origin, 'user')
      assert.equal(copy.favorite, false)
      assert.equal(copy.name, `${source.name} 2`)
      assert.notEqual(copy.id, source.id)
      assert.ok(copy.snapshot.appearance.dmeloperSkinDataUrl, 'a user copy retains its skin bytes')
      assert.deepEqual(copy.snapshot.preset, source.snapshot.preset)
      assert.equal(await h.manager.reorder(copy.id, source.id), false)
      assert.equal(await h.manager.rename(copy.id, source.name), false)
      assert.deepEqual(clonePreset(h.manager.entries.value.filter(entry => entry.origin === 'builtin')), scenes)
      assert.ok(h.store.presetCollection?.entries.every(entry => !('origin' in entry) && !entry.id.startsWith('builtin:')))
      const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useBlockStore>['$state']
      h.dispose()
      h = await harness(saved)
      assert.equal(h.manager.entries.value.length, 5)
      assert.deepEqual(clonePreset(h.manager.entries.value.filter(entry => entry.origin === 'builtin')), scenes)
      assert.equal(await h.manager.remove(copy.id), true)
      assert.equal(h.manager.entries.value.length, 4)
    } finally {
      h.dispose()
    }
  })

  it('preserves user snapshots, ordering and favorites through a settings-only reset', async () => {
    const h = await harness()
    try {
      assert.equal(await h.manager.toggleFavorite('initial'), true)
      const original = clonePreset(h.store.presetCollection)
      h.store.activePet3dPreset.cameraZoomPercent = 175
      await withPresetReset(async () => h.store.resetAllSettings())
      await vue.nextTick()
      assert.deepEqual(h.store.presetCollection, original)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 100)
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.manager.entries.value[0].id, 'initial')
      assert.equal(await h.manager.retry(), true)
      assert.deepEqual((h.saves.at(-1) as ReturnType<typeof useBlockStore>['$state']).presetCollection, original)
    } finally {
      h.dispose()
    }
  })

  it('keeps saved-card lookup work linear for a large catalog', async (t) => {
    const h = await harness()
    try {
      const count = 256
      const snapshot = clonePreset(userEntries(h.manager)[0].snapshot)
      h.store.presetCollection!.entries = Array.from({ length: count }, (_, index) => ({
        id: `catalog-${index}`,
        name: `Preset ${index}`,
        favorite: index % 2 === 0,
        snapshot: clonePreset(snapshot),
      }))
      assert.equal(await h.manager.retry(), true)
      let comparisons = 0
      const originalFind = Array.prototype.find
      // Count actual lookup scans synchronously; restore before any async work.
      // eslint-disable-next-line no-extend-native
      Array.prototype.find = function (this: any[], predicate: (value: any, index: number, array: any[]) => unknown, thisArg?: any) {
        return originalFind.call(this, (value, index, array) => {
          comparisons++
          return predicate.call(thisArg, value, index, array)
        })
      }
      let pending: Record<string, 'saving' | 'thumbnail'>
      try {
        pending = h.manager.cardPending.value
      } finally {
        // eslint-disable-next-line no-extend-native
        Array.prototype.find = originalFind
      }
      assert.equal(Object.keys(pending).length, count + 4)
      assert.ok(Object.values(pending).every(value => value === 'thumbnail'))
      t.diagnostic(`saved-card array scan comparisons for ${count} cards: ${comparisons}`)
      assert.ok(comparisons <= count * 2, 'each card must not rescan the whole saved catalog')
      h.store.presetCollection!.entries[0].name = 'Unsaved rename'
      assert.equal(h.manager.cardPending.value['catalog-0'], 'saving')
      assert.equal(h.manager.cardPending.value['catalog-1'], 'thumbnail')
    } finally {
      h.dispose()
    }
  })

  it('drops thumbnail failure state when its preset is deleted', async () => {
    const h = await harness()
    try {
      h.failThumbnail(true)
      h.manager.setListVisible(true)
      await waitFor(() => Object.keys(h.manager.thumbnailErrors.value).length === h.manager.entries.value.length)
      const ids = userEntries(h.manager).map(entry => entry.id)
      for (const id of ids) {
        assert.equal(await h.manager.remove(id), true)
        assert.equal(h.manager.thumbnailErrors.value[id], undefined)
      }
      assert.equal(Object.keys(h.manager.thumbnailErrors.value).length, 4, 'bundled previews remain after every user entry is removed')
    } finally {
      h.dispose()
    }
  })

  for (const fails of [false, true]) {
    it(`keeps completed thumbnail lookup work linear for a large catalog when rendering ${fails ? 'fails' : 'succeeds'}`, async (t) => {
      let indexBuilds = 0
      let indexRows = 0
      let snapshotStrings = 0
      class MeasuredMap extends Map<any, any> {
        constructor(values?: Iterable<readonly [any, any]> | null) {
          super(values)
          if (this.size && [...this.values()].every(value => value?.origin && value?.snapshot)) {
            indexBuilds++
            indexRows += this.size
          }
        }
      }
      const h = await harness(undefined, undefined, undefined, undefined, undefined, false, {
        Map: MeasuredMap,
        JSON: { parse: JSON.parse, stringify: (value: any) => {
          if (value?.appearance && value?.preset) snapshotStrings++
          return JSON.stringify(value)
        } },
      })
      let restoreFind = () => {}
      try {
        const count = 256
        const snapshot = clonePreset(userEntries(h.manager)[0].snapshot)
        h.store.presetCollection!.entries = Array.from({ length: count }, (_, index) => ({
          id: `catalog-${index}`,
          name: `Preset ${index}`,
          favorite: false,
          snapshot: clonePreset(snapshot),
        }))
        assert.equal(await h.manager.retry(), true)
        const entries = h.manager.entries.value
        const prototype = Object.getPrototypeOf(entries) as Array<any>
        const find = prototype.find
        let comparisons = 0
        prototype.find = function (this: any[], predicate: (value: any, index: number, array: any[]) => unknown, thisArg?: any) {
          return find.call(this, (value, index, array) => {
            if (this === entries) comparisons++
            return predicate.call(thisArg, value, index, array)
          })
        }
        restoreFind = () => {
          prototype.find = find
        }
        indexBuilds = 0
        indexRows = 0
        snapshotStrings = 0
        h.failThumbnail(fails)
        h.manager.setListVisible(true)
        await waitFor(() => Object.keys(fails ? h.manager.thumbnailErrors.value : h.manager.thumbnails.value).length === count + 4)
        assert.equal(h.manager.entries.value, entries, 'thumbnail cache completions must not invalidate the catalog index')
        t.diagnostic(`completed ${count + 4} previews: ${comparisons} scan comparisons, ${indexBuilds} index builds, ${indexRows} indexed rows, ${snapshotStrings} key serializations`)
        assert.ok(comparisons + indexRows <= (count + 4) * 2, 'completed previews must not rescan or rebuild the entire catalog for each result')
        assert.equal(indexBuilds, 1)
        assert.equal(indexRows, count + 4)
        assert.equal(snapshotStrings, (count + 4) * 3, 'indexing must preserve the existing snapshot validation work')
        assert.deepEqual(h.thumbnailBatches(), { total: 1, active: 0, maxActive: 1 })
      } finally {
        restoreFind()
        h.dispose()
      }
    })
  }

  it('invalidates the thumbnail index when a preset is deleted while its preview is preparing', async () => {
    let prepared = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await harness(undefined, async (snapshot) => {
      if (++prepared === 2) await held
      return clonePreset(snapshot)
    })
    try {
      const [first, second] = h.manager.entries.value
      h.manager.setListVisible(true)
      await waitFor(() => prepared === 2)
      assert.ok(h.manager.thumbnails.value[first.id], 'the index has already validated the first result')
      assert.equal(await h.manager.remove(second.id), true)
      release()
      await waitFor(() => Object.keys(h.manager.thumbnails.value).length === 5)
      assert.equal(h.manager.thumbnails.value[second.id], undefined, 'a delayed result must consult the current catalog')
      assert.equal(h.manager.thumbnailErrors.value[second.id], undefined)
    } finally {
      release()
      h.dispose()
    }
  })

  for (const laterFailure of ['autosave', 'rename'] as const) {
    it(`keeps a later ${laterFailure} failure independent from a retained create retry`, async (t) => {
      const h = await harness()
      const ids: string[] = []
      const randomUUID = crypto.randomUUID.bind(crypto)
      t.mock.method(crypto, 'randomUUID', () => {
        const id = randomUUID()
        ids.push(id)
        return id
      })
      try {
        h.store.activePet3dPreset.cameraZoomPercent = 174
        h.failSaveOnceAfter(1)
        assert.equal(await h.manager.create('Captured settings'), false)
        const requestId = ids[0]
        assert.equal(h.manager.hasIndependentError.value, false, 'the same create transaction needs only its captured-request retry')
        h.store.activePet3dPreset.cameraZoomPercent = 119
        h.failSave(true)
        if (laterFailure === 'autosave') {
          await waitFor(() => h.manager.status.value === 'error')
        } else {
          assert.equal(await h.manager.rename('initial', 'Renamed'), false)
        }
        assert.equal(h.manager.hasIndependentError.value, true)
        assert.equal(h.manager.createError.value, 'pages.preference.presets.errors.create')
        h.failSave(false)
        assert.equal(await h.manager.retry(), true)
        assert.equal(h.manager.hasIndependentError.value, false)
        assert.equal(h.manager.error.value, undefined)
        assert.equal(h.manager.createName.value, 'Captured settings')
        assert.equal(h.manager.canRetryCreate.value, true)
        assert.equal(await h.manager.retryCreate(), true)
        const created = userEntries(h.manager).find(entry => entry.id === requestId)!
        assert.ok(created, 'ordinary save retry retains the original create request ID')
        assert.equal(created.snapshot.preset.cameraZoomPercent, 174)
        assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 119)
        assert.equal(h.manager.createError.value, undefined)
      } finally {
        h.dispose()
      }
    })
  }

  it('never lets a later create name rejection own an earlier save failure and clears both on reset', async () => {
    const h = await harness()
    try {
      h.failSave(true)
      h.store.model.maxFPS = 41
      await waitFor(() => h.manager.status.value === 'error')
      assert.equal(await h.manager.create(userEntries(h.manager)[0].name), false)
      assert.equal(h.manager.createNeedsName.value, true)
      assert.equal(h.manager.hasIndependentError.value, true)
      h.failSave(false)
      await withPresetReset(async () => h.store.resetAllSettings({ deleteSkins: false, resetPresets: true }))
      await waitFor(() => h.manager.status.value === 'saved')
      assert.equal(h.manager.error.value, undefined)
      assert.equal(h.manager.hasIndependentError.value, false)
      assert.equal(h.manager.createError.value, undefined)
      assert.equal(h.manager.createName.value, undefined)
      assert.equal(h.manager.canRetryCreate.value, false)
    } finally {
      h.dispose()
    }
  })

  it('supersedes an obsolete autosave and acknowledges the latest edit without a false error', async () => {
    const h = await harness()
    let readStarted = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const statuses: string[] = []
    const stop = vue.watch(h.manager.status, value => statuses.push(value), { flush: 'sync' })
    try {
      h.readBackend(async () => {
        readStarted = true
        await held
        return clonePreset({ ...h.store.$state })
      })
      h.store.model.maxFPS = 41
      await waitFor(() => readStarted)
      h.store.model.maxFPS = 42
      release()
      await waitFor(() => h.manager.status.value === 'saved')
      assert.equal((h.saves.at(-1) as ReturnType<typeof useBlockStore>['$state']).model.maxFPS, 42)
      assert.equal(statuses.includes('error'), false)
      assert.equal(h.diagnostics.some(entry => entry.operation === 'presets.save'), false)
    } finally {
      release()
      stop()
      h.dispose()
    }
  })

  it('retries failed creation with its captured settings and never duplicates a completed request', async () => {
    const h = await harness()
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 174
      h.failSave(true)
      assert.equal(await h.manager.create('Captured settings'), false)
      assert.equal(h.manager.canRetryCreate.value, true)
      assert.equal(h.manager.createNeedsName.value, false)
      h.store.activePet3dPreset.cameraZoomPercent = 120
      h.failSave(false)
      assert.equal(await h.manager.retryCreate(), true)
      const created = userEntries(h.manager).filter(entry => entry.name === 'Captured settings')
      assert.equal(created.length, 1)
      assert.equal(created[0].snapshot.preset.cameraZoomPercent, 174)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 120)
      assert.equal(h.manager.createError.value, undefined)
      assert.equal(await h.manager.retryCreate(), false)
      assert.equal(userEntries(h.manager).filter(entry => entry.name === 'Captured settings').length, 1)
    } finally {
      h.dispose()
    }
  })

  it('retains a rejected name request for correction without recapturing later settings', async () => {
    const h = await harness()
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 168
      assert.equal(await h.manager.create(userEntries(h.manager)[0].name), false)
      assert.equal(h.manager.createNeedsName.value, true)
      assert.equal(h.manager.createError.value, 'pages.preference.presets.errors.duplicateName')
      h.store.activePet3dPreset.cameraZoomPercent = 111
      assert.equal(await h.manager.retryCreate('Corrected name'), true)
      assert.equal(userEntries(h.manager).find(entry => entry.name === 'Corrected name')!.snapshot.preset.cameraZoomPercent, 168)
    } finally {
      h.dispose()
    }
  })

  it('keeps preference close as native hide and flushes pending edits through the real SDK close wrapper', async () => {
    const h = await harness()
    try {
      const saves = h.saves.length
      h.store.activePet3dPreset.cameraZoomPercent = 176
      await h.requestWindowClose()
      await waitFor(() => h.saves.length > saves)
      assert.equal(h.windowDestroyRequests(), 0)
      const saved = h.saves.at(-1) as ReturnType<typeof useBlockStore>['$state']
      assert.equal(saved.customization3d.preset.cameraZoomPercent, 176)
      assert.equal(h.manager.ready.value, true)
      assert.deepEqual(h.subscriptions(), { response: 1, close: 1 })
      await h.requestWindowClose()
      assert.equal(h.windowDestroyRequests(), 0)
    } finally {
      h.dispose()
    }
  })

  it('prevents preference close from destroying a busy owner without bypassing its save gate', async () => {
    const h = await harness()
    const release = h.holdApply()
    try {
      const switching = h.manager.activate(DEFAULT_PRESET_ID)
      await waitFor(() => h.applies() === 1)
      assert.equal(h.manager.busy.value, true)
      const saves = h.saves.length
      await h.requestWindowClose()
      assert.equal(h.windowDestroyRequests(), 0)
      assert.equal(h.saves.length, saves)
      assert.equal(h.manager.busy.value, true)
      release()
      assert.equal(await switching, true)
      assert.equal(h.manager.ready.value, true)
      await h.requestWindowClose()
      assert.equal(h.windowDestroyRequests(), 0)
    } finally {
      release()
      h.dispose()
    }
  })

  it('accepts renderer skin resolution only for the current selection and keeps the save freeze intact', async () => {
    const h = await harness()
    try {
      h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
      h.store.customization3d.dmeloperSkinModel = 'auto'
      const correction = { resolvedSkinModel: { modelId: 'dmeloper', skinDataUrl: 'data:image/png;base64,YQ==', requested: 'auto', resolved: 'slim' } }
      h.manager.setListVisible(false)
      editorsLocked.value = true
      h.emitEdit(correction)
      assert.equal(h.store.customization3d.dmeloperSkinModel, 'auto')
      editorsLocked.value = false
      h.emitEdit({ resolvedSkinModel: { ...correction.resolvedSkinModel, skinDataUrl: 'data:image/png;base64,Yg==' } })
      assert.equal(h.store.customization3d.dmeloperSkinModel, 'auto')
      h.emitEdit(correction)
      assert.equal(h.store.customization3d.dmeloperSkinModel, 'slim')
      h.emitEdit({ resolvedSkinModel: { ...correction.resolvedSkinModel, resolved: 'wide' } })
      assert.equal(h.store.customization3d.dmeloperSkinModel, 'slim', 'a later manual/accepted preference wins over a stale result')
      for (const resolvedSkinModel of [null, 1, {}, { ...correction.resolvedSkinModel, resolved: 'invalid' }]) {
        assert.doesNotThrow(() => h.emitEdit({ resolvedSkinModel }))
        assert.equal(h.store.customization3d.dmeloperSkinModel, 'slim')
      }
      assert.equal(await h.manager.retry(), true)
      assert.equal((h.saves.at(-1)! as ReturnType<typeof useBlockStore>['$state']).customization3d.dmeloperSkinModel, 'slim')
    } finally {
      editorsLocked.value = false
      h.dispose()
    }
  })

  it('keeps editors active during readback while preserving preset and mutation barriers', async () => {
    const h = await harness()
    const releaseQuery = presetOperations.beginPresetNativeQuery(() => {})
    let releaseEdit: (() => void) | undefined
    try {
      assert.equal(h.manager.busy.value, true, 'preset transactions still wait for native readback')
      assert.equal(h.manager.editorsBusy.value, false, 'readback cannot make a focused slider inert')
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), false)
      h.store.customization3d.preset.cameraZoomPercent = 156
      releaseEdit = presetOperations.beginPresetNativeEdit()
      assert.equal(h.manager.editorsBusy.value, true, 'actual native mutations retain the editor barrier')
      releaseQuery()
      assert.equal(h.manager.busy.value, true)
      assert.equal(h.manager.editorsBusy.value, true)
      releaseEdit()
      assert.equal(h.manager.busy.value, false)
      assert.equal(h.manager.editorsBusy.value, false)
      assert.equal(presetOperations.presetNativeMutationPending.value, 0)
      assert.equal(await h.manager.retry(), true)
      assert.equal((h.saves.at(-1)! as ReturnType<typeof useBlockStore>['$state']).customization3d.preset.cameraZoomPercent, 156, 'edits during readback survive the save barrier')
    } finally {
      releaseQuery()
      releaseEdit?.()
      h.dispose()
    }
  })

  it('applies and saves desktop visibility as one owner without changing presets or broadcast output', async () => {
    const h = await harness()
    try {
      const before = clonePreset(h.store.presetCollection)
      for (const enabled of [false, true]) {
        h.general.broadcast.enabled = enabled
        h.general.broadcast.showOnDesktop = false
        for (const desktopVisible of [true, false]) {
          h.emitEdit({ desktopVisible })
          assert.equal(h.store.window.visible, desktopVisible)
          assert.equal(h.general.broadcast.showOnDesktop, enabled && desktopVisible)
          assert.equal(h.general.broadcast.enabled, enabled)
          assert.equal(await h.manager.retry(), true)
          const saved = h.saves.at(-1) as ReturnType<typeof useBlockStore>['$state']
          const general = h.generalSaves.at(-1) as ReturnType<typeof useGeneralStore>['$state']
          assert.equal(saved.window.visible, desktopVisible)
          assert.equal(general.broadcast.showOnDesktop, enabled && desktopVisible)
          assert.deepEqual(saved.presetCollection, before)
        }
      }
      for (const desktopVisible of [undefined, 'true', 1, null]) h.emitEdit({ desktopVisible })
      assert.equal(h.store.window.visible, false)
      assert.equal(h.general.broadcast.showOnDesktop, false)
      editorsLocked.value = true
      h.emitEdit({ desktopVisible: true })
      editorsLocked.value = false
      const releaseNative = presetOperations.beginPresetNativeEdit()
      try {
        h.emitEdit({ desktopVisible: true })
      } finally {
        releaseNative()
      }
      assert.equal(h.store.window.visible, false)
      assert.equal(h.general.broadcast.showOnDesktop, false)
      // Existing shortcut/basic-visibility requests retain their independent meaning.
      h.emitEdit({ visible: true })
      assert.equal(h.store.window.visible, true)
      assert.equal(h.general.broadcast.showOnDesktop, false)
    } finally {
      editorsLocked.value = false
      h.dispose()
    }
  })

  it('persists desktop context-menu window requests without editing a visual preset', async () => {
    const h = await harness(undefined, undefined, undefined, undefined, undefined, true)
    try {
      h.emitEdit({ keepInScreen: !h.store.window.keepInScreen })
      h.emitEdit({ alwaysOnTop: !h.store.window.alwaysOnTop })
      assert.equal(userEntries(h.manager).length, 0)
      assert.equal(await h.manager.retry(), true)
      const saved = h.saves.at(-1)! as ReturnType<typeof useBlockStore>['$state']
      assert.equal(saved.window.keepInScreen, h.store.window.keepInScreen)
      assert.equal(saved.window.alwaysOnTop, h.store.window.alwaysOnTop)
    } finally {
      h.dispose()
    }
  })

  it('starts a fresh installation with authored settings and four bundled scenes outside the user catalog', async () => {
    const h = await harness(undefined, undefined, undefined, undefined, undefined, true)
    try {
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.deepEqual(userEntries(h.manager), [])
      assert.equal(h.manager.entries.value.length, 4)
      assert.ok(h.manager.entries.value.every(entry => entry.origin === 'builtin'))
      assert.deepEqual(h.store.presetCollection?.entries, [])
      assert.equal(h.store.activePet3dPreset.autoViewportPaddingPixels, 2)
      assert.equal(h.store.activePet3dPreset.dmeloperEyebrows.depthPercent, 50)
      assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#FFDFCE')
      assert.equal(h.applies(), 0)
      assert.equal(h.saves.length, 1)
    } finally {
      h.dispose()
    }
  })

  it('preserves catalog-free settings and persists edits without creating a preset', async () => {
    setActivePinia(createPinia())
    const previous = useBlockStore()
    previous.init()
    previous.activePet3dPreset.autoViewportPaddingPixels = 12
    previous.window.visible = false
    const h = await harness(clonePreset(previous.$state))
    let saved!: ReturnType<typeof useBlockStore>['$state']
    try {
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.deepEqual(userEntries(h.manager), [])
      assert.equal(h.store.activePet3dPreset.autoViewportPaddingPixels, 12)
      assert.equal(h.store.window.visible, false)
      h.emitEdit({ key: 'cameraZoomPercent', value: 150 })
      h.store.updateDmeloperPalmColor('#123456')
      assert.equal(await h.manager.retry(), true)
      saved = h.saves.at(-1) as typeof saved
      assert.equal(saved.presetCollection?.activeId, null)
      assert.equal(saved.presetCollection?.entries.length, 0)
      assert.equal(h.applies(), 0)
    } finally {
      h.dispose()
    }
    const restarted = await harness(saved)
    try {
      assert.equal(restarted.store.presetCollection?.activeId, null)
      assert.equal(userEntries(restarted.manager).length, 0)
      assert.equal(restarted.store.activePet3dPreset.cameraZoomPercent, 150)
      assert.equal(restarted.store.activePet3dPreset.dmeloperPalmColor, '#123456')
      assert.equal(restarted.store.window.visible, false)
      assert.equal(restarted.applies(), 0)
    } finally {
      restarted.dispose()
    }
  })

  it('does not resume an explicit apply after disposal during skin preparation', async () => {
    let release!: () => void
    const delayed = new Promise<void>((resolve) => {
      release = resolve
    })
    let preparing = false
    const h = await harness(undefined, async (snapshot) => {
      preparing = true
      await delayed
      return clonePreset(snapshot)
    })
    const applying = h.manager.activate('initial')
    await waitFor(() => preparing)
    h.dispose()
    const before = clonePreset(h.store.$state)
    release()
    assert.equal(await applying, false)
    assert.deepEqual(clonePreset(h.store.$state), before)
    assert.equal(h.applies(), 0)
    assert.deepEqual(h.subscriptions(), { response: 0, close: 0 })
  })

  for (const failed of ['response', 'close'] as const) {
    it(`releases partial ${failed} subscription setup and restores both listeners before retry becomes ready`, async () => {
      const h = await harness(undefined, undefined, undefined, undefined, { [failed]: 1 })
      try {
        assert.equal(h.manager.ready.value, false)
        assert.deepEqual(h.subscriptions(), { response: 0, close: 0 })
        assert.equal(await h.manager.retry(), true)
        assert.deepEqual(h.subscriptions(), { response: 1, close: 1 })
        assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), true)
        assert.equal(h.store.presetCollection?.activeId, null)
      } finally {
        h.dispose()
      }
      assert.deepEqual(h.subscriptions(), { response: 0, close: 0 })
    })
  }

  it('cycles each menu stage, wraps intermediate and signed values, and persists rapid commands in order', async () => {
    const h = await harness()
    let saved!: ReturnType<typeof useBlockStore>['$state']
    try {
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), true)
      const builtin = clonePreset(userEntries(h.manager).find(entry => entry.id === 'initial')!)
      const zooms: number[] = []
      for (let index = 0; index < 8; index++) {
        h.emitEdit({ cycle: 'cameraZoomPercent' })
        zooms.push(h.store.activePet3dPreset.cameraZoomPercent)
      }
      assert.deepEqual(zooms, [125, 150, 200, 25, 50, 75, 100, 125])
      const rotations: number[] = []
      for (let index = 0; index < 8; index++) {
        h.emitEdit({ cycle: 'sceneRotationOffsetDegrees' })
        rotations.push(h.store.activePet3dPreset.sceneRotationOffsetDegrees)
      }
      assert.deepEqual(rotations, [45, 90, 135, 180, 225, 290, 0, 45])
      for (const [current, expected] of [[78, 100], [199, 200], [200, 25]]) {
        h.store.activePet3dPreset.cameraZoomPercent = current
        h.emitEdit({ cycle: 'cameraZoomPercent' })
        assert.equal(h.store.activePet3dPreset.cameraZoomPercent, expected)
      }
      for (const [current, expected] of [[-90, 0], [-1, 0], [46, 90], [291, 0], [360, 0]]) {
        h.store.activePet3dPreset.sceneRotationOffsetDegrees = current
        h.emitEdit({ cycle: 'sceneRotationOffsetDegrees' })
        assert.equal(h.store.activePet3dPreset.sceneRotationOffsetDegrees, expected)
      }
      h.emitEdit({ cycle: 'cameraZoomPercent' })
      h.emitEdit({ cycle: 'cameraZoomPercent' })
      h.emitEdit({ cycle: 'sceneRotationOffsetDegrees' })
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 75)
      assert.equal(h.store.activePet3dPreset.sceneRotationOffsetDegrees, 45)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.deepEqual(userEntries(h.manager).find(entry => entry.id === 'initial'), builtin)
      assert.equal(await h.manager.retry(), true)
      saved = h.saves.at(-1) as typeof saved
      const active = saved.presetCollection?.entries.find(entry => entry.id === 'initial')
      assert.equal(active?.snapshot.preset.cameraZoomPercent, 100)
      assert.equal(saved.customization3d.preset.cameraZoomPercent, 75)
      assert.equal(active?.snapshot.preset.sceneRotationOffsetDegrees, 0)
      assert.equal(saved.customization3d.preset.sceneRotationOffsetDegrees, 45)
    } finally {
      h.dispose()
    }
    const restarted = await harness(saved)
    try {
      assert.equal(restarted.store.activePet3dPreset.cameraZoomPercent, 75)
      assert.equal(restarted.store.activePet3dPreset.sceneRotationOffsetDegrees, 45)
    } finally {
      restarted.dispose()
    }
  })

  it('retains pre-readiness cycle commands and rejects invalid or busy edits', async () => {
    editRequests.requestPresetEdit({ cycle: 'cameraZoomPercent' })
    editRequests.requestPresetEdit({ cycle: 'cameraZoomPercent' })
    const h = await harness()
    try {
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 150)
      const before = clonePreset(h.store.activePet3dPreset)
      for (const payload of [null, { cycle: 'mouseEnabled' }, { cycle: 100 }, { cycle: undefined }]) h.emitEdit(payload)
      assert.deepEqual(h.store.activePet3dPreset, before)
      const releaseNative = presetOperations.beginPresetNativeEdit()
      try {
        h.emitEdit({ cycle: 'cameraZoomPercent' })
        h.emitEdit({ cycle: 'sceneRotationOffsetDegrees' })
        assert.deepEqual(h.store.activePet3dPreset, before)
      } finally {
        releaseNative()
      }
      await withPresetReset(async () => {
        h.emitEdit({ cycle: 'cameraZoomPercent' })
        assert.deepEqual(h.store.activePet3dPreset, before)
      })
      h.emitEdit({ cycle: 'cameraZoomPercent' })
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 200)
    } finally {
      h.dispose()
    }
  })

  it('duplicates the stored snapshot independently of later current edits', async () => {
    const h = await harness()
    try {
      const source = clonePreset(userEntries(h.manager).find(entry => entry.id === 'initial')!)
      h.store.activePet3dPreset.cameraZoomPercent = 141
      h.store.updateDmeloperPalmColor('#ABCDEF')
      h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,c2tpbg=='
      assert.equal(await h.manager.duplicate('initial'), true)
      const copy = userEntries(h.manager).at(-1)!
      assert.equal(copy.name, 'initialName 2')
      assert.deepEqual(copy.snapshot, source.snapshot)
      assert.equal(h.applies(), 0)
      h.store.activePet3dPreset.cameraZoomPercent = 82
      assert.deepEqual(copy.snapshot, source.snapshot)
      assert.equal(await h.manager.activate(copy.id), true)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, source.snapshot.preset.cameraZoomPercent)
      assert.deepEqual(userEntries(h.manager).find(entry => entry.id === 'initial'), source)
      assert.equal(h.manager.status.value, 'saved')
    } finally {
      h.dispose()
    }
  })

  it('duplicates the chosen card and numbers repeated copies without changing current settings', async () => {
    const h = await harness()
    try {
      await h.manager.rename('initial', '작업 😶 安')
      h.store.activePet3dPreset.cameraZoomPercent = 143
      await h.manager.create('Current')
      h.store.activePet3dPreset.cameraZoomPercent = 82
      const activeId = h.store.presetCollection?.activeId
      const applies = h.applies()
      assert.equal(await h.manager.duplicate('initial'), true)
      assert.equal(await h.manager.duplicate('initial'), true)
      const copies = userEntries(h.manager).slice(-2)
      assert.deepEqual(copies.map(entry => entry.name), ['작업 😶 安 2', '작업 😶 安 3'])
      assert.ok(copies.every(entry => entry.snapshot.preset.cameraZoomPercent === 100))
      assert.notEqual(copies[0].id, copies[1].id)
      assert.equal(h.store.presetCollection?.activeId, activeId)
      assert.equal(h.applies(), applies)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 82)
    } finally {
      h.dispose()
    }
  })

  it('duplicates a user preset with its frozen bundled skin', async () => {
    const h = await harness()
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 143
      h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,c2tpbg=='
      userEntries(h.manager)[0].snapshot.appearance.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
      assert.equal(await h.manager.duplicate(DEFAULT_PRESET_ID), true)
      const copy = userEntries(h.manager).at(-1)!
      assert.equal(copy.name, 'Default 2')
      assert.equal('builtin' in copy, false)
      assert.equal(copy.favorite, false)
      assert.equal(copy.snapshot.preset.cameraZoomPercent, 100)
      assert.equal(copy.snapshot.appearance.dmeloperSkinDataUrl, 'data:image/png;base64,YQ==')
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(h.applies(), 0)
      await h.manager.activate(copy.id)
      h.store.activePet3dPreset.cameraZoomPercent = 137
      assert.equal(userEntries(h.manager).length, 3)
      assert.equal(userEntries(h.manager).find(entry => entry.id === DEFAULT_PRESET_ID)?.snapshot.preset.cameraZoomPercent, 100)
    } finally {
      h.dispose()
    }
  })

  it('rolls back a duplicate that cannot be saved and allows retry without losing the source edit', async () => {
    const h = await harness()
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 137
      h.failSaveAfter(1)
      assert.equal(await h.manager.duplicate('initial'), false)
      assert.equal(userEntries(h.manager).length, 2)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(h.manager.status.value, 'error')
      assert.equal(h.applies(), 0)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 137)
      h.failSave(false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(await h.manager.duplicate('initial'), true)
      assert.equal(userEntries(h.manager).at(-1)?.name, 'initialName 2')
    } finally {
      h.dispose()
    }
  })

  it('blocks switching on a save failure and retries without losing the current edit', async () => {
    const h = await harness()
    try {
      assert.deepEqual(h.diagnostics, [])
      h.store.activePet3dPreset.cameraZoomPercent = 137
      h.failSave(true)
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), false)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(h.manager.cardPending.value.initial, 'thumbnail')
      assert.equal(h.applies(), 0)
      assert.deepEqual(h.diagnostics, [{ level: 'error', operation: 'presets.save' }])
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 137)
      h.failSave(false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), true)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 100)
      assert.equal(h.diagnostics.length, 1, 'successful retry/application must stay silent')
    } finally {
      h.dispose()
    }
  })

  it('saves shortcut display-area edits only into current settings', async () => {
    const h = await harness()
    try {
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), true)
      const builtin = clonePreset(userEntries(h.manager).find(entry => entry.id === 'initial')!)
      h.emitEdit({ showDisplayArea: true })
      assert.equal(h.store.activePet3dPreset.showDisplayArea, true)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.deepEqual(userEntries(h.manager).find(entry => entry.id === 'initial'), builtin)
      assert.equal(await h.manager.retry(), true)
      const saved = h.saves.at(-1) as ReturnType<typeof useBlockStore>['$state']
      assert.ok(saved.presetCollection)
      const active = saved.presetCollection.entries.find(entry => entry.id === 'initial')
      assert.equal(active?.snapshot.preset.showDisplayArea, false)
      assert.equal(saved.customization3d.preset.showDisplayArea, true)
      h.emitEdit({ showDisplayArea: false })
      assert.equal(h.store.activePet3dPreset.showDisplayArea, false)
    } finally {
      h.dispose()
    }
  })

  it('keeps hide/show outside saved presets and reveals a hidden pet on repeated apply', async () => {
    const h = await harness()
    try {
      await h.manager.activate(DEFAULT_PRESET_ID)
      const before = clonePreset(h.store.presetCollection)
      h.emitEdit({ visible: false })
      assert.equal(h.store.window.visible, false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.store.window.visible, false, 'saving common visibility must not apply a preset')
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.deepEqual(h.store.presetCollection, before)
      assert.ok(userEntries(h.manager).every(entry => !('visible' in entry.snapshot)))
      const applies = h.applies()
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), true)
      assert.equal(h.applies(), applies + 1)
      assert.equal(h.store.window.visible, true)
      h.emitEdit({ visible: false })
      assert.equal(await h.manager.create('Visible new preset'), true)
      assert.equal(h.store.window.visible, false)
    } finally {
      h.dispose()
    }
  })

  it('restores hidden live visibility when the post-apply save fails', async () => {
    const h = await harness()
    try {
      h.store.window.visible = false
      h.store.activePet3dPreset.cameraZoomPercent = 147
      h.failSaveAfter(1)
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), false)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 147)
      assert.equal(h.store.window.visible, false)
      assert.equal(h.applies(), 2, 'the successful native load must be rolled back after its disk save fails')
      h.failSave(false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.store.window.visible, false)
    } finally {
      h.dispose()
    }
  })

  it('deletes an applied entry without applying another preset and keeps current state', async () => {
    const h = await harness()
    let saved!: ReturnType<typeof useBlockStore>['$state']
    let valid = true
    const stop = editIntent.onPresetSelectionChange(() => {
      valid = false
    })
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 147
      h.store.window.visible = false
      h.failApply(true)
      const before = presetModel.capturePresetSnapshot(h.store)
      assert.equal(await h.manager.remove('initial'), true)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(userEntries(h.manager).length, 1)
      assert.equal(valid, true)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), before)
      assert.equal(h.store.window.visible, false)
      assert.equal(h.applies(), 0)
      h.store.activePet3dPreset.cameraZoomPercent = 170
      assert.equal(await h.manager.retry(), true)
      assert.equal(userEntries(h.manager)[0].snapshot.preset.cameraZoomPercent, 100)
      saved = clonePreset(h.saves.at(-1) as typeof saved)
    } finally {
      stop()
      h.dispose()
    }
    const restarted = await harness(saved)
    try {
      assert.equal(restarted.store.presetCollection?.activeId, null)
      assert.equal(restarted.store.activePet3dPreset.cameraZoomPercent, 170)
      assert.equal(restarted.store.window.visible, false)
      assert.equal(restarted.applies(), 0)
      assert.equal(await restarted.manager.remove(DEFAULT_PRESET_ID), true)
      assert.deepEqual(userEntries(restarted.manager), [])
      assert.equal(restarted.store.activePet3dPreset.cameraZoomPercent, 170)
      assert.equal(restarted.applies(), 0)
    } finally {
      restarted.dispose()
    }
  })

  it('saves current edits without modifying the applied preset', async () => {
    const h = await harness()
    try {
      await h.manager.activate(DEFAULT_PRESET_ID)
      h.store.activePet3dPreset.viewportModeRevision++
      h.store.activePet3dPreset.dmeloperEyebrows.color = '#AAAAAA'
      markPresetUserEdit()
      h.store.activePet3dPreset.cameraZoomPercent = 150
      h.store.activePet3dPreset.cameraZoomPercent = 170
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(userEntries(h.manager).length, 2)
      assert.equal(userEntries(h.manager)[0].snapshot.preset.cameraZoomPercent, 100)
      assert.equal(await h.manager.retry(), true)
      assert.equal((h.saves.at(-1) as ReturnType<typeof useBlockStore>['$state']).customization3d.preset.cameraZoomPercent, 170)
    } finally {
      h.dispose()
    }
  })

  it('keeps only the live skin and its two colors while applying all other preset settings without restoring its skin', async () => {
    const h = await harness()
    try {
      const entry = userEntries(h.manager).find(entry => entry.id === 'initial')!
      Object.assign(entry.snapshot.appearance, {
        dmeloperSkinDataUrl: 'data:image/png;base64,dGFyZ2V0',
        activeSkinLibraryEntryId: 'c'.repeat(64),
        minecraftSkinUsername: 'Target_Name',
        dmeloperSkinModel: 'wide',
        useDefaultDmeloperSkin: false,
      })
      Object.assign(entry.snapshot.preset.dmeloperEyebrows, { color: '#111111', enabled: false, widthPixels: 3, depthPercent: 125 })
      Object.assign(entry.snapshot.preset, { dmeloperPalmColor: '#222222', cameraZoomPercent: 135, petHeadScalePercent: 140 })
      entry.snapshot.mirror = true
      entry.snapshot.opacity = 65
      entry.snapshot.eyebrowAnimationEnabled = false
      Object.assign(h.store.customization3d, {
        dmeloperSkinDataUrl: 'data:image/png;base64,Yg==',
        activeSkinLibraryEntryId: 'a'.repeat(64),
        minecraftSkinUsername: 'Current_Name',
        dmeloperSkinModel: 'slim',
        useDefaultDmeloperSkin: false,
      })
      Object.assign(h.store.activePet3dPreset.dmeloperEyebrows, { color: '#abcdef', enabled: true, widthPixels: 2, depthPercent: 50 })
      h.store.activePet3dPreset.dmeloperPalmColor = '#fedcba'
      h.store.window.visible = false
      const current = presetModel.capturePresetSnapshot(h.store)
      const original = clonePreset(entry)
      const restores = h.restoredSkins()
      assert.equal(await h.manager.activate(entry.id, { applySkin: false }), true)
      const expected = clonePreset(original.snapshot)
      expected.appearance = current.appearance
      expected.preset.dmeloperEyebrows.color = current.preset.dmeloperEyebrows.color
      expected.preset.dmeloperPalmColor = current.preset.dmeloperPalmColor
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), expected)
      assert.equal(h.restoredSkins(), restores)
      assert.equal(h.store.window.visible, true)
      assert.deepEqual(userEntries(h.manager).find(item => item.id === entry.id), original)
      const saved = h.saves.at(-1) as typeof h.store.$state
      assert.equal(saved.customization3d.dmeloperSkinDataUrl, current.appearance.dmeloperSkinDataUrl)
      // Explicitly enabling the option restores the same untouched target again.
      assert.equal(await h.manager.activate(entry.id, { applySkin: true }), true)
      assert.equal(h.restoredSkins(), restores + 1)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), original.snapshot)
    } finally {
      h.dispose()
    }
  })

  for (const failure of ['apply', 'save'] as const) {
    it(`restores the complete previous scene after a skin-preserving ${failure} failure`, async () => {
      const h = await harness()
      try {
        h.store.activePet3dPreset.cameraZoomPercent = 175
        h.store.activePet3dPreset.dmeloperEyebrows.color = '#abcdef'
        h.store.activePet3dPreset.dmeloperPalmColor = '#fedcba'
        h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
        h.store.window.visible = false
        const before = presetModel.capturePresetSnapshot(h.store)
        const catalog = clonePreset(h.store.presetCollection)
        const restores = h.restoredSkins()
        if (failure === 'apply') h.failNextApply()
        else h.failSaveOnceAfter(1)
        assert.equal(await h.manager.activate('initial', { applySkin: false }), false)
        assert.deepEqual(presetModel.capturePresetSnapshot(h.store), before)
        assert.equal(h.store.window.visible, false)
        assert.deepEqual(h.store.presetCollection, catalog)
        assert.equal(h.restoredSkins(), restores)
        assert.equal(h.manager.ready.value, true)
        assert.equal(await h.manager.activate('initial', { applySkin: false }), true)
      } finally {
        h.dispose()
      }
    })
  }

  it('keeps prepared and native accepted corrections out of the source and reapplies the same visible card', async () => {
    const h = await harness(undefined, async (snapshot) => {
      // Even a mutating preparer receives a disposable copy.
      snapshot.appearance.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
      snapshot.appearance.dmeloperSkinModel = 'slim'
      return snapshot
    })
    try {
      const source = clonePreset(userEntries(h.manager).find(entry => entry.id === 'initial')!)
      h.correctNextApply((snapshot) => {
        snapshot.preset.manualViewportRect.width = 333
        return snapshot
      })
      assert.equal(await h.manager.activate('initial'), true)
      assert.equal(h.store.activePet3dPreset.manualViewportRect.width, 333)
      assert.equal(h.store.customization3d.dmeloperSkinModel, 'slim')
      assert.deepEqual(userEntries(h.manager).find(entry => entry.id === 'initial'), source)
      h.store.activePet3dPreset.cameraZoomPercent = 175
      h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,Yg=='
      const applies = h.applies()
      assert.equal(await h.manager.activate('initial'), true)
      assert.equal(h.applies(), applies + 1)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, source.snapshot.preset.cameraZoomPercent)
      assert.equal(h.store.activePet3dPreset.manualViewportRect.width, source.snapshot.preset.manualViewportRect.width)
      assert.deepEqual(userEntries(h.manager).find(entry => entry.id === 'initial'), source)
      assert.equal(h.store.presetCollection?.activeId, null)
    } finally {
      h.dispose()
    }
  })

  it('persists partial resets and later skin edits independently through restart', async () => {
    let h = await harness()
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 173
      h.store.activePet3dPreset.mouseScalePercent = 164
      h.store.activePet3dPreset.petDeskOffset = 0.4
      h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
      h.store.updateDmeloperPalmColor('#123456')
      assert.equal(await h.manager.create('Frozen'), true)
      const entry = clonePreset(userEntries(h.manager).at(-1)!)
      assert.equal(await h.manager.activate(entry.id), true)
      h.store.resetMouse3d()
      h.store.resetDesk3d()
      h.store.resetScene3d()
      h.store.setDmeloperSkinDataUrl('data:image/png;base64,Yg==', 'b'.repeat(64))
      h.store.updateDmeloperPalmColor('#654321')
      const current = presetModel.capturePresetSnapshot(h.store)
      assert.equal(await h.manager.retry(), true)
      const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useBlockStore>['$state']
      h.dispose()
      h = await harness(saved)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), current)
      assert.deepEqual(userEntries(h.manager).find(item => item.id === entry.id), entry)
      assert.equal(h.applies(), 0)
      assert.equal(await h.manager.activate(entry.id), true)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), entry.snapshot)
    } finally {
      h.dispose()
    }
  })

  it('restores current settings at restart and clears legacy selection without applying it', async () => {
    const h = await harness()
    await h.manager.create('Saved')
    const catalog = clonePreset(h.store.presetCollection!)
    h.store.activePet3dPreset.cameraZoomPercent = 154
    h.store.window.visible = false
    await h.manager.retry()
    const persisted = clonePreset(h.saves.at(-1)) as ReturnType<typeof useBlockStore>['$state']
    h.dispose()
    persisted.presetCollection!.activeId = 'initial'
    const restarted = await harness(persisted)
    try {
      assert.equal(restarted.store.activePet3dPreset.cameraZoomPercent, 154)
      assert.equal(restarted.store.window.visible, false)
      assert.deepEqual(restarted.store.presetCollection, catalog)
      assert.equal(restarted.applies(), 0)
      assert.equal((restarted.saves.at(-1) as typeof persisted).presetCollection!.activeId, null)
    } finally {
      restarted.dispose()
    }
  })

  it('blocks an uncertain native outcome even when the partial store sync has not arrived', async () => {
    const h = await harness()
    try {
      h.store.window.visible = false
      h.failApply(true)
      h.failRestore(true)
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), false)
      assert.equal(h.manager.ready.value, false)
      const requests = h.applies()
      assert.equal(await h.manager.create('blocked'), false)
      assert.equal(h.applies(), requests)
      h.failApply(false)
      h.failRestore(false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(h.store.window.visible, false, 'recovery must not reload the restored preset as a new visible selection')
    } finally {
      h.dispose()
    }
  })

  it('retains uncertain-apply recovery when whole reset fails before replacing the catalog', async () => {
    const h = await harness()
    try {
      h.store.window.visible = false
      h.failApply(true)
      h.failRestore(true)
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), false)
      assert.equal(h.manager.ready.value, false)
      const before = clonePreset(h.store.$state)
      const requests = h.applies()
      h.failApply(false)
      h.failRestore(false)
      const unexpectedStep = () => {
        throw new Error('reset crossed failed library gate')
      }
      await assert.rejects(withPresetReset(() => runProgramSettingsReset({
        getAutostartStatus: async () => ({ enabled: false, state: 'disabled', canEnable: true, canDisable: true }),
        checkPresetImport: async () => {},
        clearSkinLibrary: async () => {
          throw new Error('storage unavailable')
        },
        resetAutostart: async () => unexpectedStep(),
        stopPerformance: async () => unexpectedStep(),
        resetPerformanceMetrics: async () => unexpectedStep(),
        resetBlock: unexpectedStep,
        resetGeneral: unexpectedStep,
        initializeGeneral: async () => unexpectedStep(),
        resetShortcut: unexpectedStep,
        resetWindowState: unexpectedStep,
        resetWindowGeometry: async () => unexpectedStep(),
      }, { deleteSkins: true, resetPresets: true })), /storage unavailable/)
      await vue.nextTick()
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(h.applies(), requests, 'a failed reset must not silently retry an uncertain apply')
      assert.equal(h.manager.ready.value, false)
      assert.deepEqual(clonePreset(h.store.$state), before)
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.store.window.visible, false, 'explicit recovery retains the prior hidden state')
    } finally {
      h.dispose()
    }
  })

  it('preserves recovery when reset waits for a failed switch and then its storage gate fails', async () => {
    const h = await harness()
    const release = h.holdApply()
    try {
      h.store.window.visible = false
      h.failApply(true)
      h.failRestore(true)
      const switching = h.manager.activate(DEFAULT_PRESET_ID)
      await waitFor(() => h.applies() === 1)
      const resetting = assert.rejects(withPresetReset(async () => {
        throw new Error('storage unavailable')
      }), /storage unavailable/)
      release()
      assert.equal(await switching, false)
      await resetting
      await vue.nextTick()
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(h.applies(), 1)
      assert.equal(h.manager.ready.value, false)
      h.failApply(false)
      h.failRestore(false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.store.window.visible, false)
    } finally {
      release()
      h.dispose()
    }
  })

  it('resumes a debounced edit save after a slow reset storage failure', async () => {
    const h = await harness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 162
      const saves = h.saves.length
      const resetting = assert.rejects(withPresetReset(async () => {
        await gate
        throw new Error('storage unavailable')
      }), /storage unavailable/)
      await new Promise(resolve => setTimeout(resolve, 350))
      assert.equal(h.saves.length, saves)
      release()
      await resetting
      await waitFor(() => h.saves.length > saves && h.manager.status.value === 'saved')
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 162)
      const saved = h.saves.at(-1) as ReturnType<typeof useBlockStore>['$state']
      assert.equal(saved.presetCollection!.entries.find(entry => entry.id === 'initial')!.snapshot.preset.cameraZoomPercent, 100)
      assert.equal(saved.customization3d.preset.cameraZoomPercent, 162)
    } finally {
      release()
      h.dispose()
    }
  })

  it('preserves disabled-feature options across save failure, duplicate, hidden selection and restart', async () => {
    let h = await harness()
    try {
      h.store.activePet3dPreset.mouseEnabled = false
      h.store.activePet3dPreset.mouseScalePercent = 143
      h.store.model.eyebrowAnimationEnabled = false
      h.store.updateDmeloperEyebrows({ color: '#123456' })
      h.store.customization3d.dmeloperSkinModel = 'slim'
      h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
      h.store.model.mirror = true
      h.store.window.opacity = 25
      const expected = presetModel.capturePresetSnapshot(h.store)
      h.failSave(true)
      assert.equal(await h.manager.create('Disabled options'), false)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), expected)
      assert.equal(userEntries(h.manager).length, 2)
      h.failSave(false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(await h.manager.create('Disabled options'), true)
      const duplicate = userEntries(h.manager).at(-1)!
      assert.deepEqual(duplicate.snapshot, expected)
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), true)
      h.store.window.visible = false
      assert.equal(await h.manager.activate(duplicate.id), true)
      assert.equal(h.store.window.visible, true)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), expected)
      const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useBlockStore>['$state']
      h.dispose()
      h = await harness(saved)
      assert.equal(h.manager.ready.value, true)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), expected)
    } finally {
      h.dispose()
    }
  })

  it('preserves an unreadable startup catalog after a failed reset and recovers after a successful reset', async () => {
    let h = await harness()
    try {
      const damaged = clonePreset(h.store.$state)
      damaged.presetCollection!.schemaVersion = 999
      h.dispose()
      h = await harness(damaged)
      assert.equal(h.manager.ready.value, false)
      assert.equal(h.saves.length, 0)
      const before = clonePreset(h.store.presetCollection)
      await assert.rejects(withPresetReset(async () => {
        throw new Error('access denied')
      }), /access denied/)
      await vue.nextTick()
      assert.deepEqual(clonePreset(h.store.presetCollection), before)
      assert.equal(h.manager.ready.value, false)
      await withPresetReset(async () => h.store.resetAllSettings({ deleteSkins: false, resetPresets: true }))
      await waitFor(() => h.manager.ready.value && h.manager.status.value === 'saved')
      assert.equal(userEntries(h.manager).length, 0)
      assert.equal(h.store.presetCollection?.activeId, null)
    } finally {
      h.dispose()
    }
  })

  it('persists a user change after an earlier native sync and gates menu edits during apply', async () => {
    const h = await harness()
    try {
      await h.manager.activate(DEFAULT_PRESET_ID)
      await vue.nextTick()
      h.store.activePet3dPreset.mouseEnabled = false
      assert.equal(h.store.presetCollection?.activeId, null)
      editIntent.confirmPresetUserEdit()
      assert.equal(h.store.presetCollection?.activeId, null)
      h.emitEdit({ opacity: 75 })
      assert.equal(h.store.window.opacity, 75)
      const release = h.holdApply()
      const switching = h.manager.activate(DEFAULT_PRESET_ID)
      h.emitEdit({ opacity: 25 })
      assert.equal(h.store.window.opacity, 75)
      release()
      await switching
    } finally {
      h.dispose()
    }
  })

  it('invalidates a delayed skin selection before saving a new preset owner', async () => {
    const h = await harness()
    let valid = true
    const stop = editIntent.onPresetSelectionChange(() => {
      valid = false
    })
    let deliver!: () => void
    const response = new Promise<void>((resolve) => {
      deliver = resolve
    }).then(() => {
      if (valid) h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,late'
    })
    try {
      assert.equal(await h.manager.create('Next'), true)
      const preserved = h.store.customization3d.dmeloperSkinDataUrl
      deliver()
      await response
      assert.equal(h.store.customization3d.dmeloperSkinDataUrl, preserved)
    } finally {
      stop()
      h.dispose()
    }
  })

  it('renders only a visible list and reuses scene thumbnails across metadata edits', async () => {
    const h = await harness()
    try {
      await new Promise(resolve => setTimeout(resolve, 550))
      assert.equal(h.rendered(), 0)
      h.manager.setListVisible(true)
      await new Promise(resolve => setTimeout(resolve, 650))
      assert.equal(h.rendered(), 6)
      assert.deepEqual(h.thumbnailBatches(), { total: 1, active: 0, maxActive: 1 })
      await h.manager.rename('initial', 'Renamed')
      await h.manager.toggleFavorite('initial')
      await new Promise(resolve => setTimeout(resolve, 650))
      assert.equal(h.rendered(), 6)
      h.failThumbnail(true)
      h.store.activePet3dPreset.cameraZoomPercent = 162
      await new Promise(resolve => setTimeout(resolve, 650))
      assert.equal(h.rendered(), 6, 'current edits must reuse the stored preview')
      h.manager.retryThumbnail('initial')
      await new Promise(resolve => setTimeout(resolve, 650))
      assert.equal(h.manager.thumbnailErrors.value.initial, true)
      assert.deepEqual(h.diagnostics.at(-1), { level: 'warn', operation: 'presets.thumbnail' })
      assert.equal(h.manager.status.value, 'saved')
      assert.equal(h.manager.cardPending.value.initial, undefined)
      assert.equal(h.thumbnailBatches().active, 0)
      h.failThumbnail(false)
      h.manager.retryThumbnail('initial')
      assert.equal(h.manager.cardPending.value.initial, 'thumbnail')
      await new Promise(resolve => setTimeout(resolve, 650))
      assert.equal(h.manager.thumbnailErrors.value.initial, undefined)
      assert.equal(h.manager.cardPending.value.initial, undefined)
    } finally {
      h.dispose()
    }
  })

  it('releases an in-flight thumbnail batch on owner disposal without publishing its late result', async () => {
    const h = await harness()
    const release = h.holdThumbnail()
    try {
      h.manager.setListVisible(true)
      await waitFor(() => h.rendered() === 1)
      assert.equal(h.thumbnailBatches().active, 1)
      h.dispose()
      assert.equal(h.thumbnailBatches().active, 0)
      release()
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(Object.keys(h.manager.thumbnails.value).length, 0)
      assert.equal(Object.keys(h.manager.thumbnailErrors.value).length, 0)
      assert.equal(h.rendered(), 1)
      assert.equal(h.thumbnailBatches().maxActive, 1)
    } finally {
      release()
      h.dispose()
    }
  })

  it('saves newer current edits after an older write without changing stored previews or covering cards', async () => {
    const h = await harness()
    let releaseSave = () => {}
    try {
      h.manager.setListVisible(true)
      await waitFor(() => Object.keys(h.manager.cardPending.value).length === 0)
      const catalog = clonePreset(h.store.presetCollection)
      const previews = clonePreset(h.manager.thumbnails.value)
      releaseSave = h.holdSave()
      h.store.activePet3dPreset.cameraZoomPercent = 162
      const saves = h.saves.length
      const older = h.manager.retry()
      await vue.nextTick()
      h.store.activePet3dPreset.cameraZoomPercent = 185
      assert.equal(Object.keys(h.manager.cardPending.value).length, 0)
      releaseSave()
      assert.equal(await older, true)
      await waitFor(() => h.saves.length > saves + 1 && h.manager.status.value === 'saved')
      assert.equal((h.saves.at(-1) as ReturnType<typeof useBlockStore>['$state']).customization3d.preset.cameraZoomPercent, 185)
      assert.deepEqual(h.store.presetCollection, catalog)
      assert.deepEqual(clonePreset(h.manager.thumbnails.value), previews)
      assert.equal(h.rendered(), 6)
      assert.equal(Object.keys(h.manager.cardPending.value).length, 0)
    } finally {
      releaseSave()
      h.dispose()
    }
  })

  it('waits for a pending switch before whole-program reset and never resurrects its deleted catalog', async () => {
    const h = await harness()
    try {
      const release = h.holdApply()
      const switching = h.manager.activate(DEFAULT_PRESET_ID)
      for (let count = 0; h.applies() === 0 && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 1))
      assert.equal(h.applies(), 1)
      let reset = false
      const resetting = withPresetReset(async () => {
        h.store.resetAllSettings({ deleteSkins: false, resetPresets: true })
        reset = true
      })
      assert.equal(reset, false)
      assert.equal(await h.manager.create('blocked'), false)
      release()
      await switching
      await resetting
      await vue.nextTick()
      assert.equal(reset, true)
      assert.equal(userEntries(h.manager).length, 0)
      assert.equal(h.store.presetCollection?.activeId, null)
    } finally {
      h.dispose()
    }
  })
})

it('captures bundled PNG in a new preset without changing hidden current state at save or restart', async () => {
  const browser = installPresetSkinBrowser()
  let h: Awaited<ReturnType<typeof harness>> | undefined
  try {
    h = await harness(undefined, preparePresetSkin)
    h.store.updateDmeloperEyebrows({ color: '#123456' })
    h.store.updateDmeloperPalmColor('#abcdef')
    h.store.resetDmeloperSkinToDefault()
    h.store.window.visible = false
    assert.equal(await h.manager.retry(), true)
    assert.equal(h.store.window.visible, false)
    assert.equal(h.store.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(await h.manager.create('Bundled skin'), true)
    assert.equal(userEntries(h.manager).at(-1)!.snapshot.appearance.dmeloperSkinDataUrl, browser.dataUrl)
    assert.equal(h.store.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(h.store.activePet3dPreset.dmeloperEyebrows.color, '#123456')
    assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#abcdef')
    const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useBlockStore>['$state']
    assert.equal(saved.window.visible, false)
    assert.ok(saved.presetCollection!.entries.every(entry => !('visible' in entry.snapshot)))
    h.dispose()
    h = await harness(saved, preparePresetSkin)
    assert.equal(h.manager.ready.value, true)
    assert.equal(h.store.window.visible, false)
    assert.equal(h.store.activePet3dPreset.dmeloperEyebrows.color, '#123456')
    assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#abcdef')
  } finally {
    h?.dispose()
    browser.restore()
  }
})

it('autosaves and restores the default after active-skin deletion and cross-window JSON synchronization', async () => {
  const browser = installPresetSkinBrowser()
  let h: Awaited<ReturnType<typeof harness>> | undefined
  try {
    h = await harness(undefined, preparePresetSkin)
    assert.equal(h.manager.ready.value, true)
    h.store.updateDmeloperEyebrows({ color: '#123456' })
    h.store.updateDmeloperPalmColor('#abcdef')
    const renderState = () => {
      const { customization3d, activePet3dPreset } = h!.store
      const selection = {
        modelId: customization3d.selectedModelId,
        dmeloperSkinDataUrl: customization3d.dmeloperSkinDataUrl,
        dmeloperSkinModel: customization3d.dmeloperSkinModel,
        useDefaultDmeloperSkin: customization3d.useDefaultDmeloperSkin,
        preset: activePet3dPreset,
      }
      return {
        asset: { ...selection, dmeloperSkinUrl: getResolvedDmeloperSkinUrl(selection.dmeloperSkinDataUrl) },
        bounds: createVisibleBoundsSelectionSignature(selection),
      }
    }
    const userBytes = Buffer.concat([Buffer.from(browser.dataUrl.split(',')[1], 'base64'), Buffer.from([0])])
    h.store.setDmeloperSkinDataUrl(`data:image/png;base64,${userBytes.toString('base64')}`, 'a'.repeat(64))
    const userSkin = renderState()
    const before = h.saves.length
    const mainStore = useBlockStore(createPinia())
    mainStore.$patch(preparePetStateForSync(clonePreset({ ...h.store.$state })))
    h.store.handleSkinLibraryEntriesDeleted(['a'.repeat(64)])
    // Reproduce the native JSON boundary and Pinia merge in the other webview,
    // including a subsequent state echo before the preset owner's debounced save.
    mainStore.$patch(preparePetStateForSync(clonePreset({ ...h.store.$state })))
    assert.equal(mainStore.customization3d.dmeloperSkinDataUrl, undefined)
    h.store.$patch(preparePetStateForSync(clonePreset({ ...mainStore.$state })))
    const selectedDefault = renderState()
    assert.equal(getRequiredPetAssetMutation(userSkin.asset, selectedDefault.asset), 'skin')
    assert.equal(h.store.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(h.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    const current = h
    await waitFor(() => current.saves.length > before && current.manager.status.value === 'saved')
    assert.equal(h.store.customization3d.dmeloperSkinDataUrl, undefined)
    assert.equal(h.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    const savedDefault = renderState()
    assert.equal(getRequiredPetAssetMutation(selectedDefault.asset, savedDefault.asset), 'none', 'autosave must not reload the identical bundled PNG and hide the pet again')
    assert.equal(visibleBoundsSelectionChanged(selectedDefault.bounds, savedDefault.bounds), false, 'materializing the same skin must not trigger a second viewport measurement')
    h.store.resetDmeloperSkinToDefault()
    const repeatedDefault = renderState()
    assert.equal(getRequiredPetAssetMutation(savedDefault.asset, repeatedDefault.asset), 'none')
    assert.equal(visibleBoundsSelectionChanged(savedDefault.bounds, repeatedDefault.bounds), false)
    await h.manager.retry()
    const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useBlockStore>['$state']
    assert.equal(saved.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.equal(saved.presetCollection!.activeId, null)
    h.dispose()
    h = await harness(saved, preparePresetSkin)
    assert.equal(h.manager.ready.value, true)
    assert.equal(h.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.equal(h.store.activePet3dPreset.dmeloperEyebrows.color, '#123456')
    assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#abcdef')
  } finally {
    h?.dispose()
    browser.restore()
  }
})

it('preserves restored hidden visibility and zero opacity while the data recovery owner is locked', async () => {
  const original = await harness()
  const state = clonePreset(original.store.$state)
  original.dispose()
  state.window.visible = false
  state.window.opacity = 0
  state.model.maxFPS = 60
  const catalog = clonePreset(state.presetCollection)
  editorsLocked.value = true
  try {
    const restored = await harness(state)
    try {
      assert.equal(restored.store.window.visible, false)
      assert.equal(restored.store.window.opacity, 0)
      assert.deepEqual(restored.store.presetCollection, catalog)
      assert.equal(restored.applies(), 0)
      assert.equal(restored.store.model.maxFPS, 60)
      assert.equal(await stateOwners.flushPresets?.(), true)
      restored.emitEdit({ visible: true })
      assert.equal(restored.store.window.visible, false)
    } finally {
      restored.dispose()
    }
  } finally {
    editorsLocked.value = false
  }
})

it('keeps the actual preset owner unavailable during startup and native apply', async () => {
  const releaseOldOwner = registerPresetFlush(async () => true)
  let beforeMountReady: boolean | undefined
  const h = await harness(undefined, undefined, () => {
    beforeMountReady = stateOwners.presetsReady?.()
  })
  try {
    assert.equal(beforeMountReady, false, 'setup registration must not claim completed preset initialization')
    releaseOldOwner()
    assert.equal(stateOwners.presetsReady?.(), true, 'stale cleanup must preserve the current ready owner')
    assert.equal(h.quitReady(), true)
    const release = h.holdApply()
    try {
      const switching = h.manager.activate(DEFAULT_PRESET_ID)
      await waitFor(() => h.applies() === 1)
      assert.equal(stateOwners.presetsReady?.(), false, 'a pending native preset apply cannot acknowledge stable data')
      assert.equal(h.quitReady(), false, 'Quit must wait for the same actual native apply owner')
      release()
      assert.equal(await switching, true)
      assert.equal(stateOwners.presetsReady?.(), true)
      assert.equal(h.quitReady(), true)
    } finally {
      release()
    }
  } finally {
    h.dispose()
  }
  assert.equal(stateOwners.presetsReady, undefined)
  assert.equal(stateOwners.flushPresets, undefined)
  assert.equal(h.quitReady(), false, 'disposed owners cannot authorize Quit')
})

describe('live preset manager file transfers', () => {
  it('processes a mixed batch sequentially, retains successes, and retries only failed sources without applying a scene', async () => {
    const h = await harness()
    let release!: () => void
    let rejectBadFile = true
    h.transfer.commitHold = new Promise<void>((resolve) => {
      release = resolve
    })
    h.transfer.readDocument = (source) => {
      if (source === 'bad.petpreset' && rejectBadFile) throw new PresetTransferError('invalidFormat')
      return h.transfer.document
    }
    try {
      h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
      const current = presetModel.capturePresetSnapshot(h.store)
      const importing = h.manager.importPresets(['one.petpreset', 'bad.petpreset', 'two.petpreset'])
      await waitFor(() => h.transfer.finished.length === 1)
      assert.deepEqual(h.transfer.reads, ['one.petpreset'])
      assert.equal(h.manager.busy.value, true)
      assert.equal(h.manager.importProgress.value?.file, 'one.petpreset')
      assert.equal(await h.manager.create('overlap'), false)
      assert.equal(await h.manager.remove('initial'), false)
      assert.equal(stateOwners.presetsReady?.(), false)
      release()
      const imported = await importing
      assert.equal(imported.length, 2)
      assert.deepEqual(h.transfer.reads, ['one.petpreset', 'bad.petpreset', 'two.petpreset'])
      assert.deepEqual(Array.from(h.manager.importResults.value, result => result.status), ['saved', 'failed', 'saved'])
      assert.equal(h.manager.importBatchStopped.value, false)
      assert.equal(h.manager.isBatchImport.value, true)
      assert.equal(h.manager.canRetryImport.value, true)
      assert.equal(h.applies(), 0)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), current)
      assert.deepEqual(userEntries(h.manager).slice(-2).map(entry => entry.name), ['Shared', 'Shared 2'])
      rejectBadFile = false
      assert.equal(await h.manager.retryImport(), undefined, 'batch retry must not ask to apply a single recovered file')
      assert.deepEqual(h.transfer.reads, ['one.petpreset', 'bad.petpreset', 'two.petpreset', 'bad.petpreset'])
      assert.deepEqual(Array.from(h.manager.importResults.value, result => result.status), ['saved', 'saved', 'saved'])
      assert.equal(h.manager.canRetryImport.value, false)
      assert.equal(userEntries(h.manager).length, 5)
      assert.equal(h.applies(), 0)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), current)
    } finally {
      release()
      h.dispose()
    }
  })

  for (const failure of ['prepare', 'prepareAfterJournal', 'commit'] as const) {
    it(`stops a batch after native ${failure} failure and resumes failed plus unprocessed files explicitly`, async () => {
      const h = await harness()
      try {
        h.transfer.failure = failure
        await h.manager.importPresets(['first.petpreset', 'remaining.petpreset'])
        assert.deepEqual(h.transfer.reads, ['first.petpreset'])
        assert.equal(h.manager.importBatchStopped.value, true)
        assert.deepEqual(Array.from(h.manager.importResults.value, result => result.status), ['failed', 'pending'])
        assert.equal(userEntries(h.manager).length, 2)
        h.transfer.failure = undefined
        await h.manager.retryImport()
        assert.deepEqual(h.transfer.reads, ['first.petpreset', 'first.petpreset', 'remaining.petpreset'])
        assert.equal(userEntries(h.manager).length, 4)
        assert.equal(h.manager.importBatchStopped.value, false)
        assert.equal(h.manager.canRetryImport.value, false)
      } finally {
        h.dispose()
      }
    })
  }

  it('stops before reading any file if the initial save cannot be acknowledged', async () => {
    const h = await harness()
    try {
      h.failSave(true)
      await h.manager.importPresets(['first.petpreset', 'remaining.petpreset'])
      assert.deepEqual(h.transfer.reads, [])
      assert.equal(h.manager.importBatchStopped.value, true)
      assert.deepEqual(Array.from(h.manager.importResults.value, result => result.status), ['failed', 'pending'])
      h.failSave(false)
      await h.manager.retryImport()
      assert.deepEqual(h.transfer.reads, ['first.petpreset', 'remaining.petpreset'])
      assert.equal(userEntries(h.manager).length, 4)
    } finally {
      h.dispose()
    }
  })

  it('does not duplicate a committed batch entry after uncertain receipt recovery', async () => {
    const h = await harness()
    let release!: () => void
    h.transfer.commitHold = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      h.transfer.loseCommitReply = true
      const importing = h.manager.importPresets(['first.petpreset', 'remaining.petpreset'])
      await waitFor(() => h.transfer.finished.length === 1)
      h.transfer.journalReadError = new Error('receipt unavailable')
      release()
      await importing
      assert.equal(h.manager.ready.value, false)
      assert.deepEqual(h.transfer.reads, ['first.petpreset'])
      assert.equal(userEntries(h.manager).length, 3)
      h.transfer.journalReadError = undefined
      h.transfer.loseCommitReply = false
      assert.equal(await h.manager.retry(), true)
      await h.manager.retryImport()
      assert.deepEqual(h.transfer.reads, ['first.petpreset', 'remaining.petpreset'])
      assert.equal(userEntries(h.manager).length, 4)
      assert.deepEqual(Array.from(h.manager.importResults.value, result => result.status), ['saved', 'saved'])
    } finally {
      release()
      h.dispose()
    }
  })

  it('keeps the shared operation lock through a batch and lets reset cancel unprocessed files safely', async () => {
    const h = await harness()
    let release!: () => void
    h.transfer.commitHold = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const importing = h.manager.importPresets(['first.petpreset', 'remaining.petpreset'])
      await waitFor(() => h.transfer.finished.length === 1)
      let resetRan = false
      const resetting = withPresetReset(async () => {
        resetRan = true
        h.store.resetAllSettings()
      })
      await vue.nextTick()
      assert.equal(resetRan, false)
      release()
      await importing
      await resetting
      await vue.nextTick()
      assert.deepEqual(h.transfer.reads, ['first.petpreset'])
      assert.equal(resetRan, true)
      assert.equal(userEntries(h.manager).length, 3, 'a settings-only reset preserves the completed import')
      assert.equal(h.manager.importResults.value.length, 0)
      assert.equal(presetOperations.presetOperationInProgress.value, false)
    } finally {
      release()
      h.dispose()
    }
  })

  it('exports the chosen stored snapshot after flushing independent current edits', async () => {
    const h = await harness()
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 111
      h.store.customization3d.minecraftSkinUsername = 'Saved_Name'
      assert.equal(await h.manager.create('Inactive'), true)
      const inactiveId = userEntries(h.manager).at(-1)!.id
      assert.equal(await h.manager.retry(), true)
      assert.equal(await h.manager.activate('initial'), true)
      h.store.activePet3dPreset.cameraZoomPercent = 166
      const applies = h.applies()
      assert.equal(await h.manager.exportPreset(inactiveId!, 'nickname'), 'saved')
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 166)
      assert.equal(h.applies(), applies)
      assert.equal(h.transfer.exports[0].name, 'Inactive')
      assert.equal(h.transfer.exports[0].snapshot.preset.cameraZoomPercent, 111)
      assert.equal(h.transfer.written[0].skin.mode, 'nickname')
      assert.equal(h.transfer.written[0].skin.nickname, 'Saved_Name')
      assert.equal(userEntries(h.manager).find(entry => entry.id === 'initial')?.snapshot.preset.cameraZoomPercent, 100)
      const builtinBefore = clonePreset(userEntries(h.manager).find(entry => entry.id === 'initial'))
      assert.equal(await h.manager.exportPreset(DEFAULT_PRESET_ID, 'image'), 'saved')
      assert.deepEqual(h.transfer.exports[1].snapshot, presetModel.createDefaultPresetSnapshot())
      assert.deepEqual(userEntries(h.manager).find(entry => entry.id === 'initial'), builtinBefore)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(h.applies(), applies)
    } finally {
      h.dispose()
    }
  })

  it('reports save-dialog cancellation and export errors without applying a card or discarding an independent import retry', async () => {
    const h = await harness()
    try {
      h.transfer.failure = 'read'
      assert.equal(await h.manager.importPreset('C:\\bad.petpreset'), undefined)
      assert.equal(h.manager.canRetryImport.value, true)
      h.transfer.writeResult = false
      const snapshot = presetModel.capturePresetSnapshot(h.store)
      const applies = h.applies()
      assert.equal(await h.manager.exportPreset(DEFAULT_PRESET_ID, 'image'), 'cancelled')
      assert.equal(h.manager.transferError.value, undefined)
      assert.equal(h.manager.canRetryImport.value, true)
      assert.equal(h.manager.transferPhase.value, undefined)
      h.transfer.writeError = new Error('destination unavailable')
      assert.equal(await h.manager.exportPreset(DEFAULT_PRESET_ID, 'image'), 'error')
      assert.equal(h.manager.transferError.value, 'export')
      assert.equal(h.manager.canRetryImport.value, true)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), snapshot)
      assert.equal(h.applies(), applies)
    } finally {
      h.dispose()
    }
  })

  for (const mode of ['image', 'nickname'] as const) {
    it(`imports ${mode} settings through saved preparation and commit without applying them`, async () => {
      const transfer = transferBoundary(mode)
      const h = await harness(undefined, undefined, undefined, transfer)
      const phases: Array<string | undefined> = []
      const stop = vue.watch(h.manager.transferPhase, value => phases.push(value), { flush: 'sync' })
      try {
        h.store.window.visible = false
        const before = clonePreset(userEntries(h.manager))
        const live = { ...presetModel.capturePresetSnapshot(h.store), appearance: { ...presetModel.capturePresetSnapshot(h.store).appearance, dmeloperSkinDataUrl: 'data:image/png;base64,YQ==' } }
        const applies = h.applies()
        const pickedFile = { name: '공유 安★.petpreset' } as File
        const importedId = await h.manager.importPreset(pickedFile)
        assert.ok(importedId)
        assert.deepEqual(phases, ['reading', 'skin', 'saving', undefined])
        assert.equal(h.manager.busy.value, false)
        assert.equal(h.manager.ready.value, true)
        assert.equal(h.manager.transferError.value, undefined)
        assert.equal(h.manager.canRetryImport.value, false)
        assert.equal(h.store.window.visible, false)
        assert.deepEqual(presetModel.capturePresetSnapshot(h.store), live)
        assert.equal(h.applies(), applies)
        assert.equal(userEntries(h.manager).length, before.length + 1)
        assert.deepEqual(userEntries(h.manager).slice(0, before.length), before)
        const added = userEntries(h.manager).at(-1)!
        assert.match(added.id, /^[\da-f-]{36}$/i)
        assert.equal(added.id, importedId)
        assert.equal(h.store.presetCollection?.activeId, null)
        assert.equal(added.name, 'Shared')
        assert.equal(added.favorite, false)
        assert.equal('builtin' in added, false)
        assert.equal(added.snapshot.preset.cameraZoomPercent, 145)
        assert.equal(added.snapshot.preset.dmeloperEyebrows.color, '#123456')
        assert.equal(added.snapshot.preset.dmeloperPalmColor, '#abcdef')
        assert.equal(added.snapshot.appearance.minecraftSkinUsername, 'Linked_Name')
        assert.equal(added.snapshot.appearance.dmeloperSkinModel, mode === 'nickname' ? 'slim' : 'wide')
        assert.equal(added.snapshot.appearance.activeSkinLibraryEntryId, transfer.entryId)
        assert.equal(added.snapshot.opacity, 73)
        assert.equal(added.snapshot.mirror, true)
        assert.equal(added.snapshot.eyebrowAnimationEnabled, false)
        assert.equal(transfer.prepared.length, 1)
        assert.equal(transfer.prepared[0].request.source, mode === 'nickname' ? 'java' : 'local')
        assert.equal(transfer.prepared[0].request.canonicalNickname, mode === 'nickname' ? 'Linked_Name' : undefined)
        assert.equal(transfer.prepared[0].request.overwriteExisting, false)
        assert.deepEqual(transfer.finished.map(call => call.commit), [true])
        assert.equal(transfer.journal?.phase, 'committed')
        assert.equal(transfer.reads[0], pickedFile)
      } finally {
        stop()
        h.dispose()
      }
    })
  }

  it('keeps the transfer busy through its commit acknowledgement and rejects overlapping management', async () => {
    const h = await harness()
    let release!: () => void
    h.transfer.commitHold = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const importing = h.manager.importPreset('C:\\shared.petpreset')
      await waitFor(() => h.transfer.finished.some(call => call.commit))
      assert.equal(h.manager.busy.value, true)
      assert.equal(h.manager.transferPhase.value, 'saving')
      assert.equal(stateOwners.presetsReady?.(), false)
      assert.equal(await h.manager.activate(DEFAULT_PRESET_ID), false)
      assert.equal(await h.manager.create('overlap'), false)
      assert.equal(await h.manager.exportPreset(DEFAULT_PRESET_ID, 'image'), 'error')
      assert.equal(await h.manager.importPreset('C:\\second.petpreset'), undefined)
      assert.equal(h.transfer.prepared.length, 1)
      release()
      assert.equal(await importing, userEntries(h.manager).at(-1)!.id)
      assert.equal(h.manager.busy.value, false)
      assert.equal(stateOwners.presetsReady?.(), true)
    } finally {
      release()
      h.dispose()
    }
  })

  it('uses numeric suffixes for repeated imports without reserving the old default name', async () => {
    const h = await harness()
    try {
      for (const name of ['Shared', 'Shared 2', 'Shared 3']) {
        assert.ok(await h.manager.importPreset('C:\\same.petpreset'))
        assert.equal(userEntries(h.manager).at(-1)?.name, name)
      }
      h.transfer.document.name = '앱 기본값'
      for (const name of ['앱 기본값', '앱 기본값 2']) {
        assert.ok(await h.manager.importPreset('C:\\defaults.petpreset'))
        assert.equal(userEntries(h.manager).at(-1)?.name, name)
      }
      assert.equal(new Set(userEntries(h.manager).map(entry => entry.id)).size, userEntries(h.manager).length)
    } finally {
      h.dispose()
    }
  })

  it('fetches the nickname only during import and retains its downloaded PNG after reselect and restart', async () => {
    const transfer = transferBoundary()
    let h = await harness(undefined, undefined, undefined, transfer)
    try {
      const importedId = await h.manager.importPreset('C:\\nickname.petpreset')
      assert.ok(importedId)
      h.store.window.visible = false
      assert.equal(await h.manager.activate(importedId), true)
      const skin = h.store.customization3d.dmeloperSkinDataUrl
      assert.equal(transfer.resolved.length, 1)
      const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useBlockStore>['$state']
      transfer.nicknamePng = 'different-network-skin'
      h.dispose()
      h = await harness(saved, undefined, undefined, transfer)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(h.store.customization3d.dmeloperSkinDataUrl, skin)
      assert.equal(h.store.customization3d.minecraftSkinUsername, 'Linked_Name')
      assert.equal(h.store.customization3d.dmeloperSkinModel, 'slim')
      assert.equal(transfer.resolved.length, 1)
    } finally {
      h.dispose()
    }
  })

  for (const stage of ['read', 'skin', 'prepare', 'prepareAfterJournal', 'save', 'commit'] as const) {
    it(`preserves the previous hidden preset when ${stage} fails`, async () => {
      const h = await harness()
      try {
        h.store.window.visible = false
        h.store.activePet3dPreset.cameraZoomPercent = 171
        assert.equal(await h.manager.retry(), true)
        const previous = clonePreset(h.store.presetCollection)
        const snapshot = { ...presetModel.capturePresetSnapshot(h.store), appearance: { ...presetModel.capturePresetSnapshot(h.store).appearance, dmeloperSkinDataUrl: 'data:image/png;base64,YQ==' } }
        const applies = h.applies()
        if (stage === 'skin') h.transfer.skinError = new MinecraftSkinError({ code: 'NETWORK', retryable: true })
        else if (stage === 'save') h.failSaveOnceAfter(1)
        else h.transfer.failure = stage
        assert.equal(await h.manager.importPreset('C:\\failure.petpreset'), undefined)
        assert.deepEqual(h.store.presetCollection, previous)
        assert.deepEqual(presetModel.capturePresetSnapshot(h.store), snapshot)
        assert.equal(h.store.window.visible, false)
        assert.equal(h.manager.ready.value, true)
        assert.equal(h.manager.busy.value, false)
        assert.equal(h.manager.canRetryImport.value, true)
        assert.ok(h.manager.transferError.value)
        assert.equal(h.transfer.journal, undefined)
        assert.equal(h.applies(), applies, 'an unapplied import must not reapply the scene during rollback')
        if (stage === 'read' || stage === 'skin' || stage === 'prepare') {
          assert.equal(h.applies(), applies)
          assert.deepEqual(h.transfer.finished, [])
        } else {
          assert.equal(h.transfer.finished.at(-1)?.commit, false)
        }
        h.transfer.failure = undefined
        h.transfer.skinError = undefined
        assert.ok(await h.manager.retryImport())
        assert.equal(userEntries(h.manager).at(-1)?.name, 'Shared')
        assert.equal(h.manager.canRetryImport.value, false)
      } finally {
        h.dispose()
      }
    })
  }

  it('recognizes a durable committed receipt after its native IPC reply is lost', async () => {
    const h = await harness()
    try {
      h.transfer.loseCommitReply = true
      h.store.window.visible = false
      const importedId = await h.manager.importPreset('C:\\reply-lost.petpreset')
      assert.ok(importedId)
      assert.equal(h.transfer.journal?.phase, 'committed')
      assert.deepEqual(h.transfer.finished.map(call => call.commit), [true])
      assert.equal(userEntries(h.manager).at(-1)?.id, importedId)
      assert.equal(importedId, h.transfer.prepared[0].presetId)
      assert.equal(userEntries(h.manager).length, 3)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(h.manager.transferError.value, undefined)
      assert.equal(h.manager.canRetryImport.value, false)
      assert.equal(h.store.window.visible, false)
      assert.equal(h.applies(), 0)
    } finally {
      h.dispose()
    }
  })

  it('blocks new work after failed cleanup, then recovers the journal before an explicit retry', async () => {
    const h = await harness()
    try {
      h.store.window.visible = false
      assert.equal(await h.manager.retry(), true)
      const before = clonePreset(h.store.presetCollection)
      h.transfer.failure = 'commit'
      h.transfer.rollbackFails = true
      assert.equal(await h.manager.importPreset('C:\\recovery.petpreset'), undefined)
      assert.equal(h.manager.ready.value, false)
      assert.equal(h.manager.transferError.value, 'recovery')
      assert.equal(h.transfer.journal?.phase, 'prepared')
      const prepared = h.transfer.prepared.length
      assert.equal(await h.manager.importPreset('C:\\blocked.petpreset'), undefined)
      assert.equal(await h.manager.create('blocked'), false)
      assert.equal(await h.manager.retryImport(), undefined)
      assert.equal(h.transfer.prepared.length, prepared)
      h.transfer.rollbackFails = false
      h.transfer.failure = undefined
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.transfer.journal, undefined)
      assert.deepEqual(h.store.presetCollection, before)
      assert.equal(h.store.window.visible, false)
      assert.ok(await h.manager.importPreset('C:\\recovery.petpreset'))
    } finally {
      h.dispose()
    }
  })

  for (const catalog of ['selected', 'empty', 'unselected']) {
    it(`restores a prepared journal on restart with a ${catalog} catalog after the imported target was saved`, async () => {
      const transfer = transferBoundary()
      let h = await harness(undefined, undefined, undefined, transfer, undefined, catalog === 'empty')
      try {
        if (catalog === 'unselected') assert.equal(await h.manager.remove('initial'), true)
        h.store.window.visible = false
        assert.equal(await h.manager.retry(), true)
        const previous = clonePreset(h.store.presetCollection)
        transfer.failure = 'commit'
        transfer.rollbackFails = true
        assert.equal(await h.manager.importPreset('C:\\interrupted.petpreset'), undefined)
        const savedImported = transfer.finished.find(call => call.commit)!.saved
        assert.equal(savedImported.presetCollection?.activeId, previous?.activeId)
        assert.equal(savedImported.presetCollection?.entries.length, previous!.entries.length + 1)
        assert.equal(transfer.journal?.phase, 'prepared')
        h.dispose()
        transfer.failure = undefined
        transfer.rollbackFails = false
        h = await harness(savedImported, undefined, undefined, transfer)
        assert.equal(h.manager.ready.value, true)
        assert.deepEqual(h.store.presetCollection, previous)
        assert.equal(h.store.window.visible, false)
        assert.equal(transfer.journal, undefined)
        assert.equal(transfer.resolved.length, 1, 'startup recovery must not fetch the nickname again')
        assert.equal(transfer.finished.at(-1)?.commit, false)
      } finally {
        h.dispose()
      }
    })
  }

  it('preserves the current catalog if native startup recovery rejects a stale journal', async () => {
    const transfer = transferBoundary()
    let h = await harness(undefined, undefined, undefined, transfer)
    try {
      const previous: PresetImportPrevious = {
        collection: clonePreset(h.store.presetCollection!),
        snapshot: presetModel.capturePresetSnapshot(h.store),
        visible: h.store.window.visible,
      }
      assert.equal(await h.manager.create('Newer user preset'), true)
      const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useBlockStore>['$state']
      transfer.journal = { operationId: crypto.randomUUID(), phase: 'prepared', previous }
      transfer.journalReadError = new PresetTransferError('recovery')
      h.dispose()
      h = await harness(saved, undefined, undefined, transfer)
      assert.equal(h.manager.ready.value, false)
      assert.deepEqual(h.store.presetCollection, saved.presetCollection)
      assert.equal(h.saves.length, 0)
      assert.equal(h.applies(), 0)
      assert.equal(transfer.finished.length, 0)
    } finally {
      h.dispose()
    }
  })

  it('recovers a previously applied interrupted import and restores its hidden source on restart', async () => {
    const transfer = transferBoundary()
    let h = await harness(undefined, undefined, undefined, transfer)
    try {
      h.store.window.visible = false
      h.store.activePet3dPreset.cameraZoomPercent = 171
      assert.equal(await h.manager.retry(), true)
      const previous = clonePreset(h.store.presetCollection)
      const snapshot = { ...presetModel.capturePresetSnapshot(h.store), appearance: { ...presetModel.capturePresetSnapshot(h.store).appearance, dmeloperSkinDataUrl: 'data:image/png;base64,YQ==' } }
      const importedId = await h.manager.importPreset('C:\\legacy-interrupted.petpreset')
      assert.ok(importedId)
      // Simulate the older importer: target applied and saved, but journal not committed.
      transfer.journal!.phase = 'prepared'
      transfer.journal!.previous.collection.activeId = 'initial'
      assert.equal(await h.manager.activate(importedId), true)
      const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useBlockStore>['$state']
      saved.presetCollection!.activeId = importedId
      assert.equal(saved.window.visible, true)
      h.dispose()
      h = await harness(saved, undefined, undefined, transfer)
      assert.equal(h.manager.ready.value, true)
      assert.deepEqual(h.store.presetCollection, previous)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), snapshot)
      assert.equal(h.store.window.visible, false)
      assert.equal(h.applies(), 1, 'an already applied target still requires acknowledged scene recovery')
      assert.equal(transfer.journal, undefined)
      assert.equal(transfer.finished.at(-1)!.expected.collection.activeId, 'initial', 'native rollback must see the raw legacy selection')
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(transfer.resolved.length, 1)
    } finally {
      h.dispose()
    }
  })

  for (const catalog of ['selected', 'empty', 'unselected']) {
    it(`keeps a successful import unapplied through restart with a ${catalog} catalog`, async () => {
      const transfer = transferBoundary()
      let h = await harness(undefined, undefined, undefined, transfer, undefined, catalog === 'empty')
      try {
        if (catalog === 'unselected') assert.equal(await h.manager.remove('initial'), true)
        h.store.activePet3dPreset.cameraZoomPercent = 172
        h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,YQ=='
        h.store.window.visible = catalog === 'selected'
        const snapshot = presetModel.capturePresetSnapshot(h.store)
        const activeId = h.store.presetCollection?.activeId
        const importedId = await h.manager.importPreset('C:\\kept.petpreset')
        assert.ok(importedId)
        const imported = clonePreset(userEntries(h.manager).find(entry => entry.id === importedId))
        const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useBlockStore>['$state']
        h.dispose()
        h = await harness(saved, undefined, undefined, transfer)
        assert.equal(h.store.presetCollection?.activeId, activeId)
        assert.deepEqual(presetModel.capturePresetSnapshot(h.store), snapshot)
        assert.deepEqual(userEntries(h.manager).find(entry => entry.id === importedId), imported)
        assert.equal(h.store.window.visible, catalog === 'selected')
        assert.equal(h.applies(), 0)
        assert.equal(transfer.resolved.length, 1)
      } finally {
        h.dispose()
      }
    })
  }

  it('materializes the bundled rollback skin with an empty catalog and preserves hidden state', async () => {
    const browser = installPresetSkinBrowser()
    let h: Awaited<ReturnType<typeof harness>> | undefined
    try {
      h = await harness(undefined, preparePresetSkin)
      const current = h
      await withPresetReset(async () => {
        current.store.resetAllSettings({ deleteSkins: false, resetPresets: true })
      })
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.store.customization3d.dmeloperSkinDataUrl, undefined)
      h.store.window.visible = false
      h.transfer.failure = 'prepareAfterJournal'
      assert.equal(await h.manager.importPreset('C:\\after-reset.petpreset'), undefined)
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.deepEqual(userEntries(h.manager), [])
      assert.equal(h.transfer.prepared[0].previous.snapshot.appearance.dmeloperSkinDataUrl, browser.dataUrl)
      assert.equal(h.transfer.prepared[0].previous.snapshot.appearance.activeSkinLibraryEntryId, 'builtin:dmeloper')
      assert.equal(h.transfer.journal, undefined)
      assert.equal(h.store.window.visible, false)
      assert.equal(h.store.customization3d.dmeloperSkinDataUrl, browser.dataUrl)
    } finally {
      h?.dispose()
      browser.restore()
    }
  })

  it('finishes rollback before a waiting whole-program reset replaces the catalog', async () => {
    const h = await harness()
    let release!: () => void
    h.transfer.prepareHold = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const importing = h.manager.importPreset('C:\\reset-race.petpreset')
      await waitFor(() => h.transfer.prepared.length === 1)
      let reset = false
      const resetting = withPresetReset(async () => {
        assert.equal(h.transfer.journal, undefined, 'reset must wait until the import finishes its rollback')
        h.store.resetAllSettings({ deleteSkins: false, resetPresets: true })
        reset = true
      })
      assert.equal(reset, false)
      release()
      assert.equal(await importing, undefined)
      await resetting
      assert.equal(reset, true)
      assert.equal(userEntries(h.manager).length, 0)
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.equal(h.transfer.journal, undefined)
    } finally {
      release()
      h.dispose()
    }
  })
})

it('captures sampled, manual and automatic palm colors synchronously and restores the saved value', async () => {
  const h = await harness()
  await h.manager.activate(DEFAULT_PRESET_ID)
  let saved: ReturnType<typeof useBlockStore>['$state']
  try {
    const before = clonePreset(h.store.presetCollection)
    const active = () => h.store.activePet3dPreset
    assert.equal(h.store.applySkinLibraryEntry({ entryId: 'a'.repeat(64), source: 'local', dataUrl: 'data:image/png;base64,YQ==', skinModel: 'wide', palmColor: '#445566' }), true)
    assert.equal(active().dmeloperPalmColor, '#445566')
    assert.equal(h.store.presetCollection?.activeId, null)
    h.store.updateDmeloperPalmColor('#123456')
    assert.equal(active().dmeloperPalmColor, '#123456')
    h.store.resetDmeloperPalmColor('#445566')
    assert.equal(active().dmeloperPalmColor, '#445566')
    await h.manager.retry()
    assert.deepEqual(h.store.presetCollection, before)
    saved = clonePreset(h.saves.at(-1)) as typeof saved
  } finally {
    h.dispose()
  }
  const restarted = await harness(saved!)
  try {
    assert.equal(restarted.store.activePet3dPreset.dmeloperPalmColor, '#445566')
  } finally {
    restarted.dispose()
  }
})

for (const selected of [false, true]) {
  it(`captures current settings without reapplying or revealing the pet when an existing catalog is ${selected}`, async () => {
    const h = await harness(undefined, undefined, undefined, undefined, undefined, !selected)
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 173
      h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,Yg=='
      h.store.customization3d.activeSkinLibraryEntryId = 'b'.repeat(64)
      h.store.customization3d.minecraftSkinUsername = 'Current_Skin'
      h.store.activePet3dPreset.dmeloperPalmColor = '#123456'
      h.store.window.visible = false
      h.store.model.maxFPS = 47
      const snapshot = presetModel.capturePresetSnapshot(h.store)
      const before = clonePreset(userEntries(h.manager))
      assert.equal(await h.manager.create('App Defaults'), true)
      const created = userEntries(h.manager).at(-1)!
      assert.equal(created.name, 'App Defaults')
      assert.equal(h.store.presetCollection?.activeId, null)
      assert.deepEqual(created.snapshot, snapshot)
      assert.deepEqual(userEntries(h.manager).slice(0, -1), before)
      assert.equal(h.store.window.visible, false)
      assert.equal(h.store.model.maxFPS, 47)
      assert.equal(h.applies(), 0)
      h.store.activePet3dPreset.cameraZoomPercent = 182
      assert.equal(created.snapshot.preset.cameraZoomPercent, 173)
      assert.equal(await h.manager.retry(), true)
    } finally {
      h.dispose()
    }
  })
}

for (const operation of ['create', 'delete'] as const) {
  it(`preserves the list and current state when ${operation} cannot be saved`, async () => {
    const h = await harness(undefined, undefined, undefined, undefined, undefined, true)
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 173
      h.store.window.visible = false
      if (operation === 'delete') assert.equal(await h.manager.create('Only'), true)
      const before = clonePreset(h.store.presetCollection)
      const snapshot = presetModel.capturePresetSnapshot(h.store)
      h.failSaveAfter(1)
      const result = operation === 'create'
        ? await h.manager.create('Failed')
        : await h.manager.remove(userEntries(h.manager).at(-1)!.id)
      assert.equal(result, false)
      assert.deepEqual(h.store.presetCollection, before)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), snapshot)
      assert.equal(h.store.window.visible, false)
      assert.equal(h.applies(), 0)
      h.failSave(false)
      assert.equal(await h.manager.retry(), true)
    } finally {
      h.dispose()
    }
  })
}

it('deletes the last preset, retains current settings, and keeps them after an empty restart', async () => {
  const h = await harness(undefined, undefined, undefined, undefined, undefined, true)
  let saved!: ReturnType<typeof useBlockStore>['$state']
  try {
    h.store.activePet3dPreset.cameraZoomPercent = 163
    h.store.window.visible = false
    assert.equal(await h.manager.create('Only'), true)
    const before = presetModel.capturePresetSnapshot(h.store)
    assert.equal(await h.manager.remove(userEntries(h.manager).at(-1)!.id), true)
    assert.deepEqual(h.store.presetCollection, presetModel.createPresetCollection())
    assert.deepEqual(presetModel.capturePresetSnapshot(h.store), before)
    assert.equal(h.store.window.visible, false)
    assert.equal(h.applies(), 0)
    saved = clonePreset(h.saves.at(-1) as typeof saved)
  } finally {
    h.dispose()
  }
  const restarted = await harness(saved)
  try {
    assert.equal(userEntries(restarted.manager).length, 0)
    assert.equal(restarted.store.activePet3dPreset.cameraZoomPercent, 163)
    assert.equal(restarted.store.window.visible, false)
    assert.equal(restarted.applies(), 0)
  } finally {
    restarted.dispose()
  }
})

it('deletes another entry without changing current settings', async () => {
  const h = await harness()
  try {
    h.store.activePet3dPreset.cameraZoomPercent = 164
    const before = presetModel.capturePresetSnapshot(h.store)
    assert.equal(await h.manager.remove(DEFAULT_PRESET_ID), true)
    assert.equal(h.store.presetCollection?.activeId, null)
    assert.deepEqual(presetModel.capturePresetSnapshot(h.store), before)
    assert.equal(h.applies(), 0)
  } finally {
    h.dispose()
  }
})

for (const unselected of [false, true]) {
  for (const failing of [false, true]) {
    it(`imports from ${unselected ? 'an unselected catalog' : 'an empty catalog'} and ${failing ? 'restores it on failure' : 'retains the current state'}`, async () => {
      const h = await harness(undefined, undefined, undefined, undefined, undefined, !unselected)
      try {
        if (unselected) assert.equal(await h.manager.remove('initial'), true)
        h.store.activePet3dPreset.cameraZoomPercent = 174
        h.store.window.visible = false
        assert.equal(await h.manager.retry(), true)
        const before = clonePreset(h.store.presetCollection)
        if (failing) h.transfer.failure = 'commit'
        const importedId = await h.manager.importPreset('C:\\nullable.petpreset')
        if (failing) {
          assert.equal(importedId, undefined)
          assert.deepEqual(h.store.presetCollection, before)
          assert.equal(h.store.presetCollection?.activeId, null)
          assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 174)
          assert.equal(h.store.window.visible, false)
          assert.equal(h.transfer.journal, undefined)
        } else {
          assert.equal(importedId, userEntries(h.manager).at(-1)!.id)
          assert.equal(userEntries(h.manager).length, before!.entries.length + 1)
          assert.equal(h.store.presetCollection?.activeId, null)
          assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 174)
          assert.equal(h.store.window.visible, false)
          assert.equal(h.transfer.finished.at(-1)!.commit, true)
        }
        assert.equal(h.applies(), 0)
      } finally {
        h.dispose()
      }
    })
  }
}

it('silently imports incompatible sources, retains raw data and applies only compatible values at the save barrier', async () => {
  const h = await harness()
  let saved!: ReturnType<typeof useBlockStore>['$state']
  let importedId = ''
  try {
    h.transfer.document.settings.preset.autoViewportPaddingPixels = 40
    h.transfer.document.settings.opacity = 37
    Reflect.set(h.transfer.document.settings.preset, 'futureOption', { enabled: true })
    const beforeLive = presetModel.capturePresetSnapshot(h.store)
    const ids = await h.manager.importPresets(['first.petpreset', 'second.petpreset'])
    assert.equal(ids.length, 2)
    assert.deepEqual(presetSettings(presetModel.capturePresetSnapshot(h.store)), presetSettings(beforeLive))
    assert.equal(h.applies(), 0)
    const source = h.store.presetCollection!.entries.find(entry => entry.id === ids[0])!
    importedId = source.id
    assert.notEqual(h.manager.cardPending.value[source.id], 'saving', 'retained source metadata must not leave a saved card blocked')
    assert.equal((source.sourceSettings!.preset as Record<string, unknown>).autoViewportPaddingPixels, 40)
    assert.equal(h.manager.compatibility.value[source.id].length, 2)
    const original = clonePreset(source)
    assert.equal(await h.manager.activate(source.id), false)
    h.store.activePet3dPreset.autoViewportPaddingPixels = 12
    const preservedSkin = clonePreset(h.store.customization3d)
    assert.equal(await h.manager.activate(source.id, { applySkin: false, compatibleOnly: true, expectedSourceKey: presetSourceKey(source) }), true)
    assert.equal(h.store.activePet3dPreset.autoViewportPaddingPixels, 12)
    assert.equal(h.store.window.opacity, 37)
    assert.equal(h.store.customization3d.dmeloperSkinDataUrl, preservedSkin.dmeloperSkinDataUrl)
    assert.deepEqual(clonePreset(source), original)
    assert.equal(await h.manager.duplicate(source.id), true)
    assert.deepEqual(clonePreset(h.store.presetCollection!.entries.at(-1)!.sourceSettings), original.sourceSettings)
    assert.equal(await h.manager.exportPreset(source.id, 'image'), 'saved')
    assert.deepEqual(clonePreset(h.transfer.written.at(-1)!.sourceSettings), original.sourceSettings)
    await h.manager.retry()
    assert.deepEqual(clonePreset(h.store.presetCollection!.entries.find(entry => entry.id === source.id)!.sourceSettings), original.sourceSettings)
    saved = clonePreset(h.saves.at(-1) as typeof saved)
  } finally {
    h.dispose()
  }
  const restarted = await harness(saved)
  try {
    const entry = restarted.store.presetCollection!.entries.find(entry => entry.id === importedId)!
    assert.equal((entry.sourceSettings!.preset as Record<string, unknown>).autoViewportPaddingPixels, 40)
    assert.equal(restarted.manager.compatibility.value[importedId].length, 2)
    assert.equal(restarted.store.activePet3dPreset.autoViewportPaddingPixels, 12)
  } finally {
    restarted.dispose()
  }
})

it('rejects a stale compatibility confirmation after the save barrier and preserves source data on apply failure', async () => {
  const h = await harness()
  try {
    const entry = h.store.presetCollection!.entries[0]
    entry.sourceSettings = clonePreset(presetModel.capturePresetSnapshot(h.store)) as unknown as Record<string, unknown>
    delete entry.sourceSettings.appearance
    ;(entry.sourceSettings.preset as Record<string, unknown>).autoViewportPaddingPixels = 40
    const key = presetSourceKey(entry)
    ;(entry.sourceSettings.preset as Record<string, unknown>).autoViewportPaddingPixels = 50
    const before = clonePreset(h.store.presetCollection)
    const applies = h.applies()
    assert.equal(await h.manager.activate(entry.id, { compatibleOnly: true, expectedSourceKey: key }), false)
    assert.equal(h.applies(), applies)
    assert.deepEqual(h.store.presetCollection, before)
    h.failSaveAfter(1)
    assert.equal(await h.manager.activate(entry.id, { compatibleOnly: true, applySkin: false }), false)
    assert.deepEqual(h.store.presetCollection, before)
  } finally {
    h.dispose()
  }
})

it('audit: rejects source changes while asynchronous skin restoration is pending', async () => {
  let held = false
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await harness(undefined, async (snapshot) => {
    if (held) await pending
    const next = clonePreset(snapshot)
    next.appearance.dmeloperSkinDataUrl ??= 'data:image/png;base64,YQ=='
    return next
  })
  try {
    const entry = h.store.presetCollection!.entries[0]
    entry.sourceSettings = projectPresetSettings({}) as unknown as Record<string, unknown>
    ;(entry.sourceSettings.preset as Record<string, unknown>).autoViewportPaddingPixels = 40
    const key = presetSourceKey(entry)
    held = true
    const beforeApplies = h.applies()
    const applying = h.manager.activate(entry.id, { compatibleOnly: true, expectedSourceKey: key })
    await waitFor(() => h.restoredSkins() === 1)
    ;(entry.sourceSettings.preset as Record<string, unknown>).autoViewportPaddingPixels = 50
    release()
    assert.equal(await applying, false, 'changed sources must receive another confirmation')
    assert.equal(h.applies(), beforeApplies, 'obsolete confirmed data must not reach execution')
    assert.equal((h.store.presetCollection!.entries[0].sourceSettings!.preset as Record<string, unknown>).autoViewportPaddingPixels, 50)
    assert.equal(((h.saves.at(-1) as ReturnType<typeof useBlockStore>['$state']).presetCollection!.entries[0].sourceSettings!.preset as Record<string, unknown>).autoViewportPaddingPixels, 50)
  } finally {
    release()
    h.dispose()
  }
})

it('retains the latest current values for incompatible fields after asynchronous skin restoration', async () => {
  let held = false
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await harness(undefined, async (snapshot) => {
    if (held) await pending
    const next = clonePreset(snapshot)
    next.appearance.dmeloperSkinDataUrl ??= 'data:image/png;base64,YQ=='
    return next
  })
  try {
    const entry = h.store.presetCollection!.entries[0]
    entry.sourceSettings = projectPresetSettings({}) as unknown as Record<string, unknown>
    ;(entry.sourceSettings.preset as Record<string, unknown>).autoViewportPaddingPixels = 40
    h.store.activePet3dPreset.autoViewportPaddingPixels = 12
    held = true
    const applying = h.manager.activate(entry.id, { compatibleOnly: true, expectedSourceKey: presetSourceKey(entry) })
    await waitFor(() => h.restoredSkins() === 1)
    h.store.activePet3dPreset.autoViewportPaddingPixels = 16
    release()
    assert.equal(await applying, true)
    assert.equal(h.store.activePet3dPreset.autoViewportPaddingPixels, 16)
    assert.equal((entry.sourceSettings.preset as Record<string, unknown>).autoViewportPaddingPixels, 40)
  } finally {
    release()
    h.dispose()
  }
})

it('audit: preserves the specific compatibility reconfirmation reason', async () => {
  const h = await harness()
  try {
    const entry = h.store.presetCollection!.entries[0]
    entry.sourceSettings = projectPresetSettings({}) as unknown as Record<string, unknown>
    ;(entry.sourceSettings.preset as Record<string, unknown>).autoViewportPaddingPixels = 40
    const key = presetSourceKey(entry)
    ;(entry.sourceSettings.preset as Record<string, unknown>).autoViewportPaddingPixels = 50
    assert.equal(await h.manager.activate(entry.id, { compatibleOnly: true, expectedSourceKey: key }), false)
    assert.equal(h.manager.error.value, 'pages.preference.presets.compatibility.changed')
    assert.equal((h.store.presetCollection!.entries[0].sourceSettings!.preset as Record<string, unknown>).autoViewportPaddingPixels, 50)
  } finally {
    h.dispose()
  }
})

it('preserves future root settings from legacy snapshots through safe partial apply, copy and export', async () => {
  const h = await harness()
  try {
    const entry = h.store.presetCollection!.entries[0]
    Reflect.set(entry.snapshot, 'futureOption', { enabled: true })
    assert.equal(h.manager.compatibility.value[entry.id][0].reason, 'unknown')
    assert.equal(await h.manager.activate(entry.id, { compatibleOnly: true, applySkin: false }), true)
    assert.equal(await h.manager.duplicate(entry.id), true)
    const copy = h.store.presetCollection!.entries.at(-1)!
    assert.deepEqual(clonePreset(copy.sourceSettings!.futureOption), { enabled: true })
    assert.equal('futureOption' in copy.snapshot, false)
    assert.equal(await h.manager.exportPreset(entry.id, 'image'), 'saved')
    assert.deepEqual(clonePreset(h.transfer.written.at(-1)!.sourceSettings!.futureOption), { enabled: true })
    assert.deepEqual(Reflect.get(entry.snapshot, 'futureOption'), { enabled: true })
  } finally {
    h.dispose()
  }
})
