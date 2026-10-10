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
        class="text-lg text-color-1 font-semibold"
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
