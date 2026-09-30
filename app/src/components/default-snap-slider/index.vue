<script setup lang="ts">
import type { VNodeChild } from 'vue'

import { Slider } from 'ant-design-vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { SliderDisplayMode } from './displayValue'

import { formatSliderDisplayValue, fromSliderDisplayValue, sliderDisplayRange, toSliderDisplayValue } from './displayValue'
import { snapSliderValue } from './snapValue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  value: number
  defaultValue: number
  min?: number
  max?: number
  step?: number
  displayMode?: SliderDisplayMode
  disabled?: boolean
  tipFormatter?: ((value?: number) => VNodeChild) | null
}>(), {
  min: 0,
  max: 100,
  step: 1,
  displayMode: 'centered',
  disabled: false,
})

const emit = defineEmits<{
  'update:value': [value: number]
  'change': [value: number]
  'afterChange': [value: number]
}>()

const slider = ref<{ focus: () => void }>()
const { t } = useI18n()
const pointerInput = ref(false)
const displayRange = computed(() => sliderDisplayRange(props, props.displayMode))
const displayValue = computed(() => toSliderDisplayValue(props.value, props, props.displayMode))
const tipFormatter = computed(() => {
  if (props.tipFormatter === null) return null
  return (value?: number): VNodeChild => {
    const formatted = props.tipFormatter
      ? props.tipFormatter(value)
      : value === undefined ? '' : props.displayMode === 'raw' ? value.toString() : formatSliderDisplayValue(value)
    if (!pointerInput.value || props.disabled || value !== displayRange.value.defaultValue) return formatted
    const suffix = t('components.defaultSnapSlider.defaultSuffix')
    return typeof formatted === 'string' || typeof formatted === 'number'
      ? `${formatted}${suffix}`
      : [formatted, suffix]
  }
})

const endEvents = ['mouseup', 'touchend', 'touchcancel', 'pointercancel', 'blur'] as const
const adjustmentKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])
const heldKeys = new Set<string>()
let inputKind: 'pointer' | 'keyboard' | undefined
let latestValue = props.value
let inputChanged = false
let untrackedChanged = false

function clearInput() {
  inputKind = undefined
  pointerInput.value = false
  heldKeys.clear()
  if (typeof window !== 'undefined') {
    for (const event of endEvents) window.removeEventListener(event, finishInput)
    window.removeEventListener('keyup', finishKeyboardInput)
  }
}

function finishInput() {
  const changed = inputKind !== undefined && inputChanged
  clearInput()
  inputChanged = false
  untrackedChanged = false
  if (changed) emit('afterChange', latestValue)
}

watch(() => props.disabled, (disabled) => {
  if (disabled) finishInput()
})
onBeforeUnmount(clearInput)

function beginInput(kind: 'pointer' | 'keyboard') {
  if (inputKind === kind) return
  finishInput()
  inputKind = kind
  latestValue = props.value
  inputChanged = false
  pointerInput.value = kind === 'pointer'
  if (typeof window !== 'undefined') {
    if (kind === 'pointer') {
      // Bubble after Ant's document listeners, including releases outside us.
      for (const event of endEvents) window.addEventListener(event, finishInput)
    } else {
      window.addEventListener('keyup', finishKeyboardInput)
      window.addEventListener('blur', finishInput)
    }
  }
}

function startMouseInput(event: MouseEvent) {
  if (props.disabled || event.button !== 0) return
  // Ant ends dragging on handle blur. Focus before its track mousedown starts
  // dragging, then prevent the browser from blurring the handle afterward.
  event.preventDefault()
  slider.value?.focus()
  startPointerInput()
}

function startPointerInput() {
  if (props.disabled) return
  beginInput('pointer')
  // A handle click may not emit a change when its current value is already nearby.
  if (snapSliderValue(displayValue.value, displayRange.value) !== displayValue.value) updateValue(displayValue.value)
}

function startKeyboardInput(event: KeyboardEvent) {
  if (props.disabled || !adjustmentKeys.has(event.key)) return
  beginInput('keyboard')
  heldKeys.add(event.key)
}

function finishKeyboardInput(event: KeyboardEvent) {
  if (inputKind !== 'keyboard' || !adjustmentKeys.has(event.key)) return
  heldKeys.delete(event.key)
  if (heldKeys.size === 0) finishInput()
}

function updateValue(value: number | [number, number]) {
  if (props.disabled || typeof value !== 'number' || !Number.isFinite(value)) return
  const displayed = pointerInput.value ? snapSliderValue(value, displayRange.value) : value
  const nextValue = fromSliderDisplayValue(displayed, props, props.displayMode)
  if (inputKind) inputChanged ||= nextValue !== latestValue
  else untrackedChanged ||= nextValue !== props.value
  latestValue = nextValue
  emit('update:value', nextValue)
  emit('change', nextValue)
}

function finishSliderInput() {
  // Ant emits afterChange on every repeated keydown and can end on handle blur.
  // The wrapper owns gesture completion; preserve standalone accessible changes.
  if (inputKind || !untrackedChanged) return
  untrackedChanged = false
  emit('afterChange', latestValue)
}
</script>

<template>
  <!-- Capture on a DOM wrapper: Ant's slider does not forward native listeners. -->
  <div
    @focusout="finishInput"
    @keydown.capture="startKeyboardInput"
    @keyup.capture="finishKeyboardInput"
    @mousedown.capture="startMouseInput"
    @touchstart.capture="startPointerInput"
  >
    <Slider
      ref="slider"
      v-bind="$attrs"
      :disabled="disabled"
      :max="displayRange.max"
      :min="displayRange.min"
      :step="displayRange.step"
      :tip-formatter="tipFormatter"
      :value="displayValue"
      @after-change="finishSliderInput"
      @update:value="updateValue"
    />
  </div>
</template>
