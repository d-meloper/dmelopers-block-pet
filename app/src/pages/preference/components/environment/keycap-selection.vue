<script setup lang="ts">
import { Button, Flex, Modal, Segmented, Select } from 'ant-design-vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ResolvedKeyboardLanguage } from '@/config/keyboardLanguage'

import OptionTransition from '@/components/option-transition/index.vue'
import { vDetailHeightOption } from '@/components/preference-detail-tabs/height'
import ProListItem from '@/components/pro-list-item/index.vue'
import { beginShortcutRecording } from '@/composables/useKeyPress'
import { reconcileKeyboardKeycapSettings } from '@/config/keyboardKeycapSettings'
import { getKeyboardKeyLabel, KEYBOARD_SELECTABLE_KEYS, keyboardKeyIdFromCode } from '@/config/keyboardLayout'
import { isValidSkinLibraryDisplayName } from '@/services/skinLibrary'
import { useGeneralStore } from '@/stores/general'

const props = defineProps<{
  mode: 'all' | 'selected'
  selectedKeys: readonly string[]
  disabled: boolean
  active: boolean
}>()
const emit = defineEmits<{
  'update:mode': [mode: 'all' | 'selected']
  'update:selectedKeys': [keys: string[]]
}>()
const { t } = useI18n()
const generalStore = useGeneralStore()
const path = 'pages.preference.environment.keycapSelection'
const open = ref(false)
const keycapLanguage = ref<ResolvedKeyboardLanguage>('en')
const modeOptions = computed(() => [
  { value: 'all', label: t(`${path}.all`) },
  { value: 'selected', label: t(`${path}.selected`) },
])
const keycapLanguageOptions = computed(() => [
  { value: 'ko', label: t('pages.preference.environment.options.keyboardKorean') },
  { value: 'en', label: t('pages.preference.environment.options.keyboardEnglish') },
  { value: 'ja', label: t('pages.preference.environment.options.keyboardJapanese') },
])
const recording = ref(false)
const draft = ref<string[]>([])
const unsupportedKey = ref('')
const keyboardBoard = ref<HTMLDivElement>()
const selectedPresetId = ref<string>()
const presetMenuOpen = ref(false)
const renamingPresetId = ref<string>()
const renameOpen = ref(false)
const renameName = ref('')
const renameError = ref<string>()
const renameInput = ref<HTMLInputElement>()
const deletingPreset = ref(false)
let keepPresetMenuOpen = false
let deleteDialog: ReturnType<typeof Modal.confirm> | undefined
const selectedSet = computed(() => new Set(draft.value))
const allDraftKeysSelected = computed(() => KEYBOARD_SELECTABLE_KEYS.every(key => selectedSet.value.has(key.id)))
const rows = Array.from({ length: 5 }, (_, row) => KEYBOARD_SELECTABLE_KEYS.filter(key => key.row === row))
let finishRecording: (() => void) | undefined
let unsupportedTimer: ReturnType<typeof setTimeout> | undefined

function keyLabel(id: string) {
  return getKeyboardKeyLabel(id, keycapLanguage.value)
}

function keycapLegend(id: string, fallback: string) {
  const label = keyLabel(id)
  return label.length === 1 ? label : fallback
}

function stopRecording() {
  recording.value = false
  finishRecording?.()
  finishRecording = undefined
}

function canRecord() {
  return open.value && props.active && !props.disabled && !deletingPreset.value && !renamingPresetId.value && !document.hidden && document.hasFocus()
}

function startRecording() {
  if (recording.value || !canRecord()) return
  finishRecording = beginShortcutRecording(() => {
    stopRecording()
    // Pointer cancellation can retire a recorder without leaving the dialog.
    queueMicrotask(startRecording)
  })
  recording.value = true
}

function focusKeyboard() {
  void nextTick(() => {
    if (canRecord()) keyboardBoard.value?.focus({ preventScroll: true })
  })
}

function clearUnsupported() {
  clearTimeout(unsupportedTimer)
  unsupportedTimer = undefined
  unsupportedKey.value = ''
}

function close() {
  stopRecording()
  clearUnsupported()
  open.value = false
  presetMenuOpen.value = false
  renameOpen.value = false
}

function edit() {
  if (props.disabled || props.mode !== 'selected') return
  reconcileKeyboardKeycapSettings(generalStore.keyboardKeycap)
  stopRecording()
  clearUnsupported()
  draft.value = [...props.selectedKeys]
  open.value = true
}

