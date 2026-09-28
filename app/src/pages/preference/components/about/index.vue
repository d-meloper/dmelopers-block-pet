<script setup lang="ts">
import { getTauriVersion } from '@tauri-apps/api/app'
import { appLogDir } from '@tauri-apps/api/path'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { openPath, openUrl } from '@tauri-apps/plugin-opener'
import { arch, platform, version } from '@tauri-apps/plugin-os'
import { Button, Flex, message, Modal } from 'ant-design-vue'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { useProgramSettingsReset } from '@/composables/useProgramSettingsReset'
import { APP_DISPLAY_NAME } from '@/constants/branding'
import { selectByLanguage } from '@/locales/languageBranch'
import { reportDiagnostic } from '@/services/diagnostics'
import { getDistributionInfo } from '@/services/distribution'
import { useAppStore } from '@/stores/app'
import { ProgramSettingsResetError } from '@/utils/programSettingsReset'

import ProgramUpdates from './ProgramUpdates.vue'

const appStore = useAppStore()
const logDir = ref('')
const dataDir = ref('')
const legalNotices = ref('')
const legalOpen = ref(false)
const legalLoading = ref(false)
const { t, locale } = useI18n()
const developerEmail = 'dmeloper@gmail.com'
const { resetProgramSettings } = useProgramSettingsReset()

onMounted(async () => {
  logDir.value = await appLogDir()
  try {
    dataDir.value = (await getDistributionInfo()).dataRoot
  } catch (error) {
    reportDiagnostic('warn', 'about.data_location', error)
  }
})

async function openDeveloperLink() {
  try {
    await openUrl(selectByLanguage(locale.value, 'https://litt.ly/dmeloper', 'https://linktr.ee/dmeloper.dev'))
  } catch (error) {
    reportDiagnostic('error', 'about.open_developer_link', error)
    message.error(t('pages.preference.about.errors.openDeveloperLink'))
  }
}

async function copyDeveloperEmail() {
  try {
    await writeText(developerEmail)
    message.success(t('pages.preference.about.hints.copySuccess'))
  } catch (error) {
    reportDiagnostic('error', 'about.copy_email', error)
    message.error(t('pages.preference.about.errors.copyEmail'))
  }
}

async function copyInfo() {
  const info = {
    appName: APP_DISPLAY_NAME,
    appVersion: appStore.version,
    tauriVersion: await getTauriVersion(),
    platform: platform(),
    platformArch: arch(),
    platformVersion: version(),
  }

  await writeText(JSON.stringify(info, null, 2))

  message.success(t('pages.preference.about.hints.copySuccess'))
}

async function showLegalNotices() {
  legalLoading.value = true
  try {
    legalNotices.value ||= (await import('@/legal/notices.txt?raw')).default
    legalOpen.value = true
  } catch (error) {
    reportDiagnostic('error', 'about.legal_notices', error)
    message.error(t('pages.preference.about.errors.legalNotices'))
  } finally {
    legalLoading.value = false
  }
}

function confirmProgramReset() {
  Modal.confirm({
    title: t('pages.preference.about.confirm.resetAll'),
    content: t('pages.preference.about.confirm.resetAllWarning'),
    okType: 'danger',
    onOk: async () => {
      try {
        await resetProgramSettings()
      } catch (error) {
        reportDiagnostic('error', 'settings.reset_all', error)
        const key = error instanceof ProgramSettingsResetError
          ? { blocked: 'resetAutostartBlocked', preflight: 'resetPreflight', partial: 'resetPartial' }[error.outcome]
          : 'resetAll'
        message.error(t(`pages.preference.about.errors.${key}`))
        throw error
      }
    },
  })
}
</script>

<template>
  <PreferenceSections>
    <ProgramUpdates />

    <ProList :title="$t('pages.preference.about.labels.aboutApp')">
      <ProListItem
        :description="`v${appStore.version}`"
        :title="APP_DISPLAY_NAME"
      >
        <template #icon>
          <div class="b b-color-2 rounded-xl b-solid">
            <img
              class="size-12"
              src="/logo.png"
            >
          </div>
        </template>
      </ProListItem>

      <ProListItem :title="$t('pages.preference.about.labels.introduction')">
        <Flex
          :gap="8"
          wrap="wrap"
        >
          <Button @click="openUrl('https://app.notion.com/p/aismash/0da2dc0bb4ae82ab8db301718dde497b?source=copy_link')">
            {{ $t('pages.preference.about.buttons.notion') }}
          </Button>
          <Button @click="openUrl('https://github.com/d-meloper/dmelopers-block-pet')">
            {{ $t('pages.preference.about.buttons.github') }}
          </Button>
        </Flex>
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.about.hints.appInfo')"
        :title="$t('pages.preference.about.labels.appInfo')"
      >
        <Button @click="copyInfo">
          {{ $t('pages.preference.about.buttons.copy') }}
        </Button>
      </ProListItem>

      <ProListItem
        :description="dataDir"
        :title="t('dataLocation.title')"
      >
        <Button
          :disabled="!dataDir"
          @click="writeText(dataDir)"
        >
          {{ t('pages.preference.about.buttons.copy') }}
        </Button>
      </ProListItem>

      <ProListItem
        :description="logDir"
        :title="$t('pages.preference.about.labels.appLog')"
      >
        <Button @click="openPath(logDir)">
          {{ $t('pages.preference.about.buttons.viewLog') }}
        </Button>
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.about.hints.legalNotices')"
        :title="$t('pages.preference.about.labels.legalNotices')"
      >
        <Button
          :loading="legalLoading"
          @click="showLegalNotices"
        >
          {{ $t('pages.preference.about.buttons.viewLegalNotices') }}
        </Button>
      </ProListItem>
    </ProList>

    <ProList :title="$t('pages.preference.about.labels.developerInfo')">
      <ProListItem
        :description="$t('pages.preference.about.labels.developerName')"
        :title="$t('pages.preference.about.labels.developer')"
      >
        <Button @click="openDeveloperLink">
          {{ $t('pages.preference.about.buttons.openLinktree') }}
        </Button>
      </ProListItem>

      <ProListItem
        :description="developerEmail"
        :title="$t('pages.preference.about.labels.developerEmail')"
      >
        <Button @click="copyDeveloperEmail">
          {{ $t('pages.preference.about.buttons.copy') }}
        </Button>
      </ProListItem>
    </ProList>

    <ProList :title="$t('pages.preference.about.labels.iconCredits')">
      <ProListItem
        :description="$t('pages.preference.about.hints.solarIcons')"
        title="Solar Icons"
      />

      <ProListItem
        :description="$t('pages.preference.about.hints.lucideIcons')"
        title="Lucide Icons"
      />

      <Button
        block
        :danger="true"
        @click="confirmProgramReset"
      >
        {{ $t('pages.preference.about.labels.resetAll') }}
      </Button>
    </ProList>
  </PreferenceSections>

  <Modal
    v-model:open="legalOpen"
    :footer="null"
    :title="$t('pages.preference.about.labels.legalNotices')"
    :width="900"
  >
    <pre
      class="legal-notices"
      tabindex="0"
    >{{ legalNotices }}</pre>
  </Modal>
</template>

<style scoped>
.legal-notices {
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
}
</style>
