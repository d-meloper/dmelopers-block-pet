<script setup lang="ts">
import { Button, Flex, Modal } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'

defineProps<{
  version?: string
  busy?: boolean
  status?: string
}>()
defineEmits<{
  snooze: []
  update: []
  close: []
}>()
const { t } = useI18n()
</script>

<template>
  <Modal
    centered
    :closable="false"
    :keyboard="!busy"
    :mask-closable="false"
    :open="!!version"
    :title="t('updateReminder.title')"
    :width="540"
    @cancel="$emit('close')"
  >
    <p class="update-reminder-message">
      {{ t('updateReminder.message', { version }) }}
    </p>
    <p
      v-if="status"
      aria-live="polite"
      role="status"
    >
      {{ status }}
    </p>
    <template #footer>
      <Flex
        class="update-reminder-actions"
        :gap="8"
        wrap="wrap"
      >
        <Button
          :disabled="busy"
          @click="$emit('snooze')"
        >
          {{ t('updateReminder.snooze') }}
        </Button>
        <Button
          :loading="busy"
          type="primary"
          @click="$emit('update')"
        >
          {{ t('updateReminder.update') }}
        </Button>
        <Button
          :disabled="busy"
          @click="$emit('close')"
        >
          {{ t('updateReminder.close') }}
        </Button>
      </Flex>
    </template>
  </Modal>
</template>

<style scoped>
.update-reminder-message {
  margin: 18px 0 24px;
  font-size: 15px;
  line-height: 1.7;
}

.update-reminder-actions {
  justify-content: flex-end;
}
</style>
