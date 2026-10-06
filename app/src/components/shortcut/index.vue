<script setup lang="ts">
import { find, map, remove, some, split } from 'es-toolkit/compat'
import { onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'

import type { Key } from '@/utils/keyboard'

import { beginShortcutRecording } from '@/composables/useKeyPress'
import { keys, modifierKeys, standardKeys } from '@/utils/keyboard'
import { shortcutIdentity } from '@/utils/shortcutIdentity'

const props = defineProps<{ reservedShortcuts?: string[], label?: string }>()
const modelValue = defineModel<string>()
const shortcutInputRef = useTemplateRef('shortcutInput')
const isFocusing = ref(false)
const pressedKeys = ref<Key[]>([])
const duplicateShortcut = ref(false)
let finishRecording: ((value?: string) => void) | undefined

function cancelRecording() {
  finishRecording?.()
  finishRecording = undefined
  isFocusing.value = false
  pressedKeys.value = []
  shortcutInputRef.value?.blur()
  parseModelValue()
}

onBeforeUnmount(cancelRecording)

watch(modelValue, () => {
  duplicateShortcut.value = false
  parseModelValue()
}, { immediate: true })

function parseModelValue() {
  if (!modelValue.value) {
    return pressedKeys.value = []
  }

  pressedKeys.value = split(modelValue.value, '+').map((tauriKey) => {
    return find(keys, { tauriKey })!
  })
}

function getEventKey(event: KeyboardEvent) {
  const { key, code } = event

  const eventKey = key.replace('Meta', 'Command')

  const isModifierKey = some(modifierKeys, { eventKey })

  return isModifierKey ? eventKey : code
}

function isValidShortcut() {
  if (pressedKeys.value?.[0]?.eventKey?.startsWith('F')) {
    return true
  }

  const hasModifierKey = some(pressedKeys.value, ({ eventKey }) => {
    return some(modifierKeys, { eventKey })
  })
  const hasStandardKey = some(pressedKeys.value, ({ eventKey }) => {
    return some(standardKeys, { eventKey })
  })

  return hasModifierKey && hasStandardKey
}

function handleFocus() {
  finishRecording?.()
  finishRecording = beginShortcutRecording(cancelRecording)
  isFocusing.value = true
  duplicateShortcut.value = false

  pressedKeys.value = []
}

function handleBlur() {
  isFocusing.value = false
  const value = isValidShortcut() ? map(pressedKeys.value, 'tauriKey').join('+') : undefined
  finishRecording?.(value)
  finishRecording = undefined

  if (!value) {
    return parseModelValue()
  }

  if (props.reservedShortcuts?.some(reserved => shortcutIdentity(reserved) === shortcutIdentity(value))) {
    parseModelValue()
    duplicateShortcut.value = true
    return
  }
  if (modelValue.value && shortcutIdentity(modelValue.value) === shortcutIdentity(value)) {
    parseModelValue()
    return
  }
  modelValue.value = value
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.code === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    duplicateShortcut.value = false
    cancelRecording()
    return
  }
  const eventKey = getEventKey(event)

  const matched = find(keys, { eventKey })
  const isInvalid = !matched
  const isDuplicate = some(pressedKeys.value, { eventKey })

  if (isInvalid || isDuplicate) return

  pressedKeys.value.push(matched)

  if (isValidShortcut()) {
    shortcutInputRef.value?.blur()
  }
}

function handleKeyUp(event: KeyboardEvent) {
  remove(pressedKeys.value, { eventKey: getEventKey(event) })
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div
      ref="shortcutInput"
      :aria-label="label"
      class="relative h-8 min-w-32 flex cursor-text items-center justify-center b b-color-1 rounded-md b-solid px-2.5 text-color-3 outline-none transition focus:(b-primary shadow-[0_0_0_2px_rgba(58,167,109,0.18)]) hover:b-primary-5"
      role="group"
      :tabindex="0"
      @blur="handleBlur"
      @focus="handleFocus"
      @keydown="handleKeyDown"
      @keyup="handleKeyUp"
    >
      <span v-if="pressedKeys.length === 0">
        {{ isFocusing ? $t('components.shortcut.hints.pressRecordShortcut') : $t('components.shortcut.hints.clickRecordShortcut') }}
      </span>

      <span class="text-primary font-bold">
        {{ map(pressedKeys, 'symbol').join(' ') }}
      </span>

      <button
        v-if="pressedKeys.length > 0"
        :aria-label="$t('components.shortcut.buttons.clear')"
        class="i-lucide:circle-x absolute right-2 cursor-pointer text-4 transition focus-visible:text-primary hover:text-primary"
        type="button"
        @click.stop="modelValue = ''"
        @keydown.stop
        @keyup.stop
        @mousedown.stop
      />
    </div>
    <span
      v-if="duplicateShortcut"
      class="max-w-56 text-xs text-red-6"
      role="alert"
    >{{ $t('components.shortcut.errors.duplicate') }}</span>
  </div>
</template>
