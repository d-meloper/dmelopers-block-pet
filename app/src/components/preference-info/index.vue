<script setup lang="ts">
import { Button } from 'ant-design-vue'

import PreferenceTooltip from '@/components/preference-tooltip/index.vue'

defineProps<{
  label: string
  text: string
  emphasisText?: string
}>()
</script>

<template>
  <PreferenceTooltip>
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
  </PreferenceTooltip>
</template>
