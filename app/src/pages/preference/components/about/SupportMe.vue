<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEventListener } from '@vueuse/core'
import { Button, message } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { DistributionChannel } from '@/services/distribution'

import { useAppLanguage } from '@/composables/useAppLanguage'
import externalLinks from '@/config/externalLinks.json'
import { reportDiagnostic } from '@/services/diagnostics'
import { getDistributionInfo } from '@/services/distribution'

const { t } = useI18n()
const { select } = useAppLanguage()
const owner = getCurrentWebviewWindow()
const channel = ref<DistributionChannel>()
const busy = ref(false)
const box = ref<HTMLElement>()
const isStore = computed(() => channel.value === 'store')
let disposed = false
let generation = 0
let unlistenClose: (() => void) | undefined

function invalidate() {
  generation += 1
}

useEventListener(document, 'visibilitychange', () => {
  if (document.hidden) invalidate()
})

onMounted(async () => {
  try {
    // A raw event listener leaves the persistent window's close policy with its owner.
    const release = await owner.listen('tauri://close-requested', invalidate)
    if (disposed) return release()
    unlistenClose = release
    const info = await getDistributionInfo()
    if (!disposed) channel.value = info.channel
  } catch (error) {
    if (!disposed) reportDiagnostic('warn', 'about.support_setup', error)
  }
})

onBeforeUnmount(() => {
  disposed = true
  invalidate()
  try {
    unlistenClose?.()
  } catch (error) {
    reportDiagnostic('warn', 'about.support_cleanup', error)
  }
})

async function support() {
  if (disposed || busy.value || !channel.value) return
  const request = ++generation
  const current = () => !disposed && generation === request
  const links = select(externalLinks.korean, externalLinks.global)
  const store = isStore.value
  const destination = store ? links.microsoftStore : links.encouragement
  busy.value = true
  try {
    if (store) {
      const result = await invoke<string>('request_store_review')
      if (!current() || result === 'succeeded' || result === 'cancelled') return
      // An unknown result or rejected IPC is not proof that the native dialog failed.
      if (result !== 'unavailable') throw new Error('STORE_REVIEW_UNCONFIRMED')
    }
    if (!current() || document.hidden || !box.value?.getClientRects().length) return
    if (!await owner.isVisible() || !current() || document.hidden) return
    if (current() && !document.hidden) await openUrl(destination)
  } catch (error) {
    if (current()) {
      reportDiagnostic('warn', 'about.support', error)
      message.error(t('pages.preference.about.encouragement.error'))
    }
  } finally {
    if (!disposed) busy.value = false
  }
}
</script>

<template>
  <div
    v-if="channel"
    ref="box"
    class="about-encouragement"
  >
    <Button
      class="about-contact-link"
      :disabled="busy"
      :loading="busy"
      type="text"
      @click="support"
    >
      {{ t('pages.preference.about.encouragement.button') }}
      <span
        aria-hidden="true"
        class="i-lucide:arrow-up-right size-4"
      />
    </Button>
    <p>{{ t(`pages.preference.about.encouragement.${isStore ? 'store' : 'github'}`) }}</p>
  </div>
</template>

<style scoped>
.about-encouragement {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 16px 18px;
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: 16px;
  background: var(--ant-color-fill-quaternary);
}
.about-encouragement p {
  min-width: 0;
  margin: 0;
  color: var(--ant-color-text-secondary);
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
</style>
