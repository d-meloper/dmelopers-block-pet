import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getStoreState, saveAllNow } from '@tauri-store/pinia'
import { isEqual } from 'es-toolkit'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PresetExportMode, PresetTransferPhase } from '@/features/presets/transfer'
import type { PresetCollection, PresetEntry, PresetSnapshot } from '@/features/presets/types'
import type { PresetImportPrevious } from '@/services/presetTransfer'

import { isCycleViewportSettingRequest, isMenuViewportSettingRequest, nextViewportOption } from '@/composables/menuViewportSetting'
import { WINDOW_LABEL } from '@/constants'
import { invalidatePresetSelection, isPresetUserEdit, markPresetUserEdit, onPresetUserEditConfirmed } from '@/features/presets/editIntent'
import { registerPresetEditOwner } from '@/features/presets/editRequests'
import {
  applyPresetSnapshot,
  capturePresetSnapshot,
  clonePreset,
  createDefaultPresetSnapshot,
  createPresetCollection,
  isInitialDefaultSnapshot,
  migratePresetCollection,
  movePreset,
  nextPresetAfterDelete,
  orderedPresets,
  uniquePresetName,
  updateActivePreset,
  validatePresetCollection,
  validatePresetName,
} from '@/features/presets/model'
import { beginPresetOperation, presetNativeEditPending, presetOperationInProgress, presetResetInProgress } from '@/features/presets/operations'
import { createPresetRequestClient } from '@/features/presets/request'
import { preparePresetSkin } from '@/features/presets/skin'
import { renderPresetThumbnail } from '@/features/presets/thumbnail'
import { exportPortablePreset, PresetTransferError, resolvePortablePreset } from '@/features/presets/transfer'
import { BUILTIN_PRESET_ID, PRESET_APPLY_RESPONSE } from '@/features/presets/types'
import { editorsLocked, registerPresetFlush } from '@/features/stateSafety/bridge'
import { registerAppProcessOwner } from '@/plugins/process'
import { reportDiagnostic } from '@/services/diagnostics'
import { MinecraftSkinError } from '@/services/minecraftSkin'
import { finishPresetImport, preparePresetImport, readPortablePreset, readPresetImport, writePortablePreset } from '@/services/presetTransfer'
import { useCatStore } from '@/stores/cat'
import { saveSynchronizedSettings } from '@/utils/settingsPersistence'

