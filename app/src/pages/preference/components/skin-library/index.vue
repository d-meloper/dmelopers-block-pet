<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { Button, Flex, message, Modal, Tag } from 'ant-design-vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type {
  LocalSkinFileResponse,
  SkinLibraryEntry,
} from '@/services/skinLibrary'
import type {
  SkinLibraryOverwritePlan,
  SkinLibraryPlannedImport,
  SkinLibraryPreparedImport,
} from '@/utils/skinLibraryImport'
import type { SkinLibrarySelectionState } from '@/utils/skinLibrarySelection'
import type { NormalizedVoxelSkin } from '@/utils/three3d/voxelSkin'

import FileDropSurface from '@/components/file-drop-surface/index.vue'
import { getSkinSelectionId } from '@/config/skinIdentity'
import { onPresetSelectionChange } from '@/features/presets/editIntent'
import { beginPresetNativeEdit } from '@/features/presets/operations'
import { editorsLocked } from '@/features/stateSafety/bridge'
import { reportDiagnostic } from '@/services/diagnostics'
import { BUILTIN_DMELOPER_SKIN, resolveDefaultDmeloperColors, resolveDmeloperSkinThumbnailUrl } from '@/services/dmeloperSkin'
import {
  createMinecraftSkinBlob,
  createMinecraftSkinDataUrl,
  fetchMinecraftSkin,
  LatestRequestGate,
  MinecraftSkinError,
} from '@/services/minecraftSkin'
import { beginPetSkinChange } from '@/services/petSkinChange'
import {
  cleanupSkinLibrary,
  deleteSkinLibraryEntries,
  isValidSkinLibraryDisplayName,
  listSkinLibraryEntries,
  MAX_SKIN_LIBRARY_PNG_BYTES,
  readLocalSkinFile,
  readSkinLibraryEntry,
  renameSkinLibraryEntry,
  SkinLibraryError,
  storeSkinLibraryEntry,
} from '@/services/skinLibrary'
import { useBlockStore } from '@/stores/block'
import {
  importSkinLibraryBatch,
  planSkinLibraryOverwrites,
  resolveSkinLibraryOverwrites,
} from '@/utils/skinLibraryImport'
import {
  createSkinLibrarySelectionState,
  getSkinLibraryAutoApplyEntryId,
  reconcileSkinLibrarySelection,
  selectSkinLibraryCard,
  toggleAllSkinLibraryEntries,
  toggleSkinLibraryCheckbox,
} from '@/utils/skinLibrarySelection'
import {
  createSkinFaceThumbnailPngBase64,
  createSkinThumbnailDataUrl,
} from '@/utils/skinThumbnail'
import { decodeVoxelSkin, suggestVoxelSkinHeadTopColor, VoxelSkinDecodeError } from '@/utils/three3d/voxelSkin'

const emit = defineEmits<{
  back: []
}>()

const blockStore = useBlockStore()
const { t } = useI18n()
const entries = ref<SkinLibraryEntry[]>([])
const selection = ref<SkinLibrarySelectionState>(
  createSkinLibrarySelectionState(getSkinSelectionId(blockStore.customization3d)),
)
const loading = ref(true)
const busy = ref(false)
const importing = ref(false)
type ImportFailureReason = 'pngOnly' | 'invalidPng' | 'dimensions' | 'tooLarge' | 'storage' | 'unknown'
const lastImportFailure = ref<ImportFailureReason>()
const applying = ref(false)
const loadError = ref(false)
const cleanupPending = ref(false)
const cleaningUp = ref(false)
const cleanupRequestGate = new LatestRequestGate()
const applyRequestGate = new LatestRequestGate()
const loadRequestGate = new LatestRequestGate()
const thumbnailRequestGate = new LatestRequestGate()
const defaultThumbnailUrl = ref<string>()
const defaultThumbnailError = ref(false)
const fileInput = ref<HTMLInputElement>()
const dropActive = ref(false)
const editingEntryId = ref<string>()
const editingName = ref('')
const renameInput = ref<HTMLInputElement>()
const renaming = ref(false)
let unlistenDragDrop: (() => void) | undefined
let mounted = true
let importFailureGeneration = 0
let importFailureTimer: ReturnType<typeof setTimeout> | undefined

function setImportFailure(reason?: ImportFailureReason) {
  importFailureGeneration += 1
  if (importFailureTimer !== undefined) clearTimeout(importFailureTimer)
  importFailureTimer = undefined
  lastImportFailure.value = reason
  if (!mounted || !reason) return
  const generation = importFailureGeneration
  importFailureTimer = setTimeout(() => {
    if (!mounted || generation !== importFailureGeneration) return
    importFailureTimer = undefined
    lastImportFailure.value = undefined
  }, 3000)
}

type SkinLibraryImportCandidate
  = | { kind: 'picker', file: File }
    | { kind: 'drop', filePath: string }

interface ImportedLocalSkin {
  entry: SkinLibraryEntry
  pngBase64: string
  decoded: NormalizedVoxelSkin
}

interface IndexedLocalSkinFile extends LocalSkinFileResponse {
  importIndex: number
}