function matchesDraft(keys: readonly string[]) {
  return keys.length === draft.value.length && keys.every(key => selectedSet.value.has(key))
}

function selectPreset(id: unknown) {
  if (props.disabled || typeof id !== 'string') return
  if (id === '+save') {
    let number = 1
    const library = generalStore.keyboardKeycap.presets
    while (library.some(entry => entry.name === t(`${path}.savedPresetName`, { number }))) number++
    const entry = {
      id: `user:${crypto.randomUUID()}`,
      name: t(`${path}.savedPresetName`, { number }),
      keys: KEYBOARD_SELECTABLE_KEYS.filter(key => selectedSet.value.has(key.id)).map(key => key.id),
    }
    library.push(entry)
    selectedPresetId.value = entry.id
    keepPresetMenuOpen = true
    presetMenuOpen.value = true
    void nextTick(() => {
      if (open.value && !props.disabled) presetMenuOpen.value = true
      keepPresetMenuOpen = false
    })
    return
  } else {
    const entry = generalStore.keyboardKeycap.presets.find(preset => preset.id === id)
    if (!entry) return
    draft.value = [...entry.keys]
    selectedPresetId.value = entry.id
  }
  focusKeyboard()
}

function updatePresetMenuOpen(visible: boolean) {
  if (visible && !props.disabled) reconcileKeyboardKeycapSettings(generalStore.keyboardKeycap)
  presetMenuOpen.value = visible || keepPresetMenuOpen
}

function requestRenamePreset(id: string) {
  if (props.disabled || deletingPreset.value || renamingPresetId.value) return
  const entry = generalStore.keyboardKeycap.presets.find(preset => preset.id === id)
  if (!entry) return
  stopRecording()
  presetMenuOpen.value = false
  renamingPresetId.value = id
  renameName.value = entry.name
  renameError.value = undefined
  renameOpen.value = true
  void nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}

function submitRename() {
  if (props.disabled || !renamingPresetId.value) return
  const name = renameName.value.trim()
  if (!isValidSkinLibraryDisplayName(name)) {
    renameError.value = t(`${path}.invalidPresetName`)
    return
  }
  if (generalStore.keyboardKeycap.presets.some(entry => entry.id !== renamingPresetId.value && entry.name === name)) {
    renameError.value = t(`${path}.duplicatePresetName`)
    return
  }
  const entry = generalStore.keyboardKeycap.presets.find(preset => preset.id === renamingPresetId.value)
  if (entry) entry.name = name
  renameOpen.value = false
}

function finishRename() {
  renamingPresetId.value = undefined
  renameError.value = undefined
  startRecording()
  focusKeyboard()
}

function requestDeletePreset(id: string) {
  if (props.disabled || deletingPreset.value) return
  const entry = generalStore.keyboardKeycap.presets.find(preset => preset.id === id)
  if (!entry) return
  deletingPreset.value = true
  presetMenuOpen.value = false
  stopRecording()
  deleteDialog = Modal.confirm({
    title: t(`${path}.deletePresetTitle`, { name: entry.name }),
    content: t(`${path}.deletePresetHint`),
    okText: t(`${path}.delete`),
    cancelText: t(`${path}.cancel`),
    okType: 'danger',
    onOk: () => {
      if (props.disabled) return
      generalStore.keyboardKeycap.presets = generalStore.keyboardKeycap.presets.filter(preset => preset.id !== id)
      if (selectedPresetId.value === id) selectedPresetId.value = undefined
    },
    afterClose: () => {
      deleteDialog = undefined
      deletingPreset.value = false
      startRecording()
      focusKeyboard()
    },
  })
}

function updateMode(value: unknown) {
  if (!props.disabled && (value === 'all' || value === 'selected')) emit('update:mode', value)
}

function toggleKey(id: string) {
  if (props.disabled) return
  draft.value = selectedSet.value.has(id) ? draft.value.filter(key => key !== id) : [...draft.value, id]
}

