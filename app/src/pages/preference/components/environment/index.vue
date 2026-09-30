<script setup lang="ts">
import { Button, Modal, Select, Switch } from 'ant-design-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Pet3dPreset } from '@/stores/cat'

import ColorPicker from '@/components/color-picker/index.vue'
import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { DESK_HEIGHT_LIMITS } from '@/config/desk'
import presetRanges from '@/config/presetRanges.json'
import { markPresetUserEdit } from '@/features/presets/editIntent'
import { createDefaultPet3dPreset, useCatStore } from '@/stores/cat'

type PresetNumberKey = {
  [Key in keyof Pet3dPreset]: Pet3dPreset[Key] extends number ? Key : never
}[keyof Pet3dPreset]

type DeviceColorKey = typeof keyboardColorKeys[number] | typeof mouseColorKeys[number] | 'deskColor'

const props = defineProps<{
  mousePending: boolean
  mouseReady: boolean
  mouseError?: 'unsupported' | 'unavailable' | 'timeout'
  requestMouseEnabled: (enabled: boolean) => Promise<boolean>
  refreshMouseSetting: () => void
}>()
const keyboardColorKeys = ['keyboardColor', 'keyboardKeycapColor', 'keyboardLegendColor', 'keyboardPressedColor'] as const
const mouseColorKeys = ['mouseColor', 'mousePressedColor'] as const
const catStore = useCatStore()
const defaultPet3dPreset = createDefaultPet3dPreset()
const { t } = useI18n()
const activePet3dPreset = computed(() => catStore.activePet3dPreset)
const keyboardLanguage = computed({
  get: () => activePet3dPreset.value.keyboardLegendLanguage,
  set: (value: 'ko' | 'en') => {
    markPresetUserEdit()
    activePet3dPreset.value.keyboardLegendLanguage = value
  },
})
function applyColorSetting(key: DeviceColorKey, color: string) {
  if (key === 'deskColor' && activePet3dPreset.value.deskTransparent) return
  if ((key === 'mouseColor' || key === 'mousePressedColor') && !activePet3dPreset.value.mouseEnabled) return
  if (color === activePet3dPreset.value[key]) return
  markPresetUserEdit()
  activePet3dPreset.value[key] = color
}

function updateDeskTransparent(value: boolean) {
  if (value === activePet3dPreset.value.deskTransparent) return
  markPresetUserEdit()
  activePet3dPreset.value.deskTransparent = value
}

function updateViewportSetting(
  key: PresetNumberKey,
  value: number,
) {
  if (activePet3dPreset.value[key] === value) return
  markPresetUserEdit()
  Object.assign(activePet3dPreset.value, { [key]: value })
}

function confirmObjectReset(object: 'desk' | 'keyboard' | 'mouse') {
  Modal.confirm({
    title: t(`pages.preference.environment.confirm.reset${object[0].toUpperCase()}${object.slice(1)}`),
    okType: 'danger',
    onOk: async () => {
      if (object === 'mouse') {
        if (!await props.requestMouseEnabled(true)) throw new Error(t('pages.preference.environment.mouseErrors.unavailable'))
        catStore.resetMouse3d()
      } else if (object === 'keyboard') {
        catStore.resetKeyboard3d()
      } else {
        catStore.resetDesk3d()
      }
    },
  })
}
</script>

