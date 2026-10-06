<script setup lang="ts">
import { Button, Flex, InputNumber, Modal, Switch, TabPane, Tabs } from 'ant-design-vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { SceneViewportState } from '@/features/scene/types'

import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import OptionTransition from '@/components/option-transition/index.vue'
import { vStableDetailHeight } from '@/components/preference-detail-tabs/height'
import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { AUTO_VIEWPORT_PADDING_LIMITS, normalizeAutoViewportPadding } from '@/features/scene/viewportSettings'
import { editorsLocked } from '@/features/stateSafety/bridge'
import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'

import LightingSettings from './lighting.vue'

type SceneTab = 'view' | 'viewport' | 'lighting'

const props = defineProps<{
  viewportState?: SceneViewportState
  viewportPending: boolean
  viewportError?: string
  requestViewportMode: (automatic: boolean) => Promise<boolean>
  refreshViewport: () => void
}>()

const resetKeys = {
  view: { label: 'pages.preference.scene.labels.resetView', confirm: 'pages.preference.scene.confirm.resetView' },
  viewport: { label: 'pages.preference.scene.labels.resetViewport', confirm: 'pages.preference.scene.confirm.resetViewport' },
  lighting: { label: 'pages.preference.scene.lighting.reset', confirm: 'pages.preference.scene.lighting.confirmReset' },
} as const

const blockStore = useBlockStore()
const { t } = useI18n()
const preset = computed(() => blockStore.activePet3dPreset)
const defaults = createDefaultPet3dPreset()
const activeSceneTab = ref<SceneTab>('view')
const sceneResetLabel = computed(() => t(resetKeys[activeSceneTab.value].label))
const sceneResetDisabled = computed(() => editorsLocked.value || (activeSceneTab.value === 'viewport' && props.viewportPending))
const automatic = computed(() => preset.value.autoViewportEnabled)
const manualDisabled = computed(() => automatic.value || props.viewportPending || !props.viewportState)
const automaticPaddingDisabled = computed(() => !automatic.value || props.viewportPending || !props.viewportState)
const dimensions = ['width', 'height'] as const
const automaticPaddingLimits = { ...AUTO_VIEWPORT_PADDING_LIMITS, max: 10 } as const

function formatPixels(value?: number) {
  return `${value}px`
}

function updateAutomaticPadding(value: number | string | null) {
  if (automaticPaddingDisabled.value || value === null || value === '') return
  const pixels = Number(value)
  if (Number.isFinite(pixels)) preset.value.autoViewportPaddingPixels = normalizeAutoViewportPadding(Math.min(automaticPaddingLimits.max, pixels))
}

function dimensionValue(dimension: 'width' | 'height') {
  const rect = automatic.value ? props.viewportState?.rect : preset.value.manualViewportRect
  return Math.round(rect?.[dimension] ?? defaults.manualViewportRect[dimension])
}

function dimensionMax(dimension: 'width' | 'height') {
  const monitorMax = Math.max(100, Math.floor(props.viewportState?.monitorSize[dimension] ?? 100))
  return automatic.value ? Math.max(monitorMax, dimensionValue(dimension)) : monitorMax
}

function updateDimension(dimension: 'width' | 'height', value: number | string | null) {
  if (manualDisabled.value || value === null || value === '') return
  const number = Number(value)
  if (!Number.isFinite(number)) return
  const next = Math.min(dimensionMax(dimension), Math.max(100, Math.round(number)))
  const rect = preset.value.manualViewportRect
  const axis = dimension === 'width' ? 'x' : 'y'
  preset.value.manualViewportRect = {
    ...rect,
    [axis]: rect[axis] + (rect[dimension] - next) / 2,
    [dimension]: next,
  }
}

