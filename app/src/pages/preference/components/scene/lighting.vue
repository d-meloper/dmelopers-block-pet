<script setup lang="ts">
import { Flex } from 'ant-design-vue'
import { computed } from 'vue'

import ColorPicker from '@/components/color-picker/index.vue'
import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import { createDefaultLightingSettings, LIGHTING_LIMITS } from '@/config/lighting'
import { markPresetUserEdit } from '@/features/presets/editIntent'
import { useBlockStore } from '@/stores/block'

const store = useBlockStore()
const keyLight = computed(() => store.activePet3dPreset.lighting.key)
const defaults = createDefaultLightingSettings().key
const fields = ['strengthPercent', 'azimuthDegrees', 'elevationDegrees'] as const

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
</script>

<template>
  <Flex
    gap="middle"
    vertical
  >
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
    <div class="grid grid-cols-3 gap-4">
      <ProListItem
        v-for="field in fields"
        :key="field"
        :title="$t(`pages.preference.scene.lighting.labels.${field}`)"
        vertical
      >
        <DefaultSnapSlider
          :aria-label="$t(`pages.preference.scene.lighting.labels.${field}`)"
          class="m-0!"
          :default-value="defaults[field]"
          v-bind="LIGHTING_LIMITS[field]"
          :value="keyLight[field]"
          @update:value="updateNumber(field, $event)"
        />
      </ProListItem>
    </div>
  </Flex>
</template>
