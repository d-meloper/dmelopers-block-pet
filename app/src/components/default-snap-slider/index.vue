<script setup lang="ts">
import { Slider } from 'ant-design-vue'
import { ref } from 'vue'

import { snapSliderValue } from './snapValue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  value: number
  defaultValue: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
}>(), {
  min: 0,
  max: 100,
  step: 1,
  disabled: false,
})

const emit = defineEmits<{
  'update:value': [value: number]
  'change': [value: number]
  'afterChange': [value: number]
}>()

const slider = ref<{ focus: () => void }>()
let pointerInput = false

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
  pointerInput = true
  // A handle click may not emit a change when its current value is already nearby.
  if (snapSliderValue(props.value, props) !== props.value) updateValue(props.value)
}

function updateValue(value: number | [number, number]) {
  if (props.disabled || typeof value !== 'number') return
  const nextValue = pointerInput ? snapSliderValue(value, props) : value
  emit('update:value', nextValue)
  emit('change', nextValue)
}

function finishInput(value: number | [number, number]) {
  if (typeof value === 'number') {
    emit('afterChange', pointerInput ? snapSliderValue(value, props) : value)
  }
  pointerInput = false
}
</script>

<template>
  <!-- Capture on a DOM wrapper: Ant's slider does not forward native listeners. -->
  <div
    @keydown.capture="pointerInput = false"
    @mousedown.capture="startMouseInput"
    @touchstart.capture="startPointerInput"
  >
    <Slider
      ref="slider"
      v-bind="$attrs"
      :disabled="disabled"
      :max="max"
      :min="min"
      :step="step"
      :value="value"
      @after-change="finishInput"
      @update:value="updateValue"
    />
  </div>
</template>
