<script setup lang="ts">
import type { CSSProperties } from 'vue'

import { useEventListener, useResizeObserver } from '@vueuse/core'
import { Tooltip } from 'ant-design-vue'
import { nextTick, ref } from 'vue'

defineProps<{
  title?: string
  overlayInnerStyle?: CSSProperties
}>()

const anchor = ref<HTMLElement>()
const tooltip = ref<{ forcePopupAlign: () => void }>()
const maxWidth = ref(500)
const open = ref(false)
let alignmentPending = false

async function updateBounds() {
  if (!anchor.value) return
  const availableWidth = document.documentElement.clientWidth - anchor.value.getBoundingClientRect().left - 16
  maxWidth.value = Math.max(1, Math.min(500, availableWidth))
  if (!open.value || alignmentPending) return
  alignmentPending = true
  await nextTick()
  alignmentPending = false
  if (open.value) tooltip.value?.forcePopupAlign()
}

function updateOpenBounds() {
  if (open.value) void updateBounds()
}

function onOpenChange(value: boolean) {
  open.value = value
  if (value) void updateBounds()
}

// Ancestor resizing can move a fixed-size button during sidebar transitions.
useResizeObserver(() => {
  const elements: HTMLElement[] = []
  if (!open.value) return elements
  for (let element = anchor.value; element; element = element.parentElement ?? undefined) {
    elements.push(element)
  }
  return elements
}, updateOpenBounds)
useEventListener(window, 'resize', updateOpenBounds)
useEventListener(window, 'scroll', updateOpenBounds, { capture: true, passive: true })
</script>

<template>
  <span
    ref="anchor"
    class="inline-flex"
    @focusin="updateBounds"
    @mouseenter="updateBounds"
  >
    <Tooltip
      ref="tooltip"
      :auto-adjust-overflow="{ adjustX: 0, adjustY: 1 }"
      :overlay-inner-style="{ whiteSpace: 'pre-line', overflowWrap: 'anywhere', ...overlayInnerStyle }"
      :overlay-style="{ maxWidth: `${maxWidth}px` }"
      placement="bottomLeft"
      :trigger="['hover', 'focus']"
      @open-change="onOpenChange"
    >
      <template #title>
        <slot name="title">{{ title }}</slot>
      </template>
      <slot />
    </Tooltip>
  </span>
</template>
