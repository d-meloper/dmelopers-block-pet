<script setup lang="ts">
import { Flex } from 'ant-design-vue'

const { title } = defineProps<{
  title?: string
}>()
</script>

<template>
  <Flex
    gap="small"
    vertical
  >
    <Flex
      v-if="title"
      align="center"
      gap="small"
    >
      <div
        class="text-4 font-medium"
        data-tauri-drag-region
      >
        {{ title }}
      </div>

      <Flex
        v-if="$slots['title-extra']"
        align="center"
      >
        <slot name="title-extra" />
      </Flex>
    </Flex>

    <Flex
      gap="middle"
      vertical
    >
      <slot />
    </Flex>
  </Flex>
</template>
