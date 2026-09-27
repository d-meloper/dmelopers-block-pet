/* eslint-disable test/no-import-node-test */
import type { _DeepPartial } from 'pinia'

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

import type { createDefaultPresetSnapshot } from '@/features/presets/model'
import type { PortablePetPreset, PresetExportMode } from '@/features/presets/transfer'
import type { PresetApplyRequest, PresetSnapshot } from '@/features/presets/types'
import type { PresetImportJournal, PresetImportPrevious } from '@/services/presetTransfer'
import type { SkinLibraryStoreRequest } from '@/services/skinLibrary'

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
import { BUILTIN_PRESET_ID, PRESET_APPLY_REQUEST, PRESET_APPLY_RESPONSE } from '@/features/presets/types'
import { editorsLocked, initializePetForStartup, registerPresetFlush, stateOwners } from '@/features/stateSafety/bridge'
import { getRequiredPetAssetMutation } from '@/pages/main/petAssetSelection'
import { createVisibleBoundsSelectionSignature, visibleBoundsSelectionChanged } from '@/pages/main/viewportSelection'
import { getResolvedDmeloperSkinUrl } from '@/services/dmeloperSkin'
import { MinecraftSkinError } from '@/services/minecraftSkin'
import { preparePetStateForSync, useCatStore } from '@/stores/cat'
import { runProgramSettingsReset } from '@/utils/programSettingsReset'

