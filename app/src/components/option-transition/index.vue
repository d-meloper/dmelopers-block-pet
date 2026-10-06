<script setup lang="ts">
import { animateOptionTransition, cancelOptionTransition } from './animation'

function enter(element: Element, done: () => void) {
  animateOptionTransition(element, true, done)
}
function leave(element: Element, done: () => void) {
  animateOptionTransition(element, false, done)
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