function confirmSceneReset(scene: SceneTab) {
  if (editorsLocked.value || (scene === 'viewport' && props.viewportPending)) return
  Modal.confirm({
    title: t(resetKeys[scene].confirm),
    okType: 'danger',
    onOk: () => {
      if (editorsLocked.value || (scene === 'viewport' && props.viewportPending)) return
      if (scene === 'view') blockStore.resetSceneView3d()
      else if (scene === 'viewport') blockStore.resetSceneViewport3d()
      else blockStore.resetLighting()
    },
  })
}
</script>

<template>
  <PreferenceSections>
    <ProList :title="$t('pages.preference.scene.title')">
      <Tabs
        v-model:active-key="activeSceneTab"
        v-stable-detail-height
        class="preference-detail-tabs"
      >
        <TabPane
          key="view"
          force-render
          :tab="$t('pages.preference.scene.detailTabs.view')"
        >
          <Flex
            gap="middle"
            vertical
          >
            <div class="grid grid-cols-2 gap-4">
              <ProListItem
                :title="$t('pages.preference.scene.labels.zoom')"
                vertical
              >
                <DefaultSnapSlider
                  v-model:value="preset.cameraZoomPercent"
                  class="m-[0]!"
                  :default-value="defaults.cameraZoomPercent"
                  :max="200"
                  :min="25"
                />
              </ProListItem>

              <ProListItem
                :title="$t('pages.preference.scene.labels.rotation')"
                vertical
              >
                <DefaultSnapSlider
                  v-model:value="preset.sceneRotationOffsetDegrees"
                  class="m-[0]!"
                  :default-value="defaults.sceneRotationOffsetDegrees"
                  :max="360"
                  :min="-360"
                />
              </ProListItem>
            </div>

            <ProListItem
              :title="$t('pages.preference.scene.labels.opacity')"
              vertical
            >
              <DefaultSnapSlider
                v-model:value="blockStore.window.opacity"
                class="m-[0]!"
                :default-value="100"
                display-mode="unit"
                :max="100"
                :min="10"
              />
            </ProListItem>

            <ProListItem
              :description="$t('pages.preference.scene.hints.mirror')"
              :title="$t('pages.preference.scene.labels.mirror')"
            >
              <Switch v-model:checked="blockStore.model.mirror" />
            </ProListItem>
          </Flex>
        </TabPane>
        <TabPane
          key="viewport"
          force-render
          :tab="$t('pages.preference.scene.detailTabs.viewport')"
        >
          <Flex
            gap="middle"
            vertical
          >
            <ProListItem
              :description="$t('pages.preference.scene.hints.showDisplayArea')"
              :title="$t('pages.preference.scene.labels.showDisplayArea')"
            >
              <Switch
                v-model:checked="preset.showDisplayArea"
                :aria-label="$t('pages.preference.scene.labels.showDisplayArea')"
              />
            </ProListItem>

            <ProListItem
              :description="$t('pages.preference.scene.hints.automatic')"
              :title="$t('pages.preference.scene.labels.automatic')"
            >
              <Switch
                :aria-label="$t('pages.preference.scene.labels.automatic')"
                :checked="automatic"
                :disabled="viewportPending || !viewportState"
                :loading="viewportPending"
                @update:checked="requestViewportMode($event)"
              />
            </ProListItem>

            <OptionTransition>
              <ProListItem
                v-show="automatic"
                data-detail-height-option
                data-detail-height-variant="automatic"
                :description="$t('pages.preference.scene.hints.automaticPadding')"
                :title="$t('pages.preference.scene.labels.automaticPadding')"
                vertical
              >
                <Flex
                  align="center"
                  gap="middle"
                >
                  <div class="min-w-0 flex-1">
                    <DefaultSnapSlider
                      :aria-label="$t('pages.preference.scene.labels.automaticPadding')"
                      class="m-[0]!"
                      :default-value="defaults.autoViewportPaddingPixels"
                      :disabled="automaticPaddingDisabled"
                      display-mode="raw"
                      :max="automaticPaddingLimits.max"
                      :min="automaticPaddingLimits.min"
                      :step="1"
                      :tip-formatter="formatPixels"
                      :value="preset.autoViewportPaddingPixels"
                      @update:value="updateAutomaticPadding"
                    />
                  </div>
                  <InputNumber
                    :aria-label="$t('pages.preference.scene.labels.automaticPadding')"
                    class="w-28"
                    :disabled="automaticPaddingDisabled"
                    :max="automaticPaddingLimits.max"
                    :min="automaticPaddingLimits.min"
                    :precision="0"
                    :step="1"
                    :value="preset.autoViewportPaddingPixels"
                    @update:value="updateAutomaticPadding"
                  />
                </Flex>
              </ProListItem>
            </OptionTransition>

            <div
              v-if="viewportError"
              role="alert"
            >
              {{ viewportError }}
              <Button
                :disabled="viewportPending"
                size="small"
                @click="refreshViewport"
              >
                {{ $t('pages.preference.scene.labels.refreshViewport') }}
              </Button>
            </div>

            <OptionTransition>
              <Flex
                v-show="!automatic"
                data-detail-height-option
                data-detail-height-variant="manual"
                gap="middle"
                vertical
              >
                <ProListItem
                  :title="$t('pages.preference.scene.labels.viewport')"
                  vertical
                >
                  <div class="grid grid-cols-2 gap-4">
                    <Flex
                      v-for="dimension in dimensions"
                      :key="dimension"
                      class="min-w-0"
                      gap="middle"
                      vertical
                    >
                      <Flex
                        align="center"
                        gap="small"
                        justify="space-between"
                      >
                        <span class="text-sm font-medium">{{ $t(`pages.preference.scene.labels.${dimension}Short`) }}</span>
                        <InputNumber
                          :aria-label="$t(`pages.preference.scene.labels.${dimension}`)"
                          class="w-20"
                          :disabled="manualDisabled"
                          :max="dimensionMax(dimension)"
                          :min="100"
                          :precision="0"
                          :step="1"
                          :value="dimensionValue(dimension)"
                          @update:value="updateDimension(dimension, $event)"
                        />
                      </Flex>
                      <DefaultSnapSlider
                        :aria-label="$t(`pages.preference.scene.labels.${dimension}`)"
                        class="m-[0]!"
                        :default-value="Math.min(dimensionMax(dimension), defaults.manualViewportRect[dimension])"
                        :disabled="manualDisabled"
                        display-mode="raw"
                        :max="dimensionMax(dimension)"
                        :min="100"
                        :step="1"
                        :tip-formatter="formatPixels"
                        :value="dimensionValue(dimension)"
                        @update:value="updateDimension(dimension, $event)"
                      />
                    </Flex>
                  </div>
                </ProListItem>
                <div class="grid grid-cols-2 gap-4">
                  <ProListItem
                    :title="$t('pages.preference.scene.labels.cameraHorizontal')"
                    vertical
                  >
                    <DefaultSnapSlider
                      v-model:value="preset.cameraHorizontalOffset"
                      class="m-[0]!"
                      :default-value="defaults.cameraHorizontalOffset"
                      :disabled="manualDisabled"
                      :max="1.5"
                      :min="-1.5"
                    />
                  </ProListItem>
                  <ProListItem
                    :title="$t('pages.preference.scene.labels.cameraVertical')"
                    vertical
                  >
                    <DefaultSnapSlider
                      v-model:value="preset.cameraVerticalOffset"
                      class="m-[0]!"
                      :default-value="defaults.cameraVerticalOffset"
                      :disabled="manualDisabled"
                      :max="1.5"
                      :min="-1.5"
                    />
                  </ProListItem>
                </div>
              </Flex>
            </OptionTransition>
          </Flex>
        </TabPane>
        <TabPane
          key="lighting"
          force-render
          :tab="$t('pages.preference.scene.detailTabs.lighting')"
        >
          <LightingSettings />
        </TabPane>
      </Tabs>
      <Button
        block
        :disabled="sceneResetDisabled"
        @click="confirmSceneReset(activeSceneTab)"
      >
        {{ sceneResetLabel }}
      </Button>
    </ProList>
  </PreferenceSections>
</template>
