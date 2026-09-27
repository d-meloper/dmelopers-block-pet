<script setup lang="ts">
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { Button, Tooltip } from 'ant-design-vue'
import { nextTick, ref } from 'vue'

defineProps<{
  label: string
  text: string
  emphasisText?: string
}>()

const anchor = ref<HTMLElement>()
const tooltip = ref<{ forcePopupAlign: () => void }>()
const width = ref(500)
const open = ref(false)

async function updateBounds() {
  if (!anchor.value) return
  const availableWidth = document.documentElement.clientWidth - anchor.value.getBoundingClientRect().left - 16
  width.value = Math.max(1, Math.min(500, availableWidth))
  if (open.value) {
    await nextTick()
    tooltip.value?.forcePopupAlign()
  }
}

function onOpenChange(value: boolean) {
  open.value = value
  if (value) void updateBounds()
}

useResizeObserver(anchor, updateBounds)
useEventListener(window, 'resize', updateBounds)
useEventListener(window, 'scroll', updateBounds, { capture: true, passive: true })
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
      :overlay-inner-style="{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }"
      :overlay-style="{ width: `${width}px`, maxWidth: `${width}px` }"
      placement="bottomLeft"
      :trigger="['hover', 'focus']"
      @open-change="onOpenChange"
    >
      <template #title>
        {{ text }}
        <span
          v-if="emphasisText"
          class="mt-2 block text-primary-5 font-semibold dark:text-primary-8"
        >{{ emphasisText }}</span>
      </template>
      <Button
        :aria-label="label"
        shape="circle"
        size="small"
        type="text"
      >
        <template #icon>
          <div
            aria-hidden="true"
            class="i-solar:info-circle-bold size-5"
          />
        </template>
      </Button>
    </Tooltip>
  </span>
</template>
