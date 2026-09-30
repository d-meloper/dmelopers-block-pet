<script setup lang="ts">
import { Button, Flex, Modal, Select, Switch } from 'ant-design-vue'
import { computed, inject, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ShadowQualitySelection } from '@/config/performance'

import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import PreferenceInfo from '@/components/preference-info/index.vue'
import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { BROADCAST_CONTROLLER } from '@/composables/useBroadcast'
import { MAX_FPS } from '@/config/performance'
import { useCatStore } from '@/stores/cat'
import { usePerformanceStore } from '@/stores/performance'

const catStore = useCatStore()
const performanceStore = usePerformanceStore()
const { t } = useI18n()
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})

function resetMeasurements() {
  if (!disposed) void performanceStore.reset()
}

function updatePerformanceToggle(
  key: 'antialiasEnabled' | 'pixelFilterEnabled' | 'idlePowerSavingEnabled',
  value: boolean,
) {
  if (disposed || catStore.model[key] === value) return
  catStore.model[key] = value
  resetMeasurements()
}

function updateShadowQuality(value: ShadowQualitySelection) {
  if (disposed || catStore.shadowQualitySelection === value) return
  catStore.shadowQualitySelection = value
  resetMeasurements()
}

const broadcastController = inject(BROADCAST_CONTROLLER, undefined)
const broadcastHint = computed(() => {
  const status = broadcastController?.status.value
  return status?.enabled && status.clients > 0
    ? t('pages.preference.performance.hints.broadcastUsage')
    : undefined
})

const metrics = computed(() => [
  {
    icon: 'i-solar:cpu-bolt-bold',
    label: t('pages.preference.performance.metrics.cpu'),
    value: formatValue(performanceStore.currentMetrics.cpuPercent, '%'),
    average: formatValue(performanceStore.averageMetrics.cpuPercent, '%'),
  },
  {
    icon: 'i-solar:display-bold',
    label: t('pages.preference.performance.metrics.gpu'),
    value: formatValue(performanceStore.currentMetrics.gpuPercent, '%'),
    average: formatValue(performanceStore.averageMetrics.gpuPercent, '%'),
  },
  {
    icon: 'i-solar:sd-card-bold',
    label: t('pages.preference.performance.metrics.ram'),
    value: formatMemory(performanceStore.currentMetrics.ramBytes),
    average: formatMemory(performanceStore.averageMetrics.ramBytes),
  },
])

const samplingHint = computed(() => {
  if (performanceStore.isWarmingUp) return t('pages.preference.performance.hints.warmup')
  const totalSeconds = performanceStore.elapsedSeconds
  const duration = t(
    totalSeconds < 60
      ? 'pages.preference.performance.hints.durationSeconds'
      : 'pages.preference.performance.hints.durationMinutesSeconds',
    { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 },
  )
  return `${t('pages.preference.performance.hints.sampling')} ${t('pages.preference.performance.hints.average', { duration })}`
})

function formatValue(value: number | undefined, suffix: string) {
  return value === undefined
    ? emptyMetricValue()
    : `${value.toFixed(1)}${suffix}`
}

function formatMemory(value: number | undefined) {
  return formatValue(value === undefined ? undefined : value / 1024 / 1024, ' MiB')
}

function emptyMetricValue() {
  return !performanceStore.hasSampled
    ? '---'
    : t('pages.preference.performance.status.unavailable')
}

function confirmPerformanceReset() {
  Modal.confirm({
    title: t('pages.preference.performance.confirm.reset'),
    okType: 'danger',
    onOk: () => {
      if (disposed) return
      catStore.resetPerformanceSettings()
      resetMeasurements()
    },
  })
}
</script>

