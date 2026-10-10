<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PresetManager } from '@/composables/usePresetManager'
import type { PresetExportMode } from '@/features/presets/transfer'
import type { PresetEntry } from '@/features/presets/types'

import OptionTransition from '@/components/option-transition/index.vue'
import { reportDiagnostic } from '@/services/diagnostics'
import { isMinecraftUsername } from '@/services/minecraftSkin'

const props = defineProps<{
  manager: PresetManager
  open: boolean
  entry?: PresetEntry
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const mode = ref<PresetExportMode>('image')
const submitting = ref(false)
const operationError = ref<string>()
const username = computed(() => {
  const value = props.entry?.snapshot.appearance.minecraftSkinUsername
  return value && isMinecraftUsername(value) ? value : undefined
})
const disabled = computed(() => submitting.value || props.manager.busy.value || !props.manager.ready.value || !props.entry)
const displayName = computed(() => props.entry?.name ?? '')

watch(() => [props.open, props.entry?.id], () => {
  if (!props.open) return
  mode.value = username.value ? 'nickname' : 'image'
  operationError.value = undefined
}, { immediate: true })

watch(mode, () => {
  operationError.value = undefined
})

function close() {
  if (!disabled.value) emit('close')
}

async function submit() {
  if (disabled.value || !props.entry || (mode.value === 'nickname' && !username.value)) return
  submitting.value = true
  operationError.value = undefined
  try {
    const result = await props.manager.exportPreset(props.entry.id, mode.value)
    if (result === 'saved') {
      message.success(t('pages.preference.presets.transfer.success.export'))
      emit('close')
    } else if (result === 'error') {
      operationError.value = props.manager.transferError.value ?? t('pages.preference.presets.transfer.errors.export')
    }
  } catch (error) {
    reportDiagnostic('error', 'presets.export_ui', error)
    operationError.value = t('pages.preference.presets.transfer.errors.export')
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
    :keyboard="!disabled"
    :mask-closable="false"
    :ok-button-props="{ disabled }"
    :ok-text="$t('pages.preference.presets.transfer.buttons.export')"
    :open="open"
    :title="$t('pages.preference.presets.transfer.dialog.title', { name: displayName })"
    @cancel="close"
    @ok="submit"
  >
    <fieldset
      class="m-0 flex flex-col gap-3 border-0 p-0"
      :disabled="disabled"
    >
      <legend class="mb-3 text-sm text-color-3">
        {{ $t('pages.preference.presets.transfer.dialog.skinMode') }}
      </legend>
      <label class="flex cursor-pointer items-start gap-2 b b-color-2 rounded-lg p-3">
        <input
          v-model="mode"
          :aria-describedby="mode === 'image' ? 'preset-export-image-hint' : undefined"
          aria-labelledby="preset-export-image-title"
          class="mt-1"
          name="preset-export-skin"
          type="radio"
          value="image"
        >
        <span>
          <span
            id="preset-export-image-title"
            class="block font-medium"
          >{{ $t('pages.preference.presets.transfer.dialog.image') }}</span>
          <OptionTransition>
            <span
              v-show="mode === 'image'"
              id="preset-export-image-hint"
              class="mt-1 block whitespace-pre-line text-sm text-color-3"
            >{{ $t('pages.preference.presets.transfer.dialog.imageHint') }}</span>
          </OptionTransition>
        </span>
      </label>
      <label
        class="flex items-start gap-2 b b-color-2 rounded-lg p-3"
        :class="username ? 'cursor-pointer' : 'cursor-default opacity-65'"
      >
        <input
          v-model="mode"
          :aria-describedby="!username ? 'preset-export-nickname-hint' : mode === 'nickname' ? 'preset-export-nickname-hint preset-export-username' : undefined"
          aria-labelledby="preset-export-nickname-title"
          class="mt-1"
          :disabled="!username"
          name="preset-export-skin"
          type="radio"
          value="nickname"
        >
        <span>
          <span
            id="preset-export-nickname-title"
            class="block font-medium"
          >{{ $t('pages.preference.presets.transfer.dialog.nickname') }}</span>
          <OptionTransition>
            <span
              v-show="mode === 'nickname' || !username"
              class="mt-1 block"
            >
              <span
                id="preset-export-nickname-hint"
                class="block whitespace-pre-line text-sm text-color-3"
              >{{ $t(username ? 'pages.preference.presets.transfer.dialog.nicknameHint' : 'pages.preference.presets.transfer.dialog.noNickname') }}</span>
              <span
                v-if="username"
                id="preset-export-username"
                class="mt-2 block text-sm"
              >{{ $t('pages.preference.presets.transfer.dialog.username') }}: <strong>{{ username }}</strong></span>
            </span>
          </OptionTransition>
        </span>
      </label>
      <label class="flex cursor-pointer items-start gap-2 b b-color-2 rounded-lg p-3">
        <input
          v-model="mode"
          :aria-describedby="mode === 'default' ? 'preset-export-default-hint' : undefined"
          aria-labelledby="preset-export-default-title"
          class="mt-1"
          name="preset-export-skin"
          type="radio"
          value="default"
        >
        <span>
          <span
            id="preset-export-default-title"
            class="block font-medium"
          >{{ $t('pages.preference.presets.transfer.dialog.default') }}</span>
          <OptionTransition>
            <span
              v-show="mode === 'default'"
              id="preset-export-default-hint"
              class="mt-1 block whitespace-pre-line text-sm text-color-3"
            >{{ $t('pages.preference.presets.transfer.dialog.defaultHint') }}</span>
          </OptionTransition>
        </span>
      </label>
    </fieldset>
    <p
      v-if="submitting"
      class="mb-0 text-sm text-color-3"
      role="status"
    >
      {{ $t('pages.preference.presets.transfer.phases.exporting') }}
    </p>
    <p
      v-if="operationError"
      class="mb-0 text-red-6"
      role="alert"
    >
      {{ operationError }}
    </p>
  </Modal>
</template>