interface ImportFailure {
  index: number
  reason: ImportFailureReason
}

function importFailureReason(error: unknown): ImportFailureReason {
  if (error instanceof VoxelSkinDecodeError || error instanceof SkinLibraryError) {
    switch (error.code) {
      case 'PNG_ONLY': return 'pngOnly'
      case 'INVALID_PNG': return 'invalidPng'
      case 'INVALID_DIMENSIONS': return 'dimensions'
      case 'TOO_LARGE': return 'tooLarge'
      case 'STORAGE_UNAVAILABLE':
      case 'CATALOG_CORRUPT': return 'storage'
    }
  }
  return 'unknown'
}

const selectedIds = computed(() => selection.value.selectedIds)
const selected = computed(() => new Set(selectedIds.value))
const multiMode = computed(() => selection.value.multiSelect)
const activeEntryId = computed(
  () => getSkinSelectionId(blockStore.customization3d),
)
const defaultActive = computed(() => activeEntryId.value === BUILTIN_DMELOPER_SKIN.id)
const defaultSelected = computed(
  () => selected.value.has(BUILTIN_DMELOPER_SKIN.id) && !multiMode.value,
)
const deletableIds = computed(() => selectedIds.value.filter(id => entries.value.some(entry => entry.id === id)))
watch(activeEntryId, (id) => {
  if (!multiMode.value) selection.value = createSkinLibrarySelectionState(id)
})
const allSelected = computed(
  () => entries.value.length > 0 && selected.value.size === entries.value.length,
)

function readSkinFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error(t('pages.preference.block.errors.skinRead')))
    reader.onerror = () => reject(
      reader.error ?? new Error(t('pages.preference.block.errors.skinRead')),
    )
    reader.readAsDataURL(file)
  })
}

function getPngBase64(dataUrl: string): string {
  const base64Marker = ';base64,'
  const markerIndex = dataUrl.indexOf(base64Marker)
  const contentStart = markerIndex + base64Marker.length
  if (
    !dataUrl.startsWith('data:')
    || markerIndex < 'data:'.length
    || dataUrl.length === contentStart
  ) {
    throw new Error(t('pages.preference.block.errors.skinRead'))
  }
  return dataUrl.slice(contentStart)
}

async function readPickedSkinFile(file: File): Promise<LocalSkinFileResponse> {
  if (!file.name.toLowerCase().endsWith('.png')) {
    throw new VoxelSkinDecodeError('PNG_ONLY', 'Voxel skins must be PNG images.')
  }
  if (file.size > MAX_SKIN_LIBRARY_PNG_BYTES) {
    throw new SkinLibraryError('TOO_LARGE')
  }
  const dataUrl = await readSkinFileDataUrl(file)
  return {
    originalFilename: file.name,
    pngBase64: getPngBase64(dataUrl),
  }
}

async function readImportCandidate(
  candidate: SkinLibraryImportCandidate,
): Promise<LocalSkinFileResponse> {
  if (candidate.kind === 'drop' && !candidate.filePath.toLowerCase().endsWith('.png')) {
    throw new VoxelSkinDecodeError('PNG_ONLY', 'Voxel skins must be PNG images.')
  }
  return candidate.kind === 'picker'
    ? readPickedSkinFile(candidate.file)
    : readLocalSkinFile(candidate.filePath)
}

let activeSkinChange: ReturnType<typeof beginPetSkinChange> | undefined
function cancelSkinApplication() {
  const change = activeSkinChange
  activeSkinChange = undefined
  void change?.finish().catch(error => reportDiagnostic('warn', 'skin_library.loading', error))
}

async function runSkinApplication(generation: number, apply: () => Promise<boolean | undefined>) {
  const change = beginPetSkinChange()
  activeSkinChange = change
  let applied = false
  try {
    await change.ready
    if (!applyRequestGate.isCurrent(generation)) return
    applied = Boolean(await apply())
  } finally {
    if (activeSkinChange === change) activeSkinChange = undefined
    const skin = applied && applyRequestGate.isCurrent(generation)
      ? {
          dataUrl: blockStore.customization3d.dmeloperSkinDataUrl,
          model: blockStore.customization3d.dmeloperSkinModel === 'slim' ? 'slim' as const : 'wide' as const,
          palmColor: blockStore.activePet3dPreset.dmeloperPalmColor,
        }
      : undefined
    await change.finish(skin).catch(error => reportDiagnostic('warn', 'skin_library.loading', error))
  }
}

async function selectCard(entryId: string) {
  if (!mounted || busy.value || editorsLocked.value) return
  if (entryId === BUILTIN_DMELOPER_SKIN.id) {
    const release = beginPresetNativeEdit()
    const generation = applyRequestGate.begin()
    applying.value = true
    cancelNameEdit()
    try {
      await runSkinApplication(generation, async () => {
        const colors = await resolveDefaultDmeloperColors()
        if (!applyRequestGate.isCurrent(generation)) return
        blockStore.resetDmeloperSkinToDefault(colors.palmColor, colors.eyebrowColor)
        selection.value = createSkinLibrarySelectionState(BUILTIN_DMELOPER_SKIN.id)
        return true
      })
    } catch (error) {
      if (applyRequestGate.isCurrent(generation)) {
        reportDiagnostic('error', 'skin_library.apply_default', error)
        message.error(t('pages.preference.skinLibrary.errors.apply'))
      }
    } finally {
      release()
      if (applyRequestGate.isCurrent(generation)) applying.value = false
    }
    return
  }
  updateSelection(selectSkinLibraryCard(selection.value, entryId))
}

