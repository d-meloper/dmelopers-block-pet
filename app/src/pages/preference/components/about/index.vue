<script setup lang="ts">
import { GithubFilled } from '@ant-design/icons-vue'
import { invoke } from '@tauri-apps/api/core'
import { appLogDir } from '@tauri-apps/api/path'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { openPath, openUrl } from '@tauri-apps/plugin-opener'
import { Button, Flex, message, Modal, Switch } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ProgramSettingsResetOptions } from '@/utils/programSettingsReset'

import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { useAppLanguage } from '@/composables/useAppLanguage'
import { useProgramSettingsReset } from '@/composables/useProgramSettingsReset'
import externalLinks from '@/config/externalLinks.json'
import { reportDiagnostic } from '@/services/diagnostics'
import { collectEnvironmentInfo } from '@/services/environmentInfo'
import { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS, ProgramSettingsResetError } from '@/utils/programSettingsReset'

import AutomaticUpdates from './AutomaticUpdates.vue'
import MicrosoftStoreIcon from './MicrosoftStoreIcon.vue'
import NotionIcon from './NotionIcon.vue'
import SupportMe from './SupportMe.vue'
import { createSupportRecovery } from './supportRecovery'

const copyingInfo = ref(false)
const logDir = ref('')
const legalNotices = ref('')
const legalOpen = ref(false)
const iconCreditsOpen = ref(false)
const legalLoading = ref(false)
const dataNotice = ref('')
const dataNoticeOpen = ref(false)
const dataNoticeLoading = ref(false)
const resetOpen = ref(false)
const resetting = ref(false)
const resetOptions = ref<ProgramSettingsResetOptions>({ ...DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS })
const submittedResetOptions = ref<ProgramSettingsResetOptions>()
const { t } = useI18n()
const { select } = useAppLanguage()
const developerEmail = 'dmeloper@gmail.com'
// Every localized destination follows the same effective application language.
const resourceLinks = computed(() => select(externalLinks.korean, externalLinks.global))
const { resetProgramSettings } = useProgramSettingsReset()
const supportRecovery = createSupportRecovery()
const { busy: supportBusy } = supportRecovery
let disposed = false
onBeforeUnmount(() => {
  disposed = true
  supportRecovery.dispose()
})

function runSupport(operation: string, errorKey: string, work: (current: () => boolean) => Promise<void>) {
  return supportRecovery.run(work, (error) => {
    reportDiagnostic('error', operation, error)
    message.error(t(`pages.preference.about.errors.${errorKey}`))
  })
}

onMounted(async () => {
  try {
    const directory = await appLogDir()
    if (!disposed) logDir.value = directory
  } catch (error) {
    if (!disposed) reportDiagnostic('warn', 'about.log_directory', error)
  }
})

async function openAboutLink(url: string) {
  await runSupport('about.open_link', 'openLink', async () => {
    await openUrl(url)
  })
}

async function openLogs() {
  await runSupport('about.open_logs', 'openLog', async (current) => {
    const directory = await invoke<string>('prepare_log_directory')
    if (!current()) return
    logDir.value = directory
    await openPath(directory)
  })
}

async function openDeveloperLink() {
  await runSupport('about.open_developer_link', 'openDeveloperLink', async () => {
    await openUrl(resourceLinks.value.developer)
  })
}

async function copyDeveloperEmail() {
  const copied = await runSupport('about.copy_email', 'copyEmail', async () => {
    await writeText(developerEmail)
  })
  if (copied && !disposed) message.success(t('pages.preference.about.hints.copySuccess'))
}

async function copyInfo() {
  if (disposed || copyingInfo.value || supportBusy.value) return
  copyingInfo.value = true
  try {
    const copied = await runSupport('about.copy_info', 'copyInfo', async (current) => {
      const info = await collectEnvironmentInfo()
      if (!current()) return
      await writeText(JSON.stringify(info, null, 2))
    })
    if (copied && !disposed) message.success(t('pages.preference.about.hints.copySuccess'))
  } finally {
    if (!disposed) copyingInfo.value = false
  }
}

async function showLegalNotices() {
  if (disposed || legalLoading.value || supportBusy.value) return
  legalLoading.value = true
  try {
    await runSupport('about.legal_notices', 'legalNotices', async (current) => {
      const content = legalNotices.value || (await import('@/legal/notices.txt?raw')).default
      if (!current()) return
      legalNotices.value = content
      legalOpen.value = true
    })
  } finally {
    if (!disposed) legalLoading.value = false
  }
}

async function showDataNotice() {
  if (disposed || dataNoticeLoading.value || supportBusy.value) return
  dataNoticeLoading.value = true
  try {
    await runSupport('about.data_notice', 'legalNotices', async (current) => {
      const load = select(
        () => import('@/legal/data-permissions.ko-KR.txt?raw'),
        () => import('@/legal/data-permissions.en-US.txt?raw'),
      )
      const content = (await load()).default
      if (!current()) return
      dataNotice.value = content
      dataNoticeOpen.value = true
    })
  } finally {
    if (!disposed) dataNoticeLoading.value = false
  }
}

