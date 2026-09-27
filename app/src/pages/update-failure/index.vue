<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getStoreState } from '@tauri-store/pinia'
import { Button, ConfigProvider, Modal } from 'ant-design-vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { UpdateFailure } from '@/features/updateRecovery/failure'

import { appDarkAlgorithm, appLightAlgorithm } from '@/config/theme'
import { failureReasonKey, observeUpdateFailure } from '@/features/updateRecovery/failure'

import 'ant-design-vue/dist/reset.css'

const { t, locale } = useI18n()
const failure = ref<UpdateFailure | null>(null)
const loading = ref(true)
const closing = ref(false)
const unavailable = ref(false)
const dark = ref(matchMedia('(prefers-color-scheme: dark)').matches)
let active = true
let stop: (() => void) | undefined
const reason = computed(() => t(`updates.failure.reasons.${failureReasonKey(failure.value?.reason ?? '')}`))
const code = computed(() => /^[A-Z_]+(?::[A-Z_]+)?$/.test(failure.value?.reason ?? '') ? failure.value?.reason : '')

onMounted(async () => {
  // Read the saved language without creating a settings writer in this window.
  void getStoreState('general').then((state) => {
    const appearance = state.appearance as { language?: string, theme?: string } | undefined
    const language = appearance?.language
    if (active && (language === 'ko-KR' || language === 'en-US')) locale.value = language
    if (active && ['light', 'dark'].includes(appearance?.theme ?? '')) dark.value = appearance?.theme === 'dark'
  }).catch(() => {
    if (active && navigator.language.startsWith('ko')) locale.value = 'ko-KR'
  })
  try {
    const unsubscribe = await observeUpdateFailure({
      listen: async accept => listen<UpdateFailure | null>('update-failure', ({ payload }) => accept(payload)),
      read: () => invoke<UpdateFailure | null>('get_update_failure'),
      accept: (value) => {
        failure.value = value
      },
      active: () => active,
    })
    if (active) stop = unsubscribe
    else unsubscribe()
  } catch {
    if (active) unavailable.value = true
  } finally {
    if (active) loading.value = false
  }
})
onUnmounted(() => {
  active = false
  stop?.()
})

async function dismiss() {
  const notificationId = failure.value?.notificationId
  if (!notificationId) return
  closing.value = true
  try {
    // Native code checks the ID and hides only the matching notification.
    await invoke('dismiss_update_failure', { notificationId })
  } catch {
    // A recovery result may replace this notification while the click travels.
    // Its new message stays visible and can be acknowledged separately.
  } finally {
    closing.value = false
  }
}
</script>

<template>
  <ConfigProvider :theme="{ algorithm: dark ? appDarkAlgorithm : appLightAlgorithm }">
    <Modal
      centered
      :closable="false"
      :footer="null"
      :get-container="false"
      :keyboard="false"
      :mask="false"
      open
      :title="t('updates.failure.title')"
      :width="480"
    >
      <div aria-live="polite">
        <p v-if="loading">
          {{ t('updates.failure.loading') }}
        </p>
        <template v-else-if="failure">
          <p>{{ reason }}</p>
          <p>{{ t(`updates.failure.outcomes.${failure.outcome}`) }}</p>
          <p
            v-if="code"
            class="failure-code"
          >
            {{ t('updates.failure.code', { code }) }}
          </p>
        </template>
        <p v-else-if="unavailable">
          {{ t('updates.failure.unavailable') }}
        </p>
      </div>
      <div class="failure-actions">
        <Button
          :disabled="!failure"
          :loading="closing"
          type="primary"
          @click="dismiss"
        >
          {{ t('updates.failure.close') }}
        </Button>
      </div>
    </Modal>
  </ConfigProvider>
</template>

<style scoped>
.failure-code {
  color: var(--color-text-secondary);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.failure-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
}
</style>
