<script setup lang="ts">
import { Button, Input, Modal, Spin, Switch } from 'ant-design-vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ForegroundApplication } from '@/services/foregroundHiding'

import OptionTransition from '@/components/option-transition/index.vue'
import PreferenceTooltip from '@/components/preference-tooltip/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { createForegroundHidingSettings, isForegroundApplicationPath, isForegroundHidingSettings, MAX_FOREGROUND_HIDING_RULES } from '@/features/foregroundHiding/settings'
import { editorsLocked } from '@/features/stateSafety/bridge'
import { describeForegroundApplications, foregroundHidingStatus, listForegroundApplications, MAX_FOREGROUND_CATALOG_ITEMS, selectForegroundApplication } from '@/services/foregroundHiding'
import { useGeneralStore } from '@/stores/general'

const general = useGeneralStore()
const { t } = useI18n()
const key = 'pages.preference.foregroundHiding'
const settings = computed(() => isForegroundHidingSettings(general.app.foregroundHiding) ? general.app.foregroundHiding : undefined)
const status = computed(() => {
  if (!settings.value) return 'invalid'
  if (!settings.value.enabled) return 'off'
  if (!settings.value.applications.length) return 'empty'
  return foregroundHidingStatus.value?.state ?? 'unavailable'
})
const appModalOpen = ref(false)
const applications = ref<ForegroundApplication[]>([])
const applicationSearch = ref('')
const filteredApplications = computed(() => {
  const query = applicationSearch.value.trim().toLowerCase()
  return applications.value.filter(item => isForegroundApplicationPath(item.path) && item.name.toLowerCase().includes(query))
})
const executableCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const item of applications.value) {
    if (!isForegroundApplicationPath(item.path)) continue
    const path = item.path.toLowerCase()
    counts.set(path, (counts.get(path) ?? 0) + 1)
  }
  return counts
})
const metadata = ref(new Map<string, ForegroundApplication>())
const applicationsBusy = ref(false)
const picking = ref(false)
const applicationsError = ref('')
let listGeneration = 0
let metadataGeneration = 0
let disposed = false
function remember(rows: ForegroundApplication[], overwrite = true) {
  for (const item of rows) {
    if (!isForegroundApplicationPath(item.path)) continue
    const path = item.path.toLowerCase()
    if (overwrite || !metadata.value.has(path)) metadata.value.set(path, item)
  }
}
function application(path: string): ForegroundApplication {
  return metadata.value.get(path.toLowerCase()) ?? { path, name: path.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? t(`${key}.applications`) }
}
function setEnabled(checked: boolean | string | number) {
  if (settings.value) settings.value.enabled = checked === true
}
function removeApplication(index: number) {
  if (settings.value?.enabled) settings.value.applications.splice(index, 1)
}
function applicationAdded(path: string) {
  return settings.value?.applications.some(rule => rule.toLowerCase() === path.toLowerCase()) ?? false
}
function addApplication(item: ForegroundApplication) {
  if (editorsLocked.value || !settings.value?.enabled || !isForegroundApplicationPath(item.path) || applicationAdded(item.path)) return
  if (settings.value.applications.length >= MAX_FOREGROUND_HIDING_RULES) {
    applicationsError.value = 'limit'
    return
  }
  remember([item])
  settings.value.applications.push(item.path)
}
function toggleApplication(item: ForegroundApplication) {
  if (!settings.value?.enabled || !appModalOpen.value || disposed) return
  if (applicationAdded(item.path)) {
    settings.value.applications = settings.value.applications.filter(path => path.toLowerCase() !== item.path.toLowerCase())
    if (applicationsError.value === 'limit') applicationsError.value = ''
  } else {
    addApplication(item)
  }
}
async function loadApplications() {
  const generation = ++listGeneration
  applicationsBusy.value = true
  applicationsError.value = ''
  const seen = new Set<string>()
  const append = (row: ForegroundApplication) => {
    if (disposed || generation !== listGeneration || !appModalOpen.value || !settings.value?.enabled) return
    const identity = row.id ?? row.path.toLowerCase()
    if (applications.value.length >= MAX_FOREGROUND_CATALOG_ITEMS || !isForegroundApplicationPath(row.path) || seen.has(identity)) return
    seen.add(identity)
    applications.value.push(row)
    remember([row], false)
  }
  try {
    const rows = await listForegroundApplications(append, (incomplete) => {
      if (incomplete && !disposed && generation === listGeneration && appModalOpen.value && settings.value?.enabled) applicationsError.value = 'applicationsIncomplete'
    })
    for (const row of rows) append(row)
  } catch {
    if (!disposed && generation === listGeneration) applicationsError.value = 'applicationsUnavailable'
  } finally {
    if (!disposed && generation === listGeneration) applicationsBusy.value = false
  }
}
function openApplications() {
  if (!settings.value?.enabled) return
  applications.value = []
  applicationSearch.value = ''
  appModalOpen.value = true
  void loadApplications()
}
function closeApplications() {
  appModalOpen.value = false
  listGeneration++
  applicationsBusy.value = false
}
async function pickApplication() {
  if (disposed || editorsLocked.value || picking.value || !appModalOpen.value || !settings.value?.enabled) return
  const generation = listGeneration
  picking.value = true
  applicationsError.value = ''
  try {
    const item = await selectForegroundApplication()
    if (disposed || generation !== listGeneration || !appModalOpen.value || !settings.value?.enabled) return
    if (item) addApplication(item)
  } catch {
    if (!disposed && generation === listGeneration) applicationsError.value = 'selectionUnavailable'
  } finally {
    if (!disposed) picking.value = false
  }
}
watch(() => settings.value?.enabled ? [...settings.value.applications] : undefined, async (paths) => {
  const generation = ++metadataGeneration
  if (!settings.value?.enabled) closeApplications()
  if (!paths?.length) return
  try {
    const rows = await describeForegroundApplications(paths)
    if (!disposed && generation === metadataGeneration) remember(rows.filter(item => !metadata.value.has(item.path.toLowerCase())))
  } catch { /* A selected app still has its filename fallback. */ }
}, { immediate: true })
onBeforeUnmount(() => {
  disposed = true
  listGeneration++
  metadataGeneration++
})
function confirmRepair() {
  Modal.confirm({
    title: t(`${key}.repairTitle`),
    content: t(`${key}.repairHint`),
    okText: t(`${key}.repair`),
    okType: 'danger',
    onOk: () => {
      if (!disposed) general.app.foregroundHiding = createForegroundHidingSettings(general.app.foregroundHiding)
    },
  })
}
</script>

