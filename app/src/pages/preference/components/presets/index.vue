<script setup lang="ts">
import type { DragDropEvent } from '@tauri-apps/api/window'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { Button, Dropdown, Menu, message, Modal, Tag } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PresetManager } from '@/composables/usePresetManager'
import type { PresetEntry } from '@/features/presets/types'

import PreferenceSections from '@/components/preference-sections/index.vue'
import { reportDiagnostic } from '@/services/diagnostics'

import ExportDialog from './export-dialog.vue'
import NameDialog from './name-dialog.vue'

const props = defineProps<{ manager: PresetManager }>()
const { t, te } = useI18n()
const { entries, activeId, status, busy, ready, error, thumbnails, thumbnailErrors, cardPending } = props.manager
const { transferError, transferPhase, canRetryImport } = props.manager
const nameDialogOpen = ref(false)
const nameDialogMode = ref<'new' | 'rename'>('new')
const editingEntry = ref<PresetEntry>()
const deletingId = ref<string>()
const deleting = ref(false)
const deleteError = ref<string>()
const draggedId = ref<string>()
const dropTarget = ref<{ id: string, after: boolean }>()
const dropAtGroupEnd = ref(false)
const presetList = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>()
const exportingId = ref<string>()
const fileDropActive = ref(false)
const fileInputError = ref<string>()
const showImportError = ref(false)
const announcement = ref('')
let mounted = true
let unlistenFileDrops: (() => void) | undefined
let pointerDrag: {
  pointerId: number
  handle: HTMLElement
  startX: number
  startY: number
  x: number
  y: number
  moved: boolean
  scroller?: HTMLElement
} | undefined
let scrollFrame: number | undefined
const disabled = computed(() => busy.value || !ready.value)
const exportingEntry = computed(() => entries.value.find(entry => entry.id === exportingId.value))
const importDisabled = computed(() => disabled.value || nameDialogOpen.value || Boolean(deletingId.value) || Boolean(exportingEntry.value))
const importErrorText = computed(() => fileInputError.value
  ?? ((showImportError.value || canRetryImport.value) && !exportingEntry.value ? transferError.value : undefined))
const errorText = computed(() => status.value === 'error'
  ? error.value && te(error.value) ? t(error.value) : error.value ?? t('pages.preference.presets.errors.save')
  : undefined)
const groups = computed(() => [
  { favorite: true, label: t('pages.preference.presets.labels.favorites'), entries: entries.value.filter(entry => entry.favorite) },
  { favorite: false, label: t('pages.preference.presets.title'), entries: entries.value.filter(entry => !entry.favorite) },
].filter(group => group.entries.length > 0))
const deletingEntry = computed(() => entries.value.find(entry => entry.id === deletingId.value))
const replacementEntry = computed(() => {
  if (!deletingEntry.value || deletingEntry.value.id !== activeId.value) return
  const index = entries.value.findIndex(entry => entry.id === deletingId.value)
  return entries.value[index + 1] ?? entries.value[index - 1]
})
const draggedEntry = computed(() => entries.value.find(entry => entry.id === draggedId.value))

function displayName(entry: PresetEntry) {
  return entry.builtin ? t('pages.preference.presets.builtinName') : entry.name
}

function isEntryDisabled(entry: PresetEntry) {
  return disabled.value || Boolean(cardPending.value[entry.id])
}

function previewSource(entry: PresetEntry) {
  return thumbnailErrors.value[entry.id] ? undefined : thumbnails.value[entry.id]
}

function selectEntry(entry: PresetEntry) {
  if (!isEntryDisabled(entry)) void props.manager.activate(entry.id)
}

function openNewDialog() {
  if (disabled.value) return
  editingEntry.value = undefined
  nameDialogMode.value = 'new'
  nameDialogOpen.value = true
}

function openRenameDialog(entry: PresetEntry) {
  if (isEntryDisabled(entry) || entry.builtin) return
  editingEntry.value = entry
  nameDialogMode.value = 'rename'
  nameDialogOpen.value = true
}

