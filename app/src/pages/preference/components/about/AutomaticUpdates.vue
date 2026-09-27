<script setup lang="ts">
import { Button, Flex, message, Progress } from 'ant-design-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { usePreferenceUpdates } from '@/composables/usePreferenceUpdates'
import { reportDiagnostic } from '@/services/diagnostics'
import { openReleaseDownloads } from '@/services/manualUpdates'

const { t } = useI18n()
const { appInfo: info, checking, phase, percent, failed, busy, check, update: install } = usePreferenceUpdates()
const status = computed(() => {
  if (phase.value) return t(`inAppUpdates.${phase.value}`)
  if (checking.value) return t('inAppUpdates.checking')
  if (failed.value || !info.value) return t('inAppUpdates.unknown')
  return t(info.value.available ? 'inAppUpdates.available' : 'inAppUpdates.upToDate', { version: info.value.version })
})

async function openDownloads() {
  try {
    await openReleaseDownloads()
  } catch (error) {
    reportDiagnostic('error', 'updates.open_releases', error)
    message.error(t('manualUpdates.openFailed'))
  }
}
</script>

<template>
  <ProList :title="t('inAppUpdates.title')">
    <ProListItem
      :description="t('inAppUpdates.hint')"
      :title="t('inAppUpdates.latest')"
    >
      <Flex
        :gap="8"
        wrap="wrap"
      >
        <Button
          :disabled="busy"
          @click="check"
        >
          {{ t('inAppUpdates.check') }}
        </Button>
        <Button
          :disabled="busy || !info?.available"
          :loading="!!phase"
          type="primary"
          @click="install"
        >
          {{ t('inAppUpdates.install') }}
        </Button>
        <Button
          :disabled="busy"
          @click="openDownloads"
        >
          {{ t('inAppUpdates.releases') }}
        </Button>
      </Flex>
    </ProListItem>
    <div
      aria-live="polite"
      class="update-status"
      role="status"
    >
      {{ status }}
      <Progress
        v-if="phase === 'downloading'"
        :percent="percent"
      />
    </div>
  </ProList>
</template>

<style scoped>
.update-status {
  padding: 0 16px 12px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
</style>