function confirmProgramReset() {
  if (resetting.value || resetOpen.value) return
  resetOptions.value = { ...DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS }
  submittedResetOptions.value = undefined
  resetOpen.value = true
}

function cancelProgramReset() {
  if (resetting.value) return
  resetOpen.value = false
  submittedResetOptions.value = undefined
}

async function submitProgramReset() {
  if (!resetOpen.value || resetting.value) return
  submittedResetOptions.value ??= { ...resetOptions.value }
  resetting.value = true
  try {
    await resetProgramSettings({ ...submittedResetOptions.value })
    resetOpen.value = false
    submittedResetOptions.value = undefined
  } catch (error) {
    reportDiagnostic('error', 'settings.reset_all', error)
    const key = error instanceof ProgramSettingsResetError
      ? { blocked: 'resetAutostartBlocked', preflight: 'resetPreflight', partial: 'resetPartial' }[error.outcome]
      : 'resetAll'
    message.error(t(`pages.preference.about.errors.${key}`))
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <PreferenceSections>
    <ProList>
      <AutomaticUpdates>
        <template #developer>
          <Button
            class="about-developer"
            :disabled="supportBusy"
            :title="$t('pages.preference.about.labels.developer')"
            type="text"
            @click="openDeveloperLink"
          >
            {{ $t('pages.preference.about.labels.developerName') }}
            <span
              aria-hidden="true"
              class="locale-navigation-icon i-lucide:arrow-up-right size-3"
            />
          </Button>
        </template>
      </AutomaticUpdates>

      <div class="about-resource-grid">
        <div
          :aria-label="$t('pages.preference.about.labels.introduction')"
          class="about-resource-group"
          role="group"
        >
          <h2 class="text-lg text-color-1 font-semibold">
            {{ $t('pages.preference.about.labels.introduction') }}
          </h2>
          <div class="about-resource-actions">
            <Button
              :aria-label="$t('pages.preference.about.buttons.notion')"
              class="about-brand-action"
              :disabled="supportBusy"
              :title="$t('pages.preference.about.buttons.notion')"
              type="text"
              @click="openAboutLink(resourceLinks.introduction)"
            >
              <NotionIcon />
            </Button>
            <Button
              :aria-label="$t('pages.preference.about.buttons.github')"
              class="about-brand-action"
              :disabled="supportBusy"
              :title="$t('pages.preference.about.buttons.github')"
              type="text"
              @click="openAboutLink('https://github.com/d-meloper/dmelopers-block-pet')"
            >
              <GithubFilled
                aria-hidden="true"
                class="about-github-icon"
              />
            </Button>
            <Button
              :aria-label="$t('pages.preference.about.buttons.microsoftStore')"
              class="about-brand-action"
              :disabled="supportBusy"
              :title="$t('pages.preference.about.buttons.microsoftStore')"
              type="text"
              @click="openAboutLink(resourceLinks.microsoftStore)"
            >
              <MicrosoftStoreIcon />
            </Button>
          </div>
        </div>
        <div
          :aria-label="$t('pages.preference.about.labels.releaseNotes')"
          class="about-resource-group"
          role="group"
        >
          <h2 class="text-lg text-color-1 font-semibold">
            {{ $t('pages.preference.about.labels.releaseNotes') }}
          </h2>
          <div class="about-resource-actions">
            <Button
              :aria-label="$t('pages.preference.about.buttons.notion')"
              class="about-brand-action"
              :disabled="supportBusy"
              :title="$t('pages.preference.about.buttons.notion')"
              type="text"
              @click="openAboutLink(resourceLinks.releaseNotes)"
            >
              <NotionIcon />
            </Button>
            <Button
              :aria-label="$t('pages.preference.about.buttons.github')"
              class="about-brand-action"
              :disabled="supportBusy"
              :title="$t('pages.preference.about.buttons.github')"
              type="text"
              @click="openAboutLink('https://github.com/d-meloper/dmelopers-block-pet/releases')"
            >
              <GithubFilled
                aria-hidden="true"
                class="about-github-icon"
              />
            </Button>
            <Button
              :aria-label="$t('pages.preference.about.buttons.microsoftStore')"
              class="about-brand-action"
              :disabled="supportBusy"
              :title="$t('pages.preference.about.buttons.microsoftStore')"
              type="text"
              @click="openAboutLink(resourceLinks.microsoftStore)"
            >
              <MicrosoftStoreIcon />
            </Button>
          </div>
        </div>
      </div>
      <div class="about-policy-links">
        <Button
          class="about-policy-action"
          :disabled="supportBusy"
          :loading="legalLoading"
          :title="$t('pages.preference.about.hints.legalNotices')"
          type="text"
          @click="showLegalNotices"
        >
          {{ $t('pages.preference.about.labels.legalNotices') }}
        </Button>
        <Button
          class="about-policy-action"
          :disabled="supportBusy"
          :loading="dataNoticeLoading"
          :title="$t('pages.preference.about.hints.dataNotice')"
          type="text"
          @click="showDataNotice"
        >
          {{ $t('pages.preference.about.labels.dataNotice') }}
        </Button>
        <Button
          :aria-label="$t('pages.preference.about.labels.iconCredits')"
          class="about-policy-action"
          type="text"
          @click="iconCreditsOpen = true"
        >
          {{ $t('pages.preference.about.labels.iconCredits') }}
        </Button>
      </div>
    </ProList>

    <ProList :title="$t('pages.preference.about.labels.troubleshootingSupport')">
      <Flex
        class="about-support-content"
        gap="middle"
        vertical
      >
        <SupportMe />
        <div class="about-support-grid">
          <ProListItem
            class="about-support-item"
            :title="$t('pages.preference.about.labels.contactUs')"
          >
            <template #title>
              <Button
                class="about-contact-link"
                :disabled="supportBusy"
                type="text"
                @click="openAboutLink(resourceLinks.support)"
              >
                {{ $t('pages.preference.about.labels.contactUs') }}
                <span
                  aria-hidden="true"
                  class="locale-navigation-icon i-lucide:arrow-up-right size-4"
                />
              </Button>
            </template>
          </ProListItem>
          <ProListItem
            class="about-support-item"
            :title="$t('pages.preference.about.labels.developerEmail')"
          >
            <template #description>
              <bdi dir="ltr">{{ developerEmail }}</bdi>
            </template>
            <Button
              class="about-support-action"
              :disabled="supportBusy"
              type="text"
              @click="copyDeveloperEmail"
            >
              <span
                aria-hidden="true"
                class="i-lucide:copy size-4"
              />
              {{ $t('pages.preference.about.buttons.copy') }}
            </Button>
          </ProListItem>
          <ProListItem
            class="about-support-item"
            :description="$t('pages.preference.about.hints.appInfo')"
            :title="$t('pages.preference.about.labels.appInfo')"
          >
            <Button
              class="about-support-action"
              :disabled="supportBusy"
              :loading="copyingInfo"
              type="text"
              @click="copyInfo"
            >
              <span
                aria-hidden="true"
                class="i-lucide:copy size-4"
              />
              {{ $t('pages.preference.about.buttons.copy') }}
            </Button>
          </ProListItem>
          <ProListItem
            class="about-support-item"
            :title="$t('pages.preference.about.labels.appLog')"
          >
            <template #description>
              <bdi dir="ltr">{{ logDir }}</bdi>
            </template>
            <Button
              class="about-support-action"
              :disabled="supportBusy"
              type="text"
              @click="openLogs"
            >
              <span
                aria-hidden="true"
                class="i-lucide:folder-open size-4"
              />
              {{ $t('pages.preference.about.buttons.viewLog') }}
            </Button>
          </ProListItem>
        </div>
        <div class="about-reset">
          <Button
            :danger="true"
            :disabled="resetting"
            type="text"
            @click="confirmProgramReset"
          >
            {{ $t('pages.preference.about.labels.resetAll') }}
          </Button>
        </div>
      </Flex>
    </ProList>
  </PreferenceSections>

  <Modal
    :cancel-button-props="{ disabled: resetting }"
    :closable="!resetting"
    :confirm-loading="resetting"
    :keyboard="!resetting"
    :mask-closable="!resetting"
    :ok-button-props="{ danger: true, disabled: resetting }"
    :open="resetOpen"
    :title="$t('pages.preference.about.confirm.resetAll')"
    @cancel="cancelProgramReset"
    @ok="submitProgramReset"
  >
    <p class="mb-4 text-color-2">
      {{ $t('pages.preference.about.confirm.resetAllWarning') }}
    </p>
    <div class="space-y-3">
      <ProListItem :title="$t('pages.preference.about.labels.resetDeleteSkins')">
        <Switch
          v-model:checked="resetOptions.deleteSkins"
          :aria-label="$t('pages.preference.about.labels.resetDeleteSkins')"
          :disabled="resetting || !!submittedResetOptions"
        />
      </ProListItem>
      <ProListItem :title="$t('pages.preference.about.labels.resetPresets')">
        <Switch
          v-model:checked="resetOptions.resetPresets"
          :aria-label="$t('pages.preference.about.labels.resetPresets')"
          :disabled="resetting || !!submittedResetOptions"
        />
      </ProListItem>
    </div>
  </Modal>

  <Modal
    v-model:open="legalOpen"
    :footer="null"
    :title="$t('pages.preference.about.labels.legalNotices')"
    :width="900"
  >
    <p class="about-unofficial-notice">
      {{ $t('pages.preference.about.hints.unofficialProduct') }}
    </p>
    <pre
      class="legal-notices"
      dir="ltr"
      tabindex="0"
    >{{ legalNotices }}</pre>
  </Modal>

  <Modal
    v-model:open="dataNoticeOpen"
    :footer="null"
    :title="$t('pages.preference.about.labels.dataNotice')"
    :width="900"
  >
    <pre
      class="legal-notices"
      dir="ltr"
      tabindex="0"
    >{{ dataNotice }}</pre>
  </Modal>
  <Modal
    v-model:open="iconCreditsOpen"
    :footer="null"
    :title="$t('pages.preference.about.labels.iconCredits')"
    :width="600"
  >
    <div class="about-credit-grid">
      <ProListItem
        class="about-credit-item"
        :description="$t('pages.preference.about.hints.solarIcons')"
        title="Solar Icons"
      />
      <ProListItem
        class="about-credit-item"
        :description="$t('pages.preference.about.hints.lucideIcons')"
        title="Lucide Icons"
      />
      <ProListItem
        class="about-credit-item"
        :description="$t('pages.preference.about.hints.antDesignIcons')"
        title="Ant Design Icons"
      />
      <ProListItem
        class="about-credit-item"
        :description="$t('pages.preference.about.hints.notionIcon')"
        title="Notion"
      />
      <ProListItem
        class="about-credit-item"
        :description="$t('pages.preference.about.hints.microsoftStoreIcon')"
        title="Microsoft Store"
      />
    </div>
  </Modal>
</template>

<style scoped>
.about-unofficial-notice {
  margin: 0 0 16px;
  color: var(--ant-color-text-secondary);
  font-size: 12px;
  line-height: 1.65;
}

.about-developer {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ant-color-text-secondary);
  font-size: 18px;
}

.about-resource-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 12px 0 20px;
}

