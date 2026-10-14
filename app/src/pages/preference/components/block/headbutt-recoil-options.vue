<script setup lang="ts">
import { Flex, Switch } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'

import type { HeadbuttRecoilSettings } from '@/config/headbuttRecoil'

import { toSliderDisplayValue } from '@/components/default-snap-slider/displayValue'
import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import OptionTransition from '@/components/option-transition/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import { DEFAULT_HEADBUTT_RECOIL_SETTINGS, HEADBUTT_RECOIL_LIMITS, normalizeHeadbuttRecoilSettings } from '@/config/headbuttRecoil'

const props = defineProps<{
  settings: Readonly<HeadbuttRecoilSettings>
  disabled: boolean
}>()
const emit = defineEmits<{
  'update:settings': [settings: HeadbuttRecoilSettings]
}>()
const controls = [
  { key: 'petHeadbuttRecoilStrengthPercent', label: 'petHeadbuttRecoilStrength' },
  { key: 'petHeadbuttRecoilWobblePercent', label: 'petHeadbuttRecoilWobble' },
] as const

const committedStrength = ref(props.settings.petHeadbuttRecoilStrengthPercent)
let pendingStrength: number | undefined
const showWobble = computed(() => toSliderDisplayValue(committedStrength.value, {
  ...HEADBUTT_RECOIL_LIMITS.petHeadbuttRecoilStrengthPercent,
  defaultValue: DEFAULT_HEADBUTT_RECOIL_SETTINGS.petHeadbuttRecoilStrengthPercent,
}) > -0.7)

watch([() => props.settings, () => props.settings.petHeadbuttRecoilStrengthPercent], ([settings, strength], [previousSettings]) => {
  // Our live gesture keeps the layout stable; resets/restores have no gesture.
  if (settings !== previousSettings || strength !== pendingStrength) committedStrength.value = strength
  pendingStrength = undefined
})

watch([() => props.disabled, () => props.settings.petHeadbuttRecoilEnabled], ([disabled, enabled]) => {
  if (!disabled && enabled) committedStrength.value = props.settings.petHeadbuttRecoilStrengthPercent
})

function updateEnabled(enabled: boolean) {
  if (props.disabled || enabled === props.settings.petHeadbuttRecoilEnabled) return
  emit('update:settings', { ...props.settings, petHeadbuttRecoilEnabled: enabled })
}

function updatePercent(key: typeof controls[number]['key'], value: number) {
  if (props.disabled || !props.settings.petHeadbuttRecoilEnabled) return
  if (key === 'petHeadbuttRecoilWobblePercent' && !showWobble.value) return
  const next = normalizeHeadbuttRecoilSettings({ [key]: value }, props.settings)
  if (next[key] !== props.settings[key]) {
    if (key === 'petHeadbuttRecoilStrengthPercent') pendingStrength = next[key]
    emit('update:settings', next)
  }
}

function finishAdjustment(key: typeof controls[number]['key']) {
  if (key !== 'petHeadbuttRecoilStrengthPercent' || props.disabled || !props.settings.petHeadbuttRecoilEnabled) return
  committedStrength.value = props.settings.petHeadbuttRecoilStrengthPercent
}
</script>

<template>
  <Flex
    class="b b-color-2 rounded-lg b-solid bg-color-3 p-4"
    :gap="32"
    vertical
  >
    <ProListItem
      class="headbutt-recoil-row"
      :description="$t('pages.preference.block.hints.petHeadbuttRecoilEnabled')"
      :title="$t('pages.preference.block.labels.petHeadbuttRecoilEnabled')"
    >
      <Switch
        :checked="settings.petHeadbuttRecoilEnabled"
        :disabled="disabled"
        @update:checked="updateEnabled"
      />
    </ProListItem>
    <OptionTransition>
      <Flex
        v-show="settings.petHeadbuttRecoilEnabled"
        data-detail-height-option
        :gap="32"
        vertical
      >
        <OptionTransition
          v-for="control in controls"
          :key="control.key"
        >
          <ProListItem
            v-show="control.key === 'petHeadbuttRecoilStrengthPercent' || showWobble"
            class="headbutt-recoil-row"
            data-detail-height-option
            :description="$t(`pages.preference.block.hints.${control.label}`)"
            :title="$t(`pages.preference.block.labels.${control.label}`)"
            vertical
          >
            <DefaultSnapSlider
              class="m-[0]!"
              :default-value="DEFAULT_HEADBUTT_RECOIL_SETTINGS[control.key]"
              :disabled="disabled || !settings.petHeadbuttRecoilEnabled || (control.key === 'petHeadbuttRecoilWobblePercent' && !showWobble)"
              display-mode="centered"
              :display-step="0.1"
              :max="HEADBUTT_RECOIL_LIMITS[control.key].max"
              :min="HEADBUTT_RECOIL_LIMITS[control.key].min"
              :value="settings[control.key]"
              @after-change="finishAdjustment(control.key)"
              @update:value="updatePercent(control.key, $event)"
            />
          </ProListItem>
        </OptionTransition>
      </Flex>
    </OptionTransition>
  </Flex>
</template>

<style scoped>
.headbutt-recoil-row {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
</style>
