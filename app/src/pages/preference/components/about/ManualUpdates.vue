<script setup lang="ts">
import { openUrl } from '@tauri-apps/plugin-opener'
import { Button, Flex, message } from 'ant-design-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { usePreferenceUpdates } from '@/composables/usePreferenceUpdates'
import { reportDiagnostic } from '@/services/diagnostics'
import { openReleaseDownloads } from '@/services/manualUpdates'

const { t } = useI18n()
const { checking, manualInfo: versionInfo, failed } = usePreferenceUpdates()
const statusMessage = computed(() => {
  if (checking.value) return t('manualUpdates.checking')
  const status = failed.value ? 'unknown' : versionInfo.value?.status ?? 'unknown'
  return t(`manualUpdates.${status}`, { version: versionInfo.value?.latestVersion ?? '' })
})

async function openNotion() {
  try {
    await openUrl('https://app.notion.com/p/aismash/b872dc0bb4ae83d5b15681b53f73d0f9?source=copy_link')
  } catch (error) {
    reportDiagnostic('error', 'manual_updates.open_guide', error)
    message.error(t('manualUpdates.openFailed'))
  }
}

async function download() {
  try {
    await openReleaseDownloads()
  } catch (error) {
    reportDiagnostic('error', 'manual_updates.open_releases', error)
    message.error(t('manualUpdates.openFailed'))
  }
}
</script>

<template>
  <ProList :title="t('manualUpdates.title')">
    <ProListItem
      :description="t('manualUpdates.hint')"
      :title="t('manualUpdates.latest')"
    >
      <Flex
        :gap="8"
        wrap="wrap"
      >
        <Button @click="openNotion">
          {{ t('pages.preference.about.buttons.notion') }}
        </Button>
        <Button @click="download">
          {{ t('manualUpdates.download') }}
        </Button>
      </Flex>
    </ProListItem>
    <p
      aria-live="polite"
      class="manual-update-instructions"
      role="status"
    >
      {{ statusMessage }}
    </p>
  </ProList>
</template>

<style scoped>
.manual-update-instructions {
  padding: 0 16px 12px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
</style>
