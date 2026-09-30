<script setup lang="ts">
import { Button, Flex, message, Progress } from 'ant-design-vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import { usePreferenceUpdates } from '@/composables/usePreferenceUpdates'
import { APP_DISPLAY_NAME } from '@/constants/branding'
import { reportDiagnostic } from '@/services/diagnostics'
import { openStore } from '@/services/distribution'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const app = useAppStore()
const { channel, appInfo: info, checking, phase, percent, failed, busy, canCancel, cancelling, cancel, check, update: install } = usePreferenceUpdates()
const openingStore = ref(false)
const installAvailable = computed(() => (channel.value === 'github' || channel.value === 'test')
  && !failed.value && !!info.value?.available && !!info.value.version)
const actionDisabled = computed(() => busy.value || openingStore.value || channel.value === 'development')
const actionLabel = computed(() => t(channel.value === 'store'
  ? 'storeUpdates.open'
  : installAvailable.value ? 'inAppUpdates.install' : 'inAppUpdates.check'))
const status = computed(() => {
  if (channel.value === 'store') return t('storeUpdates.hint')
  if (channel.value === 'development') return ''
  if (phase.value) return t(`inAppUpdates.${phase.value}`)
  if (checking.value) return t('inAppUpdates.checking')
  if (failed.value || !info.value || (info.value.available && !info.value.version)) return t('inAppUpdates.unknown')
  return t(info.value.available ? 'inAppUpdates.available' : 'inAppUpdates.upToDate', { version: info.value.version })
})
const description = computed(() => [`v${app.version}`, status.value].filter(Boolean).join(' '))

async function runUpdateAction() {
  if (actionDisabled.value) return
  if (channel.value === 'store') {
    openingStore.value = true
    try {
      await openStore()
    } catch (error) {
      reportDiagnostic('warn', 'updates.open_store', error)
      message.error(t('storeUpdates.openFailed'))
    } finally {
      openingStore.value = false
    }
    return
  }
  if (installAvailable.value) await install()
  else await check(true)
}
</script>

<template>
  <ProListItem
    :description="description"
    :title="APP_DISPLAY_NAME"
  >
    <template #description>
      <span
        aria-live="polite"
        role="status"
      >{{ description }}</span>
      <Progress
        v-if="phase === 'downloading' || phase === 'verifying'"
        :percent="percent"
      />
    </template>
    <Flex
      :gap="8"
      wrap="wrap"
    >
      <Button
        :aria-label="actionLabel"
        class="update-action"
        :disabled="actionDisabled"
        :title="actionLabel"
        :type="installAvailable ? 'primary' : 'default'"
        @click="runUpdateAction"
      >
        <span
          aria-hidden="true"
          class="size-4"
          :class="{
            'i-lucide:download': installAvailable,
            'i-lucide:refresh-cw': !installAvailable,
            'animate-spin': checking || openingStore,
          }"
        />
      </Button>
      <Button
        v-if="canCancel"
        :loading="cancelling"
        @click="cancel"
      >
        {{ t('inAppUpdates.cancel') }}
      </Button>
    </Flex>
  </ProListItem>
</template>

<style scoped>
.update-action {
  display: inline-flex;
  width: 32px;
  align-items: center;
  justify-content: center;
  padding: 0;
}
</style>
