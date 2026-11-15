<script setup lang="ts">
import type { OptionTransitionAxis } from './animation'

import { animateOptionTransition, cancelOptionTransition } from './animation'

const props = withDefaults(defineProps<{ axis?: OptionTransitionAxis }>(), { axis: 'height' })

function enter(element: Element, done: () => void) {
  animateOptionTransition(element, true, done, props.axis)
}
function leave(element: Element, done: () => void) {
  animateOptionTransition(element, false, done, props.axis)
}
</script>

<template>
  <Transition
    :css="false"
    @enter="enter"
    @enter-cancelled="cancelOptionTransition"
    @leave="leave"
    @leave-cancelled="cancelOptionTransition"
  >
    <slot />
  </Transition>
</template>
