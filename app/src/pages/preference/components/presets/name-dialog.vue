<script setup lang="ts">
import { Modal } from 'ant-design-vue'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PresetManager } from '@/composables/usePresetManager'
import type { PresetEntry } from '@/features/presets/types'

import { reportDiagnostic } from '@/services/diagnostics'
import { isValidSkinLibraryDisplayName } from '@/services/skinLibrary'

const props = defineProps<{
  manager: PresetManager
  open: boolean
  mode: 'new' | 'rename'
  entry?: PresetEntry
}>()
const emit = defineEmits<{ close: [] }>()
const { t, te } = useI18n()
const name = ref('')
const input = ref<HTMLInputElement>()
const submitting = ref(false)
const validationError = ref<string>()
const operationError = ref<string>()
const title = computed(() => t(`pages.preference.presets.dialog.${props.mode}Title`))
const disabled = computed(() => submitting.value || props.manager.busy.value)
const nameError = computed(() => validationError.value ?? operationError.value)

watch(() => props.open, async (open) => {
  if (!open) return
  name.value = props.mode === 'rename'
    ? props.entry?.name ?? ''
    : props.manager.getSuggestedName()
  validationError.value = undefined
  operationError.value = undefined
  await nextTick()
  input.value?.focus()
  input.value?.select()
})

watch(name, () => {
  validationError.value = undefined
  operationError.value = undefined
}, { flush: 'sync' })

function close() {
  if (!disabled.value) emit('close')
}

async function submit() {
  if (disabled.value) return
  const trimmedName = name.value.trim()
  if (!isValidSkinLibraryDisplayName(trimmedName)) {
    validationError.value = t('pages.preference.presets.errors.invalidName')
    return
  }
  if (props.manager.entries.value.some(entry => entry.id !== (props.mode === 'rename' ? props.entry?.id : undefined)
    && (entry.builtin ? t('pages.preference.presets.builtinName') : entry.name) === trimmedName)) {
    validationError.value = t('pages.preference.presets.errors.duplicateName')
    return
  }
  submitting.value = true
  operationError.value = undefined
  try {
    const success = props.mode === 'new'
      ? await props.manager.create(trimmedName)
      : Boolean(props.entry && await props.manager.rename(props.entry.id, trimmedName))
    if (success) {
      emit('close')
    } else {
      const error = props.manager.error.value
      operationError.value = error && te(error) ? t(error) : error ?? t('pages.preference.presets.errors.manage')
    }
  } catch (error) {
    reportDiagnostic('error', 'presets.name_ui', error)
    operationError.value = t('pages.preference.presets.errors.manage')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Modal
    :cancel-button-props="{ disabled }"
    :cancel-text="$t('pages.preference.presets.buttons.cancel')"
    :closable="!disabled"
    :confirm-loading="submitting"
    destroy-on-close
    :keyboard="!disabled"
    :mask-closable="false"
    :ok-button-props="{ disabled: disabled || !name.trim() }"
    :ok-text="$t(`pages.preference.presets.buttons.${mode === 'rename' ? 'rename' : 'create'}`)"
    :open="open"
    :title="title"
    @cancel="close"
    @ok="submit"
  >
    <p class="text-sm text-color-3">
      {{ $t(`pages.preference.presets.dialog.${mode}Hint`) }}
    </p>
    <form @submit.prevent="submit">
      <label
        class="mb-2 block text-sm font-medium"
        for="preset-name-input"
      >
        {{ $t('pages.preference.presets.labels.name') }}
      </label>
      <input
        id="preset-name-input"
        ref="input"
        v-model="name"
        :aria-describedby="nameError ? 'preset-name-error' : 'preset-name-hint'"
        :aria-invalid="Boolean(nameError)"
        autocomplete="off"
        autofocus
        class="w-full b b-color-2 rounded-md b-solid bg-color-1 px-3 py-2 text-color-1 outline-none focus:b-primary-6"
        :disabled="disabled"
        type="text"
      >
      <p
        id="preset-name-hint"
        class="mb-0 mt-2 text-xs text-color-3"
      >
        {{ $t('pages.preference.presets.dialog.nameHint') }}
      </p>
      <p
        v-if="nameError"
        id="preset-name-error"
        class="mb-0 mt-2 text-sm text-red-6"
        role="alert"
      >
        {{ nameError }}
      </p>
    </form>
  </Modal>
</template>