function toggleCheckbox(entryId: string) {
  if (busy.value) return
  const userSelection = reconcileSkinLibrarySelection(selection.value, entries.value.map(entry => entry.id))
  updateSelection(toggleSkinLibraryCheckbox(userSelection, entryId))
}

function toggleAll() {
  if (busy.value) return
  updateSelection(toggleAllSkinLibraryEntries(
    selection.value,
    entries.value.map(entry => entry.id),
  ))
}

function updateSelection(nextSelection: SkinLibrarySelectionState) {
  const previousSelection = selection.value
  selection.value = nextSelection
  const entryId = getSkinLibraryAutoApplyEntryId(
    previousSelection,
    nextSelection,
  )
  if (entryId) void applyEntry(entryId)
}

function setRenameInput(element: Element | ComponentPublicInstance | null) {
  renameInput.value = element instanceof HTMLInputElement ? element : undefined
}

async function focusRenameInput() {
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

async function beginNameEdit(entry: SkinLibraryEntry) {
  if (busy.value || applying.value) return
  editingEntryId.value = entry.id
  editingName.value = entry.displayName
  await focusRenameInput()
}

function cancelNameEdit() {
  if (renaming.value) return
  editingEntryId.value = undefined
  editingName.value = ''
}

async function saveEditedName(entry: SkinLibraryEntry) {
  if (
    !mounted || editorsLocked.value || editingEntryId.value !== entry.id
    || renaming.value
    || busy.value
    || applying.value
  ) {
    return
  }
  const displayName = editingName.value.trim()
  if (displayName === entry.displayName) {
    cancelNameEdit()
    return
  }
  if (!isValidSkinLibraryDisplayName(displayName)) {
    busy.value = true
    message.error(t('pages.preference.skinLibrary.errors.invalidName'))
    await focusRenameInput()
    busy.value = false
    return
  }

  busy.value = true
  renaming.value = true
  const release = beginPresetNativeEdit()
  let shouldRetry = false
  try {
    const renamed = await renameSkinLibraryEntry(entry.id, displayName)
    entries.value = entries.value.map(candidate => candidate.id === renamed.id
      ? { ...candidate, displayName: renamed.displayName }
      : candidate)
    editingEntryId.value = undefined
    editingName.value = ''
  } catch (error) {
    if (mounted) reportDiagnostic('error', 'skin_library.rename', error)
    message.error(t('pages.preference.skinLibrary.errors.rename'))
    shouldRetry = true
  } finally {
    release()
    renaming.value = false
    if (shouldRetry) await focusRenameInput()
    busy.value = false
  }
}

function onRenameKeydown(event: KeyboardEvent, entry: SkinLibraryEntry) {
  event.stopPropagation()
  if (event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    void saveEditedName(entry)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelNameEdit()
  }
}

function renameHintId(entryId: string) {
  return `skin-library-rename-hint-${entryId}`
}

function goBack() {
  if (busy.value || applying.value) return
  emit('back')
}

async function loadEntries(selectActive = false) {
  const generation = loadRequestGate.begin()
  loadError.value = false
  loading.value = true
  try {
    const loadedEntries = await listSkinLibraryEntries()
    if (!loadRequestGate.isCurrent(generation)) return
    entries.value = loadedEntries
    const availableIds = new Set([BUILTIN_DMELOPER_SKIN.id, ...entries.value.map(entry => entry.id)])
    if ((selectActive || (defaultActive.value && selectedIds.value.length === 0)) && activeEntryId.value && availableIds.has(activeEntryId.value)) {
      selection.value = createSkinLibrarySelectionState(activeEntryId.value)
    } else {
      selection.value = reconcileSkinLibrarySelection(
        selection.value,
        [...availableIds],
      )
    }
  } catch (error) {
    if (!loadRequestGate.isCurrent(generation)) return
    reportDiagnostic('error', 'skin_library.load', error)
    entries.value = []
    selection.value = createSkinLibrarySelectionState(defaultActive.value ? BUILTIN_DMELOPER_SKIN.id : undefined)
    loadError.value = true
  } finally {
    if (loadRequestGate.isCurrent(generation)) loading.value = false
  }
}

async function loadDefaultThumbnail() {
  const generation = thumbnailRequestGate.begin()
  defaultThumbnailError.value = false
  try {
    const url = await resolveDmeloperSkinThumbnailUrl()
    if (thumbnailRequestGate.isCurrent(generation)) defaultThumbnailUrl.value = url
  } catch (error) {
    if (thumbnailRequestGate.isCurrent(generation)) {
      reportDiagnostic('warn', 'skin_library.default_thumbnail', error)
      defaultThumbnailError.value = true
    }
  }
}

async function importCandidate(
  candidate: SkinLibraryPlannedImport<IndexedLocalSkinFile>,
  generation: number,
): Promise<ImportedLocalSkin> {
  if (!applyRequestGate.isCurrent(generation)) throw new Error('Import cancelled.')
  const { originalFilename, pngBase64 } = candidate.value
  const decoded = await decodeVoxelSkin(
    createMinecraftSkinBlob(pngBase64),
    'auto',
  )
  const thumbnailPngBase64 = await createSkinFaceThumbnailPngBase64(decoded)
  if (!applyRequestGate.isCurrent(generation)) throw new Error('Import cancelled.')

  const entry = await storeSkinLibraryEntry({
    source: 'local',
    displayName: originalFilename.trim(),
    originalFilename,
    model: decoded.model,
    pngBase64,
    thumbnailPngBase64,
    overwriteExisting: candidate.overwriteExisting,
  })
  if (!applyRequestGate.isCurrent(generation)) throw new Error('Import cancelled.')
  return { entry, pngBase64, decoded }
}

async function prepareImportCandidates(
  candidates: readonly SkinLibraryImportCandidate[],
  generation: number,
): Promise<{
  candidates: SkinLibraryPreparedImport<IndexedLocalSkinFile>[]
  failureCount: number
  lastFailure?: ImportFailure
}> {
  const prepared: SkinLibraryPreparedImport<IndexedLocalSkinFile>[] = []
  let failureCount = 0
  let lastFailure: ImportFailure | undefined
  for (const [index, candidate] of candidates.entries()) {
    try {
      if (!applyRequestGate.isCurrent(generation)) throw new Error('Import cancelled.')
      const value = await readImportCandidate(candidate)
      prepared.push({ originalFilename: value.originalFilename, value: { ...value, importIndex: index } })
    } catch (error) {
      if (!applyRequestGate.isCurrent(generation)) throw new Error('Import cancelled.')
      reportDiagnostic('warn', 'skin_library.import_read', error)
      failureCount += 1
      lastFailure = { index, reason: importFailureReason(error) }
    }
  }
  return { candidates: prepared, failureCount, lastFailure }
}

function confirmSkinLibraryOverwrites(
  plan: SkinLibraryOverwritePlan<IndexedLocalSkinFile>,
): Promise<boolean> {
  const singleFilename = plan.collisionFilenames[0]
  return new Promise((resolve) => {
    let settled = false
    const settle = (confirmed: boolean) => {
      if (settled) return
      settled = true
      resolve(confirmed)
    }
    Modal.confirm({
      title: plan.collisionCount === 1
        ? t('pages.preference.skinLibrary.confirm.overwriteOne', {
            filename: singleFilename,
          })
        : t('pages.preference.skinLibrary.confirm.overwriteMany', {
            count: plan.collisionCount,
          }),
      content: t('pages.preference.skinLibrary.confirm.overwriteHint'),
      okText: t('pages.preference.skinLibrary.buttons.overwrite'),
      cancelText: t('pages.preference.skinLibrary.buttons.skipOverwrite'),
      onOk: () => settle(true),
      onCancel: () => settle(false),
      afterClose: () => settle(false),
    })
  })
}

function showImportResult(
  successCount: number,
  failureCount: number,
  skippedCount: number,
) {
  if (skippedCount > 0) {
    if (successCount > 0 || failureCount > 0) {
      message.warning(t('pages.preference.skinLibrary.status.importWithSkipped', {
        successCount,
        failureCount,
        skippedCount,
      }))
    }
  } else if (failureCount === 0) {
    message.success(t('pages.preference.skinLibrary.status.importSuccess', {
      count: successCount,
    }))
  } else if (successCount > 0) {
    message.warning(t('pages.preference.skinLibrary.status.importPartial', {
      successCount,
      failureCount,
    }))
  } else {
    message.error(t('pages.preference.skinLibrary.errors.importAll', {
      count: failureCount,
    }))
  }
}

async function importCandidates(candidates: readonly SkinLibraryImportCandidate[]) {
  if (!mounted || editorsLocked.value || candidates.length === 0 || busy.value || applying.value || loading.value) return
  const release = beginPresetNativeEdit()
  const generation = applyRequestGate.begin()
  setImportFailure()
  let lastFailure: ImportFailure | undefined
  busy.value = true
  importing.value = true
  dropActive.value = false
  try {
    const prepared = await prepareImportCandidates(candidates, generation)
    lastFailure = prepared.lastFailure
    const overwritePlan = planSkinLibraryOverwrites(
      prepared.candidates,
      entries.value,
    )
    const overwriteConfirmed = overwritePlan.collisionCount > 0
      ? await confirmSkinLibraryOverwrites(overwritePlan)
      : false
    if (!applyRequestGate.isCurrent(generation)) return
    const resolved = resolveSkinLibraryOverwrites(
      overwritePlan,
      overwriteConfirmed,
    )
    const result = await importSkinLibraryBatch(resolved.candidates, {
      importOne: candidate => importCandidate(candidate, generation).catch((error) => {
        if (applyRequestGate.isCurrent(generation)) {
          reportDiagnostic('warn', 'skin_library.import_store', error)
          if (!lastFailure || candidate.value.importIndex > lastFailure.index) {
            lastFailure = { index: candidate.value.importIndex, reason: importFailureReason(error) }
          }
        }
        throw error
      }),
      refresh: async () => {
        if (!applyRequestGate.isCurrent(generation)) {
          throw new Error('Import cancelled.')
        }
        await loadEntries()
      },
      applyLast: (imported) => {
        if (!applyRequestGate.isCurrent(generation)) return
        applyDecodedEntry(imported.entry, imported.pngBase64, imported.decoded)
        blockStore.completeSkinLibraryMigration(imported.entry.id)
        selection.value = createSkinLibrarySelectionState(imported.entry.id)
      },
    })
    if (applyRequestGate.isCurrent(generation)) {
      const successCount = result.successes.length
      const failureCount = prepared.failureCount + result.failures.length
      setImportFailure(lastFailure?.reason)
      showImportResult(successCount, failureCount, resolved.skippedCount)
    }
  } catch (error) {
    if (applyRequestGate.isCurrent(generation)) {
      reportDiagnostic('error', 'skin_library.import', error)
      setImportFailure(lastFailure?.reason ?? importFailureReason(error))
      message.error(t('pages.preference.skinLibrary.errors.importAll', {
        count: candidates.length,
      }))
    }
  } finally {
    release()
    if (applyRequestGate.isCurrent(generation)) {
      busy.value = false
      importing.value = false
    }
  }
}

function openFilePicker() {
  if (busy.value || applying.value || loading.value) return
  fileInput.value?.click()
}

function onFileInputChange(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const candidates = [...(input.files ?? [])].map(file => ({
    kind: 'picker' as const,
    file,
  }))
  input.value = ''
  void importCandidates(candidates)
}

async function cleanupLibraryFiles() {
  if (!mounted || cleaningUp.value || busy.value || applying.value) return
  const generation = cleanupRequestGate.begin()
  cleaningUp.value = true
  try {
    const response = await cleanupSkinLibrary()
    if (cleanupRequestGate.isCurrent(generation)) cleanupPending.value = response.cleanupPending
  } catch (error) {
    if (cleanupRequestGate.isCurrent(generation)) {
      cleanupPending.value = true
      reportDiagnostic('warn', 'skin_library.cleanup', error)
    }
  } finally {
    if (cleanupRequestGate.isCurrent(generation)) cleaningUp.value = false
  }
}

async function deleteSelected(entryIds: readonly string[], generation: number) {
  if (!mounted || editorsLocked.value || !applyRequestGate.isCurrent(generation) || busy.value || applying.value || cleaningUp.value) return
  const release = beginPresetNativeEdit()
  const originalSkinId = activeEntryId.value
  const isCurrent = () => mounted && applyRequestGate.isCurrent(generation)
  busy.value = true
  try {
    // Prepare the complete fallback before committing the catalog deletion.
    const defaultColors = originalSkinId && entryIds.includes(originalSkinId)
      ? await resolveDefaultDmeloperColors()
      : undefined
    if (!isCurrent()) return
    const response = await deleteSkinLibraryEntries(entryIds)
    if (!mounted) return
    if (!isCurrent()) {
      // Native deletion may have committed while a newer application invalidated this request.
      // Refresh the catalog without resetting the newer current skin.
      await loadEntries()
      await cleanupLibraryFiles()
      return
    }
    cleanupPending.value = response.cleanupPending
    if (activeEntryId.value === originalSkinId) {
      blockStore.handleSkinLibraryEntriesDeleted(response.deletedEntryIds, defaultColors?.palmColor, defaultColors?.eyebrowColor)
    }
    selection.value = createSkinLibrarySelectionState(activeEntryId.value)
    await loadEntries()
  } catch (error) {
    if (isCurrent()) {
      reportDiagnostic('error', 'skin_library.delete', error)
      message.error(t('pages.preference.skinLibrary.errors.delete'))
    }
  } finally {
    release()
    // A stale completion must not unlock a newer import/apply/delete operation.
    if (isCurrent()) busy.value = false
  }
}

function requestDelete() {
  if (busy.value || applying.value || cleaningUp.value) return
  const entryIds = [...deletableIds.value]
  if (entryIds.length === 0) return
  const generation = applyRequestGate.begin()
  Modal.confirm({
    title: entryIds.length === 1
      ? t('pages.preference.skinLibrary.confirm.deleteOne')
      : t('pages.preference.skinLibrary.confirm.deleteMany', { count: entryIds.length }),
    okType: 'danger',
    onOk: () => deleteSelected(entryIds, generation),
  })
}

async function decodeLibrarySkin(pngBase64: string, model: 'wide' | 'slim') {
  return decodeVoxelSkin(createMinecraftSkinBlob(pngBase64), model)
}

function applyDecodedEntry(
  entry: SkinLibraryEntry,
  pngBase64: string,
  decoded: NormalizedVoxelSkin,
) {
  const applied = blockStore.applySkinLibraryEntry({
    entryId: entry.id,
    source: entry.source,
    dataUrl: createMinecraftSkinDataUrl(pngBase64),
    canonicalNickname: entry.canonicalNickname,
    skinModel: decoded.model,
    palmColor: decoded.suggestedPalmColor,
    eyebrowColor: suggestVoxelSkinHeadTopColor(decoded.data),
  })
  if (!applied) throw new Error('The selected library skin could not be applied.')
}

async function applyLocalEntry(entry: SkinLibraryEntry, generation: number) {
  const content = await readSkinLibraryEntry(entry.id)
  if (!applyRequestGate.isCurrent(generation)) return
  const decoded = await decodeLibrarySkin(content.pngBase64, content.model)
  if (!applyRequestGate.isCurrent(generation)) return
  applyDecodedEntry(entry, content.pngBase64, decoded)
  return true
}

async function applyJavaEntry(entry: SkinLibraryEntry, generation: number) {
  if (!entry.canonicalNickname) throw new Error('Missing Java nickname.')
  const response = await fetchMinecraftSkin(entry.canonicalNickname)
  if (!applyRequestGate.isCurrent(generation)) return

  let decoded: NormalizedVoxelSkin
  try {
    decoded = await decodeLibrarySkin(response.pngBase64, response.model)
    if (decoded.convertedFromLegacy !== (response.height === 32)) {
      throw new MinecraftSkinError({ code: 'INVALID_RESPONSE', retryable: false })
    }
  } catch (error) {
    if (error instanceof MinecraftSkinError) throw error
    throw new MinecraftSkinError({ code: 'INVALID_PNG', retryable: false })
  }
  const thumbnailPngBase64 = await createSkinFaceThumbnailPngBase64(decoded)
  if (!applyRequestGate.isCurrent(generation)) return

  const storedEntry = await storeSkinLibraryEntry({
    source: 'java',
    displayName: response.canonicalName,
    canonicalNickname: response.canonicalName,
    model: decoded.model,
    pngBase64: response.pngBase64,
    thumbnailPngBase64,
  })
  if (!applyRequestGate.isCurrent(generation)) return
  applyDecodedEntry(storedEntry, response.pngBase64, decoded)
  await loadEntries()
  return true
}

async function applyEntry(entryId: string) {
  if (!mounted || editorsLocked.value) return
  const entry = entries.value.find(candidate => candidate.id === entryId)
  if (!entry) return
  const generation = applyRequestGate.begin()
  if (activeEntryId.value === entry.id) {
    cancelSkinApplication()
    applying.value = false
    return
  }
  const release = beginPresetNativeEdit()
  applying.value = true
  try {
    await runSkinApplication(generation, () => entry.source === 'java'
      ? applyJavaEntry(entry, generation)
      : applyLocalEntry(entry, generation))
  } catch (error) {
    if (applyRequestGate.isCurrent(generation)) {
      reportDiagnostic('error', 'skin_library.apply', error)
      message.error(t('pages.preference.skinLibrary.errors.apply'))
    }
  } finally {
    release()
    if (applyRequestGate.isCurrent(generation)) applying.value = false
  }
}

function onCardKeydown(event: KeyboardEvent, entryId: string) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  selectCard(entryId)
}

