<script setup lang="ts">
import { Button, Divider, Flex, InputNumber, message, Modal, Select, Switch } from 'ant-design-vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { AutostartStatus } from '@/services/autostart'

import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { getAutostartStatus, setAutostartEnabled } from '@/services/autostart'
import { reportDiagnostic } from '@/services/diagnostics'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'

import BroadcastSettings from './components/broadcast-settings/index.vue'
import ThemeMode from './components/theme-mode/index.vue'

const catStore = useCatStore()
const generalStore = useGeneralStore()
const { t } = useI18n()

const autostart = ref<AutostartStatus>()
const autostartBusy = ref(false)
let disposed = false
async function refreshAutostart() {
  try {
    const status = await getAutostartStatus()
    if (!disposed) autostart.value = status
  } catch (error) {
    if (!disposed) autostart.value = undefined
    reportDiagnostic('warn', 'autostart.status', error)
  }
}
async function changeAutostart(checked: boolean | string | number) {
  if (autostartBusy.value || !autostart.value) return
  autostartBusy.value = true
  try {
    await setAutostartEnabled(checked === true)
  } catch (error) {
    reportDiagnostic('warn', 'autostart.change', error)
    message.error(t('autostartStatus.failed'))
  } finally {
    await refreshAutostart()
    autostartBusy.value = false
  }
}
onMounted(() => {
  void refreshAutostart()
  window.addEventListener('focus', refreshAutostart)
})
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('focus', refreshAutostart)
})

function confirmGeneralReset() {
  Modal.confirm({
    title: t('pages.preference.general.confirm.reset'),
    okType: 'danger',
    onOk: async () => {
      catStore.resetGeneralSettings()
      generalStore.reset()
      await generalStore.init()
      await setAutostartEnabled(false)
      await refreshAutostart()
    },
  })
}
</script>

<template>
  <PreferenceSections>
    <ProList
      :title="$t('pages.preference.general.labels.petSettings')"
    >
      <ProListItem
        :description="$t('pages.preference.general.hints.keepInScreen')"
        :title="$t('pages.preference.general.labels.keepInScreen')"
      >
        <Switch v-model:checked="catStore.window.keepInScreen" />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.general.hints.alwaysOnTop')"
        :title="$t('pages.preference.general.labels.alwaysOnTop')"
      >
        <Switch v-model:checked="catStore.window.alwaysOnTop" />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.general.hints.hideOnHover')"
        :title="$t('pages.preference.general.labels.hideOnHover')"
      >
        <Flex align="center">
          <Switch v-model:checked="catStore.window.hideOnHover" />

          <Flex
            align="center"
            class="overflow-hidden transition-all"
            :class="[catStore.window.hideOnHover ? 'w-28 opacity-100' : 'w-0 opacity-0']"
          >
            <Divider type="vertical" />
            <InputNumber
              v-model:value="catStore.window.hideOnHoverDelay"
              addon-after="s"
              class="w-24"
              :min="0"
            />
          </Flex>
        </Flex>
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.general.hints.passThrough')"
        :title="$t('pages.preference.general.labels.passThrough')"
      >
        <Switch v-model:checked="catStore.window.passThrough" />
      </ProListItem>
    </ProList>

    <BroadcastSettings />

    <ProList
      :title="$t('pages.preference.general.labels.appSettings')"
    >
      <ProListItem
        :description="t(`autostartStatus.${autostart?.state ?? 'unknown'}`)"
        :title="$t('pages.preference.general.labels.launchOnStartup')"
      >
        <Switch
          :checked="autostart?.enabled ?? false"
          :disabled="!autostart || autostartBusy || (autostart.enabled ? !autostart.canDisable : !autostart.canEnable)"
          :loading="autostartBusy"
          @change="changeAutostart"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.general.hints.showTaskbarIcon')"
        :title="$t('pages.preference.general.labels.showTaskbarIcon')"
      >
        <Switch v-model:checked="generalStore.app.taskbarVisible" />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.general.hints.showTrayIcon')"
        :title="$t('pages.preference.general.labels.showTrayIcon')"
      >
        <Switch v-model:checked="generalStore.app.trayVisible" />
      </ProListItem>

      <ThemeMode />

      <ProListItem :title="$t('pages.preference.general.labels.language')">
        <Select v-model:value="generalStore.appearance.language">
          <Select.Option value="ko-KR">
            한국어
          </Select.Option>
          <Select.Option value="en-US">
            English
          </Select.Option>
        </Select>
      </ProListItem>

      <Button
        block
        :danger="true"
        @click="confirmGeneralReset"
      >
        {{ $t('pages.preference.general.labels.reset') }}
      </Button>
    </ProList>
  </PreferenceSections>
</template>
