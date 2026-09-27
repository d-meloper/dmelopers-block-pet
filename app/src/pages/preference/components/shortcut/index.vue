<script setup lang="ts">
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import Shortcut from '@/components/shortcut/index.vue'
import { useShortcutStore } from '@/stores/shortcut.ts'

const shortcutStore = useShortcutStore()

function otherShortcuts(key: keyof typeof shortcutStore.$state): string[] {
  return Object.entries(shortcutStore.$state).filter(([name]) => name !== key).map(([, value]) => value)
}
</script>

<template>
  <ProList :title="$t('pages.preference.shortcut.title')">
    <ProListItem
      :description="$t('pages.preference.shortcut.hints.toggleCat')"
      :title="$t('pages.preference.shortcut.labels.toggleCat')"
    >
      <Shortcut
        v-model="shortcutStore.visibleCat"
        :reserved-shortcuts="otherShortcuts('visibleCat')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.toggleBroadcast')"
      :title="$t('pages.preference.shortcut.labels.toggleBroadcast')"
    >
      <Shortcut
        v-model="shortcutStore.toggleBroadcast"
        :reserved-shortcuts="otherShortcuts('toggleBroadcast')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.togglePreferences')"
      :title="$t('pages.preference.shortcut.labels.togglePreferences')"
    >
      <Shortcut
        v-model="shortcutStore.visiblePreference"
        :reserved-shortcuts="otherShortcuts('visiblePreference')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.scene.hints.showDisplayArea')"
      :title="$t('pages.preference.scene.labels.showDisplayArea')"
    >
      <Shortcut
        v-model="shortcutStore.showDisplayArea"
        :reserved-shortcuts="otherShortcuts('showDisplayArea')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.environment.hints.mouseEnabled')"
      :title="$t('pages.preference.shortcut.labels.toggleMouse')"
    >
      <Shortcut
        v-model="shortcutStore.mouseEnabled"
        :reserved-shortcuts="otherShortcuts('mouseEnabled')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.mirrorMode')"
      :title="$t('pages.preference.shortcut.labels.mirrorMode')"
    >
      <Shortcut
        v-model="shortcutStore.mirrorMode"
        :reserved-shortcuts="otherShortcuts('mirrorMode')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.cycleZoom')"
      :title="$t('pages.preference.shortcut.labels.cycleZoom')"
    >
      <Shortcut
        v-model="shortcutStore.cycleZoom"
        :reserved-shortcuts="otherShortcuts('cycleZoom')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.cycleRotation')"
      :title="$t('pages.preference.shortcut.labels.cycleRotation')"
    >
      <Shortcut
        v-model="shortcutStore.cycleRotation"
        :reserved-shortcuts="otherShortcuts('cycleRotation')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.general.hints.keepInScreen')"
      :title="$t('pages.preference.general.labels.keepInScreen')"
    >
      <Shortcut
        v-model="shortcutStore.keepInScreen"
        :reserved-shortcuts="otherShortcuts('keepInScreen')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.general.hints.passThrough')"
      :title="$t('pages.preference.shortcut.labels.passThrough')"
    >
      <Shortcut
        v-model="shortcutStore.penetrable"
        :reserved-shortcuts="otherShortcuts('penetrable')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.general.hints.hideOnHover')"
      :title="$t('pages.preference.shortcut.labels.hideOnHover')"
    >
      <Shortcut
        v-model="shortcutStore.hideOnHover"
        :reserved-shortcuts="otherShortcuts('hideOnHover')"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.alwaysOnTop')"
      :title="$t('pages.preference.shortcut.labels.alwaysOnTop')"
    >
      <Shortcut
        v-model="shortcutStore.alwaysOnTop"
        :reserved-shortcuts="otherShortcuts('alwaysOnTop')"
      />
    </ProListItem>
  </ProList>
</template>
