<script setup lang="ts">
import OptionStack from '@/components/option-transition/stack.vue'

withDefaults(defineProps<{ grouped?: boolean }>(), { grouped: true })
</script>

<template>
  <OptionStack
    class="min-w-0"
    :class="grouped ? 'b b-color-2 rounded-lg b-solid bg-color-3 p-4' : undefined"
    :gap="grouped ? 32 : 0"
  >
    <slot />
  </OptionStack>
</template>