async function listenForSkinFileDrops() {
  try {
    const unlisten = await getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter' || payload.type === 'over') {
        dropActive.value = !busy.value && !applying.value && !loading.value
        return
      }
      dropActive.value = false
      if (
        payload.type === 'drop'
        && payload.paths.length > 0
        && !busy.value
        && !applying.value
        && !loading.value
      ) {
        void importCandidates(payload.paths.map(filePath => ({
          kind: 'drop' as const,
          filePath,
        })))
      }
    })
    if (mounted) unlistenDragDrop = unlisten
    else unlisten()
  } catch (error) {
    if (mounted) reportDiagnostic('warn', 'skin_library.drop_listener', error)
    dropActive.value = false
  }
}

onMounted(() => {
  void loadEntries(true)
  void loadDefaultThumbnail()
  void cleanupLibraryFiles()
  void listenForSkinFileDrops()
})
const stopPresetSelectionListener = onPresetSelectionChange(() => {
  cancelSkinApplication()
  applyRequestGate.invalidate()
  applying.value = false
  busy.value = false
  importing.value = false
})
onBeforeUnmount(stopPresetSelectionListener)
onBeforeUnmount(() => {
  mounted = false
  setImportFailure()
  cancelSkinApplication()
  dropActive.value = false
  unlistenDragDrop?.()
  unlistenDragDrop = undefined
  applyRequestGate.invalidate()
  loadRequestGate.invalidate()
  thumbnailRequestGate.invalidate()
  cleanupRequestGate.invalidate()
})
</script>

