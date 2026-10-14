<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { RecoveryReport } from '@/features/recovery/types'

const props = defineProps<{ report?: RecoveryReport }>()
const { t } = useI18n()
const outcome = computed(() => props.report?.status ?? 'running')
</script>

<template>
  <section
    v-if="report"
    :aria-busy="outcome === 'running'"
    aria-live="polite"
    class="recovery-feedback"
    :class="`recovery-feedback-${outcome}`"
    role="status"
  >
    <p class="recovery-title">
      {{ t(report.summaryKey ?? `recovery.status.${outcome}`) }}
    </p>
    <ul
      v-if="report.steps.length"
      class="recovery-steps"
    >
      <li
        v-for="(step, index) in report.steps"
        :key="`${index}:${step.key}`"
      >
        <span>{{ t(step.key) }}</span>
        <span class="recovery-step-state">{{ t(`recovery.step.${step.state}`) }}</span>
      </li>
    </ul>
    <template v-if="report.guidanceKeys?.length && outcome !== 'running'">
      <p class="recovery-guide-title">
        {{ t('recovery.nextSteps') }}
      </p>
      <ol class="recovery-guidance">
        <li
          v-for="key in report.guidanceKeys"
          :key="key"
        >
          {{ t(key) }}
        </li>
      </ol>
    </template>
    <slot name="actions" />
  </section>
</template>

<style scoped>
.recovery-feedback {
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: 10px;
  background: var(--ant-color-fill-quaternary);
  color: var(--ant-color-text-secondary);
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.recovery-title {
  margin: 0;
  color: var(--ant-color-text);
  font-weight: 600;
}

.recovery-feedback-unresolved .recovery-title,
.recovery-feedback-unknown .recovery-title {
  color: var(--ant-color-warning-text);
}

.recovery-feedback-recovered .recovery-title {
  color: var(--ant-color-success-text);
}

.recovery-steps,
.recovery-guidance {
  margin: 8px 0 0;
  padding-left: 18px;
}

.recovery-steps li {
  padding-right: 2px;
}

.recovery-step-state {
  margin-left: 8px;
  color: var(--ant-color-text-tertiary);
}

.recovery-guide-title {
  margin: 10px 0 0;
  color: var(--ant-color-text);
  font-weight: 600;
}
</style>
