<script setup lang="ts">
import { Button, Divider, Flex, InputNumber, Modal, Select, Switch } from 'ant-design-vue'
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'

import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { setAutostartEnabled } from '@/services/autostart'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'

import BroadcastSettings from './components/broadcast-settings/index.vue'
import ThemeMode from './components/theme-mode/index.vue'

const catStore = useCatStore()
const generalStore = useGeneralStore()
const { t } = useI18n()

watch(() => generalStore.app.autostart, setAutostartEnabled, { immediate: true })

function confirmGeneralReset() {
  Modal.confirm({
    title: t('pages.preference.general.confirm.reset'),
    okType: 'danger',
    onOk: async () => {
      catStore.resetGeneralSettings()
      generalStore.reset()
      await generalStore.init()
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
      <ProListItem :title="$t('pages.preference.general.labels.launchOnStartup')">
        <Switch v-model:checked="generalStore.app.autostart" />
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
