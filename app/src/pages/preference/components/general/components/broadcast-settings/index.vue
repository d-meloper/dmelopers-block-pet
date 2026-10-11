<script setup lang="ts">
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useEventListener } from '@vueuse/core'
import { Button, Flex, Input, Switch, Tooltip } from 'ant-design-vue'
import { computed, inject, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import OptionTransition from '@/components/option-transition/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { BROADCAST_CONTROLLER } from '@/composables/useBroadcast'
import { reportDiagnostic } from '@/services/diagnostics'
import { useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'

const controller = inject(BROADCAST_CONTROLLER)
const block = useBlockStore()
const general = useGeneralStore()
const { t } = useI18n()
const desktopVisible = computed({
  get: () => general.broadcast.showOnDesktop,
  set: (visible: boolean) => {
    if (!general.broadcast.enabled) return
    general.broadcast.showOnDesktop = visible
    if (visible) block.window.visible = true
  },
})
const errorHint = computed(() => {
  const error = state.value?.error
  if (error === 'render_failed') return 'pages.preference.broadcast.renderErrorHint'
  if (error === 'port_in_use') return 'pages.preference.broadcast.portInUseHint'
  if (error === 'endpoint_conflict') return 'pages.preference.broadcast.endpointConflictHint'
  if (error === 'endpoint_invalid') return 'pages.preference.broadcast.endpointInvalidHint'
  if (error === 'endpoint_unavailable') return 'pages.preference.broadcast.endpointUnavailableHint'
  return 'pages.preference.broadcast.errorHint'
})
const copied = ref(false)
const copyError = ref(false)
const state = computed(() => controller?.status.value)
const addressRevealed = ref(false)
const displayedAddress = computed(() => {
  if (!state.value?.url) return ''
  return addressRevealed.value ? state.value.url : '••••••••••••••••'
})

function hideAddress() {
  addressRevealed.value = false
}

function revealAddressWhilePressed(event: PointerEvent) {
  if (!state.value?.url || !event.isPrimary || event.button !== 0) return
  const button = event.currentTarget as HTMLElement
  button.setPointerCapture(event.pointerId)
  addressRevealed.value = true
}

function revealAddressWithKeyboard(event: KeyboardEvent) {
  if (event.key !== ' ' && event.key !== 'Enter') return
  event.preventDefault()
  if (!event.repeat && state.value?.url) addressRevealed.value = true
}

function hideAddressWithKeyboard(event: KeyboardEvent) {
  if (event.key !== ' ' && event.key !== 'Enter') return
  event.preventDefault()
  hideAddress()
}

useEventListener(window, ['pointerup', 'pointercancel'], hideAddress, { capture: true })
useEventListener(window, 'blur', hideAddress)
useEventListener(document, 'visibilitychange', hideAddress)
watch([() => state.value?.url, () => general.broadcast.enabled], hideAddress)

const statusLabel = computed(() => {
  if (state.value?.error) return 'error'
  if (controller?.pending.value) return 'updating'
  if (!state.value?.enabled) return 'off'
  return state.value.clients > 0 ? 'connected' : 'waiting'
})

async function copyAddress() {
  if (!state.value?.url) return
  copied.value = false
  copyError.value = false
  try {
    await writeText(state.value.url)
    copied.value = true
  } catch (error) {
    reportDiagnostic('error', 'broadcast.copy_address', error)
    copyError.value = true
  }
}
</script>

<template>
  <ProList :title="t('pages.preference.broadcast.title')">
    <template #title-extra>
      <Flex
        align="center"
        gap="small"
      >
        <Tooltip
          :overlay-inner-style="{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }"
          :overlay-style="{ maxWidth: 'min(500px, calc(100vw - 32px))' }"
          placement="bottomLeft"
          :title="t('pages.preference.broadcast.setupInfo')"
          :trigger="['hover', 'focus']"
        >
          <Button
            :aria-label="t('pages.preference.broadcast.setupInfoLabel')"
            size="small"
          >
            {{ t('pages.preference.broadcast.setupButtonLabel') }}
          </Button>
        </Tooltip>
        <Tooltip
          :overlay-inner-style="{ overflowWrap: 'anywhere', lineHeight: '1.6' }"
          :overlay-style="{ maxWidth: 'min(500px, calc(100vw - 32px))' }"
          placement="bottomLeft"
          :trigger="['hover', 'focus']"
        >
          <template #title>
            <h4 class="m-0 mb-2 text-sm font-semibold">
              {{ t('pages.preference.broadcast.usageInfoQuestion') }}
            </h4>
            <p class="m-0">
              {{ t('pages.preference.broadcast.usageInfoAnswer') }}
            </p>
          </template>
          <Button
            :aria-label="t('pages.preference.broadcast.usageInfoLabel')"
            size="small"
          >
            FAQ
          </Button>
        </Tooltip>
      </Flex>
    </template>
    <div class="broadcast-panel">
      <ProListItem
        class="broadcast-row"
        :description="t('pages.preference.broadcast.enabledHint')"
        :title="t('pages.preference.broadcast.enabled')"
      >
        <Switch
          v-model:checked="general.broadcast.enabled"
          :aria-label="t('pages.preference.broadcast.enabled')"
        />
      </ProListItem>
      <OptionTransition>
        <ProListItem
          v-show="general.broadcast.enabled"
          class="broadcast-row"
          :description="t('pages.preference.broadcast.desktopVisibleHint')"
          :title="t('pages.preference.broadcast.desktopVisible')"
        >
          <Switch
            v-model:checked="desktopVisible"
            :aria-label="t('pages.preference.broadcast.desktopVisible')"
            :disabled="!general.broadcast.enabled"
          />
        </ProListItem>
      </OptionTransition>
      <ProListItem
        class="broadcast-row broadcast-connection"
        :description="t('pages.preference.broadcast.setupHint')"
        :title="t('pages.preference.broadcast.connection')"
        vertical
      >
        <Flex
          class="broadcast-address min-w-0"
          gap="small"
        >
          <Input
            :aria-label="t('pages.preference.broadcast.connection')"
            class="broadcast-address-input"
            :placeholder="t('pages.preference.broadcast.addressPlaceholder')"
            readonly
            :value="displayedAddress"
          >
            <template #suffix>
              <button
                :aria-label="t('pages.preference.broadcast.holdToShowAddress')"
                :aria-pressed="addressRevealed"
                class="broadcast-reveal"
                :disabled="!state?.url"
                :title="t('pages.preference.broadcast.holdToShowAddress')"
                type="button"
                @blur="hideAddress"
                @keydown="revealAddressWithKeyboard"
                @keyup="hideAddressWithKeyboard"
                @lostpointercapture="hideAddress"
                @mousedown.stop
                @pointerdown="revealAddressWhilePressed"
              >
                <span
                  aria-hidden="true"
                  class="size-4"
                  :class="addressRevealed ? 'i-lucide:eye' : 'i-lucide:eye-off'"
                />
              </button>
            </template>
          </Input>
          <Button
            class="broadcast-copy"
            :disabled="!state?.url"
            @click="copyAddress"
          >
            {{ t(copied ? 'pages.preference.broadcast.copied' : 'pages.preference.broadcast.copy') }}
          </Button>
        </Flex>
        <span
          v-if="copyError"
          class="text-xs text-red-5"
          role="alert"
        >{{ t('pages.preference.broadcast.copyError') }}</span>
      </ProListItem>
      <ProListItem
        class="broadcast-row"
        :description="t('pages.preference.broadcast.statusHint')"
        :title="t('pages.preference.broadcast.statusTitle')"
      >
        <Flex
          align="end"
          gap="small"
          vertical
        >
          <span
            class="broadcast-status text-sm"
            :class="{ 'text-red-5': !!state?.error }"
            role="status"
          >
            <span
              aria-hidden="true"
              class="broadcast-status-dot"
              :class="`broadcast-status-${statusLabel}`"
            />
            {{ t(`pages.preference.broadcast.status.${statusLabel}`, { count: state?.clients ?? 0 }) }}
          </span>
          <Button
            v-if="state?.error || state?.warning"
            :loading="controller?.pending.value"
            size="small"
            @click="controller?.retry()"
          >
            {{ t('pages.preference.broadcast.retry') }}
          </Button>
        </Flex>
      </ProListItem>
      <p
        v-if="state?.error"
        class="broadcast-notice m-0 text-xs text-red-5"
        role="alert"
      >
        {{ t(errorHint) }}
      </p>
      <p
        v-if="state?.warning"
        class="broadcast-notice m-0 text-xs text-amber-6"
        role="status"
      >
        {{ t('pages.preference.broadcast.endpointBackupHint') }}
      </p>
    </div>
  </ProList>
</template>

<style scoped>
.broadcast-panel {
  min-width: 0;
  padding: 2px 18px;
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: 16px;
  background: var(--ant-color-fill-quaternary);
}

.broadcast-row {
  min-width: 0;
  gap: 16px;
  padding: 16px 0;
  border: 0;
  border-bottom: 1px solid var(--ant-color-border-secondary);
  border-radius: 0;
  background: transparent;
}

.broadcast-row:last-of-type {
  border-bottom: 0;
}

.broadcast-row :deep(> .ant-flex),
.broadcast-row :deep(> .ant-flex > .ant-flex) {
  min-width: 0;
}

.broadcast-row :deep(.text-xs) {
  margin-top: 4px;
  line-height: 1.6;
  word-break: normal;
  overflow-wrap: anywhere;
}

.broadcast-row :deep(.ant-switch) {
  flex-shrink: 0;
}

.broadcast-connection {
  gap: 10px;
}

.broadcast-address {
  width: 100%;
}

.broadcast-address-input {
  min-width: 0;
  flex: 1;
}

.broadcast-address :deep(.ant-input) {
  min-width: 0;
  font-size: 12px;
}

.broadcast-copy {
  flex-shrink: 0;
}

.broadcast-reveal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ant-color-text-secondary);
  cursor: pointer;
  touch-action: none;
  user-select: none;
}

.broadcast-reveal:hover:not(:disabled) {
  color: var(--ant-color-text);
}

.broadcast-reveal:focus-visible {
  box-shadow: inset 0 0 0 2px var(--ant-color-primary);
}

.broadcast-reveal:disabled {
  color: var(--ant-color-text-disabled);
  cursor: not-allowed;
}

.broadcast-status {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  max-width: 220px;
  text-align: right;
  line-height: 1.5;
}

.broadcast-status-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--ant-color-text-quaternary);
}

.broadcast-status-connected {
  background: var(--ant-color-primary);
}

.broadcast-status-waiting,
.broadcast-status-updating {
  background: var(--ant-color-warning);
}

.broadcast-status-error {
  background: var(--ant-color-error);
}

.broadcast-notice {
  padding-bottom: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
