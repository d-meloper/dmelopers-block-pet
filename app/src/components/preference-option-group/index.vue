<script setup lang="ts">
import { Flex } from 'ant-design-vue'

withDefaults(defineProps<{ grouped?: boolean }>(), { grouped: true })
</script>

<template>
  <Flex
    class="min-w-0"
    :class="grouped ? 'b b-color-2 rounded-lg b-solid bg-color-3 p-4' : undefined"
    :gap="grouped ? 32 : 0"
    vertical
  >
    <slot />
  </Flex>
</template>
