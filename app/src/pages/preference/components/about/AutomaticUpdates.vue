<script setup lang="ts">
import { Button, Flex, message, Progress } from 'ant-design-vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { usePreferenceUpdates } from '@/composables/usePreferenceUpdates'
import { APP_DISPLAY_NAME } from '@/constants/branding'
import { reportDiagnostic } from '@/services/diagnostics'
import { openStore } from '@/services/distribution'
import { useAppStore } from '@/stores/app'

import AppIdentity from './AppIdentity.vue'
import MicrosoftStoreIcon from './MicrosoftStoreIcon.vue'

const { t } = useI18n()
const app = useAppStore()
const { channel, appInfo: info, checking, phase, percent, failed, busy, canCancel, cancelling, cancel, check, update: install } = usePreferenceUpdates()
const openingStore = ref(false)
const installAvailable = computed(() => (channel.value === 'github' || channel.value === 'test')
  && !failed.value && !!info.value?.available && !!info.value.version)
const actionDisabled = computed(() => busy.value || openingStore.value || channel.value === 'development')
const actionSpinning = computed(() => busy.value || openingStore.value)
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
  <AppIdentity
    :description="description"
    :stack-actions="Boolean(phase)"
    :title="APP_DISPLAY_NAME"
  >
    <template #developer>
      <slot name="developer" />
    </template>
    <template #description>
      <span
        v-if="!phase"
        aria-live="polite"
        role="status"
      >{{ description }}</span>
      <div
        v-else
        aria-live="polite"
        class="update-progress-description"
        role="status"
      >
        <span>{{ `v${app.version}` }}</span>
        <span class="update-phase-text">{{ status }}</span>
      </div>
      <Progress
        v-if="phase === 'downloading' || phase === 'verifying'"
        class="update-progress-bar"
        :percent="percent"
      />
    </template>
    <Flex
      :gap="8"
      justify="center"
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
        <MicrosoftStoreIcon
          v-if="channel === 'store' && !actionSpinning"
          class="update-action-icon"
        />
        <span
          v-else
          aria-hidden="true"
          class="update-action-icon"
          :class="{
            'i-lucide:loader-circle': actionSpinning,
            'i-lucide:download': !actionSpinning && installAvailable,
            'i-lucide:refresh-cw': !actionSpinning && !installAvailable,
            'animate-spin': actionSpinning,
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
  </AppIdentity>
</template>

<style scoped>
.update-progress-description {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.update-phase-text {
  font-size: 14.4px;
}

.update-progress-bar {
  width: min(100%, 320px);
}

.update-action {
  display: inline-flex;
  width: 25.6px;
  height: 25.6px;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.update-action .update-action-icon {
  width: 12.8px;
  height: 12.8px;
}
</style>