async function duplicateEntry(entry: PresetEntry) {
  if (!isEntryDisabled(entry)) await props.manager.duplicate(entry.id)
}

function onEntryMenu(key: string | number, entry: PresetEntry) {
  if (key === 'duplicate') void duplicateEntry(entry)
  else if (key === 'export') openExportDialog(entry)
  else if (key === 'rename') openRenameDialog(entry)
  else if (key === 'delete') openDeleteDialog(entry)
}

function openExportDialog(entry: PresetEntry) {
  if (isEntryDisabled(entry)) return
  exportingId.value = entry.id
  showImportError.value = false
  fileInputError.value = undefined
}

function openFilePicker() {
  if (!importDisabled.value) fileInput.value?.click()
}

async function importSources(sources: Array<File | string>) {
  if (!mounted || importDisabled.value || sources.length === 0) return
  if (sources.length !== 1) {
    fileInputError.value = t('pages.preference.presets.transfer.errors.multipleFiles')
    return
  }
  fileInputError.value = undefined
  showImportError.value = true
  try {
    if (await props.manager.importPreset(sources[0])) {
      message.success(t('pages.preference.presets.transfer.success.import'))
    }
  } catch (error) {
    if (mounted) reportDiagnostic('error', 'presets.import_ui', error)
    fileInputError.value = t('pages.preference.presets.transfer.errors.import')
  }
}

async function onFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  await importSources(files)
}

async function retryImport() {
  if (importDisabled.value || !canRetryImport.value) return
  fileInputError.value = undefined
  showImportError.value = true
  try {
    if (await props.manager.retryImport()) {
      message.success(t('pages.preference.presets.transfer.success.import'))
    }
  } catch (error) {
    if (mounted) reportDiagnostic('error', 'presets.retry_import_ui', error)
    fileInputError.value = t('pages.preference.presets.transfer.errors.import')
  }
}

function onNativeFileDrop(payload: DragDropEvent) {
  if (!mounted || draggedId.value || importDisabled.value) {
    fileDropActive.value = false
    return
  }
  fileDropActive.value = payload.type === 'enter' || payload.type === 'over'
  if (payload.type === 'drop') void importSources(payload.paths)
}

async function listenForPresetFileDrops() {
  try {
    const unlisten = await getCurrentWindow().onDragDropEvent(({ payload }) => onNativeFileDrop(payload))
    if (mounted) unlistenFileDrops = unlisten
    else unlisten()
  } catch (error) {
    if (mounted) reportDiagnostic('warn', 'presets.drop_listener', error)
    fileDropActive.value = false
  }
}

watch(importDisabled, (value) => {
  if (value) {
    fileDropActive.value = false
    endDrag()
  }
})

onMounted(() => {
  void listenForPresetFileDrops()
})
onBeforeUnmount(() => {
  mounted = false
  endDrag()
  fileDropActive.value = false
  unlistenFileDrops?.()
  unlistenFileDrops = undefined
})

function openDeleteDialog(entry: PresetEntry) {
  if (isEntryDisabled(entry) || entry.builtin) return
  deletingId.value = entry.id
  deleteError.value = undefined
}

function closeDeleteDialog() {
  if (!deleting.value && !busy.value) deletingId.value = undefined
}

async function deleteEntry() {
  if (deleting.value || !deletingEntry.value || deletingEntry.value.builtin || isEntryDisabled(deletingEntry.value)) return
  deleting.value = true
  deleteError.value = undefined
  try {
    if (await props.manager.remove(deletingEntry.value.id)) {
      deletingId.value = undefined
    } else {
      const error = props.manager.error.value
      deleteError.value = error && te(error) ? t(error) : error ?? t('pages.preference.presets.errors.manage')
    }
  } catch (error) {
    if (mounted) reportDiagnostic('error', 'presets.delete_ui', error)
    deleteError.value = t('pages.preference.presets.errors.manage')
  } finally {
    deleting.value = false
  }
}