.about-resource-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 4px 12px;
  text-align: center;
}

.about-resource-group + .about-resource-group {
  border-inline-start: 1px solid var(--ant-color-border-secondary);
}

.about-resource-group h2 {
  margin: 0;
}

.about-resource-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.about-brand-action {
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 10px;
  color: var(--ant-color-text-secondary);
}

.about-github-icon {
  font-size: 23px;
  color: inherit;
}

.about-brand-action:focus-visible,
.about-developer:focus-visible {
  outline: 2px solid var(--ant-color-primary) !important;
  outline-offset: 3px;
}

.about-policy-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 12px;
  padding-top: 16px;
  border-top: 1px solid var(--ant-color-border-secondary);
}

.about-policy-action {
  display: inline-flex;
  height: auto;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  color: var(--ant-color-text-tertiary);
  font-size: 12px;
  white-space: normal;
}

.about-support-content {
  margin-top: 12px;
}

.about-support-grid {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 2px 18px;
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: 16px;
  background: var(--ant-color-fill-quaternary);
}

.about-support-item {
  min-width: 0;
  align-items: center;
  gap: 16px;
  padding: 16px 0;
  border: 0;
  border-bottom: 1px solid var(--ant-color-border-secondary);
  border-radius: 0;
  background: transparent;
}

