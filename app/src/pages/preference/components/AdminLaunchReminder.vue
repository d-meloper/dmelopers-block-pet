<script setup lang="ts">
import { Button, Checkbox, Flex, Modal } from 'ant-design-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  open: boolean
  showDismiss?: boolean
  reminderDismissed?: boolean
  busy?: boolean
  action?: 'enable' | 'disable' | 'dismiss'
  phase?: 'saving' | 'preparing' | 'restarting' | 'disabling'
  feedback?: 'cancelled' | 'failed' | 'saveFailed' | 'identityMismatch' | 'disableFailed' | 'requiresNormalLaunch'
}>()
defineEmits<{
  enable: []
  reminderDismissedChange: [enabled: boolean]
  continue: []
  afterClose: []
}>()
const { t } = useI18n()
const statusMessage = computed(() => props.feedback ?? (props.phase === 'saving' ? undefined : props.phase))
</script>

<template>
  <Modal
    :after-close="() => $emit('afterClose')"
    centered
    :closable="false"
    :keyboard="!busy"
    :mask-closable="false"
    :open="open"
    :title="t('adminLaunchReminder.title')"
    :width="540"
    @cancel="!busy && $emit('continue')"
  >
    <p class="admin-launch-message">
      {{ t('adminLaunchReminder.message') }}
    </p>
    <p
      v-if="statusMessage"
      aria-live="polite"
      role="status"
    >
      {{ t(`adminLaunchReminder.${statusMessage}`) }}
    </p>
    <div
      v-if="showDismiss !== false"
      class="admin-launch-reminder-option"
    >
      <Checkbox
        :aria-label="t('adminLaunchReminder.neverShow')"
        :checked="reminderDismissed ?? false"
        :disabled="busy"
        @change="event => !busy && $emit('reminderDismissedChange', event.target.checked)"
      >
        {{ t('adminLaunchReminder.neverShow') }}
      </Checkbox>
    </div>
    <template #footer>
      <Flex
        :gap="8"
        justify="end"
        wrap="wrap"
      >
        <Button
          :disabled="busy"
          @click="$emit('continue')"
        >
          {{ t('adminLaunchReminder.continue') }}
        </Button>
        <Button
          :disabled="busy"
          :loading="busy && action === 'enable'"
          type="primary"
          @click="$emit('enable')"
        >
          {{ t('adminLaunchReminder.always') }}
        </Button>
      </Flex>
    </template>
  </Modal>
</template>

<style scoped>
.admin-launch-message {
  margin: 18px 0 24px;
  font-size: 15px;
  line-height: 1.7;
  white-space: pre-line;
}

.admin-launch-reminder-option {
  text-align: start;
}
</style>
