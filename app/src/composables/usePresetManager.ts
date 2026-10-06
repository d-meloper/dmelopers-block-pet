import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getStoreState, saveAllNow } from '@tauri-store/pinia'
import { isEqual } from 'es-toolkit'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PresetThumbnailBatch } from '@/features/presets/thumbnail'
import type { PresetExportMode, PresetTransferPhase } from '@/features/presets/transfer'
import type { PresetCollection, PresetEntry, PresetListEntry, PresetSnapshot } from '@/features/presets/types'
import type { PresetImportPrevious } from '@/services/presetTransfer'

import { isCycleViewportSettingRequest, isMenuViewportSettingRequest, nextViewportOption } from '@/composables/menuViewportSetting'
import { WINDOW_LABEL } from '@/constants'
import { builtinPresets } from '@/features/presets/builtin'
import { invalidatePresetSelection, markPresetUserEdit } from '@/features/presets/editIntent'
import { registerPresetEditOwner } from '@/features/presets/editRequests'
import {
  applyPresetSnapshot,
  capturePresetSnapshot,
  clonePreset,
  createPresetCollection,
  migratePresetCollection,
  movePreset,
  orderedPresets,
  uniquePresetName,
  validatePresetCollection,
  validatePresetName,
} from '@/features/presets/model'
import { beginPresetOperation, presetNativeEditPending, presetOperationInProgress, presetResetInProgress } from '@/features/presets/operations'
import { createPresetRequestClient } from '@/features/presets/request'
import { preparePresetSkin, restorePresetSkin } from '@/features/presets/skin'
import { createPresetThumbnailBatch } from '@/features/presets/thumbnail'
import { exportPortablePreset, PresetTransferError, resolvePortablePreset } from '@/features/presets/transfer'
import { isResolvedSkinModelRequest, PRESET_APPLY_RESPONSE } from '@/features/presets/types'
import { editorsLocked, registerPresetFlush } from '@/features/stateSafety/bridge'
import { registerAppProcessOwner } from '@/plugins/process'
import { reportDiagnostic } from '@/services/diagnostics'
import { MinecraftSkinError } from '@/services/minecraftSkin'
import { finishPresetImport, preparePresetImport, readPortablePreset, readPresetImport, writePortablePreset } from '@/services/presetTransfer'
import { useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'
import { saveSynchronizedSettings, SettingsSnapshotSupersededError } from '@/utils/settingsPersistence'

export interface PresetImportResult {
  key: string
  file: string
  status: 'pending' | 'saved' | 'failed'
  presetId?: string
  error?: string
}

interface PresetImportRequest {
  source: File | string
  presetId: string
}

export function usePresetManager(
  emit: (event: string, payload: unknown) => Promise<unknown> = (event, payload) => emitTo(WINDOW_LABEL.MAIN, event, payload),
) {
  const store = useBlockStore()
  const general = useGeneralStore()
  const { t } = useI18n()
  const ready = ref(false)
  const localBusy = ref(true)
  const busy = computed(() => localBusy.value || presetResetInProgress.value || presetNativeEditPending.value > 0)
  const status = ref<'saving' | 'saved' | 'error'>('saving')
  const error = ref<string>()
  const createError = ref<string>()
  const errorRevision = ref(0)
  const createFailureRevision = ref<number>()
  const hasIndependentError = computed(() => status.value === 'error'
    && (!createError.value || createFailureRevision.value !== errorRevision.value))
  const pendingCreate = shallowRef<{ id: string, name: string, snapshot: PresetSnapshot }>()
  const createName = computed(() => pendingCreate.value?.name)
  const createNeedsName = computed(() => createError.value === 'pages.preference.presets.errors.invalidName'
    || createError.value === 'pages.preference.presets.errors.duplicateName')
  const canRetryCreate = computed(() => ready.value && !busy.value && !!createError.value && !!pendingCreate.value)
  const transferError = ref<string>()
  const transferPhase = ref<PresetTransferPhase>()
  let importRequests: PresetImportRequest[] = []
  const importResults = ref<PresetImportResult[]>([])
  const importProgress = ref<{ current: number, total: number, file: string }>()
  const importBatchStopped = ref(false)
  const isBatchImport = computed(() => importResults.value.length > 1)
  const canRetryImport = computed(() => ready.value && !busy.value && importResults.value.some(result => result.status !== 'saved'))
  const thumbnails = ref<Record<string, string>>({})
  const thumbnailErrors = ref<Record<string, boolean>>({})
  const entries = computed<PresetListEntry[]>(() => {
    const catalog = store.presetCollection
    if (!catalog || !Array.isArray(catalog.entries) || catalog.entries.some(entry => !entry || typeof entry.id !== 'string')) return []
    return [
      ...orderedPresets(catalog).map(entry => ({ ...entry, origin: 'user' as const })),
      ...builtinPresets(t),
    ]
  })
  const client = createPresetRequestClient(emit)
  const stops: Array<() => void> = []
  const thumbnailKeys = shallowReactive(new Map<string, string>())
  const thumbnailErrorKeys = shallowReactive(new Map<string, string>())
  const persistedCollection = shallowRef<PresetCollection>()
  const cardPending = computed<Record<string, 'saving' | 'thumbnail'>>(() => {
    const pending: Record<string, 'saving' | 'thumbnail'> = {}
    const savedById = new Map(persistedCollection.value?.entries.map(entry => [entry.id, entry]))
    for (const entry of entries.value) {
      const saved = savedById.get(entry.id)
      if (entry.origin === 'user' && !isEqual({ id: entry.id, name: entry.name, favorite: entry.favorite, snapshot: entry.snapshot }, saved)) {
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
  let activeThumbnailBatch: PresetThumbnailBatch | undefined
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
  const namingCollection = (): PresetCollection => ({ ...collection(), entries: entries.value })
  const isUserEntry = (id: string) => !id.startsWith('builtin:') && collection().entries.some(entry => entry.id === id)
  const fail = (value: unknown, fallback = 'save') => {
    errorRevision.value++
    if (!disposed) reportDiagnostic('error', `presets.${fallback}`, value)
    error.value = value instanceof Error && value.message.startsWith('pages.preference.presets.errors.')
      ? value.message
      : `pages.preference.presets.errors.${fallback}`
    status.value = 'error'
    return false
  }

  function flush(materializeLiveSkin = false, autosave = false): Promise<boolean> {
    clearTimeout(saveTimer)
    status.value = 'saving'
    const operation = saveTail.catch(() => false).then(async () => {
      const version = changeVersion
      try {
        if (materializeLiveSkin) {
          const source = capturePresetSnapshot(store)
          const prepared = await preparePresetSkin(source)
          if (!disposed && isEqual(source, capturePresetSnapshot(store))) {
            internalMutation = true
            try {
              store.$patch(() => applyPresetSnapshot(store, prepared, store.activePet3dPreset.viewportModeRevision, store.window.visible))
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
          ...(autosave ? { isCurrent: () => !disposed && version === changeVersion } : {}),
        })
        // A completed older write must not clear the overlay for a newer edit.
        persistedCollection.value = savedCollection
        if (version === changeVersion) {
          status.value = 'saved'
          error.value = undefined
        }
        return true
      } catch (cause) {
        if (cause instanceof SettingsSnapshotSupersededError) return false
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
      if (!disposed && !busy.value) void flush(false, true)
    }, 300)
    scheduleThumbnails()
  }

  // This owner also persists common Block settings while native autosave is disabled.
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
    const batch = createPresetThumbnailBatch()
    activeThumbnailBatch = batch
    try {
      for (const entry of entries.value) {
        if (disposed || !listVisible || busy.value) break
        const key = JSON.stringify(entry.snapshot)
        if (thumbnailKeys.get(entry.id) === key || thumbnailErrorKeys.get(entry.id) === key) continue
        try {
          const prepared = await preparePresetSkin(clonePreset(entry.snapshot))
          if (disposed || !listVisible || busy.value) break
          const thumbnail = await batch.render(prepared)
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
      batch.dispose()
      activeThumbnailBatch = undefined
      renderingThumbnail = false
      if (!disposed && listVisible && entries.value.some((entry) => {
        const key = JSON.stringify(entry.snapshot)
        return thumbnailKeys.get(entry.id) !== key && thumbnailErrorKeys.get(entry.id) !== key
      })) {
        scheduleThumbnails()
      }
    }
  }

  async function apply(snapshot: PresetSnapshot, restoreVisibility?: boolean, alreadyPrepared = false): Promise<void> {
    invalidatePresetSelection()
    const prepared = alreadyPrepared ? clonePreset(snapshot) : await preparePresetSkin(clonePreset(snapshot))
    if (disposed) throw new Error('pages.preference.presets.errors.apply')
    if (editorsLocked.value && snapshot.appearance.dmeloperSkinDataUrl && snapshot.appearance.activeSkinLibraryEntryId == null) {
      prepared.appearance.activeSkinLibraryEntryId = snapshot.appearance.activeSkinLibraryEntryId
    }
    const response = await client.apply(prepared, restoreVisibility)
    if (disposed) throw new Error('pages.preference.presets.errors.apply')
    const accepted = response.snapshot!
    store.$patch(() => applyPresetSnapshot(store, accepted, response.revision, restoreVisibility ?? true))
    await nextTick()
  }

  async function mutate(operation: () => Promise<void> | void): Promise<boolean> {
    if (!ready.value || busy.value || disposed || editorsLocked.value) return false
    localBusy.value = true
    const finishOperation = beginPresetOperation()
    // Catalog operations save their snapshots without changing the live skin.
    if (!await flush(false)) {
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
      if (!await flush(false)) throw new Error('pages.preference.presets.errors.save')
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

  const activate = (id: string, { applySkin = true }: { applySkin?: boolean } = {}) => mutate(async () => {
    const entry = entries.value.find(entry => entry.id === id)
    if (!entry) throw new Error('pages.preference.presets.errors.apply')
    let snapshot = clonePreset(entry.snapshot)
    if (applySkin) {
      snapshot = await restorePresetSkin(snapshot, entry.name)
    } else {
      // Capture after the transaction's save barrier, never when its dialog opens.
      // Keep the live skin identity without preparing or restoring the target PNG.
      const current = capturePresetSnapshot(store)
      snapshot.appearance = current.appearance
      snapshot.preset.dmeloperEyebrows.color = current.preset.dmeloperEyebrows.color
      snapshot.preset.dmeloperPalmColor = current.preset.dmeloperPalmColor
    }
    await apply(snapshot, undefined, true)
  })

  async function submitCreate(request: NonNullable<typeof pendingCreate.value>): Promise<boolean> {
    if (!ready.value || busy.value || disposed || editorsLocked.value) return false
    pendingCreate.value = request
    createError.value = undefined
    createFailureRevision.value = undefined
    const precedingErrorRevision = errorRevision.value
    try {
      validatePresetName(namingCollection(), request.name, request.id)
    } catch (cause) {
      createError.value = cause instanceof Error ? cause.message : 'pages.preference.presets.errors.create'
      return false
    }
    const accepted = await mutate(async () => {
      const existing = collection().entries.find(entry => entry.id === request.id)
      // Retrying the same accepted request must never add a second card.
      if (existing) return
      const validated = validatePresetName(namingCollection(), request.name)
      invalidatePresetSelection()
      const snapshot = await preparePresetSkin(clonePreset(request.snapshot))
      if (disposed) throw new Error('pages.preference.presets.errors.create')
      const entry: PresetEntry = { id: request.id, name: validated, favorite: false, snapshot }
      collection().entries.push(entry)
    })
    if (pendingCreate.value !== request || disposed) return accepted
    if (accepted) {
      pendingCreate.value = undefined
      createError.value = undefined
    } else {
      createError.value = 'pages.preference.presets.errors.create'
      // Only this request's new transaction failure shares the create retry.
      // Older/later save failures still need their own ordinary save retry.
      if (errorRevision.value > precedingErrorRevision) createFailureRevision.value = errorRevision.value
    }
    return accepted
  }

  function add(name: string): Promise<boolean> {
    if (!ready.value || busy.value || disposed || editorsLocked.value) return Promise.resolve(false)
    // Capture synchronously before the dialog closes or any persistence awaits.
    return submitCreate({ id: crypto.randomUUID(), name: name.trim(), snapshot: capturePresetSnapshot(store) })
  }

  function retryCreate(name = pendingCreate.value?.name): Promise<boolean> {
    const request = pendingCreate.value
    if (!request || name === undefined) return Promise.resolve(false)
    return submitCreate({ ...request, name: name.trim() })
  }

  const importState = (): PresetImportPrevious => clonePreset({ collection: collection(), snapshot: capturePresetSnapshot(store), visible: store.window.visible })

  function transferMessage(cause: unknown, fallback: string): string {
    if (cause instanceof MinecraftSkinError) {
      const base = t(`pages.preference.block.errors.minecraftSkin.${cause.code}`)
      return cause.retryAfterSeconds === undefined ? base : `${base} ${t('pages.preference.block.errors.minecraftSkin.retryAfter', { seconds: cause.retryAfterSeconds })}`
    }
    const code = cause instanceof PresetTransferError ? cause.code : typeof cause === 'string' ? cause : fallback
    const allowed = ['read', 'tooLarge', 'invalidFormat', 'unsupportedVersion', 'invalidSettings', 'invalidSkin', 'invalidNickname', 'lookup', 'library', 'apply', 'save', 'recovery', 'import', 'export']
    return t(`pages.preference.presets.transfer.errors.${allowed.includes(code) ? code : fallback}`)
  }

  async function restoreImport(previous: PresetImportPrevious, operationId: string) {
    store.presetCollection = clonePreset(previous.collection)
    // New imports never apply; old interrupted imports may still need scene rollback.
    if (!isEqual(previous.snapshot, capturePresetSnapshot(store)) || previous.visible !== store.window.visible) {
      await apply(previous.snapshot, previous.visible)
    }
    changeVersion++
    if (!await flush(false)) throw new PresetTransferError('recovery')
    await finishPresetImport(operationId, false, importState())
  }

  async function exportPreset(id: string, mode: PresetExportMode): Promise<'saved' | 'cancelled' | 'error'> {
    if (!ready.value || busy.value || disposed || editorsLocked.value || !isUserEntry(id)) return 'error'
    localBusy.value = true
    const finish = beginPresetOperation()
    transferError.value = undefined
    transferPhase.value = 'exporting'
    try {
      if (!await flush()) throw new PresetTransferError('save')
      const entry = collection().entries.find(entry => entry.id === id)
      if (!entry) throw new PresetTransferError('export')
      const document = await exportPortablePreset(entry.name, clonePreset(entry.snapshot), mode)
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

  async function importOne(request: PresetImportRequest): Promise<{ id?: string, error?: string, fatal?: boolean }> {
    // A commit whose acknowledgement was lost may have been verified by recovery.
    // Retry the same request identity, never append an already committed preset.
    if (collection().entries.some(entry => entry.id === request.presetId)) return { id: request.presetId }
    transferPhase.value = 'reading'
    const operationId = crypto.randomUUID()
    const presetId = request.presetId
    let nativeStarted = false
    let previous: PresetImportPrevious | undefined
    try {
      // Freeze the live rollback image/identity before journaling, including the
      // bundled skin after reset, even with no selected preset.
      if (!await flush(true)) throw new PresetTransferError('save')
      previous = importState()
      const document = await readPortablePreset(request.source)
      transferPhase.value = 'skin'
      let resolved: Awaited<ReturnType<typeof resolvePortablePreset>>
      try {
        resolved = await resolvePortablePreset(document)
      } catch (cause) {
        throw cause instanceof MinecraftSkinError || cause instanceof PresetTransferError ? cause : new PresetTransferError('invalidSkin')
      }
      if (disposed || presetResetInProgress.value || editorsLocked.value) throw new PresetTransferError('import')
      const name = uniquePresetName(namingCollection(), document.name)
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
      collection().entries.push({ id: presetId, name, favorite: false, snapshot: resolved.snapshot })
      changeVersion++
      transferPhase.value = 'saving'
      if (!await flush(false)) throw new PresetTransferError('save')
      await finishPresetImport(operationId, true, importState())
      return { id: presetId }
    } catch (cause) {
      if (nativeStarted && previous) {
        try {
          const journal = await readPresetImport()
          // The disk commit may have succeeded before its IPC response was lost.
          if (journal?.operationId === operationId && journal.phase === 'committed') {
            return { id: presetId }
          }
          if (journal?.operationId === operationId) await restoreImport(journal.previous, operationId)
          else if (journal?.phase === 'prepared') throw new PresetTransferError('recovery')
        } catch (recoveryError) {
          if (!disposed) reportDiagnostic('error', 'presets.import_recovery', recoveryError)
          ready.value = false
          fail(new Error('pages.preference.presets.errors.apply'), 'apply')
          return { error: transferMessage('recovery', 'recovery'), fatal: true }
        }
      }
      if (!disposed && !presetResetInProgress.value && !editorsLocked.value) {
        reportDiagnostic('error', 'presets.import', cause)
      }
      // Malformed files/skin lookups may be skipped; a failed native library or
      // persistence transaction stops the batch even after a successful rollback.
      return { error: transferMessage(cause, 'import'), fatal: nativeStarted || (cause instanceof PresetTransferError && cause.code === 'save') }
    }
  }

  async function runImports(requests: PresetImportRequest[]): Promise<string[]> {
    if (!ready.value || busy.value || disposed || editorsLocked.value || requests.length === 0) return []
    localBusy.value = true
    const finish = beginPresetOperation()
    invalidatePresetSelection()
    transferError.value = undefined
    importBatchStopped.value = false
    const imported: string[] = []
    try {
      for (const [index, request] of requests.entries()) {
        if (disposed || presetResetInProgress.value || editorsLocked.value || !ready.value) {
          importBatchStopped.value = true
          break
        }
        const result = importResults.value.find(result => result.key === request.presetId)!
        result.status = 'pending'
        result.error = undefined
        importProgress.value = { current: index + 1, total: requests.length, file: result.file }
        const outcome = await importOne(request)
        if (outcome.id) {
          result.status = 'saved'
          result.presetId = outcome.id
          imported.push(outcome.id)
        } else {
          result.status = 'failed'
          result.error = outcome.error
          transferError.value = outcome.error
        }
        if (outcome.fatal) {
          importBatchStopped.value = true
          break
        }
      }
      return imported
    } finally {
      transferPhase.value = undefined
      importProgress.value = undefined
      localBusy.value = false
      finish()
      scheduleThumbnails()
    }
  }

  function importPresets(sources: Array<File | string>): Promise<string[]> {
    if (!ready.value || busy.value || disposed || editorsLocked.value || sources.length === 0) return Promise.resolve([])
    importRequests = sources.map(source => ({ source, presetId: crypto.randomUUID() }))
    importResults.value = importRequests.map(request => ({
      key: request.presetId,
      file: typeof request.source === 'string' ? request.source.split(/[\\/]/).at(-1)! : request.source.name,
      status: 'pending',
    }))
    return runImports(importRequests)
  }

  async function importPreset(source: File | string): Promise<string | undefined> {
    return (await importPresets([source]))[0]
  }

  async function retryImport(): Promise<string | undefined> {
    const completed = new Set(importResults.value.filter(result => result.status === 'saved').map(result => result.key))
    const imported = await runImports(importRequests.filter(request => !completed.has(request.presetId)))
    return isBatchImport.value ? undefined : imported[0]
  }

  async function ensureSubscriptions() {
    if (subscriptionsReady) return
    const results = await Promise.allSettled([
      listen<unknown>(PRESET_APPLY_RESPONSE, ({ payload }) => client.accept(payload)),
      getCurrentWebviewWindow().onCloseRequested((event) => {
        // Native close hides this resident owner; the SDK otherwise tries destroy.
        event.preventDefault()
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
      }
      if (!store.presetCollection) {
        store.presetCollection = createPresetCollection()
      } else {
        store.presetCollection = migratePresetCollection(store.presetCollection) as PresetCollection
        validatePresetCollection(store.presetCollection)
      }
      // Recover legacy journals with their original catalog before detaching it.
      collection().activeId = null
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
    if (isResolvedSkinModelRequest(payload)) {
      const selection = store.customization3d
      const correction = payload.resolvedSkinModel
      if (selection.selectedModelId === correction.modelId
        && selection.dmeloperSkinDataUrl === correction.skinDataUrl
        && selection.dmeloperSkinModel === correction.requested) {
        store.setDmeloperSkinModel(correction.resolved)
      }
      return
    }
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
    const request = payload as { desktopVisible?: unknown, visible?: unknown, opacity?: unknown, mirror?: unknown, showDisplayArea?: unknown, keepInScreen?: unknown, alwaysOnTop?: unknown }
    if (typeof request.desktopVisible === 'boolean') {
      if (general.broadcast.enabled) general.broadcast.showOnDesktop = request.desktopVisible
      store.window.visible = request.desktopVisible
    } else if (typeof request.visible === 'boolean') {
      store.window.visible = request.visible
    } else if (typeof request.keepInScreen === 'boolean') {
      store.window.keepInScreen = request.keepInScreen
    } else if (typeof request.alwaysOnTop === 'boolean') {
      store.window.alwaysOnTop = request.alwaysOnTop
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
    // A failed library/storage gate never resets Block. Keep uncertain-apply
    // recovery (including hidden visibility) until the user explicitly retries.
    if (store.presetCollection === collectionBeforeReset) {
      // An edit's debounce may have elapsed while the failed reset was busy.
      if (ready.value) changed()
      return
    }
    recovery = undefined
    pendingCreate.value = undefined
    createError.value = undefined
    importRequests = []
    importResults.value = []
    importBatchStopped.value = false
    transferError.value = undefined
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
    return (await flush()) && dataFlushReady()
  }, dataFlushReady)

  onBeforeUnmount(() => {
    stopQuitOwner()
    stopDataFlush()
    disposed = true
    activeThumbnailBatch?.dispose()
    stopEditOwner?.()
    clearTimeout(saveTimer)
    clearTimeout(thumbnailTimer)
    client.dispose()
    stops.splice(0).forEach(stop => stop())
  })

  return {
    entries,
    status,
    busy,
    ready,
    error,
    hasIndependentError,
    createError,
    createName,
    createNeedsName,
    canRetryCreate,
    transferError,
    transferPhase,
    importResults,
    importProgress,
    importBatchStopped,
    isBatchImport,
    canRetryImport,
    exportPreset,
    importPresets,
    importPreset,
    retryImport,
    thumbnails,
    thumbnailErrors,
    cardPending,
    activate,
    create: add,
    retryCreate,
    duplicate: (id: string) => mutate(async () => {
      const source = entries.value.find(entry => entry.id === id)
      if (!source) throw new Error('pages.preference.presets.errors.manage')
      const snapshot = source.origin === 'builtin' ? await preparePresetSkin(source.snapshot) : clonePreset(source.snapshot)
      const name = uniquePresetName(namingCollection(), source.name, true)
      collection().entries.push({ id: crypto.randomUUID(), name, favorite: false, snapshot })
    }),
    rename: (id: string, name: string) => !ready.value || !isUserEntry(id)
      ? Promise.resolve(false)
      : mutate(() => {
          const entry = collection().entries.find(entry => entry.id === id)
          if (!entry) throw new Error('pages.preference.presets.errors.manage')
          entry.name = validatePresetName(namingCollection(), name, id)
        }),
    remove: (id: string) => !ready.value || !isUserEntry(id)
      ? Promise.resolve(false)
      : mutate(async () => {
          const entry = collection().entries.find(entry => entry.id === id)
          if (!entry) throw new Error('pages.preference.presets.errors.manage')
          collection().entries = collection().entries.filter(entry => entry.id !== id)
          delete thumbnails.value[id]
          delete thumbnailErrors.value[id]
          thumbnailKeys.delete(id)
          thumbnailErrorKeys.delete(id)
        }),
    toggleFavorite: (id: string) => !ready.value || !isUserEntry(id)
      ? Promise.resolve(false)
      : mutate(() => {
          const entry = collection().entries.find(entry => entry.id === id)
          if (!entry) return
          entry.favorite = !entry.favorite
          movePreset(collection(), id)
        }),
    move: (id: string, delta: -1 | 1) => !ready.value || !isUserEntry(id)
      ? Promise.resolve(false)
      : mutate(() => {
          const entry = collection().entries.find(entry => entry.id === id)
          if (!entry) return
          const group = collection().entries.filter(item => item.favorite === entry.favorite)
          const index = group.findIndex(item => item.id === id)
          if (index + delta < 0 || index + delta >= group.length) return
          movePreset(collection(), id, delta < 0 ? group[index - 1].id : group[index + 2]?.id)
        }),
    reorder: (id: string, beforeId?: string) => !ready.value || !isUserEntry(id) || (beforeId !== undefined && !isUserEntry(beforeId))
      ? Promise.resolve(false)
      : mutate(() => movePreset(collection(), id, beforeId)),
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
    getSuggestedName: () => uniquePresetName(namingCollection(), t('pages.preference.presets.newName')),
  }
}

export type PresetManager = ReturnType<typeof usePresetManager>
