<script setup lang="ts">
import { Button, Flex, InputNumber, Modal } from 'ant-design-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ColorPicker from '@/components/color-picker/index.vue'
import { formatSliderDisplayValue, fromSliderDisplayValue, toSliderDisplayValue } from '@/components/default-snap-slider/displayValue'
import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { createDefaultLightingSettings, LIGHTING_LIMITS } from '@/config/lighting'
import { markPresetUserEdit } from '@/features/presets/editIntent'
import { useCatStore } from '@/stores/cat'

const store = useCatStore()
const { t } = useI18n()
const keyLight = computed(() => store.activePet3dPreset.lighting.key)
const defaults = createDefaultLightingSettings().key
const fields = ['strengthPercent', 'azimuthDegrees', 'elevationDegrees'] as const

function numberRange(key: typeof fields[number]) {
  return { ...LIGHTING_LIMITS[key], defaultValue: defaults[key] }
}

function updateColor(value: string) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return
  markPresetUserEdit()
  keyLight.value.color = value
}

function updateNumber(key: typeof fields[number], value: number | null) {
  if (value === null || !Number.isFinite(value)) return
  const { min, max } = LIGHTING_LIMITS[key]
  markPresetUserEdit()
  keyLight.value[key] = Math.min(max, Math.max(min, value))
}

function updateDisplayedNumber(key: typeof fields[number], value: number | string | null) {
  if (value === null || value === '') return
  const displayed = Number(value)
  if (Number.isFinite(displayed)) updateNumber(key, fromSliderDisplayValue(displayed, numberRange(key)))
}

function formatDisplayedNumber(value: number | string | undefined, info: { userTyping: boolean, input: string }) {
  // Preserve incomplete decimal input until editing finishes.
  if (info.userTyping) return info.input
  return value === undefined || value === '' ? '' : formatSliderDisplayValue(Number(value))
}

function reset() {
  Modal.confirm({ title: t('pages.preference.scene.lighting.confirmReset'), okType: 'danger', onOk: () => store.resetLighting() })
}
</script>

<template>
  <ProList :title="$t('pages.preference.scene.lighting.title')">
    <ProListItem
      :description="$t('pages.preference.scene.lighting.hints.color')"
      :title="$t('pages.preference.scene.lighting.labels.color')"
    >
      <ColorPicker
        :label="$t('pages.preference.scene.lighting.labels.color')"
        :value="keyLight.color"
        @update:value="updateColor"
      />
    </ProListItem>
    <ProListItem
      v-for="field in fields"
      :key="field"
      :description="$t(`pages.preference.scene.lighting.hints.${field}`)"
      :title="$t(`pages.preference.scene.lighting.labels.${field}`)"
      vertical
    >
      <Flex
        align="center"
        class="w-full"
        gap="middle"
      >
        <div class="min-w-0 flex-1">
          <DefaultSnapSlider
            :aria-label="$t(`pages.preference.scene.lighting.labels.${field}`)"
            class="m-0!"
            :default-value="defaults[field]"
            v-bind="LIGHTING_LIMITS[field]"
            :value="keyLight[field]"
            @update:value="updateNumber(field, $event)"
          />
        </div>
        <InputNumber
          :aria-label="$t(`pages.preference.scene.lighting.labels.${field}`)"
          class="w-28!"
          :formatter="formatDisplayedNumber"
          :max="1"
          :min="-1"
          :precision="2"
          :step="0.01"
          :value="toSliderDisplayValue(keyLight[field], numberRange(field))"
          @update:value="updateDisplayedNumber(field, $event)"
        />
      </Flex>
    </ProListItem>
    <Button
      block
      :danger="true"
      @click="reset"
    >
      {{ $t('pages.preference.scene.lighting.reset') }}
    </Button>
  </ProList>
</template>
