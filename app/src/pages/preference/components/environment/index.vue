<script setup lang="ts">
import { Button, Flex, Modal, Select, Switch, TabPane, Tabs } from 'ant-design-vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Pet3dPreset } from '@/stores/block'

import ColorPicker from '@/components/color-picker/index.vue'
import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import OptionTransition from '@/components/option-transition/index.vue'
import { vStableDetailHeight } from '@/components/preference-detail-tabs/height'
import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { DESK_DIMENSION_LIMITS } from '@/config/desk'
import presetRanges from '@/config/presetRanges.json'
import { markPresetUserEdit } from '@/features/presets/editIntent'
import { editorsLocked } from '@/features/stateSafety/bridge'
import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'

type ObjectTab = 'mouse' | 'keyboard' | 'desk'

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
const keyboardColorKeys = ['keyboardColor', 'keyboardPressedColor', 'keyboardKeycapColor', 'keyboardLegendColor'] as const
const mouseColorKeys = ['mouseColor', 'mousePressedColor'] as const
const deskDimensionKeys = ['deskHeightOffset', 'deskWidthOffset', 'deskDepthOffset'] as const
const blockStore = useBlockStore()
const activeObjectTab = ref<ObjectTab>('mouse')
const defaultPet3dPreset = createDefaultPet3dPreset()
const { t } = useI18n()
const activePet3dPreset = computed(() => blockStore.activePet3dPreset)
const mouseControlsDisabled = computed(() => !activePet3dPreset.value.mouseEnabled
  || !props.mouseReady || props.mousePending || editorsLocked.value)
const objectResetLabel = computed(() => t(`pages.preference.environment.labels.reset${activeObjectTab.value[0].toUpperCase()}${activeObjectTab.value.slice(1)}`))
const keyboardLanguage = computed({
  get: () => activePet3dPreset.value.keyboardLegendLanguage,
  set: (value: 'ko' | 'en') => {
    markPresetUserEdit()
    activePet3dPreset.value.keyboardLegendLanguage = value
  },
})
function applyColorSetting(key: DeviceColorKey, color: string) {
  if (editorsLocked.value) return
  if (key === 'deskColor' && activePet3dPreset.value.deskTransparent) return
  if ((key === 'mouseColor' || key === 'mousePressedColor') && mouseControlsDisabled.value) return
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
  if (editorsLocked.value) return
  if ((key === 'mouseBaseXOffset' || key === 'mouseBaseZOffset' || key === 'mouseScalePercent') && mouseControlsDisabled.value) return
  if (activePet3dPreset.value[key] === value) return
  markPresetUserEdit()
  Object.assign(activePet3dPreset.value, { [key]: value })
}

function updateDeskDimension(key: typeof deskDimensionKeys[number], value: number) {
  if (editorsLocked.value || (key !== 'deskHeightOffset' && activePet3dPreset.value.deskTransparent)) return
  updateViewportSetting(key, value)
}

function confirmObjectReset(object: ObjectTab) {
  if (editorsLocked.value) return
  Modal.confirm({
    title: t(`pages.preference.environment.confirm.reset${object[0].toUpperCase()}${object.slice(1)}`),
    okType: 'danger',
    onOk: async () => {
      if (editorsLocked.value) return
      if (object === 'mouse') {
        if (!await props.requestMouseEnabled(true)) throw new Error(t('pages.preference.environment.mouseErrors.unavailable'))
        blockStore.resetMouse3d()
      } else if (object === 'keyboard') {
        blockStore.resetKeyboard3d()
      } else {
        blockStore.resetDesk3d()
      }
    },
  })
}
</script>

