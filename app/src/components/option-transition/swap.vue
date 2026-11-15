<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { animateOptionResize, cancelOptionTransition } from './animation'

const props = defineProps<{ value: string | number | boolean }>()
const root = ref<HTMLDivElement>()
let generation = 0
let active: HTMLElement | undefined
let targetHeight = 0
let resizing = false
const resizeObserver = typeof ResizeObserver === 'undefined'
  ? undefined
  : new ResizeObserver(() => {
      const element = root.value
      if (!resizing || !element || !active || active.inert || getComputedStyle(active).display === 'none') return
      const height = active.getBoundingClientRect().height
      if (Math.abs(height - targetHeight) < 0.5) return
      resize(element, element.getBoundingClientRect().height, height)
    })

function resize(element: HTMLElement, from: number, to: number) {
  targetHeight = to
  resizing = true
  animateOptionResize(element, from, to, () => {
    resizing = false
    resizeObserver?.disconnect()
  })
}

watch(() => props.value, async () => {
  const element = root.value
  if (!element) return
  const from = element.getBoundingClientRect().height
  const current = ++generation
  await nextTick()
  if (generation !== current || root.value !== element) return
  active = [...element.children].find((child): child is HTMLElement => child instanceof HTMLElement
    && !child.inert && getComputedStyle(child).display !== 'none')
  resizeObserver?.disconnect()
  if (active) resizeObserver?.observe(active, { box: 'border-box' })
  resize(element, from, active?.getBoundingClientRect().height ?? 0)
}, { flush: 'pre' })

onBeforeUnmount(() => {
  generation++
  resizeObserver?.disconnect()
  if (root.value) cancelOptionTransition(root.value)
})
</script>

<template>
  <div
    ref="root"
    class="option-swap"
  >
    <slot />
  </div>
</template>

<style scoped>
.option-swap {
  display: grid;
  min-width: 0;
}
.option-swap > :deep(*) {
  grid-area: 1 / 1;
  min-width: 0;
  align-self: start;
}
</style>