async function toggleFavorite(entry: PresetEntry) {
  if (isEntryDisabled(entry)) return
  if (await props.manager.toggleFavorite(entry.id)) {
    const updated = entries.value.find(candidate => candidate.id === entry.id)
    if (updated) announcePosition(updated)
  }
}

function announcePosition(entry: PresetEntry) {
  const group = entries.value.filter(candidate => candidate.favorite === entry.favorite)
  announcement.value = t('pages.preference.presets.status.moved', {
    name: displayName(entry),
    group: t(entry.favorite ? 'pages.preference.presets.labels.favorites' : 'pages.preference.presets.title'),
    position: group.findIndex(candidate => candidate.id === entry.id) + 1,
    count: group.length,
  })
}

async function onMoveKeydown(event: KeyboardEvent, entry: PresetEntry) {
  event.stopPropagation()
  if (!event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  if (isEntryDisabled(entry)) return
  if (await props.manager.move(entry.id, event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1)) announcePosition(entry)
}

function scrollParent(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent
  }
}

function startPointerDrag(event: PointerEvent, entry: PresetEntry) {
  if (event.button !== 0 || !event.isPrimary || pointerDrag) return
  event.preventDefault()
  if (isEntryDisabled(entry) || importDisabled.value) return
  const handle = event.currentTarget as HTMLElement
  try {
    handle.setPointerCapture(event.pointerId)
  } catch {
    return
  }
  pointerDrag = {
    pointerId: event.pointerId,
    handle,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    moved: false,
    scroller: scrollParent(handle),
  }
  draggedId.value = entry.id
  fileDropActive.value = false
}

