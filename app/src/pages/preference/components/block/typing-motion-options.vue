<script setup lang="ts">
import { Flex } from 'ant-design-vue'

import type { TypingMotionSettings } from '@/config/typingMotion'

import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import { DEFAULT_TYPING_MOTION_SETTINGS, normalizeTypingMotionSettings, TYPING_MOTION_LIMITS } from '@/config/typingMotion'

const props = defineProps<{
  settings: Readonly<TypingMotionSettings>
  disabled: boolean
}>()
const emit = defineEmits<{
  'update:settings': [settings: TypingMotionSettings]
}>()
const controls = [
  { key: 'petTypingMaxRadiusOffset', label: 'petTypingRadius' },
  { key: 'petTypingHandLiftPercent', label: 'petTypingHandLift' },
  { key: 'petTypingBodyMotionPercent', label: 'petTypingBodyMotion' },
  { key: 'petTypingReturnSpeedPercent', label: 'petTypingReturnSpeed' },
] as const

function updateSetting(key: keyof TypingMotionSettings, value: number) {
  if (props.disabled) return
  const next = normalizeTypingMotionSettings({ [key]: value }, props.settings)
  if (next[key] !== props.settings[key]) emit('update:settings', next)
}
</script>

<template>
  <Flex
    gap="middle"
    vertical
  >
    <ProListItem
      v-for="control in controls"
      :key="control.key"
      :description="$t(`pages.preference.block.hints.${control.label}`)"
      :title="$t(`pages.preference.block.labels.${control.label}`)"
      vertical
    >
      <DefaultSnapSlider
        class="m-[0]!"
        :default-value="DEFAULT_TYPING_MOTION_SETTINGS[control.key]"
        :disabled="disabled"
        display-mode="centered"
        :display-step="0.1"
        :max="TYPING_MOTION_LIMITS[control.key].max"
        :min="TYPING_MOTION_LIMITS[control.key].min"
        :value="settings[control.key]"
        @update:value="updateSetting(control.key, $event)"
      />
    </ProListItem>
  </Flex>
</template>