export function usePresetManager(
  emit: (event: string, payload: unknown) => Promise<unknown> = (event, payload) => emitTo(WINDOW_LABEL.MAIN, event, payload),
) {
  const store = useCatStore()
  const { t } = useI18n()
  const ready = ref(false)
  const localBusy = ref(true)
  const busy = computed(() => localBusy.value || presetResetInProgress.value || presetNativeEditPending.value > 0)
  const status = ref<'saving' | 'saved' | 'error'>('saving')
  const error = ref<string>()
  const transferError = ref<string>()
  const transferPhase = ref<PresetTransferPhase>()
  let lastImportSource: File | string | undefined
  const canRetryImport = computed(() => ready.value && !busy.value && !!transferError.value && lastImportSource !== undefined)
  const thumbnails = ref<Record<string, string>>({})
  const thumbnailErrors = ref<Record<string, boolean>>({})
  const entries = computed(() => {
    const catalog = store.presetCollection
    if (!catalog || !Array.isArray(catalog.entries) || catalog.entries.some(entry => !entry || typeof entry.id !== 'string')) return []
    return orderedPresets(catalog)
  })
  const activeId = computed(() => store.presetCollection?.activeId ?? BUILTIN_PRESET_ID)
  const client = createPresetRequestClient(emit)
  const stops: Array<() => void> = []
  const thumbnailKeys = shallowReactive(new Map<string, string>())
  const thumbnailErrorKeys = shallowReactive(new Map<string, string>())
  const persistedCollection = shallowRef<PresetCollection>()
  const cardPending = computed<Record<string, 'saving' | 'thumbnail'>>(() => {
    const pending: Record<string, 'saving' | 'thumbnail'> = {}
    const persisted = persistedCollection.value
    for (const entry of entries.value) {
      const saved = persisted?.entries.find(candidate => candidate.id === entry.id)
      if (!isEqual(entry, saved) || (entry.id === activeId.value && persisted?.activeId !== activeId.value)) {
        if (status.value !== 'error') pending[entry.id] = 'saving'
        continue
      }
      const key = JSON.stringify(entry.snapshot)
      if (thumbnailKeys.get(entry.id) !== key && thumbnailErrorKeys.get(entry.id) !== key) pending[entry.id] = 'thumbnail'
    }
    return pending
  })
  let disposed = false
  let subscriptionsReady = false
  let stopEditOwner: (() => void) | undefined
  let listVisible = false
  let renderingThumbnail = false
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let thumbnailTimer: ReturnType<typeof setTimeout> | undefined
  let changeVersion = 0
  let internalMutation = false
  let recovery: { snapshot: PresetSnapshot, visible: boolean } | undefined
  let collectionBeforeReset: PresetCollection | undefined
  let saveTail: Promise<boolean> = Promise.resolve(true)

  const collection = (): PresetCollection => {
    if (!store.presetCollection) throw new Error('pages.preference.presets.errors.load')
    return store.presetCollection
  }
  const fail = (value: unknown, fallback = 'save') => {
    if (!disposed) reportDiagnostic('error', `presets.${fallback}`, value)
    error.value = value instanceof Error && value.message.startsWith('pages.preference.presets.errors.')
      ? value.message
      : `pages.preference.presets.errors.${fallback}`
    status.value = 'error'
    return false
  }

  function flush(materializeLiveSkin = false): Promise<boolean> {
    clearTimeout(saveTimer)
    const version = changeVersion
    status.value = 'saving'
    const operation = saveTail.catch(() => false).then(async () => {
      try {
        const entry = collection().entries.find(item => item.id === activeId.value)
        if (entry && (materializeLiveSkin || (!entry.builtin && !store.customization3d.dmeloperSkinDataUrl))) {
          const source = capturePresetSnapshot(store)
          const prepared = await preparePresetSkin(source)
          if (entry.id === activeId.value && isEqual(source, capturePresetSnapshot(store))) {
            internalMutation = true
            try {
              store.$patch(() => applyPresetSnapshot(store, prepared, store.activePet3dPreset.viewportModeRevision, store.window.visible))
              if (!entry.builtin) entry.snapshot = clonePreset(prepared)
            } finally {
              internalMutation = false
            }
          }
        }
        let savedCollection: PresetCollection | undefined
        await saveSynchronizedSettings({
          flushFrontend: nextTick,
          snapshots: () => {
            const state = clonePreset({ ...store.$state })
            savedCollection = state.presetCollection
            return [{ id: store.$id, state }]
          },
          readBackend: getStoreState,
          saveNow: saveAllNow,
        })
        // A completed older write must not clear the overlay for a newer edit.
        persistedCollection.value = savedCollection
        if (version === changeVersion) {
          status.value = 'saved'
          error.value = undefined
        }
        return true
      } catch (cause) {
        return fail(cause)
      }
    })
    saveTail = operation
    return operation
  }

  function changed() {
    changeVersion++
    status.value = 'saving'
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!disposed && !busy.value) void flush()
    }, 300)
    scheduleThumbnails()
  }

  function capture() {
    if (!ready.value || localBusy.value || presetResetInProgress.value || internalMutation || disposed) return
    if (updateActivePreset(collection(), capturePresetSnapshot(store), isPresetUserEdit(), t('pages.preference.presets.defaultCopyName'))) changed()
  }
  stops.push(watch(() => capturePresetSnapshot(store), capture, { deep: true, flush: 'sync' }))
  stops.push(onPresetUserEditConfirmed(capture))
  // This owner also persists common Cat settings while native autosave is disabled.
  // Keep rollback notifications inside the transaction's busy guard.
  stops.push(watch(store.$state, () => {
    if (ready.value && !localBusy.value && !presetResetInProgress.value && !internalMutation) changed()
  }, { deep: true, flush: 'sync' }))
  stops.push(watch(presetNativeEditPending, (pending) => {
    if (pending === 0 && ready.value && !localBusy.value && !presetResetInProgress.value) changed()
  }))

  function scheduleThumbnails() {
    clearTimeout(thumbnailTimer)
    thumbnailTimer = setTimeout(() => {
      void updateThumbnails()
    }, 500)
  }

  async function updateThumbnails() {
    if (disposed || !ready.value || busy.value || !listVisible || renderingThumbnail) return
    renderingThumbnail = true
    try {
      for (const entry of entries.value) {
        if (disposed || !listVisible || busy.value) break
        const key = JSON.stringify(entry.snapshot)
        if (thumbnailKeys.get(entry.id) === key || thumbnailErrorKeys.get(entry.id) === key) continue
        try {
          const thumbnail = await renderPresetThumbnail(await preparePresetSkin(clonePreset(entry.snapshot)))
          const current = entries.value.find(item => item.id === entry.id)
          if (disposed || !current || JSON.stringify(current.snapshot) !== key) continue
          thumbnails.value = { ...thumbnails.value, [entry.id]: thumbnail }
          thumbnailKeys.set(entry.id, key)
          thumbnailErrorKeys.delete(entry.id)
          delete thumbnailErrors.value[entry.id]
        } catch (cause) {
          const current = entries.value.find(item => item.id === entry.id)
          if (disposed || !current || JSON.stringify(current.snapshot) !== key) continue
          reportDiagnostic('warn', 'presets.thumbnail', cause)
          thumbnailErrorKeys.set(entry.id, key)
          thumbnailErrors.value = { ...thumbnailErrors.value, [entry.id]: true }
        }
      }
    } finally {
      renderingThumbnail = false
      if (!disposed && listVisible && entries.value.some((entry) => {
        const key = JSON.stringify(entry.snapshot)
        return thumbnailKeys.get(entry.id) !== key && thumbnailErrorKeys.get(entry.id) !== key
      })) {
        scheduleThumbnails()
      }
    }
  }

  async function apply(snapshot: PresetSnapshot, restoreVisibility?: boolean): Promise<PresetSnapshot> {
    invalidatePresetSelection()
    const prepared = await preparePresetSkin(snapshot)
    if (disposed) throw new Error('pages.preference.presets.errors.apply')
    if (editorsLocked.value && snapshot.appearance.dmeloperSkinDataUrl && snapshot.appearance.activeSkinLibraryEntryId == null) {
      prepared.appearance.activeSkinLibraryEntryId = snapshot.appearance.activeSkinLibraryEntryId
    }
    const response = await client.apply(prepared, restoreVisibility)
    if (disposed) throw new Error('pages.preference.presets.errors.apply')
    const accepted = response.snapshot!
    store.$patch(() => applyPresetSnapshot(store, accepted, response.revision, restoreVisibility ?? true))
    await nextTick()
    return capturePresetSnapshot(store)
  }

  async function mutate(operation: () => Promise<void> | void): Promise<boolean> {
    if (!ready.value || busy.value || disposed) return false
    capture()
    localBusy.value = true
    const finishOperation = beginPresetOperation()
    if (!await flush()) {
      localBusy.value = false
      finishOperation()
      return false
    }
    const previous = clonePreset(collection())
    const previousSnapshot = capturePresetSnapshot(store)
    const previousVisible = store.window.visible
    try {
      await operation()
      changeVersion++
      if (!await flush()) throw new Error('pages.preference.presets.errors.save')
      return true
    } catch (cause) {
      store.presetCollection = previous
      if (cause instanceof Error && cause.name === 'PresetApplyUncertainError') {
        recovery = { snapshot: previousSnapshot, visible: previousVisible }
        ready.value = false
      }
      if (!isEqual(previousSnapshot, capturePresetSnapshot(store)) || previousVisible !== store.window.visible) {
        try {
          await apply(previousSnapshot, previousVisible)
        } catch (cause) {
          if (!disposed) reportDiagnostic('error', 'presets.rollback', cause)
          recovery = { snapshot: previousSnapshot, visible: previousVisible }
          ready.value = false
        }
      }
      return fail(cause, 'manage')
    } finally {
      localBusy.value = false
      finishOperation()
      scheduleThumbnails()
    }
  }

  const activate = (id: string) => mutate(async () => {
    const entry = collection().entries.find(entry => entry.id === id)
    if (!entry) throw new Error('pages.preference.presets.errors.apply')
    if (id === collection().activeId && store.window.visible) return
    const accepted = await apply(entry.builtin ? createDefaultPresetSnapshot() : entry.snapshot)
    collection().activeId = id
    if (!entry.builtin) entry.snapshot = accepted
  })

  const add = (name: string, snapshot: PresetSnapshot) => mutate(async () => {
    if (name.trim() === t('pages.preference.presets.builtinName')) throw new Error('pages.preference.presets.errors.duplicateName')
    const validated = validatePresetName(collection(), name)
    const accepted = await apply(snapshot)
    const entry: PresetEntry = { id: crypto.randomUUID(), name: validated, builtin: false, favorite: false, snapshot: accepted }
    collection().entries.push(entry)
    collection().activeId = entry.id
  })

  const importState = (): PresetImportPrevious => clonePreset({ collection: collection(), snapshot: capturePresetSnapshot(store), visible: store.window.visible })

  function transferMessage(cause: unknown, fallback: string): string {
    if (cause instanceof MinecraftSkinError) {
      const base = t(`pages.preference.cat.errors.minecraftSkin.${cause.code}`)
      return cause.retryAfterSeconds === undefined ? base : `${base} ${t('pages.preference.cat.errors.minecraftSkin.retryAfter', { seconds: cause.retryAfterSeconds })}`
    }
    const code = cause instanceof PresetTransferError ? cause.code : typeof cause === 'string' ? cause : fallback
    const allowed = ['read', 'tooLarge', 'invalidFormat', 'unsupportedVersion', 'invalidSettings', 'invalidSkin', 'invalidNickname', 'lookup', 'library', 'apply', 'save', 'recovery', 'import', 'export']
    return t(`pages.preference.presets.transfer.errors.${allowed.includes(code) ? code : fallback}`)
  }

  async function restoreImport(previous: PresetImportPrevious, operationId: string) {
    store.presetCollection = clonePreset(previous.collection)
    await apply(previous.snapshot, previous.visible)
    changeVersion++
    if (!await flush()) throw new PresetTransferError('recovery')
    await finishPresetImport(operationId, false, importState())
  }

  async function exportPreset(id: string, mode: PresetExportMode): Promise<'saved' | 'cancelled' | 'error'> {
    if (!ready.value || busy.value || disposed || editorsLocked.value) return 'error'
    capture()
    localBusy.value = true
    const finish = beginPresetOperation()
    lastImportSource = undefined
    transferError.value = undefined
    transferPhase.value = 'exporting'
    try {
      if (!await flush()) throw new PresetTransferError('save')
      const entry = collection().entries.find(entry => entry.id === id)
      if (!entry) throw new PresetTransferError('export')
      const document = await exportPortablePreset(entry.builtin ? t('pages.preference.presets.builtinName') : entry.name, entry.builtin ? createDefaultPresetSnapshot() : clonePreset(entry.snapshot), mode)
      return await writePortablePreset(document) ? 'saved' : 'cancelled'
    } catch (cause) {
      if (!disposed) reportDiagnostic('error', 'presets.export', cause)
      transferError.value = transferMessage(cause, 'export')
      return 'error'
    } finally {
      transferPhase.value = undefined
      localBusy.value = false
      finish()
      scheduleThumbnails()
    }
  }

  async function importPreset(source: File | string): Promise<boolean> {
    if (!ready.value || busy.value || disposed || editorsLocked.value) return false
    capture()
    localBusy.value = true
    const finish = beginPresetOperation()
    invalidatePresetSelection()
    lastImportSource = source
    transferError.value = undefined
    transferPhase.value = 'reading'
    const operationId = crypto.randomUUID()
    let nativeStarted = false
    let previous: PresetImportPrevious | undefined
    try {
      // Freeze the live rollback image/identity before journaling, including the
      // bundled skin after reset. The immutable App Defaults card stays intact.
      if (!await flush(true)) throw new PresetTransferError('save')
      previous = importState()
      const document = await readPortablePreset(source)
      transferPhase.value = 'skin'
      let resolved: Awaited<ReturnType<typeof resolvePortablePreset>>
      try {
        resolved = await resolvePortablePreset(document)
      } catch (cause) {
        throw cause instanceof MinecraftSkinError || cause instanceof PresetTransferError ? cause : new PresetTransferError('invalidSkin')
      }
      if (disposed || presetResetInProgress.value || editorsLocked.value) throw new PresetTransferError('import')
      const presetId = crypto.randomUUID()
      const name = uniquePresetName(collection(), document.name, document.name === t('pages.preference.presets.builtinName'))
      nativeStarted = true
      const entryId = await preparePresetImport(operationId, presetId, previous, {
        source: resolved.source === 'nickname' ? 'java' : 'local',
        displayName: resolved.source === 'nickname' ? resolved.nickname! : document.name,
        ...(resolved.source === 'nickname' ? { canonicalNickname: resolved.nickname } : { originalFilename: `preset-${resolved.pngSha256}.png` }),
        model: resolved.model,
        pngBase64: resolved.pngBase64,
        thumbnailPngBase64: resolved.thumbnailPngBase64,
        overwriteExisting: false,
      })
      resolved.snapshot.appearance.activeSkinLibraryEntryId = entryId
      if (disposed || presetResetInProgress.value || editorsLocked.value) throw new PresetTransferError('import')
      transferPhase.value = 'applying'
      const accepted = await apply(resolved.snapshot)
      collection().entries.push({ id: presetId, name, builtin: false, favorite: false, snapshot: accepted })
      collection().activeId = presetId
      changeVersion++
      transferPhase.value = 'saving'
      if (!await flush()) throw new PresetTransferError('save')
      await finishPresetImport(operationId, true, importState())
      lastImportSource = undefined
      return true
    } catch (cause) {
      if (nativeStarted && previous) {
        try {
          const journal = await readPresetImport()
          // The disk commit may have succeeded before its IPC response was lost.
          if (journal?.operationId === operationId && journal.phase === 'committed') {
            lastImportSource = undefined
            return true
          }
          if (journal?.operationId === operationId) await restoreImport(journal.previous, operationId)
          else if (journal?.phase === 'prepared') throw new PresetTransferError('recovery')
        } catch (recoveryError) {
          if (!disposed) reportDiagnostic('error', 'presets.import_recovery', recoveryError)
          ready.value = false
          fail(new Error('pages.preference.presets.errors.apply'), 'apply')
          transferError.value = transferMessage('recovery', 'recovery')
          return false
        }
      }
      if (!disposed && !presetResetInProgress.value && !editorsLocked.value) {
        reportDiagnostic('error', 'presets.import', cause)
      }
      transferError.value = transferMessage(cause, 'import')
      return false
    } finally {
      transferPhase.value = undefined
      localBusy.value = false
      finish()
      scheduleThumbnails()
    }
  }

  async function ensureSubscriptions() {
    if (subscriptionsReady) return
    const results = await Promise.allSettled([
      listen<unknown>(PRESET_APPLY_RESPONSE, ({ payload }) => client.accept(payload)),
      getCurrentWebviewWindow().onCloseRequested(() => {
        if (ready.value && !busy.value) void flush()
      }),
    ])
    const registered = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const failure = results.find(result => result.status === 'rejected')
    if (disposed || failure) {
      registered.forEach(stop => stop())
      if (failure) throw failure.reason
      return
    }
    stops.push(...registered)
    subscriptionsReady = true
  }

  async function initialize() {
    localBusy.value = true
    const finishOperation = beginPresetOperation()
    try {
      await ensureSubscriptions()
      if (disposed) return
      const pendingImport = await readPresetImport()
      if (disposed) return
      if (pendingImport?.phase === 'prepared') {
        await restoreImport(pendingImport.previous, pendingImport.operationId)
        transferError.value = undefined
      } else if (!store.presetCollection) {
        const initial = capturePresetSnapshot(store)
        const current = await preparePresetSkin(initial)
        if (disposed) return
        store.$patch(() => {
          applyPresetSnapshot(store, current, store.activePet3dPreset.viewportModeRevision)
          store.presetCollection = createPresetCollection(isInitialDefaultSnapshot(initial) ? undefined : current, t('pages.preference.presets.initialName'))
        })
      } else {
        store.presetCollection = migratePresetCollection(store.presetCollection) as PresetCollection
        validatePresetCollection(store.presetCollection)
        const active = collection().entries.find(entry => entry.id === collection().activeId)!
        // The catalog is the restart authority, including an interrupted apply.
        const accepted = await apply(active.builtin ? createDefaultPresetSnapshot() : active.snapshot, editorsLocked.value ? store.window.visible : undefined)
        if (!active.builtin) active.snapshot = accepted
      }
      ready.value = true
      changeVersion++
      await flush()
    } catch (cause) {
      fail(cause, 'load')
    } finally {
      localBusy.value = false
      finishOperation()
      if (!disposed) {
        if (ready.value && !stopEditOwner) stopEditOwner = registerPresetEditOwner(handleExternalEdit)
        scheduleThumbnails()
      }
    }
  }

  function handleExternalEdit(payload: unknown) {
    if (!ready.value || busy.value || !payload || typeof payload !== 'object') return
    if (isCycleViewportSettingRequest(payload)) {
      markPresetUserEdit()
      // Resolve against the owner's latest value, including earlier queued presses.
      store.activePet3dPreset[payload.cycle] = nextViewportOption(payload.cycle, store.activePet3dPreset[payload.cycle])
      return
    }
    if (isMenuViewportSettingRequest(payload)) {
      markPresetUserEdit()
      store.activePet3dPreset[payload.key] = payload.value
      return
    }
    const request = payload as { visible?: unknown, opacity?: unknown, mirror?: unknown, showDisplayArea?: unknown }
    if (typeof request.visible === 'boolean') {
      store.window.visible = request.visible
    } else if (typeof request.showDisplayArea === 'boolean') {
      markPresetUserEdit()
      store.activePet3dPreset.showDisplayArea = request.showDisplayArea
    } else if (typeof request.mirror === 'boolean') {
      markPresetUserEdit()
      store.model.mirror = request.mirror
    } else if (typeof request.opacity === 'number' && [25, 50, 75, 100].includes(request.opacity)) {
      markPresetUserEdit()
      store.window.opacity = request.opacity
    }
  }

  onMounted(initialize)

  stops.push(watch(() => store.presetCollection, (next, previous) => {
    // Reset waits for an active switch. Its rollback can replace the catalog
    // before the reset gate runs and must remain the reset's starting state.
    if (presetResetInProgress.value && presetOperationInProgress.value) collectionBeforeReset = next
    if (!ready.value || busy.value || next === previous || !next) return
    // Whole-program reset replaces the catalog and must not recapture old presets.
    // Observe replacement synchronously so a failed mutation's rollback stays gated.
    thumbnails.value = {}
    thumbnailErrors.value = {}
    thumbnailKeys.clear()
    thumbnailErrorKeys.clear()
    changed()
  }, { flush: 'sync' }))

  stops.push(watch(presetResetInProgress, (resetting) => {
    if (resetting) {
      collectionBeforeReset = store.presetCollection
      return
    }
    // A failed library/storage gate never resets Cat. Keep uncertain-apply
    // recovery (including hidden visibility) until the user explicitly retries.
    if (store.presetCollection === collectionBeforeReset) {
      // An edit's debounce may have elapsed while the failed reset was busy.
      if (ready.value) changed()
      return
    }
    recovery = undefined
    if (!ready.value) {
      void initialize()
      return
    }
    thumbnails.value = {}
    thumbnailErrors.value = {}
    thumbnailKeys.clear()
    thumbnailErrorKeys.clear()
    changed()
  }))

  const dataFlushReady = () => ready.value && !disposed && !busy.value
  const stopQuitOwner = registerAppProcessOwner(dataFlushReady)
  const stopDataFlush = registerPresetFlush(async () => {
    if (!dataFlushReady()) return false
    return flush()
  }, dataFlushReady)

  onBeforeUnmount(() => {
    stopQuitOwner()
    stopDataFlush()
    disposed = true
    stopEditOwner?.()
    clearTimeout(saveTimer)
    clearTimeout(thumbnailTimer)
    client.dispose()
    stops.splice(0).forEach(stop => stop())
  })

  return {
    entries,
    activeId,
    status,
    busy,
    ready,
    error,
    transferError,
    transferPhase,
    canRetryImport,
    exportPreset,
    importPreset,
    retryImport: () => lastImportSource === undefined ? Promise.resolve(false) : importPreset(lastImportSource),
    thumbnails,
    thumbnailErrors,
    cardPending,
    activate,
    create: (name: string) => add(name, createDefaultPresetSnapshot()),
    duplicate: (id: string) => mutate(async () => {
      const source = collection().entries.find(entry => entry.id === id)
      if (!source) throw new Error('pages.preference.presets.errors.manage')
      const snapshot = source.builtin
        ? await preparePresetSkin(createDefaultPresetSnapshot())
        : clonePreset(source.snapshot)
      const name = uniquePresetName(collection(), source.builtin ? t('pages.preference.presets.builtinName') : source.name, true)
      collection().entries.push({ id: crypto.randomUUID(), name, builtin: false, favorite: false, snapshot })
    }),
    rename: (id: string, name: string) => mutate(() => {
      const entry = collection().entries.find(entry => entry.id === id)
      if (!entry || entry.builtin) throw new Error('pages.preference.presets.errors.manage')
      if (name.trim() === t('pages.preference.presets.builtinName')) throw new Error('pages.preference.presets.errors.duplicateName')
      entry.name = validatePresetName(collection(), name, id)
    }),
    remove: (id: string) => mutate(async () => {
      const entry = collection().entries.find(entry => entry.id === id)
      if (!entry || entry.builtin) throw new Error('pages.preference.presets.errors.manage')
      if (collection().activeId === id) {
        const next = nextPresetAfterDelete(collection(), id)!
        const accepted = await apply(next.builtin ? createDefaultPresetSnapshot() : next.snapshot)
        collection().activeId = next.id
        if (!next.builtin) next.snapshot = accepted
      }
      collection().entries = collection().entries.filter(entry => entry.id !== id)
      delete thumbnails.value[id]
      thumbnailKeys.delete(id)
      thumbnailErrorKeys.delete(id)
    }),
    toggleFavorite: (id: string) => mutate(() => {
      const entry = collection().entries.find(entry => entry.id === id)
      if (!entry) return
      entry.favorite = !entry.favorite
      movePreset(collection(), id)
    }),
    move: (id: string, delta: -1 | 1) => mutate(() => {
      const entry = collection().entries.find(entry => entry.id === id)
      if (!entry) return
      const group = collection().entries.filter(item => item.favorite === entry.favorite)
      const index = group.findIndex(item => item.id === id)
      if (index + delta < 0 || index + delta >= group.length) return
      movePreset(collection(), id, delta < 0 ? group[index - 1].id : group[index + 2]?.id)
    }),
    reorder: (id: string, beforeId?: string) => mutate(() => movePreset(collection(), id, beforeId)),
    retry: async () => {
      if (busy.value || disposed) return false
      if (recovery) {
        localBusy.value = true
        const finishOperation = beginPresetOperation()
        try {
          await apply(recovery.snapshot, recovery.visible)
          recovery = undefined
          ready.value = true
          localBusy.value = false
        } catch (cause) {
          localBusy.value = false
          return fail(cause, 'apply')
        } finally {
          finishOperation()
        }
      }
      if (!ready.value) {
        await initialize()
        return ready.value
      }
      return flush()
    },
    retryThumbnail: (id: string) => {
      delete thumbnailErrors.value[id]
      thumbnailKeys.delete(id)
      thumbnailErrorKeys.delete(id)
      scheduleThumbnails()
    },
    setListVisible: (visible: boolean) => {
      listVisible = visible
      if (visible) scheduleThumbnails()
    },
    markUserEdit: markPresetUserEdit,
    getSuggestedName: () => uniquePresetName(collection(), t('pages.preference.presets.newName')),
  }
}

export type PresetManager = ReturnType<typeof usePresetManager>
