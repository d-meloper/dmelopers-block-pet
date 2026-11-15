<script setup lang="ts">
import { Flex, theme } from 'ant-design-vue'
import { computed } from 'vue'

const props = withDefaults(defineProps<{ gap?: number | string }>(), { gap: 'middle' })
const { token } = theme.useToken()
const spacing = computed(() => {
  const sizes: Record<string, number> = { small: token.value.paddingXS, middle: token.value.padding, large: token.value.paddingLG }
  const gap = typeof props.gap === 'number' ? props.gap : sizes[props.gap] ?? props.gap
  return typeof gap === 'number' ? `${gap}px` : gap
})
</script>

<template>
  <div class="option-stack">
    <Flex
      class="option-stack-inner"
      :gap="0"
      :style="{ '--option-stack-gap': spacing }"
      vertical
    >
      <slot />
    </Flex>
  </div>
</template>

<style scoped>
/* The leading row stays mounted; following rows own their collapsible spacing. */
.option-stack {
  min-width: 0;
}
.option-stack-inner > :deep(* + *) {
  margin-block-start: var(--option-stack-gap);
}
</style>