<template>
  <div class="relative h-screen min-w-0 flex flex-col bg-color-1">
    <Flex
      align="center"
      class="h-16 flex-shrink-0 b-b b-color-2 b-solid px-5"
      justify="space-between"
    >
      <h1
        class="m-0 text-lg font-semibold"
      >
        {{ $t('pages.preference.skinLibrary.title') }}
      </h1>
      <Flex gap="small">
        <input
          ref="fileInput"
          accept=".png,image/png"
          class="hidden"
          multiple
          type="file"
          @change="onFileInputChange"
        >
        <Button
          class="skin-library-header-button"
          :disabled="busy || applying || loading"
          :loading="importing"
          @click="openFilePicker"
        >
          <template #icon>
            <span
              aria-hidden="true"
              class="skin-library-header-icon i-lucide:file-up size-4"
            />
          </template>
          {{ $t('pages.preference.skinLibrary.buttons.importFile') }}
        </Button>
        <Button
          :aria-label="$t('pages.preference.skinLibrary.buttons.back')"
          class="skin-library-header-button"
          :disabled="busy || applying"
          @click="goBack"
        >
          <template #icon>
            <span
              aria-hidden="true"
              class="skin-library-header-icon i-lucide:arrow-left size-4"
            />
          </template>
          {{ $t('pages.preference.skinLibrary.buttons.back') }}
        </Button>
      </Flex>
    </Flex>

    <div class="skin-library-viewport relative min-h-0 flex-1 overflow-hidden">
      <main class="h-full min-h-0 overflow-auto p-5">
        <p
          v-if="lastImportFailure"
          class="mb-5 mt-0 text-sm text-danger"
          role="alert"
        >
          {{ $t(`pages.preference.skinLibrary.errors.importReasons.${lastImportFailure}`) }}
        </p>
        <Flex
          v-if="loading"
          align="center"
          class="mb-5 text-color-3"
          justify="center"
          role="status"
        >
          {{ $t('pages.preference.skinLibrary.status.loading') }}
        </Flex>
        <Flex
          v-else-if="loadError"
          align="center"
          class="mb-5"
          gap="middle"
          justify="center"
          vertical
        >
          <span role="alert">{{ $t('pages.preference.skinLibrary.errors.load') }}</span>
          <Button @click="loadEntries(true)">
            {{ $t('pages.preference.skinLibrary.buttons.retry') }}
          </Button>
        </Flex>
        <Flex
          v-else-if="entries.length === 0"
          align="center"
          class="mb-5 text-color-3"
          justify="center"
        >
          {{ $t('pages.preference.skinLibrary.status.empty') }}
        </Flex>
        <Flex
          v-if="cleanupPending"
          align="center"
          class="mb-5"
          gap="middle"
          justify="center"
          vertical
        >
          <span role="alert">{{ $t('pages.preference.skinLibrary.status.cleanupPending') }}</span>
          <Button
            :disabled="busy || applying || cleaningUp"
            :loading="cleaningUp"
            @click="cleanupLibraryFiles"
          >
            {{ $t('pages.preference.skinLibrary.buttons.retryCleanup') }}
          </Button>
        </Flex>
        <div
          :aria-multiselectable="multiMode"
          class="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-4"
          role="listbox"
        >
          <div
            :aria-disabled="busy"
            :aria-label="$t('pages.preference.skinLibrary.builtinName')"
            :aria-selected="defaultSelected"
            class="relative min-w-0 cursor-pointer b-2 rounded-xl b-solid bg-color-2 p-3 outline-none transition focus-visible:(ring-2 ring-primary-6)"
            :class="defaultSelected ? 'b-primary-6' : 'b-color-2 hover:b-primary-4'"
            :data-skin-id="BUILTIN_DMELOPER_SKIN.id"
            role="option"
            tabindex="0"
            @click="selectCard(BUILTIN_DMELOPER_SKIN.id)"
            @keydown="onCardKeydown($event, BUILTIN_DMELOPER_SKIN.id)"
          >
            <Tag
              v-if="defaultActive"
              class="absolute right-2 top-2 m-0!"
              color="blue"
            >
              {{ $t('pages.preference.skinLibrary.status.current') }}
            </Tag>
            <img
              v-if="defaultThumbnailUrl"
              :alt="$t('pages.preference.skinLibrary.labels.preview', { name: $t('pages.preference.skinLibrary.builtinName') })"
              class="[image-rendering:pixelated] aspect-square w-full rounded-lg bg-color-3 object-cover"
              draggable="false"
              :src="defaultThumbnailUrl"
            >
            <div
              v-else
              aria-hidden="true"
              class="aspect-square w-full flex items-center justify-center rounded-lg bg-color-3 text-color-3"
            >
              <span class="i-lucide:user-round size-12" />
            </div>
            <div class="mt-3 min-w-0 truncate text-color-1 font-medium">
              {{ $t('pages.preference.skinLibrary.builtinName') }}
            </div>
            <Flex
              class="mt-1 text-xs text-color-3"
              gap="small"
              wrap="wrap"
            >
              <span>{{ $t('pages.preference.skinLibrary.sources.builtin') }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ $t(`pages.preference.block.options.dmeloperSkinModel.${BUILTIN_DMELOPER_SKIN.model}`) }}</span>
            </Flex>
            <div
              v-if="defaultThumbnailError"
              class="mt-2 text-xs text-color-3"
            >
              <span role="alert">{{ $t('pages.preference.skinLibrary.errors.preview') }}</span>
              <Button
                class="mt-2"
                size="small"
                @click.stop="loadDefaultThumbnail"
                @keydown.stop
              >
                {{ $t('pages.preference.skinLibrary.buttons.retry') }}
              </Button>
            </div>
          </div>
          <div
            v-for="entry in entries"
            :key="entry.id"
            :aria-label="entry.displayName"
            :aria-selected="selected.has(entry.id)"
            class="relative min-w-0 cursor-pointer b-2 rounded-xl b-solid bg-color-2 p-3 outline-none transition focus-visible:(ring-2 ring-primary-6)"
            :class="selected.has(entry.id) ? 'b-primary-6' : 'b-color-2 hover:b-primary-4'"
            :data-skin-id="entry.id"
            role="option"
            tabindex="0"
            @click="selectCard(entry.id)"
            @keydown="onCardKeydown($event, entry.id)"
          >
            <button
              :aria-checked="selected.has(entry.id)"
              :aria-label="$t('pages.preference.skinLibrary.buttons.toggleSelection', { name: entry.displayName })"
              class="bg-color-1/90 absolute left-2 top-2 z-1 size-7 flex cursor-pointer items-center justify-center b-0 rounded-md p-0 text-color-3"
              role="checkbox"
              type="button"
              @click.stop="toggleCheckbox(entry.id)"
              @keydown.stop
            >
              <span
                aria-hidden="true"
                class="size-5"
                :class="selected.has(entry.id) ? 'i-lucide:square-check-big text-primary-6' : 'i-lucide:square'"
              />
            </button>
            <Tag
              v-if="activeEntryId === entry.id"
              class="absolute right-2 top-2 m-0!"
              color="blue"
            >
              {{ $t('pages.preference.skinLibrary.status.current') }}
            </Tag>
            <img
              :alt="$t('pages.preference.skinLibrary.labels.preview', { name: entry.displayName })"
              class="[image-rendering:pixelated] aspect-square w-full rounded-lg bg-color-3 object-cover"
              draggable="false"
              :src="createSkinThumbnailDataUrl(entry.thumbnailPngBase64)"
            >
            <div class="mt-3 min-w-0">
              <button
                v-if="editingEntryId !== entry.id"
                :aria-label="$t('pages.preference.skinLibrary.labels.rename', { name: entry.displayName })"
                class="w-full cursor-text truncate b-0 bg-transparent p-0 text-left text-color-1 font-medium"
                :disabled="busy || applying"
                :title="entry.displayName"
                type="button"
                @click.stop="beginNameEdit(entry)"
                @keydown.stop
              >
                {{ entry.displayName }}
              </button>
              <template v-else>
                <input
                  :ref="setRenameInput"
                  v-model="editingName"
                  :aria-busy="renaming"
                  :aria-describedby="renameHintId(entry.id)"
                  :aria-label="$t('pages.preference.skinLibrary.labels.renameInput', { name: entry.displayName })"
                  class="w-full b b-color-2 rounded-md bg-color-1 px-2 py-1 text-color-1 font-medium outline-none focus:b-primary-6"
                  :readonly="busy || renaming"
                  type="text"
                  @blur="saveEditedName(entry)"
                  @click.stop
                  @keydown="onRenameKeydown($event, entry)"
                >
                <span
                  :id="renameHintId(entry.id)"
                  class="sr-only"
                >
                  {{ $t('pages.preference.skinLibrary.hints.rename') }}
                </span>
              </template>
            </div>
            <Flex
              class="mt-1 text-xs text-color-3"
              gap="small"
              wrap="wrap"
            >
              <span>{{ $t(`pages.preference.skinLibrary.sources.${entry.source}`) }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ $t(`pages.preference.block.options.dmeloperSkinModel.${entry.model}`) }}</span>
            </Flex>
          </div>
        </div>
      </main>
      <div
        v-if="dropActive"
        aria-live="polite"
        class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center p-6"
        role="status"
      >
        <FileDropSurface
          :title="$t('pages.preference.skinLibrary.drop.activeTitle')"
        />
      </div>
    </div>

    <Flex
      align="center"
      class="min-h-16 flex-shrink-0 b-t b-color-2 b-solid px-5 py-3"
      justify="space-between"
    >
      <Flex
        v-if="multiMode"
        align="center"
        gap="middle"
      >
        <Button
          :disabled="busy || entries.length === 0"
          @click="toggleAll"
        >
          {{ allSelected
            ? $t('pages.preference.skinLibrary.buttons.clearAll')
            : $t('pages.preference.skinLibrary.buttons.selectAll') }}
        </Button>
        <span
          aria-live="polite"
          class="text-sm text-color-3"
        >
          {{ $t('pages.preference.skinLibrary.status.selected', { count: selected.size }) }}
        </span>
      </Flex>
      <span v-else />
      <Flex gap="small">
        <Button
          danger
          :disabled="deletableIds.length === 0 || busy || applying || cleaningUp"
          :loading="busy"
          @click="requestDelete"
        >
          {{ $t('pages.preference.skinLibrary.buttons.delete') }}
        </Button>
      </Flex>
    </Flex>
  </div>
</template>

<style scoped>
.skin-library-header-button {
  align-items: center;
  display: inline-flex;
  justify-content: center;
}

.skin-library-header-icon {
  display: block;
  flex: none;
  margin-inline-end: 8px;
}
</style>