.about-support-item:last-child {
  border-bottom: 0;
}

.about-support-item :deep(> .ant-flex) {
  min-width: 0;
  align-items: center;
}

.about-support-item :deep(.text-xs) {
  line-height: 1.65;
  overflow-wrap: anywhere;
  word-break: normal;
}

:deep(.about-contact-link) {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  margin-inline-start: -8px;
  color: var(--ant-color-text);
  font-size: 14px;
  font-weight: 500;
}
.about-support-action {
  display: inline-flex;
  height: auto;
  align-items: center;
  justify-content: center;
  gap: 7px;
  max-width: 42%;
  flex-shrink: 0;
  padding: 7px 10px;
  color: var(--ant-color-text-secondary);
  font-size: 12px;
  white-space: normal;
}

.about-credit-grid {
  display: flex;
  flex-direction: column;
  gap: 0;
  max-height: 60vh;
  overflow: auto;
}

.about-credit-item {
  min-width: 0;
  align-items: flex-start;
  padding: 10px 4px;
  border: 0;
  background: transparent;
}

.about-credit-item :deep(.text-sm) {
  font-size: 12px;
  color: var(--ant-color-text-secondary);
}

.about-credit-item :deep(.text-xs) {
  margin-top: 4px;
  line-height: 1.65;
}
.about-reset {
  display: flex;
  justify-content: center;
  margin-top: 0;
  padding-top: 0;
}
.legal-notices {
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
}
</style>