<template>
  <PreferenceSections>
    <ProList :title="$t('pages.preference.performance.labels.metrics')">
      <template #title-extra>
        <Flex
          align="center"
          gap="small"
        >
          <span
            v-if="performanceStore.isWarmingUp"
            class="text-xs text-color-3"
            role="status"
          >{{ $t('pages.preference.performance.status.preparing') }}</span>
          <PreferenceInfo
            :emphasis-text="broadcastHint"
            :label="$t('pages.preference.performance.buttons.measurementInfo')"
            :text="samplingHint"
          />
        </Flex>
      </template>

      <div class="grid grid-cols-2 gap-3">
        <div
          v-for="metric in metrics"
          :key="metric.label"
          class="b b-color-2 rounded-lg b-solid bg-color-3 p-4 last:col-span-2"
        >
          <Flex
            align="center"
            class="mb-3 text-color-3"
            gap="small"
          >
            <div
              aria-hidden="true"
              class="size-5"
              :class="metric.icon"
            />
            <span class="text-xs font-medium">{{ metric.label }}</span>
          </Flex>
          <div class="text-xl font-semibold tabular-nums">
            {{ metric.value }}
            <span
              v-if="metric.average !== undefined"
              class="ml-1 whitespace-nowrap"
            >({{ metric.average }})</span>
          </div>
        </div>
      </div>
    </ProList>

    <ProList :title="$t('pages.preference.performance.labels.settings')">
      <ProListItem
        :description="$t('pages.preference.performance.hints.maxFPS')"
        :title="$t('pages.preference.performance.labels.maxFPS')"
        vertical
      >
        <DefaultSnapSlider
          v-model:value="catStore.model.maxFPS"
          class="m-[0]!"
          :default-value="60"
          display-mode="raw"
          :max="MAX_FPS"
          :min="20"
          :step="1"
          @after-change="resetMeasurements"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.performance.hints.shadowQuality')"
        :title="$t('pages.preference.performance.labels.shadowQuality')"
      >
        <Select
          :value="catStore.shadowQualitySelection"
          @update:value="updateShadowQuality"
        >
          <Select.Option value="high">
            {{ $t('pages.preference.performance.options.shadowQuality.high') }}
          </Select.Option>
          <Select.Option value="medium">
            {{ $t('pages.preference.performance.options.shadowQuality.medium') }}
          </Select.Option>
          <Select.Option value="low">
            {{ $t('pages.preference.performance.options.shadowQuality.low') }}
          </Select.Option>
          <Select.Option value="off">
            {{ $t('pages.preference.performance.options.shadowQuality.off') }}
          </Select.Option>
        </Select>
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.performance.hints.antialias')"
        :title="$t('pages.preference.performance.labels.antialias')"
      >
        <Switch
          :checked="catStore.model.antialiasEnabled"
          @update:checked="updatePerformanceToggle('antialiasEnabled', Boolean($event))"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.performance.hints.pixelFilter')"
        :title="$t('pages.preference.performance.labels.pixelFilter')"
      >
        <Switch
          :checked="catStore.model.pixelFilterEnabled"
          @update:checked="updatePerformanceToggle('pixelFilterEnabled', Boolean($event))"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.performance.hints.renderScale')"
        :title="$t('pages.preference.performance.labels.renderScale')"
        vertical
      >
        <DefaultSnapSlider
          v-model:value="catStore.model.renderScalePercent"
          class="m-[0]!"
          :default-value="100"
          display-mode="raw"
          :max="100"
          :min="50"
          :step="5"
          :tip-formatter="(value) => `${value}%`"
          @after-change="resetMeasurements"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.performance.hints.idlePowerSaving')"
        :title="$t('pages.preference.performance.labels.idlePowerSaving')"
      >
        <Switch
          :checked="catStore.model.idlePowerSavingEnabled"
          @update:checked="updatePerformanceToggle('idlePowerSavingEnabled', Boolean($event))"
        />
      </ProListItem>

      <Button
        block
        :danger="true"
        @click="confirmPerformanceReset"
      >
        {{ $t('pages.preference.performance.labels.reset') }}
      </Button>
    </ProList>
  </PreferenceSections>
</template>
