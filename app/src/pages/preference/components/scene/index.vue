<script setup lang="ts">
import { Button, Flex, InputNumber, Modal, Switch } from 'ant-design-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { SceneViewportState } from '@/features/scene/types'

import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { AUTO_VIEWPORT_PADDING_LIMITS, normalizeAutoViewportPadding } from '@/features/scene/viewportSettings'
import { createDefaultPet3dPreset, useCatStore } from '@/stores/cat'

const props = defineProps<{
  viewportState?: SceneViewportState
  viewportPending: boolean
  viewportError?: string
  requestViewportMode: (automatic: boolean) => Promise<boolean>
  refreshViewport: () => void
}>()
const catStore = useCatStore()
const { t } = useI18n()
const preset = computed(() => catStore.activePet3dPreset)
const defaults = createDefaultPet3dPreset()
const automatic = computed(() => preset.value.autoViewportEnabled)
const manualDisabled = computed(() => automatic.value || props.viewportPending || !props.viewportState)
const automaticPaddingDisabled = computed(() => !automatic.value || props.viewportPending || !props.viewportState)
const dimensions = ['width', 'height'] as const

function updateAutomaticPadding(value: number | string | null) {
  if (automaticPaddingDisabled.value || value === null || value === '') return
  const pixels = Number(value)
  if (Number.isFinite(pixels)) preset.value.autoViewportPaddingPixels = normalizeAutoViewportPadding(pixels)
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

function confirmSceneReset() {
  Modal.confirm({
    title: t('pages.preference.scene.confirm.reset'),
    okType: 'danger',
    onOk: () => catStore.resetScene3d(),
  })
}
</script>

<template>
  <PreferenceSections>
    <ProList>
      <ProListItem
        :description="$t('pages.preference.scene.hints.zoom')"
        :title="$t('pages.preference.scene.labels.zoom')"
        vertical
      >
        <DefaultSnapSlider
          v-model:value="preset.cameraZoomPercent"
          class="m-[0]!"
          :default-value="defaults.cameraZoomPercent"
          :max="200"
          :min="25"
          :step="1"
          :tip-formatter="(value) => `${value}%`"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.scene.hints.rotation')"
        :title="$t('pages.preference.scene.labels.rotation')"
        vertical
      >
        <DefaultSnapSlider
          v-model:value="preset.sceneRotationOffsetDegrees"
          class="m-[0]!"
          :default-value="defaults.sceneRotationOffsetDegrees"
          :max="360"
          :min="-360"
          :step="1"
          :tip-formatter="(value) => `${value}°`"
        />
      </ProListItem>

      <ProListItem
        :title="$t('pages.preference.scene.labels.opacity')"
        vertical
      >
        <DefaultSnapSlider
          v-model:value="catStore.window.opacity"
          class="m-[0]!"
          :default-value="100"
          :max="100"
          :min="10"
          :step="1"
          :tip-formatter="(value) => `${value}%`"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.scene.hints.mirror')"
        :title="$t('pages.preference.scene.labels.mirror')"
      >
        <Switch v-model:checked="catStore.model.mirror" />
      </ProListItem>
    </ProList>

    <ProList :title="$t('pages.preference.scene.labels.viewport')">
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

      <ProListItem
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
              :max="AUTO_VIEWPORT_PADDING_LIMITS.max"
              :min="AUTO_VIEWPORT_PADDING_LIMITS.min"
              :step="1"
              :tip-formatter="(value) => `${value}px`"
              :value="preset.autoViewportPaddingPixels"
              @update:value="updateAutomaticPadding"
            />
          </div>
          <InputNumber
            :aria-label="$t('pages.preference.scene.labels.automaticPadding')"
            class="w-28"
            :disabled="automaticPaddingDisabled"
            :max="AUTO_VIEWPORT_PADDING_LIMITS.max"
            :min="AUTO_VIEWPORT_PADDING_LIMITS.min"
            :precision="0"
            :step="1"
            :value="preset.autoViewportPaddingPixels"
            @update:value="updateAutomaticPadding"
          />
        </Flex>
      </ProListItem>

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

      <ProListItem
        v-for="dimension in dimensions"
        :key="dimension"
        :description="$t(`pages.preference.scene.hints.${dimension}`)"
        :title="$t(`pages.preference.scene.labels.${dimension}`)"
        vertical
      >
        <Flex
          align="center"
          gap="middle"
        >
          <div class="min-w-0 flex-1">
            <DefaultSnapSlider
              class="m-[0]!"
              :default-value="Math.min(dimensionMax(dimension), defaults.manualViewportRect[dimension])"
              :disabled="manualDisabled"
              :max="dimensionMax(dimension)"
              :min="100"
              :step="1"
              :tip-formatter="(value) => `${value}px`"
              :value="dimensionValue(dimension)"
              @update:value="updateDimension(dimension, $event)"
            />
          </div>
          <InputNumber
            :aria-label="$t(`pages.preference.scene.labels.${dimension}`)"
            class="w-28"
            :disabled="manualDisabled"
            :max="dimensionMax(dimension)"
            :min="100"
            :precision="0"
            :step="1"
            :value="dimensionValue(dimension)"
            @update:value="updateDimension(dimension, $event)"
          />
        </Flex>
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.scene.hints.cameraHorizontal')"
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
          :step="0.01"
          :tip-formatter="(value) => value?.toFixed(2)"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.scene.hints.cameraVertical')"
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
          :step="0.01"
          :tip-formatter="(value) => value?.toFixed(2)"
        />
      </ProListItem>

      <Button
        block
        :danger="true"
        @click="confirmSceneReset"
      >
        {{ $t('pages.preference.scene.labels.reset') }}
      </Button>
    </ProList>
  </PreferenceSections>
</template>