<template>
  <ProList :title="t(`${key}.title`)">
    <template #title-extra>
      <PreferenceTooltip :overlay-inner-style="{ whiteSpace: 'normal', lineHeight: '1.6' }">
        <template #title>
          <h4 class="m-0 mb-2 text-sm font-semibold">
            {{ t(`${key}.faqQuestion`) }}
          </h4>
          <p class="m-0">
            {{ t(`${key}.faqAnswer`) }}
          </p>
        </template>
        <Button
          :aria-label="t(`${key}.faqLabel`)"
          size="small"
        >
          FAQ
        </Button>
      </PreferenceTooltip>
    </template>
    <div class="foreground-panel">
      <ProListItem
        class="foreground-row"
        :description="t(`${key}.enabledHint`)"
        :title="t(`${key}.enabled`)"
      >
        <Switch
          :aria-label="t(`${key}.enabled`)"
          :checked="settings?.enabled ?? false"
          :disabled="!settings"
          @change="setEnabled"
        />
      </ProListItem>
      <div
        v-if="!settings"
        class="foreground-feedback"
        role="alert"
      >
        <p>{{ t(`${key}.invalidHint`) }}</p>
        <Button @click="confirmRepair">
          {{ t(`${key}.repair`) }}
        </Button>
      </div>
      <OptionTransition v-else>
        <div
          v-show="settings.enabled"
          class="foreground-options"
        >
          <p
            v-if="status === 'empty' || status === 'unavailable'"
            class="foreground-feedback"
            :role="status === 'unavailable' ? 'alert' : 'status'"
          >
            {{ t(`${key}.${status === 'unavailable' ? 'unavailableHint' : 'status.empty'}`) }}
          </p>
          <ProListItem
            class="foreground-row"
            :title="t(`${key}.applications`)"
            vertical
          >
            <ul
              v-if="settings.applications.length"
              class="foreground-applications"
            >
              <li
                v-for="(path, index) in settings.applications"
                :key="path"
              >
                <img
                  v-if="application(path).icon"
                  alt=""
                  class="application-icon"
                  :src="application(path).icon!"
                >
                <span
                  v-else
                  aria-hidden="true"
                  class="application-icon application-fallback i-lucide-app-window"
                />
                <span class="application-name">{{ application(path).name }}</span>
                <Button
                  :aria-label="t(`${key}.removeApplication`, { name: application(path).name })"
                  :disabled="!settings.enabled"
                  size="small"
                  @click="removeApplication(index)"
                >
                  {{ t(`${key}.remove`) }}
                </Button>
              </li>
            </ul>
            <p
              v-else
              class="foreground-note"
            >
              {{ t(`${key}.noApplications`) }}
            </p>
            <Button
              class="foreground-add-application"
              :disabled="!settings.enabled"
              @click="openApplications"
            >
              {{ t(`${key}.addApplication`) }}
            </Button>
            <p
              v-if="settings.applications.length >= MAX_FOREGROUND_HIDING_RULES"
              class="foreground-note"
            >
              {{ t(`${key}.errors.limit`, { count: MAX_FOREGROUND_HIDING_RULES }) }}
            </p>
          </ProListItem>
        </div>
      </OptionTransition>
    </div>
    <Modal
      v-if="settings?.enabled"
      :footer="null"
      :open="appModalOpen"
      :title="t(`${key}.applicationModalTitle`)"
      @cancel="closeApplications"
    >
      <p class="foreground-note">
        {{ t(`${key}.applicationModalHint`) }}
      </p>
      <Button
        class="foreground-pc-picker"
        :disabled="editorsLocked || picking || !settings?.enabled"
        :loading="picking"
        @click="pickApplication"
      >
        {{ t(`${key}.selectFromPc`) }}
      </Button>
      <Input
        v-model:value="applicationSearch"
        allow-clear
        :aria-label="t(`${key}.searchApplications`)"
        autocomplete="off"
        class="foreground-application-search"
        :placeholder="t(`${key}.searchApplications`)"
        type="search"
      />
      <p
        v-if="applicationsError"
        class="foreground-feedback"
        role="alert"
      >
        {{ t(`${key}.errors.${applicationsError}`, { count: MAX_FOREGROUND_HIDING_RULES }) }}
      </p>
      <p
        v-if="!applicationsBusy && !applications.length"
        class="foreground-note"
        role="status"
      >
        {{ t(`${key}.noInstalledApplications`) }}
      </p>
      <p
        v-else-if="!applicationsBusy && !filteredApplications.length"
        class="foreground-note"
        role="status"
      >
        {{ t(`${key}.noMatchingApplications`) }}
      </p>
      <ul
        v-if="filteredApplications.length"
        :aria-busy="applicationsBusy"
        class="foreground-applications foreground-application-picker"
      >
        <li
          v-for="item in filteredApplications"
          :key="item.id ?? item.path"
        >
          <img
            v-if="item.icon"
            alt=""
            class="application-icon"
            loading="lazy"
            :src="item.icon"
          >
          <span
            v-else
            aria-hidden="true"
            class="application-icon application-fallback i-lucide-app-window"
          />
          <span class="application-name">
            {{ item.name }}
            <span
              v-if="item.launchOptions || (executableCounts.get(item.path.toLowerCase()) ?? 0) > 1"
              class="application-detail"
            >{{ t(`${key}.sharedExecutable`) }}</span>
          </span>
          <Button
            :aria-label="t(`${key}.${applicationAdded(item.path) ? 'removeApplication' : 'addNamedApplication'}`, { name: item.name })"
            :disabled="!settings?.enabled || (!applicationAdded(item.path) && settings.applications.length >= MAX_FOREGROUND_HIDING_RULES)"
            size="small"
            @click="toggleApplication(item)"
          >
            {{ t(`${key}.${applicationAdded(item.path) ? 'remove' : 'add'}`) }}
          </Button>
        </li>
      </ul>
      <div
        v-if="applicationsBusy"
        class="foreground-loading"
        role="status"
      >
        <Spin /> <span>{{ t(`${key}.loadingApplications`) }}</span>
      </div>
    </Modal>
  </ProList>