<template>
  <PreferenceSections>
    <ProList :title="$t('pages.preference.environment.labels.objectSettings')">
      <Tabs
        v-model:active-key="activeObjectTab"
        v-stable-detail-height
        class="preference-detail-tabs"
      >
        <TabPane
          key="mouse"
          force-render
          :tab="$t('pages.preference.environment.detailTabs.mouse')"
        >
          <Flex
            gap="middle"
            vertical
          >
            <ProListItem
              :description="$t('pages.preference.environment.hints.mouseEnabled')"
              :title="$t('pages.preference.environment.labels.mouseEnabled')"
            >
              <Switch
                :aria-label="$t('pages.preference.environment.labels.mouseEnabled')"
                :checked="activePet3dPreset.mouseEnabled"
                :disabled="editorsLocked || !mouseReady || mousePending"
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

            <OptionTransition>
              <div
                v-show="activePet3dPreset.mouseEnabled"
                class="grid grid-cols-2 gap-4"
                data-detail-height-option
              >
                <ProListItem
                  v-for="key in mouseColorKeys"
                  :key="key"
                  :title="$t(`pages.preference.environment.labels.${key}`)"
                >
                  <ColorPicker
                    :disabled="mouseControlsDisabled"
                    :label="$t(`pages.preference.environment.labels.${key}`)"
                    :value="activePet3dPreset[key]"
                    @update:value="applyColorSetting(key, $event)"
                  />
                </ProListItem>
              </div>
            </OptionTransition>

            <OptionTransition>
              <div
                v-show="activePet3dPreset.mouseEnabled"
                class="grid grid-cols-3 gap-4"
                data-detail-height-option
              >
                <ProListItem
                  :title="$t('pages.preference.environment.labels.mouseX')"
                  vertical
                >
                  <DefaultSnapSlider
                    class="m-[0]!"
                    :default-value="defaultPet3dPreset.mouseBaseXOffset"
                    :disabled="mouseControlsDisabled"
                    :max="presetRanges.preset.mouseBaseXOffset.max"
                    :min="presetRanges.preset.mouseBaseXOffset.min"
                    :value="activePet3dPreset.mouseBaseXOffset"
                    @update:value="updateViewportSetting('mouseBaseXOffset', $event)"
                  />
                </ProListItem>
                <ProListItem
                  :title="$t('pages.preference.environment.labels.mouseZ')"
                  vertical
                >
                  <DefaultSnapSlider
                    class="m-[0]!"
                    :default-value="defaultPet3dPreset.mouseBaseZOffset"
                    :disabled="mouseControlsDisabled"
                    :max="presetRanges.preset.mouseBaseZOffset.max"
                    :min="presetRanges.preset.mouseBaseZOffset.min"
                    :value="activePet3dPreset.mouseBaseZOffset"
                    @update:value="updateViewportSetting('mouseBaseZOffset', $event)"
                  />
                </ProListItem>
                <ProListItem
                  :title="$t('pages.preference.environment.labels.mouseScale')"
                  vertical
                >
                  <DefaultSnapSlider
                    class="m-[0]!"
                    :default-value="defaultPet3dPreset.mouseScalePercent"
                    :disabled="mouseControlsDisabled"
                    :max="200"
                    :min="50"
                    :value="activePet3dPreset.mouseScalePercent"
                    @update:value="updateViewportSetting('mouseScalePercent', $event)"
                  />
                </ProListItem>
              </div>
            </OptionTransition>
          </Flex>
        </TabPane>
        <TabPane
          key="keyboard"
          force-render
          :tab="$t('pages.preference.environment.detailTabs.keyboard')"
        >
          <Flex
            gap="middle"
            vertical
          >
            <div class="grid grid-cols-2 gap-4">
              <ProListItem
                v-for="key in keyboardColorKeys"
                :key="key"
                :title="$t(`pages.preference.environment.labels.${key}`)"
              >
                <ColorPicker
                  :label="$t(`pages.preference.environment.labels.${key}`)"
                  :value="activePet3dPreset[key]"
                  @update:value="applyColorSetting(key, $event)"
                />
              </ProListItem>
            </div>

            <ProListItem
              :description="$t('pages.preference.environment.hints.keyboardLanguage')"
              :title="$t('pages.preference.environment.labels.keyboardLanguage')"
            >
              <Select
                v-model:value="keyboardLanguage"
              >
                <Select.Option value="ko">
                  {{ $t('pages.preference.environment.options.keyboardKorean') }}
                </Select.Option>
                <Select.Option value="en">
                  {{ $t('pages.preference.environment.options.keyboardEnglish') }}
                </Select.Option>
              </Select>
            </ProListItem>

            <div class="grid grid-cols-3 gap-4">
              <ProListItem
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
            </div>
          </Flex>
        </TabPane>
        <TabPane
          key="desk"
          force-render
          :tab="$t('pages.preference.environment.detailTabs.desk')"
        >
          <Flex
            gap="middle"
            vertical
          >
            <ProListItem
              :description="$t('pages.preference.environment.hints.deskTransparent')"
              :title="$t('pages.preference.environment.labels.deskTransparent')"
            >
              <Switch
                :checked="activePet3dPreset.deskTransparent"
                @update:checked="updateDeskTransparent"
              />
            </ProListItem>
            <OptionTransition>
              <ProListItem
                v-show="!activePet3dPreset.deskTransparent"
                data-detail-height-option
                :description="$t('pages.preference.environment.hints.deskColor')"
                :title="$t('pages.preference.environment.labels.deskColor')"
              >
                <ColorPicker
                  :disabled="editorsLocked || activePet3dPreset.deskTransparent"
                  :label="$t('pages.preference.environment.labels.deskColor')"
                  :value="activePet3dPreset.deskColor"
                  @update:value="applyColorSetting('deskColor', $event)"
                />
              </ProListItem>
            </OptionTransition>
            <div class="grid grid-cols-2 gap-4">
              <OptionTransition
                v-for="key in deskDimensionKeys"
                :key="key"
              >
                <ProListItem
                  v-show="key === 'deskHeightOffset' || !activePet3dPreset.deskTransparent"
                  :class="{ 'col-span-2': key === 'deskHeightOffset' }"
                  data-detail-height-option
                  :title="$t(`pages.preference.environment.labels.${key}`)"
                  vertical
                >
                  <DefaultSnapSlider
                    class="m-[0]!"
                    :default-value="defaultPet3dPreset[key]"
                    :disabled="editorsLocked || (key !== 'deskHeightOffset' && activePet3dPreset.deskTransparent)"
                    :display-mode="key === 'deskHeightOffset' ? 'raw' : 'centered'"
                    :max="DESK_DIMENSION_LIMITS.max"
                    :min="DESK_DIMENSION_LIMITS.min"
                    :step="DESK_DIMENSION_LIMITS.step"
                    :value="activePet3dPreset[key]"
                    @update:value="updateDeskDimension(key, $event)"
                  />
                </ProListItem>
              </OptionTransition>
            </div>
          </Flex>
        </TabPane>
      </Tabs>
      <Button
        block
        :disabled="editorsLocked"
        @click="confirmObjectReset(activeObjectTab)"
      >
        {{ objectResetLabel }}
      </Button>
    </ProList>
  </PreferenceSections>
</template>
