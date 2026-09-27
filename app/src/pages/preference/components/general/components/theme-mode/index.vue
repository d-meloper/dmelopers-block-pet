<script setup lang="ts">
import { Select, SelectOption } from 'ant-design-vue'

import ProListItem from '@/components/pro-list-item/index.vue'
import { useGeneralStore } from '@/stores/general'

const generalStore = useGeneralStore()
</script>

<template>
  <ProListItem :title="$t('pages.preference.general.labels.themeMode')">
    <Select
      v-model:value="generalStore.appearance.theme"
      :dropdown-match-select-width="false"
    >
      <SelectOption value="auto">
        {{ $t('pages.preference.general.options.auto') }}
      </SelectOption>
      <SelectOption value="light">
        {{ $t('pages.preference.general.options.lightMode') }}
      </SelectOption>
      <SelectOption value="dark">
        {{ $t('pages.preference.general.options.darkMode') }}
      </SelectOption>
    </Select>
  </ProListItem>
</template>