import type { PresetManager } from './usePresetManager'

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('./usePresetManager.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

interface TransferBoundary {
  document: PortablePetPreset
  journal?: PresetImportJournal
  entryId: string
  failure?: 'read' | 'prepare' | 'prepareAfterJournal' | 'commit'
  skinError?: unknown
  journalReadError?: unknown
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
  finished: Array<{ operationId: string, commit: boolean, expected: PresetImportPrevious, saved: ReturnType<typeof useCatStore>['$state'] }>
}

function transferBoundary(mode: PresetExportMode = 'nickname', name = 'Shared'): TransferBoundary {
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

async function harness(
  initialState?: ReturnType<typeof useCatStore>['$state'],
  skinPreparer?: typeof preparePresetSkin,
  beforeMount?: (dispose: () => void) => void,
  transfer: TransferBoundary = transferBoundary(),
  subscriptionFailures: { response?: number, close?: number } = {},
  freshInstall = false,
) {
  setActivePinia(createPinia())
  const store = useCatStore()
  if (initialState) store.$patch(clonePreset(initialState) as _DeepPartial<typeof store.$state>)
  // Most cases exercise an existing editable catalog. A fresh installation now
  // starts with only the immutable built-in entry, covered explicitly below.
  const seededCatalog = !initialState && !freshInstall
  if (seededCatalog) store.presetCollection = presetModel.createPresetCollection(presetModel.capturePresetSnapshot(store), 'initialName')
  initializePetForStartup(store)
  if (editorsLocked.value && initialState?.window.visible === false) assert.equal(store.window.visible, false, 'recovery initialization preserves hidden state')
  const mounted: Array<() => Promise<void>> = []
  const unmounted: Array<() => void> = []
  const listeners = new Map<string, (event: { payload: unknown }) => void>()
  let closeListeners = 0
  let quitReady: (() => boolean) | undefined
  let saveFails = false
  let saveFailureAfter: number | undefined
  let saveFailureOnceAfter: number | undefined
  let applyFails = false
  let applyFailuresRemaining = 0
  let restored = true
  let applyHold: Promise<void> | undefined
  let saveHold: Promise<void> | undefined
  let thumbnailHold: Promise<void> | undefined
  let applies = 0
  let rendered = 0
  let thumbnailFails = false
  const saves: unknown[] = []
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
    if (!failed) store.$patch(() => applyPresetSnapshot(store, request.snapshot, undefined, request.restoreVisibility ?? true))
    listeners.get(PRESET_APPLY_RESPONSE)?.({ payload: {
      requestId: request.requestId,
      success: !failed,
      restored,
      revision: store.activePet3dPreset.viewportModeRevision,
      snapshot: clonePreset(request.snapshot),
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
        return { getCurrentWebviewWindow: () => ({ onCloseRequested: async () => {
          if (subscriptionFailures.close) {
            subscriptionFailures.close--
            throw new Error('close subscription unavailable')
          }
          closeListeners++
          return () => {
            closeListeners--
          }
        } }) }
      }
      if (id === '@tauri-store/pinia') {
        return {
          getStoreState: async () => clonePreset(store.$state),
          saveAllNow: async () => {
            await saveHold
            if (saveFailureOnceAfter !== undefined && saves.length >= saveFailureOnceAfter) {
              saveFailureOnceAfter = undefined
              throw new Error('disk full once')
            }
            if (saveFails || (saveFailureAfter !== undefined && saves.length >= saveFailureAfter)) throw new Error('disk full')
            saves.push(clonePreset(store.$state))
          },
        }
      }
      if (id === '@/features/stateSafety/bridge') return { editorsLocked, stateOwners, initializePetForStartup, registerPresetFlush }
      if (id === '@/stores/cat') return { useCatStore: () => store }
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
      if (id === '@/features/presets/skin') return { preparePresetSkin: skinPreparer ?? prepare }
      if (id === '@/features/presets/transfer') {
        return {
          PresetTransferError,
          exportPortablePreset: async (name: string, snapshot: PresetSnapshot, mode: PresetExportMode) => {
            transfer.exports.push({ name, snapshot: clonePreset(snapshot), mode })
            if (mode === 'nickname' && !snapshot.appearance.minecraftSkinUsername) throw new PresetTransferError('invalidNickname')
            return {
              ...clonePreset(transfer.document),
              name,
              settings: clonePreset({ preset: snapshot.preset, mirror: snapshot.mirror, opacity: snapshot.opacity, eyebrowAnimationEnabled: snapshot.eyebrowAnimationEnabled }),
              skin: mode === 'nickname'
                ? { mode, nickname: snapshot.appearance.minecraftSkinUsername! }
                : { mode, pngBase64: snapshot.appearance.dmeloperSkinDataUrl?.split(',')[1] ?? 'YQ==', model: snapshot.appearance.dmeloperSkinModel === 'slim' ? 'slim' : 'wide' },
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
          const saved = saves.at(-1) as ReturnType<typeof useCatStore>['$state']
          assert.ok(saved, 'the manager must save before requesting native completion')
          assert.deepEqual(saved.presetCollection, expected.collection)
          assert.deepEqual(presetModel.capturePresetSnapshot(saved as ReturnType<typeof useCatStore>), expected.snapshot)
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
            return clonePreset(transfer.document)
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
        return { renderPresetThumbnail: async (snapshot: ReturnType<typeof createDefaultPresetSnapshot>) => {
          rendered++
          await thumbnailHold
          if (thumbnailFails) throw new Error('WebGL unavailable')
          return `data:image/png;base64,preview-${snapshot.preset.cameraZoomPercent}`
        } }
      }
      if (id.startsWith('@/')) return require(fileURLToPath(new URL(`../${id.slice(2)}`, import.meta.url)))
      return require(id)
    },
  })
  const manager = module.exports.usePresetManager()
  beforeMount?.(() => unmounted.forEach(callback => callback()))
  for (const mount of mounted) await mount()
  if (seededCatalog) applies = 0
  return {
    store,
    manager,
    saves,
    diagnostics,
    transfer,
    subscriptions: () => ({ response: listeners.size, close: closeListeners }),
    quitReady: () => quitReady?.() ?? false,
    applies: () => applies,
    rendered: () => rendered,
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
  it('starts a fresh installation with only the authored built-in preset', async () => {
    const h = await harness(undefined, undefined, undefined, undefined, undefined, true)
    try {
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.manager.activeId.value, BUILTIN_PRESET_ID)
      assert.equal(h.manager.entries.value.length, 1)
      assert.equal(h.manager.entries.value[0].name, '')
      assert.equal(h.store.activePet3dPreset.autoViewportPaddingPixels, 2)
      assert.equal(h.store.activePet3dPreset.dmeloperEyebrows.depthPercent, 50)
      assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#FFDFCE')
      assert.equal(h.applies(), 0)
      assert.equal(h.saves.length, 1)
    } finally {
      h.dispose()
    }
  })

  it('preserves catalog-free saved visual settings as an editable initial preset', async () => {
    setActivePinia(createPinia())
    const previous = useCatStore()
    previous.init()
    previous.activePet3dPreset.autoViewportPaddingPixels = 12
    const h = await harness(clonePreset(previous.$state))
    try {
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.manager.activeId.value, 'initial')
      assert.equal(h.manager.entries.value.length, 2)
      assert.equal(h.store.activePet3dPreset.autoViewportPaddingPixels, 12)
      assert.equal(h.manager.entries.value[0].snapshot.preset.autoViewportPaddingPixels, 2)
    } finally {
      h.dispose()
    }
  })

  for (const existing of [false, true]) {
    it(`does not resume ${existing ? 'saved-catalog apply' : 'first adoption'} after disposal during skin preparation`, async () => {
      let release!: () => void
      const delayed = new Promise<void>((resolve) => {
        release = resolve
      })
      let preparing = false
      let dispose!: () => void
      setActivePinia(createPinia())
      const initial = useCatStore()
      if (existing) initial.presetCollection = presetModel.createPresetCollection(presetModel.capturePresetSnapshot(initial))
      const creating = harness(clonePreset(initial.$state), async (snapshot) => {
        preparing = true
        await delayed
        return { ...clonePreset(snapshot), appearance: { ...snapshot.appearance, dmeloperSkinDataUrl: 'data:image/png;base64,YQ==' } }
      }, (unmount) => {
        dispose = unmount
      })
      await waitFor(() => preparing)
      dispose()
      const before = clonePreset(useCatStore().$state)
      release()
      const h = await creating
      try {
        assert.equal(h.manager.ready.value, false)
        assert.deepEqual(clonePreset(h.store.$state), before)
        assert.equal(h.applies(), 0)
        assert.equal(h.saves.length, 0)
        assert.deepEqual(h.subscriptions(), { response: 0, close: 0 })
      } finally {
        h.dispose()
      }
    })
  }

  for (const failed of ['response', 'close'] as const) {
    it(`releases partial ${failed} subscription setup and restores both listeners before retry becomes ready`, async () => {
      const h = await harness(undefined, undefined, undefined, undefined, { [failed]: 1 })
      try {
        assert.equal(h.manager.ready.value, false)
        assert.deepEqual(h.subscriptions(), { response: 0, close: 0 })
        assert.equal(await h.manager.retry(), true)
        assert.deepEqual(h.subscriptions(), { response: 1, close: 1 })
        assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), true)
        assert.equal(h.manager.activeId.value, BUILTIN_PRESET_ID)
      } finally {
        h.dispose()
      }
      assert.deepEqual(h.subscriptions(), { response: 0, close: 0 })
    })
  }

  it('cycles each menu stage, wraps intermediate and signed values, and persists rapid commands in order', async () => {
    const h = await harness()
    let saved!: ReturnType<typeof useCatStore>['$state']
    try {
      assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), true)
      const builtin = clonePreset(h.manager.entries.value.find(entry => entry.builtin)!)
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
      assert.notEqual(h.manager.activeId.value, BUILTIN_PRESET_ID)
      assert.deepEqual(h.manager.entries.value.find(entry => entry.builtin), builtin)
      assert.equal(await h.manager.retry(), true)
      saved = h.saves.at(-1) as typeof saved
      const active = saved.presetCollection?.entries.find(entry => entry.id === h.manager.activeId.value)
      assert.equal(active?.snapshot.preset.cameraZoomPercent, 75)
      assert.equal(active?.snapshot.preset.sceneRotationOffsetDegrees, 45)
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

  it('duplicates the latest saved edit without applying it and keeps both snapshots independent', async () => {
    const h = await harness()
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 141
      h.store.updateDmeloperPalmColor('#ABCDEF')
      h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,c2tpbg=='
      assert.equal(h.manager.entries.value.find(entry => entry.id === h.manager.activeId.value)?.snapshot.preset.cameraZoomPercent, 141)
      assert.equal(await h.manager.duplicate('initial'), true)
      const copy = h.manager.entries.value.at(-1)!
      assert.equal(copy.name, 'initialName 2')
      assert.equal(copy.snapshot.preset.cameraZoomPercent, 141)
      assert.equal(copy.snapshot.appearance.dmeloperSkinDataUrl, 'data:image/png;base64,c2tpbg==')
      assert.equal(h.manager.activeId.value, 'initial')
      assert.equal(h.applies(), 0)
      h.store.activePet3dPreset.cameraZoomPercent = 82
      h.store.updateDmeloperPalmColor('#123456')
      assert.equal(copy.snapshot.preset.cameraZoomPercent, 141)
      assert.equal(copy.snapshot.preset.dmeloperPalmColor, '#ABCDEF')
      assert.equal(await h.manager.activate(copy.id), true)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 141)
      assert.equal(h.manager.entries.value.find(entry => entry.id === 'initial')?.snapshot.preset.cameraZoomPercent, 82)
      assert.equal(h.manager.status.value, 'saved')
    } finally {
      h.dispose()
    }
  })

  it('duplicates the chosen inactive card and numbers repeated copies without changing the current preset', async () => {
    const h = await harness()
    try {
      await h.manager.rename('initial', '작업 😶 安')
      h.store.activePet3dPreset.cameraZoomPercent = 143
      await h.manager.create('Current')
      h.store.activePet3dPreset.cameraZoomPercent = 82
      const activeId = h.manager.activeId.value
      const applies = h.applies()
      assert.equal(await h.manager.duplicate('initial'), true)
      assert.equal(await h.manager.duplicate('initial'), true)
      const copies = h.manager.entries.value.slice(-2)
      assert.deepEqual(copies.map(entry => entry.name), ['작업 😶 安 2', '작업 😶 安 3'])
      assert.ok(copies.every(entry => entry.snapshot.preset.cameraZoomPercent === 143))
      assert.notEqual(copies[0].id, copies[1].id)
      assert.equal(h.manager.activeId.value, activeId)
      assert.equal(h.applies(), applies)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 82)
    } finally {
      h.dispose()
    }
  })

  it('creates a mutable, numbered default duplicate with its own bundled skin', async () => {
    const h = await harness()
    try {
      h.store.activePet3dPreset.cameraZoomPercent = 143
      h.store.customization3d.dmeloperSkinDataUrl = 'data:image/png;base64,c2tpbg=='
      assert.equal(await h.manager.duplicate(BUILTIN_PRESET_ID), true)
      const copy = h.manager.entries.value.at(-1)!
      assert.equal(copy.name, 'builtinName 2')
      assert.equal(copy.builtin, false)
      assert.equal(copy.favorite, false)
      assert.equal(copy.snapshot.preset.cameraZoomPercent, 100)
      assert.equal(copy.snapshot.appearance.dmeloperSkinDataUrl, 'data:image/png;base64,YQ==')
      assert.equal(h.manager.activeId.value, 'initial')
      assert.equal(h.applies(), 0)
      await h.manager.activate(copy.id)
      h.store.activePet3dPreset.cameraZoomPercent = 137
      assert.equal(h.manager.entries.value.length, 3)
      assert.equal(h.manager.entries.value.find(entry => entry.builtin)?.snapshot.preset.cameraZoomPercent, 100)
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
      assert.equal(h.manager.entries.value.length, 2)
      assert.equal(h.manager.activeId.value, 'initial')
      assert.equal(h.manager.status.value, 'error')
      assert.equal(h.applies(), 0)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 137)
      h.failSave(false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(await h.manager.duplicate('initial'), true)
      assert.equal(h.manager.entries.value.at(-1)?.name, 'initialName 2')
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
      assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), false)
      assert.equal(h.manager.activeId.value, 'initial')
      assert.equal(h.manager.cardPending.value.initial, undefined)
      assert.equal(h.applies(), 0)
      assert.deepEqual(h.diagnostics, [{ level: 'error', operation: 'presets.save' }])
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 137)
      h.failSave(false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), true)
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 100)
      assert.equal(h.diagnostics.length, 1, 'successful retry/application must stay silent')
    } finally {
      h.dispose()
    }
  })

  it('saves shortcut display-area edits while preserving immutable defaults', async () => {
    const h = await harness()
    try {
      assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), true)
      const builtin = clonePreset(h.manager.entries.value.find(entry => entry.builtin)!)
      h.emitEdit({ showDisplayArea: true })
      assert.equal(h.store.activePet3dPreset.showDisplayArea, true)
      assert.notEqual(h.manager.activeId.value, BUILTIN_PRESET_ID)
      assert.deepEqual(h.manager.entries.value.find(entry => entry.builtin), builtin)
      assert.equal(await h.manager.retry(), true)
      const saved = h.saves.at(-1) as ReturnType<typeof useCatStore>['$state']
      assert.ok(saved.presetCollection)
      const active = saved.presetCollection.entries.find(entry => entry.id === h.manager.activeId.value)
      assert.equal(active?.snapshot.preset.showDisplayArea, true)
      h.emitEdit({ showDisplayArea: false })
      assert.equal(h.store.activePet3dPreset.showDisplayArea, false)
    } finally {
      h.dispose()
    }
  })

  it('keeps hide/show outside saved presets and reveals a hidden active preset when selected again', async () => {
    const h = await harness()
    try {
      await h.manager.activate(BUILTIN_PRESET_ID)
      const before = clonePreset(h.store.presetCollection)
      h.emitEdit({ visible: false })
      assert.equal(h.store.window.visible, false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.store.window.visible, false, 'saving common visibility must not apply a preset')
      assert.equal(h.manager.activeId.value, BUILTIN_PRESET_ID)
      assert.deepEqual(h.store.presetCollection, before)
      assert.ok(h.manager.entries.value.every(entry => !('visible' in entry.snapshot)))
      const applies = h.applies()
      assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), true)
      assert.equal(h.applies(), applies + 1)
      assert.equal(h.store.window.visible, true)
      h.emitEdit({ visible: false })
      assert.equal(await h.manager.create('Visible new preset'), true)
      assert.equal(h.store.window.visible, true)
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
      assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), false)
      assert.equal(h.manager.activeId.value, 'initial')
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

  it('does not delete the active entry if applying its successor fails', async () => {
    const h = await harness()
    try {
      h.failApply(true)
      assert.equal(await h.manager.remove('initial'), false)
      assert.equal(h.manager.activeId.value, 'initial')
      assert.equal(h.manager.entries.value.length, 2)
    } finally {
      h.dispose()
    }
  })

  it('creates only one factory copy and ignores automatic normalization', async () => {
    const h = await harness()
    try {
      await h.manager.activate(BUILTIN_PRESET_ID)
      h.store.activePet3dPreset.viewportModeRevision++
      h.store.activePet3dPreset.dmeloperEyebrows.color = '#AAAAAA'
      assert.equal(h.manager.activeId.value, BUILTIN_PRESET_ID)
      markPresetUserEdit()
      h.store.activePet3dPreset.cameraZoomPercent = 150
      const copiedId = h.manager.activeId.value
      assert.notEqual(copiedId, BUILTIN_PRESET_ID)
      h.store.activePet3dPreset.cameraZoomPercent = 170
      assert.equal(h.manager.activeId.value, copiedId)
      assert.equal(h.manager.entries.value.length, 3)
    } finally {
      h.dispose()
    }
  })

  it('restores the selected catalog snapshot on restart, including interrupted live state', async () => {
    const h = await harness()
    await h.manager.create('Saved')
    h.store.activePet3dPreset.cameraZoomPercent = 154
    await h.manager.retry()
    const persisted = clonePreset(h.store.$state)
    h.dispose()
    persisted.customization3d.preset.cameraZoomPercent = 27
    const restarted = await harness(persisted)
    try {
      assert.equal(restarted.store.activePet3dPreset.cameraZoomPercent, 154)
      assert.equal(restarted.manager.entries.value.find(entry => entry.id === restarted.manager.activeId.value)?.name, 'Saved')
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
      assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), false)
      assert.equal(h.manager.ready.value, false)
      const requests = h.applies()
      assert.equal(await h.manager.create('blocked'), false)
      assert.equal(h.applies(), requests)
      h.failApply(false)
      h.failRestore(false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.manager.activeId.value, 'initial')
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
      assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), false)
      assert.equal(h.manager.ready.value, false)
      const before = clonePreset(h.store.$state)
      const requests = h.applies()
      h.failApply(false)
      h.failRestore(false)
      const unexpectedStep = () => {
        throw new Error('reset crossed failed library gate')
      }
      await assert.rejects(withPresetReset(() => runProgramSettingsReset({
        clearSkinLibrary: async () => {
          throw new Error('storage unavailable')
        },
        resetAutostart: async () => unexpectedStep(),
        stopPerformance: async () => unexpectedStep(),
        resetPerformanceMetrics: async () => unexpectedStep(),
        resetCat: unexpectedStep,
        resetGeneral: unexpectedStep,
        initializeGeneral: async () => unexpectedStep(),
        resetShortcut: unexpectedStep,
        resetWindowState: unexpectedStep,
        resetWindowGeometry: async () => unexpectedStep(),
      })), /storage unavailable/)
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
      const switching = h.manager.activate(BUILTIN_PRESET_ID)
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
      const saved = h.saves.at(-1) as ReturnType<typeof useCatStore>['$state']
      assert.equal(saved.presetCollection!.entries.find(entry => entry.id === 'initial')!.snapshot.preset.cameraZoomPercent, 162)
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
      h.store.model.mirror = true
      h.store.window.opacity = 25
      const expected = presetModel.capturePresetSnapshot(h.store)
      h.failSave(true)
      assert.equal(await h.manager.duplicate('initial'), false)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), expected)
      assert.equal(h.manager.entries.value.length, 2)
      h.failSave(false)
      assert.equal(await h.manager.retry(), true)
      assert.equal(await h.manager.duplicate('initial'), true)
      const duplicate = h.manager.entries.value.find(entry => entry.id !== 'initial' && !entry.builtin)!
      assert.deepEqual(duplicate.snapshot, expected)
      assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), true)
      h.store.window.visible = false
      assert.equal(await h.manager.activate(duplicate.id), true)
      assert.equal(h.store.window.visible, true)
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), expected)
      const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useCatStore>['$state']
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
      await withPresetReset(async () => h.store.resetAllSettings())
      await waitFor(() => h.manager.ready.value && h.manager.status.value === 'saved')
      assert.equal(h.manager.entries.value.length, 1)
      assert.equal(h.manager.activeId.value, BUILTIN_PRESET_ID)
    } finally {
      h.dispose()
    }
  })

  it('captures an acknowledged user change after an earlier native sync and gates menu edits during apply', async () => {
    const h = await harness()
    try {
      await h.manager.activate(BUILTIN_PRESET_ID)
      await vue.nextTick()
      h.store.activePet3dPreset.mouseEnabled = false
      assert.equal(h.manager.activeId.value, BUILTIN_PRESET_ID)
      editIntent.confirmPresetUserEdit()
      assert.notEqual(h.manager.activeId.value, BUILTIN_PRESET_ID)
      h.emitEdit({ opacity: 75 })
      assert.equal(h.store.window.opacity, 75)
      const release = h.holdApply()
      const switching = h.manager.create('B')
      h.emitEdit({ opacity: 25 })
      assert.equal(h.store.window.opacity, 75)
      release()
      await switching
    } finally {
      h.dispose()
    }
  })

  it('invalidates a delayed skin selection before a new preset applies its new owner', async () => {
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
      assert.equal(h.rendered(), 2)
      await h.manager.rename('initial', 'Renamed')
      await h.manager.toggleFavorite('initial')
      await new Promise(resolve => setTimeout(resolve, 650))
      assert.equal(h.rendered(), 2)
      h.failThumbnail(true)
      h.store.activePet3dPreset.cameraZoomPercent = 162
      await new Promise(resolve => setTimeout(resolve, 650))
      assert.equal(h.manager.thumbnailErrors.value.initial, true)
      assert.deepEqual(h.diagnostics.at(-1), { level: 'warn', operation: 'presets.thumbnail' })
      assert.equal(h.manager.status.value, 'saved')
      assert.equal(h.manager.cardPending.value.initial, undefined)
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

  it('covers only the changed card until both its disk save and current thumbnail finish, in either order', async () => {
    const h = await harness()
    let releaseSave = () => {}
    let releaseThumbnail = () => {}
    try {
      h.manager.setListVisible(true)
      await waitFor(() => Object.keys(h.manager.cardPending.value).length === 0)
      h.store.model.maxFPS = 31
      assert.equal(Object.keys(h.manager.cardPending.value).length, 0)
      await h.manager.retry()
      releaseSave = h.holdSave()
      releaseThumbnail = h.holdThumbnail()
      h.store.activePet3dPreset.cameraZoomPercent = 162
      assert.equal(h.manager.cardPending.value.initial, 'saving')
      assert.equal(h.manager.cardPending.value[BUILTIN_PRESET_ID], undefined)
      await waitFor(() => h.rendered() === 3)
      assert.equal(h.manager.cardPending.value.initial, 'saving')
      releaseSave()
      await waitFor(() => h.manager.status.value === 'saved')
      assert.equal(h.manager.cardPending.value.initial, 'thumbnail')
      releaseThumbnail()
      await waitFor(() => !h.manager.cardPending.value.initial)
      assert.equal(h.manager.thumbnails.value.initial, 'data:image/png;base64,preview-162')

      releaseSave = h.holdSave()
      h.store.activePet3dPreset.cameraZoomPercent = 177
      await waitFor(() => h.manager.thumbnails.value.initial === 'data:image/png;base64,preview-177')
      assert.equal(h.manager.cardPending.value.initial, 'saving')
      releaseSave()
      await waitFor(() => !h.manager.cardPending.value.initial)
    } finally {
      releaseSave()
      releaseThumbnail()
      h.dispose()
    }
  })

  it('keeps a newer edit covered when an older disk write and stale preview failure finish', async () => {
    const h = await harness()
    let releaseSave = () => {}
    let releaseThumbnail = () => {}
    try {
      h.manager.setListVisible(true)
      await waitFor(() => Object.keys(h.manager.cardPending.value).length === 0)
      const previousThumbnail = h.manager.thumbnails.value.initial
      releaseSave = h.holdSave()
      releaseThumbnail = h.holdThumbnail()
      h.store.activePet3dPreset.cameraZoomPercent = 162
      await waitFor(() => h.rendered() === 3)
      h.store.activePet3dPreset.cameraZoomPercent = 185
      const saves = h.saves.length
      releaseSave()
      await waitFor(() => h.saves.length > saves)
      assert.equal(h.manager.cardPending.value.initial, 'saving')
      h.failThumbnail(true)
      releaseThumbnail()
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(h.manager.thumbnailErrors.value.initial, undefined)
      assert.equal(h.manager.thumbnails.value.initial, previousThumbnail)
      assert.ok(h.manager.cardPending.value.initial)
      h.failThumbnail(false)
      await waitFor(() => !h.manager.cardPending.value.initial)
      assert.equal(h.manager.thumbnails.value.initial, 'data:image/png;base64,preview-185')
    } finally {
      releaseSave()
      releaseThumbnail()
      h.dispose()
    }
  })

  it('waits for a pending switch before whole-program reset and never resurrects its deleted catalog', async () => {
    const h = await harness()
    try {
      const release = h.holdApply()
      const switching = h.manager.create('B')
      for (let count = 0; h.applies() === 0 && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 1))
      assert.equal(h.applies(), 1)
      let reset = false
      const resetting = withPresetReset(async () => {
        h.store.resetAllSettings()
        reset = true
      })
      assert.equal(reset, false)
      assert.equal(await h.manager.create('blocked'), false)
      release()
      await switching
      await resetting
      await vue.nextTick()
      assert.equal(reset, true)
      assert.equal(h.manager.entries.value.length, 1)
      assert.equal(h.manager.activeId.value, BUILTIN_PRESET_ID)
    } finally {
      h.dispose()
    }
  })
})