function endDrag() {
  const drag = pointerDrag
  pointerDrag = undefined
  draggedId.value = undefined
  dropTarget.value = undefined
  dropAtGroupEnd.value = false
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
  scrollFrame = undefined
  try {
    if (drag?.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
  } catch {
    // A removed handle may have already lost its capture.
  }
}

function canDrop(entry: PresetEntry) {
  return !isEntryDisabled(entry) && draggedEntry.value && !isEntryDisabled(draggedEntry.value)
    && draggedEntry.value.favorite === entry.favorite
}

function updateDropTarget(x: number, y: number) {
  dropTarget.value = undefined
  dropAtGroupEnd.value = false
  const hit = document.elementFromPoint(x, y)
  const card = hit?.closest<HTMLElement>('[data-preset-id]')
  if (card && presetList.value?.contains(card)) {
    const entry = entries.value.find(candidate => candidate.id === card.dataset.presetId)
    if (!entry || entry.id === draggedId.value || !canDrop(entry)) return
    const rect = card.getBoundingClientRect()
    dropTarget.value = { id: entry.id, after: x >= rect.left + rect.width / 2 }
    return
  }
  const groupEnd = hit?.closest<HTMLElement>('[data-preset-group-end]')
  if (groupEnd && presetList.value?.contains(groupEnd) && draggedEntry.value && !isEntryDisabled(draggedEntry.value)) {
    dropAtGroupEnd.value = groupEnd.dataset.presetGroupEnd === String(draggedEntry.value.favorite)
  }
}

function scrollPointerDrag() {
  scrollFrame = undefined
  const drag = pointerDrag
  if (!drag?.moved || !drag.scroller) return
  if (!draggedEntry.value || isEntryDisabled(draggedEntry.value) || importDisabled.value) {
    endDrag()
    return
  }
  const rect = drag.scroller.getBoundingClientRect()
  if (drag.x < rect.left || drag.x > rect.right) return
  const edge = 40
  const top = Math.max(0, rect.top)
  const bottom = Math.min(window.innerHeight, rect.bottom)
  const direction = drag.y < top + edge ? -1 : drag.y > bottom - edge ? 1 : 0
  if (!direction) return
  const previous = drag.scroller.scrollTop
  drag.scroller.scrollTop += direction * 12
  updateDropTarget(drag.x, drag.y)
  if (drag.scroller.scrollTop !== previous) scrollFrame = requestAnimationFrame(scrollPointerDrag)
}

function movePointerDrag(event: PointerEvent) {
  const drag = pointerDrag
  if (!drag || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  if (!draggedEntry.value || isEntryDisabled(draggedEntry.value) || event.buttons === 0) {
    endDrag()
    return
  }
  drag.x = event.clientX
  drag.y = event.clientY
  drag.moved ||= Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 6
  if (!drag.moved) return
  updateDropTarget(drag.x, drag.y)
  if (scrollFrame === undefined && drag.scroller) scrollFrame = requestAnimationFrame(scrollPointerDrag)
}

async function finishPointerDrag(event: PointerEvent) {
  const drag = pointerDrag
  if (!drag || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  if (drag.moved) updateDropTarget(event.clientX, event.clientY)
  const id = draggedId.value
  const target = dropTarget.value
  const source = draggedEntry.value
  const valid = drag.moved && id && source && !isEntryDisabled(source) && (target || dropAtGroupEnd.value)
  const group = source ? entries.value.filter(candidate => candidate.favorite === source.favorite) : []
  const beforeId = target ? target.after ? group[group.findIndex(candidate => candidate.id === target.id) + 1]?.id : target.id : undefined
  endDrag()
  if (!valid || id === beforeId) return
  if (await props.manager.reorder(id, beforeId)) {
    const updated = entries.value.find(candidate => candidate.id === id)
    if (updated) announcePosition(updated)
  }
}

function cancelPointerDrag(event: PointerEvent) {
  if (event.pointerId === pointerDrag?.pointerId) endDrag()
}
</script>

<template>
  <section
    ref="presetList"
    :aria-label="$t('pages.preference.presets.title')"
    class="relative"
  >
    <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
      <h1 class="m-0 text-lg font-semibold">
        {{ $t('pages.preference.presets.title') }}
      </h1>
      <div class="flex flex-wrap items-center gap-2">
        <input
          ref="fileInput"
          accept=".petpreset"
          :aria-label="$t('pages.preference.presets.transfer.buttons.import')"
          class="hidden"
          :disabled="importDisabled"
          type="file"
          @change="onFileInputChange"
        >
        <Button
          class="preset-import-button"
          :disabled="importDisabled"
          @click="openFilePicker"
        >
          <template #icon>
            <span
              aria-hidden="true"
              class="i-lucide:folder-open mr-1.5 size-4"
            />
          </template>
          {{ $t('pages.preference.presets.transfer.buttons.import') }}
        </Button>
        <Button
          class="preset-new-button"
          :disabled="disabled"
          type="primary"
          @click="openNewDialog"
        >
          <template #icon>
            <span
              aria-hidden="true"
              class="i-lucide:plus mr-1.5 size-4"
            />
          </template>
          {{ $t('pages.preference.presets.buttons.new') }}
        </Button>
      </div>
    </div>
    <p class="mb-5 mt-0 whitespace-pre-line text-sm text-color-3">
      {{ $t('pages.preference.presets.hints.scope') }}
    </p>
    <p
      v-if="transferPhase && !exportingEntry"
      aria-live="polite"
      class="mb-4 flex items-center gap-2 text-sm text-color-3"
      role="status"
    >
      <span
        aria-hidden="true"
        class="i-lucide:loader-circle size-4 animate-spin"
      />
      {{ $t(`pages.preference.presets.transfer.phases.${transferPhase}`) }}
    </p>
    <div
      v-if="importErrorText"
      class="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm"
      role="alert"
    >
      <span class="min-w-0 flex-1 text-red-6">{{ importErrorText }}</span>
      <Button
        v-if="canRetryImport && !fileInputError"
        :disabled="importDisabled"
        size="small"
        @click="retryImport"
      >
        {{ $t('pages.preference.presets.buttons.retry') }}
      </Button>
    </div>
    <div
      v-if="errorText"
      class="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm"
      role="alert"
    >
      <span class="min-w-0 flex-1 text-red-6">{{ errorText }}</span>
      <Button
        :disabled="busy"
        size="small"
        @click="manager.retry()"
      >
        {{ $t('pages.preference.presets.buttons.retry') }}
      </Button>
    </div>
    <p
      v-if="!ready"
      class="py-6 text-center text-sm text-color-3"
      role="status"
    >
      {{ $t('pages.preference.presets.status.loading') }}
    </p>
    <PreferenceSections v-else>
      <section
        v-for="group in groups"
        :key="String(group.favorite)"
        :aria-label="group.label"
      >
        <h2 class="mb-2 mt-0 text-sm text-color-3 font-medium">
          {{ group.label }}
        </h2>
        <ul class="preset-grid m-0 list-none p-0">
          <li
            v-for="entry in group.entries"
            :key="entry.id"
            :aria-busy="Boolean(cardPending[entry.id])"
            class="preset-card"
            :class="{
              'preset-card-active': entry.id === activeId,
              'preset-card-dragging': entry.id === draggedId,
              'preset-card-drop-before': dropTarget?.id === entry.id && !dropTarget.after,
              'preset-card-drop-after': dropTarget?.id === entry.id && dropTarget.after,
            }"
            :data-preset-id="entry.id"
            @click="selectEntry(entry)"
          >
            <button
              :aria-label="$t('pages.preference.presets.labels.reorder', { name: displayName(entry) })"
              class="preset-action preset-drag-handle"
              :disabled="isEntryDisabled(entry)"
              :title="$t('pages.preference.presets.hints.reorder')"
              type="button"
              @click.stop
              @keydown="onMoveKeydown($event, entry)"
              @lostpointercapture="cancelPointerDrag"
              @pointercancel.stop="cancelPointerDrag"
              @pointerdown.stop="startPointerDrag($event, entry)"
              @pointermove.stop="movePointerDrag"
              @pointerup.stop="finishPointerDrag"
            >
              <span
                aria-hidden="true"
                class="i-lucide:grip-vertical size-4"
              />
            </button>
            <button
              :aria-label="$t('pages.preference.presets.labels.apply', { name: displayName(entry) })"
              :aria-pressed="entry.id === activeId"
              class="preset-select"
              :disabled="isEntryDisabled(entry)"
              type="button"
            >
              <span class="preset-thumbnail">
                <img
                  v-if="previewSource(entry)"
                  alt=""
                  draggable="false"
                  :src="previewSource(entry)"
                >
                <span
                  v-else
                  aria-hidden="true"
                  class="size-7 text-color-3"
                  :class="thumbnailErrors[entry.id] ? 'i-lucide:image-off' : 'i-lucide:box'"
                />
              </span>
              <span class="preset-details">
                <span
                  class="preset-name text-sm font-medium"
                  :title="displayName(entry)"
                >{{ displayName(entry) }}</span>
                <Tag
                  v-if="entry.id === activeId"
                  class="shrink-0 m-0!"
                  color="green"
                >
                  {{ $t('pages.preference.presets.status.active') }}
                </Tag>
              </span>
            </button>
            <div class="preset-actions">
              <button
                :aria-label="$t(`pages.preference.presets.labels.${entry.favorite ? 'unfavorite' : 'favorite'}`, { name: displayName(entry) })"
                :aria-pressed="entry.favorite"
                class="preset-action"
                :class="{ 'preset-favorite-active': entry.favorite }"
                :disabled="isEntryDisabled(entry)"
                :title="$t(`pages.preference.presets.buttons.${entry.favorite ? 'unfavorite' : 'favorite'}`)"
                type="button"
                @click.stop="toggleFavorite(entry)"
                @keydown.stop
              >
                <span
                  aria-hidden="true"
                  class="i-lucide:star size-4"
                />
              </button>
              <Dropdown
                :disabled="isEntryDisabled(entry)"
                :trigger="['click']"
              >
                <button
                  aria-haspopup="menu"
                  :aria-label="$t('pages.preference.presets.labels.more', { name: displayName(entry) })"
                  class="preset-action"
                  :disabled="isEntryDisabled(entry)"
                  :title="$t('pages.preference.presets.buttons.more')"
                  type="button"
                  @click.stop
                  @keydown.stop
                >
                  <span
                    aria-hidden="true"
                    class="i-lucide:ellipsis size-4"
                  />
                </button>
                <template #overlay>
                  <Menu @click="({ key }) => onEntryMenu(key, entry)">
                    <Menu.Item
                      key="export"
                      :disabled="isEntryDisabled(entry)"
                    >
                      {{ $t('pages.preference.presets.transfer.buttons.export') }}
                    </Menu.Item>
                    <Menu.Item
                      key="duplicate"
                      :disabled="isEntryDisabled(entry)"
                    >
                      {{ $t('pages.preference.presets.buttons.duplicate') }}
                    </Menu.Item>
                    <Menu.Item
                      key="rename"
                      :disabled="entry.builtin || isEntryDisabled(entry)"
                    >
                      {{ $t('pages.preference.presets.buttons.rename') }}
                    </Menu.Item>
                    <Menu.Item
                      key="delete"
                      danger
                      :disabled="entry.builtin || isEntryDisabled(entry)"
                    >
                      {{ $t('pages.preference.presets.buttons.delete') }}
                    </Menu.Item>
                  </Menu>
                </template>
              </Dropdown>
            </div>
            <div
              v-if="thumbnailErrors[entry.id]"
              class="preset-preview-error text-xs text-color-3"
            >
              <span>{{ $t('pages.preference.presets.errors.preview') }}</span>
              <Button
                class="ml-1"
                :disabled="isEntryDisabled(entry)"
                size="small"
                type="link"
                @click.stop="manager.retryThumbnail(entry.id)"
                @keydown.stop
              >
                {{ $t('pages.preference.presets.buttons.retry') }}
              </Button>
            </div>
            <div
              v-if="cardPending[entry.id]"
              class="preset-card-loading"
              role="status"
              @click.stop
              @keydown.stop
            >
              <span
                aria-hidden="true"
                class="i-lucide:loader-circle size-5 animate-spin"
              />
              <span>{{ $t(`pages.preference.presets.status.${cardPending[entry.id]}`) }}</span>
            </div>
          </li>
        </ul>
        <div
          v-if="draggedEntry?.favorite === group.favorite"
          class="mt-2 b b-color-2 rounded-lg b-dashed p-2 text-center text-xs text-color-3"
          :class="{ 'preset-group-drop-active': dropAtGroupEnd }"
          :data-preset-group-end="String(group.favorite)"
        >
          {{ $t('pages.preference.presets.hints.moveToEnd') }}
        </div>
      </section>
    </PreferenceSections>
    <div
      v-if="fileDropActive"
      class="bg-color-1/95 pointer-events-none absolute inset-0 z-10 flex items-center justify-center b-2 b-primary-6 rounded-xl b-dashed p-6 text-center text-primary-7"
      role="status"
    >
      {{ $t('pages.preference.presets.transfer.hints.drop') }}
    </div>
    <span
      aria-live="polite"
      class="sr-only"
      role="status"
    >{{ announcement }}</span>
    <NameDialog
      :entry="editingEntry"
      :manager="manager"
      :mode="nameDialogMode"
      :open="nameDialogOpen"
      @close="nameDialogOpen = false"
    />
    <ExportDialog
      :entry="exportingEntry"
      :manager="manager"
      :open="Boolean(exportingEntry)"
      @close="exportingId = undefined"
    />
    <Modal
      :cancel-button-props="{ disabled: deleting || busy }"
      :cancel-text="$t('pages.preference.presets.buttons.cancel')"
      :closable="!deleting && !busy"
      :confirm-loading="deleting"
      :keyboard="!deleting && !busy"
      :mask-closable="false"
      :ok-button-props="{ disabled: disabled || deleting || Boolean(deletingEntry && isEntryDisabled(deletingEntry)) }"
      :ok-text="$t('pages.preference.presets.buttons.delete')"
      ok-type="danger"
      :open="Boolean(deletingEntry)"
      :title="$t('pages.preference.presets.dialog.deleteTitle', { name: deletingEntry ? displayName(deletingEntry) : '' })"
      @cancel="closeDeleteDialog"
      @ok="deleteEntry"
    >
      <p>{{ $t('pages.preference.presets.dialog.deleteHint') }}</p>
      <p v-if="replacementEntry">
        {{ $t('pages.preference.presets.dialog.deleteActiveHint', { name: displayName(replacementEntry) }) }}
      </p>
      <p
        v-if="deleteError"
        class="mb-0 text-red-6"
        role="alert"
      >
        {{ deleteError }}
      </p>
    </Modal>
  </section>
</template>

<style scoped>
.preset-import-button,
.preset-new-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.preset-card {
  display: grid;
  position: relative;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  grid-template-rows: auto 1fr;
  align-items: start;
  gap: 6px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--ant-color-border, #d6e6da);
  border-radius: 12px;
  background: var(--ant-color-bg-container, #fff);
  cursor: pointer;
  transition:
    border-color 0.15s,
    background-color 0.15s;
}

.preset-card:hover,
.preset-card-active {
  border-color: var(--ant-color-primary, #3aa76d);
}

.preset-card-active {
  background: var(--ant-color-primary-bg, #e3f6e9);
}

.preset-card-dragging {
  opacity: 0.5;
}

.preset-card-loading {
  position: absolute;
  z-index: 1;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border-radius: inherit;
  background: color-mix(in srgb, var(--ant-color-bg-container, #fff) 84%, transparent);
  color: var(--ant-color-text, #24382b);
  font-size: 14px;
  font-weight: 500;
  text-align: center;
  cursor: progress;
}

.preset-card-drop-before {
  box-shadow: -3px 0 0 var(--ant-color-primary, #3aa76d);
}

.preset-card-drop-after {
  box-shadow: 3px 0 0 var(--ant-color-primary, #3aa76d);
}

.preset-group-drop-active {
  border-color: var(--ant-color-primary, #3aa76d);
  color: var(--ant-color-primary, #3aa76d);
}

.preset-select {
  display: flex;
  grid-column: 1 / -1;
  grid-row: 2;
  flex-direction: column;
  min-width: 0;
  width: 100%;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.preset-thumbnail {
  display: flex;
  width: 100%;
  aspect-ratio: 16 / 10;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
  background: var(--ant-color-fill-quaternary, rgba(58, 167, 109, 0.05));
}

.preset-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.preset-details {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.preset-name {
  display: -webkit-box;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.preset-actions {
  display: flex;
  grid-column: 3;
  grid-row: 1;
  gap: 2px;
}

.preset-action {
  display: flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ant-color-text-secondary, #617166);
  cursor: pointer;
}

.preset-action:hover {
  background: var(--ant-color-fill-tertiary, rgba(58, 167, 109, 0.08));
}

.preset-favorite-active {
  background: var(--ant-color-primary-bg, #e3f6e9);
  color: var(--ant-color-primary, #3aa76d);
}

.preset-drag-handle {
  grid-column: 1;
  grid-row: 1;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.preset-drag-handle:active {
  cursor: grabbing;
}

.preset-select:disabled,
.preset-action:disabled {
  cursor: default;
  opacity: 0.65;
}

.preset-select:focus-visible,
.preset-action:focus-visible {
  outline: 2px solid var(--ant-color-primary, #3aa76d);
  outline-offset: 2px;
}

.preset-preview-error {
  grid-column: 1 / -1;
}
</style>
