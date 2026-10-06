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
const maxWidth = ref(500)
const open = ref(false)

async function updateBounds() {
  if (!anchor.value) return
  const availableWidth = document.documentElement.clientWidth - anchor.value.getBoundingClientRect().left - 16
  maxWidth.value = Math.max(1, Math.min(500, availableWidth))
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
      :overlay-style="{ maxWidth: `${maxWidth}px` }"
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
        :style="{ width: '19.2px', height: '19.2px', minWidth: '19.2px', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }"
        type="text"
      >
        <template #icon>
          <div
            aria-hidden="true"
            class="i-solar:info-circle-bold size-4"
          />
        </template>
      </Button>
    </Tooltip>
  </span>
</template>