</template>

<style scoped>
.foreground-panel {
  min-width: 0;
  padding: 2px 18px;
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: 16px;
  background: var(--ant-color-fill-quaternary);
}
.foreground-row {
  min-width: 0;
  gap: 12px;
  padding: 16px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.foreground-options {
  display: flow-root;
}
.foreground-row :deep(.text-xs) {
  line-height: 1.6;
  word-break: normal;
  overflow-wrap: anywhere;
}
.foreground-row :deep(> .ant-flex),
.foreground-row :deep(> .ant-flex > .ant-flex) {
  min-width: 0;
}
.foreground-note {
  margin: 0;
  color: var(--ant-color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.foreground-feedback {
  margin: 12px 0;
  color: var(--ant-color-error);
  font-size: 12px;
  line-height: 1.6;
}
.foreground-applications {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.foreground-applications li {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.application-icon {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  object-fit: contain;
}
.application-fallback {
  color: var(--ant-color-text-secondary);
}
.application-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.application-detail {
  display: block;
  margin-top: 3px;
  color: var(--ant-color-text-secondary);
  font-size: 11px;
  line-height: 1.5;
}
.foreground-applications :deep(.ant-btn),
.foreground-row :deep(.ant-switch) {
  flex-shrink: 0;
}
.foreground-add-application {
  align-self: flex-start;
}
.foreground-pc-picker {
  margin-top: 16px;
}
.foreground-application-search {
  display: flex;
  margin-top: 22.4px;
  margin-bottom: 22.4px;
}
.foreground-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  color: var(--ant-color-text-secondary);
  font-size: 13px;
}
.foreground-application-picker {
  max-height: min(380px, 50vh);
  overflow-y: auto;
  margin-top: 0;
}
</style>
