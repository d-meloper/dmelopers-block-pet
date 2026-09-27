<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Button, Flex, Modal, Progress, Switch } from 'ant-design-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { updateEditorsLocked } from '@/features/updateRecovery'
import { cancelUpdate, checkForUpdates, startUpdate, updateBusy, updateErrorKey, updateProgress, updateStatus } from '@/services/updateDelivery'
import { useGeneralStore } from '@/stores/general'

const general = useGeneralStore()
const { t } = useI18n()
const description = computed(() => updateStatus.value.errorCode
  ? t(`updates.errors.${updateErrorKey({ code: updateStatus.value.errorCode })}`)
  : t(`updates.phases.${updateStatus.value.phase}`, { version: updateStatus.value.targetVersion ?? '', progress: updateProgress.value }))

async function run(action: () => Promise<unknown>) {
  try {
    await action()
  } catch (error) {
    // Install failures own a native modal that also survives app restarts.
    if (action === startUpdate && await invoke('get_update_failure').catch(() => null)) return
    Modal.error({ title: t('updates.failure.title'), content: t(`updates.errors.${updateErrorKey(error)}`) })
  }
}
</script>

<template>
  <ProList :title="t('updates.title')">
    <ProListItem
      :description="t('updates.automaticHint')"
      :title="t('updates.automatic')"
    >
      <Switch
        v-model:checked="general.app.autoUpdateCheck"
        :disabled="updateEditorsLocked"
      />
    </ProListItem>
    <ProListItem
      :description="description"
      :title="t('updates.stable')"
    >
      <Flex
        data-update-control
        :gap="8"
        wrap="wrap"
      >
        <Button
          :disabled="updateBusy"
          @click="run(checkForUpdates)"
        >
          {{ t('updates.check') }}
        </Button>
        <Button
          v-if="updateStatus.phase === 'available'"
          :disabled="updateEditorsLocked"
          type="primary"
          @click="run(startUpdate)"
        >
          {{ t('updates.install', { version: updateStatus.targetVersion }) }}
        </Button>
        <Button
          v-if="updateStatus.releaseUrl"
          @click="run(() => openUrl(updateStatus.releaseUrl!))"
        >
          {{ t('updates.notes') }}
        </Button>
        <Button
          v-if="updateStatus.canCancel"
          @click="run(cancelUpdate)"
        >
          {{ t('updates.cancel') }}
        </Button>
      </Flex>
    </ProListItem>
    <div
      v-if="['downloading', 'verifying', 'preparing'].includes(updateStatus.phase)"
      aria-live="polite"
      class="update-progress"
      role="status"
    >
      <Progress :percent="updateProgress" />
      <p>{{ t('updates.continues') }}</p>
    </div>
    <p
      v-if="updateStatus.phase === 'available'"
      class="update-progress"
    >
      {{ t('updates.installHint') }}
    </p>
  </ProList>
</template>

<style scoped>
.update-progress {
  padding: 0 16px 12px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
</style>