<template>
  <PreferenceSections>
    <ProList :title="$t('pages.preference.environment.labels.deskSettings')">
      <ProListItem
        :description="$t('pages.preference.environment.hints.deskTransparent')"
        :title="$t('pages.preference.environment.labels.deskTransparent')"
      >
        <Switch
          :checked="activePet3dPreset.deskTransparent"
          @update:checked="updateDeskTransparent"
        />
      </ProListItem>
      <ProListItem
        :description="$t('pages.preference.environment.hints.deskHeightOffset')"
        :title="$t('pages.preference.environment.labels.deskHeightOffset')"
        vertical
      >
        <DefaultSnapSlider
          class="m-[0]!"
          :default-value="defaultPet3dPreset.deskHeightOffset"
          :max="DESK_HEIGHT_LIMITS.max"
          :min="DESK_HEIGHT_LIMITS.min"
          :value="activePet3dPreset.deskHeightOffset"
          @update:value="updateViewportSetting('deskHeightOffset', $event)"
        />
      </ProListItem>
      <ProListItem
        :description="$t('pages.preference.environment.hints.deskColor')"
        :title="$t('pages.preference.environment.labels.deskColor')"
      >
        <ColorPicker
          :disabled="activePet3dPreset.deskTransparent"
          :label="$t('pages.preference.environment.labels.deskColor')"
          :value="activePet3dPreset.deskColor"
          @update:value="applyColorSetting('deskColor', $event)"
        />
      </ProListItem>
      <Button
        block
        :danger="true"
        @click="confirmObjectReset('desk')"
      >
        {{ $t('pages.preference.environment.labels.resetDesk') }}
      </Button>
    </ProList>

    <ProList :title="$t('pages.preference.environment.labels.keyboardSettings')">
      <ProListItem
        v-for="key in keyboardColorKeys"
        :key="key"
        :description="$t(`pages.preference.environment.hints.${key}`)"
        :title="$t(`pages.preference.environment.labels.${key}`)"
      >
        <ColorPicker
          :label="$t(`pages.preference.environment.labels.${key}`)"
          :value="activePet3dPreset[key]"
          @update:value="applyColorSetting(key, $event)"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.environment.hints.keyboardLanguage')"
        :title="$t('pages.preference.environment.labels.keyboardLanguage')"
      >
        <Select
          v-model:value="keyboardLanguage"
        >
          <Select.Option value="ko">
            한글
          </Select.Option>
          <Select.Option value="en">
            English
          </Select.Option>
        </Select>
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.environment.hints.keyboardX')"
        :title="$t('pages.preference.environment.labels.keyboardX')"
        vertical
      >
        <DefaultSnapSlider
          class="m-[0]!"
          :default-value="defaultPet3dPreset.keyboardBaseXOffset"
          :max="presetRanges.preset.keyboardBaseXOffset.max"
          :min="presetRanges.preset.keyboardBaseXOffset.min"
          :value="activePet3dPreset.keyboardBaseXOffset"
          @update:value="updateViewportSetting('keyboardBaseXOffset', $event)"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.environment.hints.keyboardZ')"
        :title="$t('pages.preference.environment.labels.keyboardZ')"
        vertical
      >
        <DefaultSnapSlider
          class="m-[0]!"
          :default-value="defaultPet3dPreset.keyboardBaseZOffset"
          :max="presetRanges.preset.keyboardBaseZOffset.max"
          :min="presetRanges.preset.keyboardBaseZOffset.min"
          :value="activePet3dPreset.keyboardBaseZOffset"
          @update:value="updateViewportSetting('keyboardBaseZOffset', $event)"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.environment.hints.keyboardScale')"
        :title="$t('pages.preference.environment.labels.keyboardScale')"
        vertical
      >
        <DefaultSnapSlider
          class="m-[0]!"
          :default-value="defaultPet3dPreset.keyboardScalePercent"
          :max="200"
          :min="50"
          :value="activePet3dPreset.keyboardScalePercent"
          @update:value="updateViewportSetting('keyboardScalePercent', $event)"
        />
      </ProListItem>
      <Button
        block
        :danger="true"
        @click="confirmObjectReset('keyboard')"
      >
        {{ $t('pages.preference.environment.labels.resetKeyboard') }}
      </Button>
    </ProList>

    <ProList :title="$t('pages.preference.environment.labels.mouseSettings')">
      <ProListItem
        :description="$t('pages.preference.environment.hints.mouseEnabled')"
        :title="$t('pages.preference.environment.labels.mouseEnabled')"
      >
        <Switch
          :aria-label="$t('pages.preference.environment.labels.mouseEnabled')"
          :checked="activePet3dPreset.mouseEnabled"
          :disabled="!mouseReady || mousePending"
          :loading="mousePending"
          @update:checked="requestMouseEnabled($event)"
        />
      </ProListItem>
      <div
        v-if="mouseError"
        role="alert"
      >
        {{ $t(`pages.preference.environment.mouseErrors.${mouseError}`) }}
        <Button
          :disabled="mousePending"
          size="small"
          @click="refreshMouseSetting"
        >
          {{ $t('pages.preference.environment.labels.refreshMouse') }}
        </Button>
      </div>

      <ProListItem
        v-for="key in mouseColorKeys"
        :key="key"
        :description="$t(`pages.preference.environment.hints.${key}`)"
        :title="$t(`pages.preference.environment.labels.${key}`)"
      >
        <ColorPicker
          :disabled="!activePet3dPreset.mouseEnabled"
          :label="$t(`pages.preference.environment.labels.${key}`)"
          :value="activePet3dPreset[key]"
          @update:value="applyColorSetting(key, $event)"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.environment.hints.mouseX')"
        :title="$t('pages.preference.environment.labels.mouseX')"
        vertical
      >
        <DefaultSnapSlider
          class="m-[0]!"
          :default-value="defaultPet3dPreset.mouseBaseXOffset"
          :max="presetRanges.preset.mouseBaseXOffset.max"
          :min="presetRanges.preset.mouseBaseXOffset.min"
          :value="activePet3dPreset.mouseBaseXOffset"
          @update:value="updateViewportSetting('mouseBaseXOffset', $event)"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.environment.hints.mouseZ')"
        :title="$t('pages.preference.environment.labels.mouseZ')"
        vertical
      >
        <DefaultSnapSlider
          class="m-[0]!"
          :default-value="defaultPet3dPreset.mouseBaseZOffset"
          :max="presetRanges.preset.mouseBaseZOffset.max"
          :min="presetRanges.preset.mouseBaseZOffset.min"
          :value="activePet3dPreset.mouseBaseZOffset"
          @update:value="updateViewportSetting('mouseBaseZOffset', $event)"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.environment.hints.mouseScale')"
        :title="$t('pages.preference.environment.labels.mouseScale')"
        vertical
      >
        <DefaultSnapSlider
          class="m-[0]!"
          :default-value="defaultPet3dPreset.mouseScalePercent"
          :max="200"
          :min="50"
          :value="activePet3dPreset.mouseScalePercent"
          @update:value="updateViewportSetting('mouseScalePercent', $event)"
        />
      </ProListItem>

      <Button
        block
        :danger="true"
        @click="confirmObjectReset('mouse')"
      >
        {{ $t('pages.preference.environment.labels.resetMouse') }}
      </Button>
    </ProList>
  </PreferenceSections>
</template>
