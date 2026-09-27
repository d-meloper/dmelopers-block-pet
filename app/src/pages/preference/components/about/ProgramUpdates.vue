<script setup lang="ts">
import { Button, message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { usePreferenceUpdates } from '@/composables/usePreferenceUpdates'
import { reportDiagnostic } from '@/services/diagnostics'
import { openStore } from '@/services/distribution'
import { useAppStore } from '@/stores/app'

import AutomaticUpdates from './AutomaticUpdates.vue'

const { channel } = usePreferenceUpdates()
const app = useAppStore()
const { t } = useI18n()
async function showStore() {
  try {
    await openStore()
  } catch (error) {
    reportDiagnostic('warn', 'updates.open_store', error)
    message.error(t('storeUpdates.openFailed'))
  }
}
</script>

<template>
  <AutomaticUpdates v-if="channel === 'github' || channel === 'test'" />
  <ProList
    v-else-if="channel === 'store'"
    :title="t('inAppUpdates.title')"
  >
    <ProListItem
      :description="t('storeUpdates.hint', { version: app.version })"
      :title="t('storeUpdates.title')"
    >
      <Button @click="showStore">
        {{ t('storeUpdates.open') }}
      </Button>
    </ProListItem>
  </ProList>
  <ProList
    v-else-if="channel === 'development'"
    :title="t('inAppUpdates.title')"
  >
    <ProListItem
      :description="t('storeUpdates.developmentHint')"
      :title="t('storeUpdates.development')"
    />
  </ProList>
</template>