function recordKey(event: KeyboardEvent) {
  if (!canRecord()) return
  startRecording()
  // Keep the language menu's own keyboard navigation available.
  if (event.target instanceof Element && event.target.closest('.ant-select, .ant-select-dropdown')) return
  if (event.code === 'Escape' || event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }
  // Tab can select its cap while retaining ordinary focus navigation.
  if (event.code !== 'Tab') {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  if (event.repeat) return
  const id = keyboardKeyIdFromCode(event.code)
  if (!id) {
    clearUnsupported()
    unsupportedKey.value = event.code || event.key
    unsupportedTimer = setTimeout(clearUnsupported, 3000)
    return
  }
  clearUnsupported()
  toggleKey(id)
}

function onVisibilityChange() {
  if (document.hidden) stopRecording()
  else startRecording()
}

function apply() {
  if (props.disabled) return
  const allKeysSelected = allDraftKeysSelected.value
  // Keep a stable keyboard order regardless of click/recording order.
  emit('update:selectedKeys', KEYBOARD_SELECTABLE_KEYS.filter(key => selectedSet.value.has(key.id)).map(key => key.id))
  if (allKeysSelected) emit('update:mode', 'all')
  close()
}

onMounted(() => {
  if (!props.disabled) reconcileKeyboardKeycapSettings(generalStore.keyboardKeycap)
})
watch(() => [props.disabled, props.active] as const, ([disabled, active]) => {
  if (disabled || !active) close()
})
// Only changes to this common setting retire the draft; pet presets do not own it.
watch(() => [props.mode, props.selectedKeys] as const, close, { deep: true })
watch([draft, () => generalStore.keyboardKeycap.presets], () => {
  const entry = generalStore.keyboardKeycap.presets.find(preset => preset.id === selectedPresetId.value)
  if (!entry || !matchesDraft(entry.keys)) selectedPresetId.value = undefined
}, { deep: true })
watch(renameName, () => renameError.value = undefined)
watch(open, (visible) => {
  if (visible) {
    window.addEventListener('keydown', recordKey, true)
    window.addEventListener('blur', stopRecording)
    window.addEventListener('focus', startRecording)
    document.addEventListener('visibilitychange', onVisibilityChange)
    startRecording()
    focusKeyboard()
  } else {
    stopRecording()
    window.removeEventListener('keydown', recordKey, true)
    window.removeEventListener('blur', stopRecording)
    window.removeEventListener('focus', startRecording)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}, { flush: 'sync' })
onBeforeUnmount(() => {
  close()
  deleteDialog?.destroy()
  window.removeEventListener('keydown', recordKey, true)
  window.removeEventListener('blur', stopRecording)
  window.removeEventListener('focus', startRecording)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div
    class="keycap-filter"
    data-preset-common-setting
  >
    <ProListItem
      plain
      :title="t(`${path}.range`)"
    >
      <Flex
        align="center"
        wrap
      >
        <Segmented
          :aria-label="t(`${path}.range`)"
          :disabled="disabled"
          :options="modeOptions"
          :value="mode"
          @update:value="updateMode"
        />
        <OptionTransition axis="width">
          <div
            v-show="mode === 'selected'"
            v-detail-height-option
            class="keycap-choose-action"
          >
            <Button
              :disabled="disabled || mode !== 'selected'"
              @click="edit"
            >
              {{ t(`${path}.choose`) }}
            </Button>
          </div>
        </OptionTransition>
      </Flex>
    </ProListItem>
    <Modal
      :cancel-text="t(`${path}.cancel`)"
      :keyboard="false"
      :mask-closable="false"
      :ok-button-props="{ disabled }"
      :ok-text="t(`${path}.apply`)"
      :open="open"
      :title="t(`${path}.title`)"
      :width="760"
      :wrap-props="{ 'data-preset-common-setting': '' }"
      @cancel="close"
      @ok="apply"
    >
      <div class="keycap-editor">
        <p class="keycap-hint">
          {{ t(`${path}.hint`) }}
        </p>
        <Flex
          align="center"
          gap="small"
          justify="space-between"
          wrap
        >
          <Select
            :aria-label="t(`${path}.presets`)"
            :disabled="disabled"
            :open="presetMenuOpen"
            option-label-prop="label"
            :placeholder="t(`${path}.presets`)"
            popup-class-name="keycap-preset-popup"
            :style="{ width: '252px', maxWidth: '100%' }"
            :value="selectedPresetId"
            @change="selectPreset"
            @dropdown-visible-change="updatePresetMenuOpen"
          >
            <Select.Option
              v-for="entry in generalStore.keyboardKeycap.presets"
              :key="entry.id"
              :label="entry.name"
              :value="entry.id"
            >
              <span class="keycap-preset-option">
                <span class="keycap-preset-name">{{ entry.name }}</span>
                <span class="keycap-preset-actions">
                  <button
                    :aria-label="t(`${path}.renamePreset`, { name: entry.name })"
                    class="keycap-preset-action keycap-preset-rename"
                    :disabled="disabled"
                    type="button"
                    @click.prevent.stop="requestRenamePreset(entry.id)"
                    @mousedown.prevent.stop
                  ><span
                    aria-hidden="true"
                    class="i-lucide:pencil"
                  /></button>
                  <button
                    :aria-label="t(`${path}.deletePreset`, { name: entry.name })"
                    class="keycap-preset-action keycap-preset-remove"
                    :disabled="disabled"
                    type="button"
                    @click.prevent.stop="requestDeletePreset(entry.id)"
                    @mousedown.prevent.stop
                  >×</button>
                </span>
              </span>
            </Select.Option>
            <Select.Option
              :label="t(`${path}.savePreset`)"
              value="+save"
            >
              {{ t(`${path}.savePreset`) }}
            </Select.Option>
          </Select>
          <Select
            v-model:value="keycapLanguage"
            :aria-label="t(`${path}.language`)"
            :disabled="disabled"
            :options="keycapLanguageOptions"
            :style="{ minWidth: '116px' }"
            @change="focusKeyboard"
          />
        </Flex>
        <div
          v-if="unsupportedKey"
          class="keycap-unsupported"
          role="status"
        >
          {{ t(`${path}.unsupported`, { key: unsupportedKey }) }}
        </div>
        <div class="keycap-board-scroll">
          <div
            ref="keyboardBoard"
            :aria-label="t(`${path}.keymap`)"
            class="keycap-board"
            dir="ltr"
            role="group"
            :tabindex="-1"
          >
            <div
              v-for="(row, index) in rows"
              :key="index"
              class="keycap-row"
            >
              <button
                v-for="key in row"
                :key="key.id"
                :aria-label="keyLabel(key.id)"
                :aria-pressed="selectedSet.has(key.id)"
                class="keycap-key"
                :class="{ 'is-selected': selectedSet.has(key.id) }"
                :disabled="disabled"
                :style="{ flexGrow: key.units, flexBasis: `${key.units * 28}px` }"
                type="button"
                @click="toggleKey(key.id)"
              >
                <span>{{ keycapLegend(key.id, key.legend) }}</span>
                <span
                  v-if="selectedSet.has(key.id)"
                  aria-hidden="true"
                  class="keycap-check"
                >✓</span>
              </button>
            </div>
          </div>
        </div>
        <Flex
          align="center"
          gap="small"
          wrap
        >
          <span>{{ allDraftKeysSelected ? t(`${path}.allSelected`) : t(`${path}.count`, { count: draft.length }) }}</span>
          <Flex
            gap="small"
            wrap
          >
            <button
              class="keycap-record"
              :disabled="disabled"
              type="button"
              @click="draft = KEYBOARD_SELECTABLE_KEYS.map(key => key.id)"
            >
              {{ t(`${path}.selectAll`) }}
            </button>
            <button
              class="keycap-record"
              :disabled="disabled"
              type="button"
              @click="draft = []"
            >
              {{ t(`${path}.clearAll`) }}
            </button>
          </Flex>
        </Flex>
        <div
          :aria-label="t(`${path}.selectedList`)"
          class="keycap-chip-list"
          dir="ltr"
          role="group"
        >
          <button
            v-for="key in KEYBOARD_SELECTABLE_KEYS.filter(key => selectedSet.has(key.id))"
            :key="key.id"
            :aria-label="t(`${path}.removeKey`, { key: keyLabel(key.id) })"
            class="keycap-chip"
            :disabled="disabled"
            type="button"
            @click="toggleKey(key.id)"
          >
            {{ keyLabel(key.id) }} <span aria-hidden="true">×</span>
          </button>
          <span
            v-if="!draft.length"
            class="keycap-hint"
          >{{ t(`${path}.empty`) }}</span>
        </div>
      </div>
    </Modal>
    <Modal
      :after-close="finishRename"
      :cancel-text="t(`${path}.cancel`)"
      :mask-closable="false"
      :ok-button-props="{ disabled: disabled || !renameName.trim() }"
      :ok-text="t(`${path}.rename`)"
      :open="renameOpen"
      :title="t(`${path}.renamePresetTitle`)"
      :width="420"
      :wrap-props="{ 'data-preset-common-setting': '' }"
      @cancel="renameOpen = false"
      @ok="submitRename"
    >
      <form @submit.prevent="submitRename">
        <label
          class="keycap-name-label"
          for="keycap-preset-name"
        >{{ t(`${path}.presetName`) }}</label>
        <input
          id="keycap-preset-name"
          ref="renameInput"
          v-model="renameName"
          :aria-describedby="renameError ? 'keycap-preset-name-error' : undefined"
          :aria-invalid="Boolean(renameError)"
          autocomplete="off"
          class="keycap-name-input"
          :disabled="disabled"
          type="text"
        >
        <p
          v-if="renameError"
          id="keycap-preset-name-error"
          class="keycap-name-error"
          role="alert"
        >
          {{ renameError }}
        </p>
      </form>
    </Modal>
  </div>
</template>

<style scoped>
.keycap-filter,
.keycap-editor {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.keycap-choose-action {
  flex: 0 0 auto;
  padding-inline-start: 8px;
  white-space: nowrap;
}
.keycap-hint {
  color: var(--ant-color-text-secondary);
  margin: 0;
  font-size: 12px;
}
.keycap-unsupported {
  color: var(--ant-color-warning-text);
  font-size: 12px;
}
.keycap-board-scroll {
  overflow-x: auto;
  padding-block: 4px;
}
.keycap-board {
  min-width: 570px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px;
  border-radius: 10px;
  background: var(--ant-color-fill-tertiary);
}
.keycap-row {
  display: flex;
  gap: 4px;
}
.keycap-key {
  position: relative;
  flex-shrink: 0;
  min-width: 0;
  height: 40px;
  padding: 0 2px;
  border: 1px solid var(--ant-color-border);
  border-radius: 5px;
  background: var(--ant-color-bg-elevated);
  color: var(--ant-color-text);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
  box-shadow: 0 2px 0 var(--ant-color-border-secondary);
}
.keycap-key.is-selected {
  background: var(--ant-color-primary-bg);
  border-color: var(--ant-color-primary);
  color: var(--ant-color-primary-text);
}
.keycap-key:hover {
  border-color: var(--ant-color-primary-hover);
}
.keycap-check {
  position: absolute;
  top: 1px;
  right: 3px;
  font-size: 9px;
}
.keycap-key:focus-visible,
.keycap-chip:focus-visible,
.keycap-record:focus-visible {
  outline: 2px solid var(--ant-color-primary);
  outline-offset: 2px;
}
.keycap-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 126px;
  overflow-y: auto;
  padding: 3px;
}
.keycap-chip,
.keycap-record {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--ant-color-border);
  border-radius: 6px;
  color: var(--ant-color-text);
  background: var(--ant-color-bg-container);
  font: inherit;
  cursor: pointer;
}
.keycap-chip {
  padding: 3px 8px;
  font-size: 12px;
}
.keycap-record {
  height: 32px;
  padding: 0 12px;
  font-size: 14px;
  line-height: 20px;
}
.keycap-preset-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.keycap-preset-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.keycap-preset-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.keycap-preset-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ant-color-text-secondary);
  cursor: pointer;
  font: inherit;
}
.keycap-preset-rename:hover {
  background: var(--ant-color-fill-secondary);
  color: var(--ant-color-text);
}
.keycap-preset-remove:hover {
  background: var(--ant-color-error-bg);
  color: var(--ant-color-error);
}
.keycap-preset-action:focus-visible {
  outline: 2px solid var(--ant-color-primary);
  outline-offset: 1px;
}
:global(.keycap-preset-popup .ant-select-item-option:has(.keycap-preset-action:hover)) {
  background-color: var(--ant-color-bg-elevated) !important;
}
.keycap-name-label {
  display: block;
  margin-bottom: 8px;
}
.keycap-name-input {
  box-sizing: border-box;
  width: 100%;
  padding: 7px 11px;
  border: 1px solid var(--ant-color-border);
  border-radius: 6px;
  color: var(--ant-color-text);
  background: var(--ant-color-bg-container);
  font: inherit;
}
.keycap-name-input:focus-visible {
  outline: 2px solid var(--ant-color-primary);
  outline-offset: 1px;
}
.keycap-name-error {
  margin: 8px 0 0;
  color: var(--ant-color-error);
  font-size: 12px;
}
.keycap-chip:hover,
.keycap-record:hover {
  border-color: var(--ant-color-primary-hover);
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