it('preserves hidden live state during asynchronous PNG materialization and shows it on restart load', async () => {
  const browser = installPresetSkinBrowser()
  let h: Awaited<ReturnType<typeof harness>> | undefined
  try {
    h = await harness(undefined, preparePresetSkin)
    h.store.updateDmeloperEyebrows({ color: '#123456' })
    h.store.updateDmeloperPalmColor('#abcdef')
    h.store.resetDmeloperSkinToDefault()
    h.store.window.visible = false
    assert.equal(await h.manager.retry(), true)
    assert.equal(h.store.window.visible, false, 'autosave materialization must retain hidden state')
    assert.equal(h.store.customization3d.dmeloperSkinDataUrl, browser.dataUrl)
    assert.equal(h.store.activePet3dPreset.dmeloperEyebrows.color, '#123456')
    assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#abcdef')
    const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useCatStore>['$state']
    assert.equal(saved.window.visible, false)
    assert.ok(saved.presetCollection!.entries.every(entry => !('visible' in entry.snapshot)))
    h.dispose()
    h = await harness(saved, preparePresetSkin)
    assert.equal(h.manager.ready.value, true)
    assert.equal(h.store.window.visible, true)
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
    const mainStore = useCatStore(createPinia())
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
    assert.equal(h.store.customization3d.dmeloperSkinDataUrl, browser.dataUrl)
    assert.equal(h.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    const savedDefault = renderState()
    assert.equal(getRequiredPetAssetMutation(selectedDefault.asset, savedDefault.asset), 'none', 'autosave must not reload the identical bundled PNG and hide the pet again')
    assert.equal(visibleBoundsSelectionChanged(selectedDefault.bounds, savedDefault.bounds), false, 'materializing the same skin must not trigger a second viewport measurement')
    h.store.resetDmeloperSkinToDefault()
    const repeatedDefault = renderState()
    assert.equal(getRequiredPetAssetMutation(savedDefault.asset, repeatedDefault.asset), 'none')
    assert.equal(visibleBoundsSelectionChanged(savedDefault.bounds, repeatedDefault.bounds), false)
    await h.manager.retry()
    const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useCatStore>['$state']
    const active = saved.presetCollection!.entries.find(entry => entry.id === saved.presetCollection!.activeId)!
    assert.equal(active.snapshot.appearance.activeSkinLibraryEntryId, 'builtin:dmeloper')
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
  state.presetCollection!.entries.find(entry => entry.id === state.presetCollection!.activeId)!.snapshot.opacity = 0
  editorsLocked.value = true
  try {
    const restored = await harness(state)
    try {
      assert.equal(restored.store.window.visible, false)
      assert.equal(restored.store.window.opacity, 0)
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
      const switching = h.manager.activate(BUILTIN_PRESET_ID)
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
  it('exports the selected card’s saved snapshot after flushing pending edits and preserves the active selection', async () => {
    const h = await harness()
    try {
      assert.equal(await h.manager.create('Inactive'), true)
      const inactiveId = h.manager.activeId.value
      h.store.activePet3dPreset.cameraZoomPercent = 111
      h.store.customization3d.minecraftSkinUsername = 'Saved_Name'
      assert.equal(await h.manager.retry(), true)
      assert.equal(await h.manager.activate('initial'), true)
      h.store.activePet3dPreset.cameraZoomPercent = 166
      const applies = h.applies()
      assert.equal(await h.manager.exportPreset(inactiveId, 'nickname'), 'saved')
      assert.equal(h.manager.activeId.value, 'initial')
      assert.equal(h.store.activePet3dPreset.cameraZoomPercent, 166)
      assert.equal(h.applies(), applies)
      assert.equal(h.transfer.exports[0].name, 'Inactive')
      assert.equal(h.transfer.exports[0].snapshot.preset.cameraZoomPercent, 111)
      assert.equal(h.transfer.written[0].skin.mode, 'nickname')
      assert.equal(h.transfer.written[0].skin.nickname, 'Saved_Name')
      assert.equal(h.manager.entries.value.find(entry => entry.id === 'initial')?.snapshot.preset.cameraZoomPercent, 166)
      const builtinBefore = clonePreset(h.manager.entries.value.find(entry => entry.builtin))
      assert.equal(await h.manager.exportPreset(BUILTIN_PRESET_ID, 'image'), 'saved')
      assert.deepEqual(h.transfer.exports[1].snapshot, presetModel.createDefaultPresetSnapshot())
      assert.deepEqual(h.manager.entries.value.find(entry => entry.builtin), builtinBefore)
      assert.equal(h.manager.activeId.value, 'initial')
      assert.equal(h.applies(), applies)
    } finally {
      h.dispose()
    }
  })

  it('reports save-dialog cancellation and export errors without applying a card or retaining an import retry', async () => {
    const h = await harness()
    try {
      h.transfer.failure = 'read'
      assert.equal(await h.manager.importPreset('C:\\bad.petpreset'), false)
      assert.equal(h.manager.canRetryImport.value, true)
      h.transfer.writeResult = false
      const snapshot = presetModel.capturePresetSnapshot(h.store)
      const applies = h.applies()
      assert.equal(await h.manager.exportPreset(BUILTIN_PRESET_ID, 'image'), 'cancelled')
      assert.equal(h.manager.transferError.value, undefined)
      assert.equal(h.manager.canRetryImport.value, false)
      assert.equal(h.manager.transferPhase.value, undefined)
      h.transfer.writeError = new Error('destination unavailable')
      assert.equal(await h.manager.exportPreset(BUILTIN_PRESET_ID, 'image'), 'error')
      assert.equal(h.manager.transferError.value, 'export')
      assert.equal(h.manager.canRetryImport.value, false)
      assert.equal(h.manager.activeId.value, 'initial')
      assert.deepEqual(presetModel.capturePresetSnapshot(h.store), snapshot)
      assert.equal(h.applies(), applies)
    } finally {
      h.dispose()
    }
  })

  for (const mode of ['image', 'nickname'] as const) {
    it(`imports ${mode} settings through saved preparation, native apply, and durable commit`, async () => {
      const transfer = transferBoundary(mode)
      const h = await harness(undefined, undefined, undefined, transfer)
      const phases: Array<string | undefined> = []
      const stop = vue.watch(h.manager.transferPhase, value => phases.push(value), { flush: 'sync' })
      try {
        h.store.window.visible = false
        const before = clonePreset(h.manager.entries.value)
        const pickedFile = { name: '공유 安★.petpreset' } as File
        assert.equal(await h.manager.importPreset(pickedFile), true)
        assert.deepEqual(phases, ['reading', 'skin', 'applying', 'saving', undefined])
        assert.equal(h.manager.busy.value, false)
        assert.equal(h.manager.ready.value, true)
        assert.equal(h.manager.transferError.value, undefined)
        assert.equal(h.manager.canRetryImport.value, false)
        assert.equal(h.store.window.visible, true)
        assert.equal(h.manager.entries.value.length, before.length + 1)
        assert.deepEqual(h.manager.entries.value.slice(0, before.length), before)
        const added = h.manager.entries.value.at(-1)!
        assert.match(added.id, /^[\da-f-]{36}$/i)
        assert.equal(added.id, h.manager.activeId.value)
        assert.equal(added.name, 'Shared')
        assert.equal(added.favorite, false)
        assert.equal(added.builtin, false)
        assert.equal(added.snapshot.preset.cameraZoomPercent, 145)
        assert.equal(added.snapshot.preset.dmeloperEyebrows.color, '#123456')
        assert.equal(added.snapshot.preset.dmeloperPalmColor, '#abcdef')
        assert.equal(added.snapshot.appearance.minecraftSkinUsername, 'Linked_Name')
        assert.equal(added.snapshot.appearance.dmeloperSkinModel, mode === 'nickname' ? 'slim' : 'wide')
        assert.equal(added.snapshot.appearance.activeSkinLibraryEntryId, transfer.entryId)
        assert.equal(h.store.window.opacity, 73)
        assert.equal(h.store.model.mirror, true)
        assert.equal(h.store.model.eyebrowAnimationEnabled, false)
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
      assert.equal(await h.manager.activate(BUILTIN_PRESET_ID), false)
      assert.equal(await h.manager.create('overlap'), false)
      assert.equal(await h.manager.exportPreset(BUILTIN_PRESET_ID, 'image'), 'error')
      assert.equal(await h.manager.importPreset('C:\\second.petpreset'), false)
      assert.equal(h.transfer.prepared.length, 1)
      release()
      assert.equal(await importing, true)
      assert.equal(h.manager.busy.value, false)
      assert.equal(stateOwners.presetsReady?.(), true)
    } finally {
      release()
      h.dispose()
    }
  })

  it('uses numeric suffixes for duplicate names and repeated App Defaults imports', async () => {
    const h = await harness()
    try {
      for (const name of ['Shared', 'Shared 2', 'Shared 3']) {
        assert.equal(await h.manager.importPreset('C:\\same.petpreset'), true)
        assert.equal(h.manager.entries.value.at(-1)?.name, name)
      }
      h.transfer.document.name = 'builtinName'
      for (const name of ['builtinName 2', 'builtinName 3']) {
        assert.equal(await h.manager.importPreset('C:\\defaults.petpreset'), true)
        assert.equal(h.manager.entries.value.at(-1)?.name, name)
      }
      assert.equal(new Set(h.manager.entries.value.map(entry => entry.id)).size, h.manager.entries.value.length)
      assert.equal(h.manager.entries.value.filter(entry => entry.builtin).length, 1)
    } finally {
      h.dispose()
    }
  })

  it('fetches the nickname only during import and retains its downloaded PNG after reselect and restart', async () => {
    const transfer = transferBoundary()
    let h = await harness(undefined, undefined, undefined, transfer)
    try {
      assert.equal(await h.manager.importPreset('C:\\nickname.petpreset'), true)
      const importedId = h.manager.activeId.value
      const skin = h.store.customization3d.dmeloperSkinDataUrl
      h.store.window.visible = false
      assert.equal(await h.manager.activate(importedId), true)
      assert.equal(transfer.resolved.length, 1)
      const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useCatStore>['$state']
      transfer.nicknamePng = 'different-network-skin'
      h.dispose()
      h = await harness(saved, undefined, undefined, transfer)
      assert.equal(h.manager.activeId.value, importedId)
      assert.equal(h.store.customization3d.dmeloperSkinDataUrl, skin)
      assert.equal(h.store.customization3d.minecraftSkinUsername, 'Linked_Name')
      assert.equal(h.store.customization3d.dmeloperSkinModel, 'slim')
      assert.equal(transfer.resolved.length, 1)
    } finally {
      h.dispose()
    }
  })

  for (const stage of ['read', 'skin', 'prepare', 'prepareAfterJournal', 'apply', 'save', 'commit'] as const) {
    it(`preserves the previous hidden preset when ${stage} fails`, async () => {
      const h = await harness()
      try {
        h.store.window.visible = false
        h.store.activePet3dPreset.cameraZoomPercent = 171
        assert.equal(await h.manager.retry(), true)
        const previous = clonePreset(h.store.presetCollection)
        const snapshot = presetModel.capturePresetSnapshot(h.store)
        const applies = h.applies()
        if (stage === 'skin') h.transfer.skinError = new MinecraftSkinError({ code: 'NETWORK', retryable: true })
        else if (stage === 'apply') h.failNextApply()
        else if (stage === 'save') h.failSaveOnceAfter(1)
        else h.transfer.failure = stage
        assert.equal(await h.manager.importPreset('C:\\failure.petpreset'), false)
        assert.deepEqual(h.store.presetCollection, previous)
        assert.deepEqual(presetModel.capturePresetSnapshot(h.store), snapshot)
        assert.equal(h.store.window.visible, false)
        assert.equal(h.manager.ready.value, true)
        assert.equal(h.manager.busy.value, false)
        assert.equal(h.manager.canRetryImport.value, true)
        assert.ok(h.manager.transferError.value)
        assert.equal(h.transfer.journal, undefined)
        if (stage === 'read' || stage === 'skin' || stage === 'prepare') {
          assert.equal(h.applies(), applies)
          assert.deepEqual(h.transfer.finished, [])
        } else {
          assert.equal(h.transfer.finished.at(-1)?.commit, false)
        }
        h.transfer.failure = undefined
        h.transfer.skinError = undefined
        assert.equal(await h.manager.retryImport(), true)
        assert.equal(h.manager.entries.value.at(-1)?.name, 'Shared')
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
      assert.equal(await h.manager.importPreset('C:\\reply-lost.petpreset'), true)
      assert.equal(h.transfer.journal?.phase, 'committed')
      assert.deepEqual(h.transfer.finished.map(call => call.commit), [true])
      assert.equal(h.manager.entries.value.at(-1)?.id, h.manager.activeId.value)
      assert.equal(h.manager.transferError.value, undefined)
      assert.equal(h.manager.canRetryImport.value, false)
      assert.equal(h.store.window.visible, true)
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
      assert.equal(await h.manager.importPreset('C:\\recovery.petpreset'), false)
      assert.equal(h.manager.ready.value, false)
      assert.equal(h.manager.transferError.value, 'recovery')
      assert.equal(h.transfer.journal?.phase, 'prepared')
      const prepared = h.transfer.prepared.length
      assert.equal(await h.manager.importPreset('C:\\blocked.petpreset'), false)
      assert.equal(await h.manager.create('blocked'), false)
      assert.equal(await h.manager.retryImport(), false)
      assert.equal(h.transfer.prepared.length, prepared)
      h.transfer.rollbackFails = false
      h.transfer.failure = undefined
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.transfer.journal, undefined)
      assert.deepEqual(h.store.presetCollection, before)
      assert.equal(h.store.window.visible, false)
      assert.equal(await h.manager.importPreset('C:\\recovery.petpreset'), true)
    } finally {
      h.dispose()
    }
  })

  it('restores a prepared journal on restart even when the imported target was already saved', async () => {
    const transfer = transferBoundary()
    let h = await harness(undefined, undefined, undefined, transfer)
    try {
      h.store.window.visible = false
      assert.equal(await h.manager.retry(), true)
      const previous = clonePreset(h.store.presetCollection)
      transfer.failure = 'commit'
      transfer.rollbackFails = true
      assert.equal(await h.manager.importPreset('C:\\interrupted.petpreset'), false)
      const savedImported = transfer.finished.find(call => call.commit)!.saved
      assert.notEqual(savedImported.presetCollection?.activeId, previous?.activeId)
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
      const saved = clonePreset(h.saves.at(-1)) as ReturnType<typeof useCatStore>['$state']
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

  it('materializes the bundled rollback skin after reset without modifying App Defaults', async () => {
    const browser = installPresetSkinBrowser()
    let h: Awaited<ReturnType<typeof harness>> | undefined
    try {
      h = await harness(undefined, preparePresetSkin)
      const current = h
      await withPresetReset(async () => {
        current.store.resetAllSettings()
      })
      assert.equal(await h.manager.retry(), true)
      assert.equal(h.store.customization3d.dmeloperSkinDataUrl, undefined)
      const builtin = clonePreset(h.manager.entries.value[0])
      h.store.window.visible = false
      h.transfer.failure = 'prepareAfterJournal'
      assert.equal(await h.manager.importPreset('C:\\after-reset.petpreset'), false)
      assert.equal(h.manager.ready.value, true)
      assert.equal(h.manager.activeId.value, BUILTIN_PRESET_ID)
      assert.equal(h.manager.entries.value.length, 1)
      assert.deepEqual(h.manager.entries.value[0], builtin)
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
        h.store.resetAllSettings()
        reset = true
      })
      assert.equal(reset, false)
      release()
      assert.equal(await importing, false)
      await resetting
      assert.equal(reset, true)
      assert.equal(h.manager.entries.value.length, 1)
      assert.equal(h.manager.activeId.value, BUILTIN_PRESET_ID)
      assert.equal(h.transfer.journal, undefined)
    } finally {
      release()
      h.dispose()
    }
  })
})

it('captures sampled, manual and automatic palm colors synchronously and restores the saved value', async () => {
  const h = await harness()
  await h.manager.activate(BUILTIN_PRESET_ID)
  let saved: ReturnType<typeof useCatStore>['$state']
  try {
    const active = () => h.manager.entries.value.find(entry => entry.id === h.manager.activeId.value)!
    assert.equal(h.store.applySkinLibraryEntry({ entryId: 'a'.repeat(64), source: 'local', dataUrl: 'data:image/png;base64,YQ==', skinModel: 'wide', palmColor: '#445566' }), true)
    assert.equal(active().snapshot.preset.dmeloperPalmColor, '#445566')
    assert.notEqual(h.manager.activeId.value, BUILTIN_PRESET_ID)
    h.store.updateDmeloperPalmColor('#123456')
    assert.equal(active().snapshot.preset.dmeloperPalmColor, '#123456')
    h.store.resetDmeloperPalmColor('#445566')
    assert.equal(active().snapshot.preset.dmeloperPalmColor, '#445566')
    await h.manager.retry()
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
