<script setup lang="ts">
import { Button, Flex, Input, Modal, Segmented, Select, Switch, TabPane, Tabs } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { DmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'
import type { PetModelId } from '@/config/model3d'
import type { Pet3dPreset } from '@/stores/block'
import type { NormalizedVoxelSkin, VoxelSkinModel } from '@/utils/three3d/voxelSkin'

import ColorPicker from '@/components/color-picker/index.vue'
import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import OptionTransition from '@/components/option-transition/index.vue'
import { vStableDetailHeight } from '@/components/preference-detail-tabs/height'
import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { createDefaultDmeloperEyebrowPreset, DMELOPER_EYEBROW_LIMITS } from '@/config/dmeloperEyebrows'
import { PET_MODEL_OPTIONS } from '@/config/model3d'
import presetRanges from '@/config/presetRanges.json'
import { BUILTIN_DMELOPER_SKIN, getSkinSelectionId } from '@/config/skinIdentity'
import { markPresetUserEdit, onPresetSelectionChange } from '@/features/presets/editIntent'
import { beginPresetNativeEdit } from '@/features/presets/operations'
import { editorsLocked } from '@/features/stateSafety/bridge'
import { reportDiagnostic } from '@/services/diagnostics'
import { resolveDefaultDmeloperColors, resolveDmeloperSkinUrl } from '@/services/dmeloperSkin'
import {
  createMinecraftSkinBlob,
  createMinecraftSkinDataUrl,
  fetchMinecraftSkin,
  isMinecraftUsername,
  LatestRequestGate,
  MinecraftSkinError,
  normalizeMinecraftSkinError,
} from '@/services/minecraftSkin'
import { SkinLibraryError, storeSkinLibraryEntry } from '@/services/skinLibrary'
import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'
import { createSkinFaceThumbnailPngBase64 } from '@/utils/skinThumbnail'
import { decodeVoxelSkin, suggestVoxelSkinHeadTopColor, suggestVoxelSkinPalmColor } from '@/utils/three3d/voxelSkin'

const emit = defineEmits<{
  openSkinLibrary: []
}>()

const blockStore = useBlockStore()
const defaultPet3dPreset = createDefaultPet3dPreset()
const defaultDmeloperEyebrows = createDefaultDmeloperEyebrowPreset()
const { t } = useI18n()
type PetDetailTab = 'body' | 'arms' | 'eyebrows'
const activePetDetailTab = ref<PetDetailTab>('body')
const minecraftSkinError = ref<string>()
const minecraftSkinLoading = ref(false)
const skinLibraryMigrationLoading = ref(true)
const minecraftSkinUsernameDraft = ref(
  blockStore.customization3d.minecraftSkinUsername ?? '',
)
const wideAvailable = ref(true)
const analyzedSkin = shallowRef<{ dataUrl?: string, skin: NormalizedVoxelSkin }>()
let disposed = false
let skinResolutionGeneration = 0
const minecraftSkinRequestGate = new LatestRequestGate()

function invalidateMinecraftSkinRequest() {
  minecraftSkinRequestGate.invalidate()
  minecraftSkinLoading.value = false
}

const selectedModelId = computed({
  get: () => blockStore.customization3d.selectedModelId,
  set: (modelId: PetModelId) => {
    if (modelId !== blockStore.customization3d.selectedModelId) {
      invalidateMinecraftSkinRequest()
    }
    blockStore.selectPetModel(modelId)
  },
})
const activePet3dPreset = computed(() => blockStore.activePet3dPreset)
type PresetNumberKey = {
  [Key in keyof Pet3dPreset]: Pet3dPreset[Key] extends number ? Key : never
}[keyof Pet3dPreset]

function updateViewportSetting(
  key: PresetNumberKey,
  value: number,
) {
  Object.assign(activePet3dPreset.value, { [key]: value })
}

const petDeskDistance = computed({
  get: () => 0 - activePet3dPreset.value.petDeskOffset,
  set: value => updateViewportSetting('petDeskOffset', 0 - value),
})
const petRightArmSpread = computed({
  get: () => 0 - activePet3dPreset.value.petRightArmSpreadDegrees,
  set: value => updateViewportSetting('petRightArmSpreadDegrees', 0 - value),
})

function createDmeloperEyebrowSetting<Key extends keyof DmeloperEyebrowPreset>(
  key: Key,
) {
  return computed<DmeloperEyebrowPreset[Key]>({
    get: () => activePet3dPreset.value.dmeloperEyebrows[key],
    set: (value) => {
      if (editorsLocked.value || (key !== 'enabled' && !activePet3dPreset.value.dmeloperEyebrows.enabled)) return
      blockStore.updateDmeloperEyebrows({ [key]: value } as Partial<DmeloperEyebrowPreset>)
    },
  })
}
const dmeloperEyebrowsEnabled = createDmeloperEyebrowSetting('enabled')
const eyebrowAnimationEnabled = computed({
  get: () => blockStore.model.eyebrowAnimationEnabled,
  set: (enabled: boolean) => {
    if (editorsLocked.value || !dmeloperEyebrowsEnabled.value) return
    blockStore.model.eyebrowAnimationEnabled = enabled
  },
})
const dmeloperEyebrowColor = createDmeloperEyebrowSetting('color')
const dmeloperEyebrowHeight = createDmeloperEyebrowSetting('heightOffsetPixels')
const dmeloperEyebrowSpacing = createDmeloperEyebrowSetting('spacingPixels')
const dmeloperEyebrowWidth = createDmeloperEyebrowSetting('widthPixels')
const dmeloperEyebrowThickness = createDmeloperEyebrowSetting('thicknessPixels')
const dmeloperEyebrowCenter = createDmeloperEyebrowSetting('centerOffsetPixels')
const storedDmeloperEyebrowDepth = createDmeloperEyebrowSetting('depthPercent')
const dmeloperEyebrowDepth = computed({
  get: () => 0 - storedDmeloperEyebrowDepth.value,
  set: value => storedDmeloperEyebrowDepth.value = 0 - value,
})
const automaticPalmColor = computed(() => {
  const analyzed = analyzedSkin.value
  if (!analyzed || analyzed.dataUrl !== blockStore.customization3d.dmeloperSkinDataUrl) return undefined
  return suggestVoxelSkinPalmColor(analyzed.skin.data, dmeloperSkinModel.value)
})

function resetDmeloperPalmColor() {
  if (automaticPalmColor.value) blockStore.resetDmeloperPalmColor(automaticPalmColor.value)
}

const automaticEyebrowColor = computed(() => {
  const analyzed = analyzedSkin.value
  if (!analyzed || analyzed.dataUrl !== blockStore.customization3d.dmeloperSkinDataUrl) return undefined
  return suggestVoxelSkinHeadTopColor(analyzed.skin.data)
})
const automaticEyebrowColorDisabled = computed(() => editorsLocked.value
  || !dmeloperEyebrowsEnabled.value || !automaticEyebrowColor.value)

function setDmeloperEyebrowColorAutomatically() {
  const color = automaticEyebrowColor.value
  if (automaticEyebrowColorDisabled.value || !color) return
  dmeloperEyebrowColor.value = color
}

const dmeloperPalmColor = computed({
  get: () => activePet3dPreset.value.dmeloperPalmColor,
  set: color => blockStore.updateDmeloperPalmColor(color),
})
const dmeloperSkinModel = computed<VoxelSkinModel>({
  get: () => blockStore.customization3d.dmeloperSkinModel === 'slim' ? 'slim' : 'wide',
  set: (skinModel) => {
    markPresetUserEdit()
    blockStore.setDmeloperSkinModel(skinModel)
  },
})
const dmeloperSkinModelOptions = computed(() => [
  {
    disabled: !wideAvailable.value,
    label: t('pages.preference.block.options.dmeloperSkinModel.wide'),
    value: 'wide',
  },
  {
    label: t('pages.preference.block.options.dmeloperSkinModel.slim'),
    value: 'slim',
  },
])
const minecraftSkinSourceStatus = computed(() => {
  if (getSkinSelectionId(blockStore.customization3d) === BUILTIN_DMELOPER_SKIN.id) {
    return t('pages.preference.block.status.defaultSkin')
  }
  const username = blockStore.customization3d.minecraftSkinUsername
  if (username && blockStore.customization3d.dmeloperSkinDataUrl) {
    return t('pages.preference.block.status.minecraftSkinApplied', {
      name: username,
      model: t(`pages.preference.block.options.dmeloperSkinModel.${dmeloperSkinModel.value}`),
    })
  }
  if (blockStore.customization3d.dmeloperSkinDataUrl) {
    return t('pages.preference.block.status.localSkin')
  }
  return t('pages.preference.block.status.defaultSkin')
})

watch(
  () => blockStore.customization3d.minecraftSkinUsername,
  (username) => {
    if (!minecraftSkinLoading.value) {
      minecraftSkinUsernameDraft.value = username ?? ''
    }
  },
)

watch(
  () => blockStore.customization3d.dmeloperSkinDataUrl,
  async (storedDataUrl) => {
    const release = beginPresetNativeEdit()
    const generation = ++skinResolutionGeneration
    analyzedSkin.value = undefined
    try {
      const skinUrl = await resolveDmeloperSkinUrl(storedDataUrl)
      if (generation !== skinResolutionGeneration) return
      const response = await fetch(skinUrl)
      if (!response.ok) throw new Error('The saved Dmeloper skin could not be read.')
      const decoded = await decodeVoxelSkin(await response.blob(), 'auto')
      if (generation !== skinResolutionGeneration) return

      analyzedSkin.value = { dataUrl: storedDataUrl, skin: decoded }
      wideAvailable.value = decoded.wideArmLayoutCompatible
      if (!wideAvailable.value) blockStore.setDmeloperSkinModel('slim')
      else if (blockStore.customization3d.dmeloperSkinModel === 'auto') blockStore.setDmeloperSkinModel(decoded.model)
    } catch (error) {
      if (!disposed && generation === skinResolutionGeneration) reportDiagnostic('warn', 'skin.analyze_saved', error)
    } finally {
      release()
    }
  },
  { immediate: true },
)

function getPngBase64(dataUrl: string): string {
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix) || dataUrl.length === prefix.length) {
    throw new Error(t('pages.preference.block.errors.skinRead'))
  }
  return dataUrl.slice(prefix.length)
}

function formatMinecraftSkinError(error: unknown): string {
  const normalized = normalizeMinecraftSkinError(error)
  const baseMessage = t(
    `pages.preference.block.errors.minecraftSkin.${normalized.code}`,
  )
  if (!normalized.retryable) return baseMessage
  if (normalized.retryAfterSeconds !== undefined) {
    return `${baseMessage} ${t('pages.preference.block.errors.minecraftSkin.retryAfter', {
      seconds: normalized.retryAfterSeconds,
    })}`
  }
  return `${baseMessage} ${t('pages.preference.block.errors.minecraftSkin.retry')}`
}

async function applyMinecraftSkinNickname() {
  if (disposed || editorsLocked.value) return
  const requestedName = minecraftSkinUsernameDraft.value.trim()
  invalidateMinecraftSkinRequest()
  minecraftSkinError.value = undefined

  if (!requestedName) {
    const release = beginPresetNativeEdit()
    const generation = minecraftSkinRequestGate.begin()
    minecraftSkinLoading.value = true
    try {
      const colors = await resolveDefaultDmeloperColors()
      if (!minecraftSkinRequestGate.isCurrent(generation)) return
      minecraftSkinUsernameDraft.value = ''
      wideAvailable.value = true
      blockStore.resetDmeloperSkinToDefault(colors.palmColor, colors.eyebrowColor)
    } catch (error) {
      if (minecraftSkinRequestGate.isCurrent(generation)) {
        reportDiagnostic('error', 'skin.apply_default', error)
        minecraftSkinError.value = formatMinecraftSkinError(error)
      }
    } finally {
      release()
      if (minecraftSkinRequestGate.isCurrent(generation)) minecraftSkinLoading.value = false
    }
    return
  }

  if (!isMinecraftUsername(requestedName)) {
    minecraftSkinError.value = t(
      'pages.preference.block.errors.minecraftSkin.INVALID_USERNAME',
    )
    return
  }

  const generation = minecraftSkinRequestGate.begin()
  const release = beginPresetNativeEdit()
  minecraftSkinLoading.value = true

  try {
    const response = await fetchMinecraftSkin(requestedName)
    if (
      !minecraftSkinRequestGate.isCurrent(generation)
      || selectedModelId.value !== 'dmeloper'
    ) {
      return
    }

    const dataUrl = createMinecraftSkinDataUrl(response.pngBase64)
    let decoded: NormalizedVoxelSkin
    try {
      decoded = await decodeVoxelSkin(
        createMinecraftSkinBlob(response.pngBase64),
        response.model,
      )
      if (decoded.convertedFromLegacy !== (response.height === 32)) {
        throw new MinecraftSkinError({ code: 'INVALID_RESPONSE', retryable: false })
      }
    } catch (error) {
      if (error instanceof MinecraftSkinError) {
        throw error
      }
      throw new MinecraftSkinError({ code: 'INVALID_PNG', retryable: false })
    }

    if (
      !minecraftSkinRequestGate.isCurrent(generation)
      || selectedModelId.value !== 'dmeloper'
    ) {
      return
    }

    const thumbnailPngBase64 = await createSkinFaceThumbnailPngBase64(decoded)
    if (
      !minecraftSkinRequestGate.isCurrent(generation)
      || selectedModelId.value !== 'dmeloper'
    ) {
      return
    }
    const storedEntry = await storeSkinLibraryEntry({
      source: 'java',
      displayName: response.canonicalName,
      canonicalNickname: response.canonicalName,
      model: decoded.model,
      pngBase64: response.pngBase64,
      thumbnailPngBase64,
    })
    if (
      !minecraftSkinRequestGate.isCurrent(generation)
      || selectedModelId.value !== 'dmeloper'
    ) {
      return
    }

    const applied = blockStore.applyMinecraftSkin({
      dataUrl,
      canonicalName: response.canonicalName,
      skinModel: decoded.model,
      palmColor: decoded.suggestedPalmColor,
      eyebrowColor: suggestVoxelSkinHeadTopColor(decoded.data),
      libraryEntryId: storedEntry.id,
    })
    if (!applied) {
      throw new MinecraftSkinError({ code: 'INVALID_RESPONSE', retryable: false })
    }
    blockStore.completeSkinLibraryMigration(storedEntry.id)

    wideAvailable.value = decoded.wideArmLayoutCompatible
    minecraftSkinUsernameDraft.value = response.canonicalName
  } catch (error) {
    if (minecraftSkinRequestGate.isCurrent(generation)) {
      reportDiagnostic('error', 'skin.apply_java', error)
      minecraftSkinError.value = error instanceof SkinLibraryError
        ? t('pages.preference.block.errors.skinStore')
        : formatMinecraftSkinError(error)
    }
  } finally {
    release()
    if (minecraftSkinRequestGate.isCurrent(generation)) {
      minecraftSkinLoading.value = false
    }
  }
}

async function migrateStoredSkinToLibrary() {
  const release = beginPresetNativeEdit()
  try {
    if (disposed || editorsLocked.value) return
    const migration = blockStore.getPendingSkinLibraryMigration()
    if (!migration) {
      if (!blockStore.customization3d.skinLibraryMigrationCompleted) {
        blockStore.completeSkinLibraryMigration()
      }
      return
    }
    const blob = await fetch(migration.dataUrl).then((response) => {
      if (!response.ok) throw new Error(t('pages.preference.block.errors.skinRead'))
      return response.blob()
    })
    if (disposed) return
    const decoded = await decodeVoxelSkin(blob, migration.modelPreference)
    if (disposed) return
    const thumbnailPngBase64 = await createSkinFaceThumbnailPngBase64(decoded)
    if (disposed) return
    const storedEntry = await storeSkinLibraryEntry({
      source: migration.source,
      displayName: migration.displayName,
      canonicalNickname: migration.canonicalNickname,
      originalFilename: migration.originalFilename,
      model: decoded.model,
      pngBase64: getPngBase64(migration.dataUrl),
      thumbnailPngBase64,
    })
    if (
      !disposed
      && !blockStore.customization3d.skinLibraryMigrationCompleted
      && blockStore.customization3d.dmeloperSkinDataUrl === migration.dataUrl
    ) {
      blockStore.completeSkinLibraryMigration(storedEntry.id, migration.dataUrl)
    }
  } catch (error) {
    if (!disposed) reportDiagnostic('warn', 'skin.library_migration', error)
  } finally {
    release()
    skinLibraryMigrationLoading.value = false
  }
}

onMounted(() => void migrateStoredSkinToLibrary())

const stopPresetSelectionListener = onPresetSelectionChange(invalidateMinecraftSkinRequest)
onBeforeUnmount(stopPresetSelectionListener)
onBeforeUnmount(invalidateMinecraftSkinRequest)
onBeforeUnmount(() => {
  disposed = true
  skinResolutionGeneration += 1
})

const petDetailResetLabel = computed(() => t(`pages.preference.block.detailReset.${activePetDetailTab.value}`))
const petDetailResetDisabled = computed(() => editorsLocked.value)

function confirmPetDetailReset() {
  if (petDetailResetDisabled.value) return
  const tab = activePetDetailTab.value
  Modal.confirm({
    title: t(`pages.preference.block.detailResetConfirm.${tab}`),
    okType: 'danger',
    onOk: () => {
      if (editorsLocked.value) return
      if (tab === 'eyebrows') {
        blockStore.resetDmeloperEyebrows()
        return
      }
      markPresetUserEdit()
      const defaults = createDefaultPet3dPreset()
      if (tab === 'body') {
        blockStore.updateActivePet3dPreset({
          petHeadScalePercent: defaults.petHeadScalePercent,
          petRotationDegrees: defaults.petRotationDegrees,
          petDeskOffset: defaults.petDeskOffset,
        })
      } else {
        blockStore.updateActivePet3dPreset({
          petRightArmBendPercent: defaults.petRightArmBendPercent,
          petRightArmSpreadDegrees: defaults.petRightArmSpreadDegrees,
          petLeftArmBendPercent: defaults.petLeftArmBendPercent,
          petLeftArmSpreadDegrees: defaults.petLeftArmSpreadDegrees,
        })
        blockStore.resetDmeloperPalmColor()
      }
    },
  })
}
</script>

<template>
  <PreferenceSections>
    <ProList :title="$t('pages.preference.block.title')">
      <ProListItem
        :description="$t('pages.preference.general.hints.visible')"
        :title="$t('pages.preference.general.labels.visible')"
      >
        <Switch
          v-model:checked="blockStore.window.visible"
          data-preset-common-setting
        />
      </ProListItem>

      <ProListItem
        v-if="PET_MODEL_OPTIONS.length > 1"
        :description="$t('pages.preference.block.hints.petModel')"
        :title="$t('pages.preference.block.labels.petModel')"
      >
        <Select
          v-model:value="selectedModelId"
        >
          <Select.Option
            v-for="model in PET_MODEL_OPTIONS"
            :key="model.id"
            :value="model.id"
          >
            {{ model.label }}
          </Select.Option>
        </Select>
      </ProListItem>

      <ProListItem
        v-if="selectedModelId === 'dmeloper'"
        :description="$t('pages.preference.block.hints.minecraftSkinUsername')"
        :title="$t('pages.preference.block.labels.minecraftSkinUsername')"
      >
        <Flex
          class="w-80"
          gap="small"
          vertical
        >
          <Flex gap="small">
            <Input.Search
              v-model:value="minecraftSkinUsernameDraft"
              allow-clear
              :aria-label="$t('pages.preference.block.labels.minecraftSkinUsername')"
              autocomplete="off"
              class="min-w-0 flex-1"
              :disabled="minecraftSkinLoading"
              :enter-button="$t('pages.preference.block.labels.applyMinecraftSkin')"
              :loading="minecraftSkinLoading"
              :maxlength="16"
              :placeholder="$t('pages.preference.block.placeholders.minecraftSkinUsername')"
              :spellcheck="false"
              @search="applyMinecraftSkinNickname"
            />
            <Button
              :aria-label="$t('pages.preference.skinLibrary.buttons.open')"
              class="skin-library-open-button"
              :disabled="minecraftSkinLoading || skinLibraryMigrationLoading"
              @click="emit('openSkinLibrary')"
            >
              <template #icon>
                <span
                  aria-hidden="true"
                  class="skin-library-open-icon i-lucide:folder-open size-4"
                />
              </template>
            </Button>
          </Flex>
          <span
            aria-live="polite"
            class="text-xs text-gray-500"
            role="status"
          >
            {{ minecraftSkinSourceStatus }}
          </span>
          <span
            v-if="minecraftSkinLoading"
            aria-live="polite"
            class="text-xs text-gray-500"
            role="status"
          >
            {{ $t('pages.preference.block.status.minecraftSkinLoading') }}
          </span>
          <span
            v-if="minecraftSkinError"
            aria-live="assertive"
            class="text-sm text-red-500"
            role="alert"
          >
            {{ minecraftSkinError }}
          </span>
        </Flex>
      </ProListItem>

      <ProListItem
        v-if="selectedModelId === 'dmeloper'"
        :description="$t('pages.preference.block.hints.dmeloperSkinModel')"
        :title="$t('pages.preference.block.labels.dmeloperSkinModel')"
      >
        <Segmented
          v-model:value="dmeloperSkinModel"
          :disabled="minecraftSkinLoading"
          :options="dmeloperSkinModelOptions"
        />
      </ProListItem>
    </ProList>

    <ProList :title="$t('pages.preference.block.labels.petBehaviorSettings')">
      <Tabs
        v-model:active-key="activePetDetailTab"
        v-stable-detail-height
        class="preference-detail-tabs"
      >
        <TabPane
          key="body"
          force-render
          :tab="$t('pages.preference.block.detailTabs.body')"
        >
          <Flex
            gap="middle"
            vertical
          >
            <ProListItem
              :description="$t('pages.preference.block.hints.petHeadScale')"
              :title="$t('pages.preference.block.labels.petHeadScale')"
              vertical
            >
              <DefaultSnapSlider
                class="m-[0]!"
                :default-value="defaultPet3dPreset.petHeadScalePercent"
                :max="200"
                :min="25"
                :value="activePet3dPreset.petHeadScalePercent"
                @update:value="updateViewportSetting('petHeadScalePercent', $event)"
              />
            </ProListItem>

            <ProListItem
              :description="$t('pages.preference.environment.hints.petRotation')"
              :title="$t('pages.preference.environment.labels.petRotation')"
              vertical
            >
              <DefaultSnapSlider
                class="m-[0]!"
                :default-value="defaultPet3dPreset.petRotationDegrees"
                :max="presetRanges.preset.petRotationDegrees.max"
                :min="presetRanges.preset.petRotationDegrees.min"
                :value="activePet3dPreset.petRotationDegrees"
                @update:value="updateViewportSetting('petRotationDegrees', $event)"
              />
            </ProListItem>

            <ProListItem
              :description="$t('pages.preference.environment.hints.deskDistance')"
              :title="$t('pages.preference.environment.labels.deskDistance')"
              vertical
            >
              <DefaultSnapSlider
                v-model:value="petDeskDistance"
                class="m-[0]!"
                :default-value="0 - defaultPet3dPreset.petDeskOffset"
                :max="0 - presetRanges.preset.petDeskOffset.min"
                :min="0 - presetRanges.preset.petDeskOffset.max"
              />
            </ProListItem>
          </Flex>
        </TabPane>
        <TabPane
          key="arms"
          force-render
          :tab="$t('pages.preference.block.detailTabs.arms')"
        >
          <Flex
            gap="middle"
            vertical
          >
            <div class="grid grid-cols-2 gap-4">
              <Flex
                gap="middle"
                vertical
              >
                <ProListItem
                  :description="$t('pages.preference.block.hints.petRightArmBend')"
                  :title="$t('pages.preference.block.labels.petRightArmBend')"
                  vertical
                >
                  <DefaultSnapSlider
                    class="m-[0]!"
                    :default-value="defaultPet3dPreset.petRightArmBendPercent"
                    :max="400"
                    :min="0"
                    :value="activePet3dPreset.petRightArmBendPercent"
                    @update:value="updateViewportSetting('petRightArmBendPercent', $event)"
                  />
                </ProListItem>

                <ProListItem
                  :description="$t('pages.preference.block.hints.petRightArmSpread')"
                  :title="$t('pages.preference.block.labels.petRightArmSpread')"
                  vertical
                >
                  <DefaultSnapSlider
                    v-model:value="petRightArmSpread"
                    class="m-[0]!"
                    :default-value="0 - defaultPet3dPreset.petRightArmSpreadDegrees"
                    :max="45"
                    :min="-45"
                  />
                </ProListItem>
              </Flex>
              <Flex
                gap="middle"
                vertical
              >
                <ProListItem
                  :description="$t('pages.preference.block.hints.petLeftArmBend')"
                  :title="$t('pages.preference.block.labels.petLeftArmBend')"
                  vertical
                >
                  <DefaultSnapSlider
                    class="m-[0]!"
                    :default-value="defaultPet3dPreset.petLeftArmBendPercent"
                    :max="400"
                    :min="0"
                    :value="activePet3dPreset.petLeftArmBendPercent"
                    @update:value="updateViewportSetting('petLeftArmBendPercent', $event)"
                  />
                </ProListItem>

                <ProListItem
                  :description="$t('pages.preference.block.hints.petLeftArmSpread')"
                  :title="$t('pages.preference.block.labels.petLeftArmSpread')"
                  vertical
                >
                  <DefaultSnapSlider
                    class="m-[0]!"
                    :default-value="defaultPet3dPreset.petLeftArmSpreadDegrees"
                    :max="45"
                    :min="-45"
                    :value="activePet3dPreset.petLeftArmSpreadDegrees"
                    @update:value="updateViewportSetting('petLeftArmSpreadDegrees', $event)"
                  />
                </ProListItem>
              </Flex>
            </div>

            <ProListItem
              v-if="selectedModelId === 'dmeloper'"
              :description="$t('pages.preference.block.hints.dmeloperPalmColor')"
              :title="$t('pages.preference.block.labels.dmeloperPalmColor')"
            >
              <Flex
                align="center"
                gap="small"
              >
                <ColorPicker
                  v-model:value="dmeloperPalmColor"
                  :label="$t('pages.preference.block.labels.dmeloperPalmColor')"
                />
                <Button
                  :aria-label="$t('pages.preference.block.labels.resetDmeloperPalmColor')"
                  :disabled="!automaticPalmColor"
                  @click="resetDmeloperPalmColor"
                >
                  {{ $t('pages.preference.block.labels.setAutomatically') }}
                </Button>
              </Flex>
            </ProListItem>
          </Flex>
        </TabPane>
        <TabPane
          v-if="selectedModelId === 'dmeloper'"
          key="eyebrows"
          force-render
          :tab="$t('pages.preference.block.detailTabs.eyebrows')"
        >
          <Flex
            gap="middle"
            vertical
          >
            <ProListItem
              :description="$t('pages.preference.block.hints.dmeloperEyebrowsEnabled')"
              :title="$t('pages.preference.block.labels.dmeloperEyebrowsEnabled')"
            >
              <Switch v-model:checked="dmeloperEyebrowsEnabled" />
            </ProListItem>

            <OptionTransition>
              <Flex
                v-show="dmeloperEyebrowsEnabled"
                data-detail-height-option
                gap="middle"
                vertical
              >
                <ProListItem
                  :description="$t('pages.preference.block.hints.eyebrowAnimation')"
                  :title="$t('pages.preference.block.labels.eyebrowAnimation')"
                >
                  <Switch
                    v-model:checked="eyebrowAnimationEnabled"
                    :disabled="!dmeloperEyebrowsEnabled"
                  />
                </ProListItem>
                <ProListItem
                  :description="$t('pages.preference.block.hints.dmeloperEyebrowColor')"
                  :title="$t('pages.preference.block.labels.dmeloperEyebrowColor')"
                >
                  <Flex
                    align="center"
                    gap="small"
                  >
                    <ColorPicker
                      v-model:value="dmeloperEyebrowColor"
                      :disabled="!dmeloperEyebrowsEnabled"
                      :label="$t('pages.preference.block.labels.dmeloperEyebrowColor')"
                    />
                    <Button
                      :aria-label="$t('pages.preference.block.labels.setDmeloperEyebrowColorAutomatically')"
                      :disabled="automaticEyebrowColorDisabled"
                      @click="setDmeloperEyebrowColorAutomatically"
                    >
                      {{ $t('pages.preference.block.labels.setAutomatically') }}
                    </Button>
                  </Flex>
                </ProListItem>
                <div class="grid grid-cols-3 gap-4">
                  <ProListItem
                    :title="$t('pages.preference.block.labels.dmeloperEyebrowCenter')"
                    vertical
                  >
                    <DefaultSnapSlider
                      v-model:value="dmeloperEyebrowCenter"
                      class="m-[0]!"
                      :default-value="defaultDmeloperEyebrows.centerOffsetPixels"
                      :disabled="!dmeloperEyebrowsEnabled"
                      :max="DMELOPER_EYEBROW_LIMITS.centerOffsetPixels.max"
                      :min="DMELOPER_EYEBROW_LIMITS.centerOffsetPixels.min"
                    />
                  </ProListItem>
                  <ProListItem
                    :title="$t('pages.preference.block.labels.dmeloperEyebrowHeight')"
                    vertical
                  >
                    <DefaultSnapSlider
                      v-model:value="dmeloperEyebrowHeight"
                      class="m-[0]!"
                      :default-value="defaultDmeloperEyebrows.heightOffsetPixels"
                      :disabled="!dmeloperEyebrowsEnabled"
                      :max="DMELOPER_EYEBROW_LIMITS.heightOffsetPixels.max"
                      :min="DMELOPER_EYEBROW_LIMITS.heightOffsetPixels.min"
                    />
                  </ProListItem>
                  <ProListItem
                    :title="$t('pages.preference.block.labels.dmeloperEyebrowSpacing')"
                    vertical
                  >
                    <DefaultSnapSlider
                      v-model:value="dmeloperEyebrowSpacing"
                      class="m-[0]!"
                      :default-value="defaultDmeloperEyebrows.spacingPixels"
                      :disabled="!dmeloperEyebrowsEnabled"
                      :max="DMELOPER_EYEBROW_LIMITS.spacingPixels.max"
                      :min="DMELOPER_EYEBROW_LIMITS.spacingPixels.min"
                    />
                  </ProListItem>
                  <ProListItem
                    :title="$t('pages.preference.block.labels.dmeloperEyebrowWidth')"
                    vertical
                  >
                    <DefaultSnapSlider
                      v-model:value="dmeloperEyebrowWidth"
                      class="m-[0]!"
                      :default-value="defaultDmeloperEyebrows.widthPixels"
                      :disabled="!dmeloperEyebrowsEnabled"
                      :max="DMELOPER_EYEBROW_LIMITS.widthPixels.max"
                      :min="DMELOPER_EYEBROW_LIMITS.widthPixels.min"
                    />
                  </ProListItem>
                  <ProListItem
                    :title="$t('pages.preference.block.labels.dmeloperEyebrowThickness')"
                    vertical
                  >
                    <DefaultSnapSlider
                      v-model:value="dmeloperEyebrowThickness"
                      class="m-[0]!"
                      :default-value="defaultDmeloperEyebrows.thicknessPixels"
                      :disabled="!dmeloperEyebrowsEnabled"
                      :max="DMELOPER_EYEBROW_LIMITS.thicknessPixels.max"
                      :min="DMELOPER_EYEBROW_LIMITS.thicknessPixels.min"
                    />
                  </ProListItem>
                  <ProListItem
                    :title="$t('pages.preference.block.labels.dmeloperEyebrowDepth')"
                    vertical
                  >
                    <DefaultSnapSlider
                      v-model:value="dmeloperEyebrowDepth"
                      class="m-[0]!"
                      :default-value="0 - defaultDmeloperEyebrows.depthPercent"
                      :disabled="!dmeloperEyebrowsEnabled"
                      :max="0 - DMELOPER_EYEBROW_LIMITS.depthPercent.min"
                      :min="0 - DMELOPER_EYEBROW_LIMITS.depthPercent.max"
                    />
                  </ProListItem>
                </div>
              </Flex>
            </OptionTransition>
          </Flex>
        </TabPane>
      </Tabs>

      <Button
        block
        :disabled="petDetailResetDisabled"
        @click="confirmPetDetailReset"
      >
        {{ petDetailResetLabel }}
      </Button>
    </ProList>
  </PreferenceSections>
</template>

<style scoped>
.skin-library-open-button {
  align-items: center;
  display: inline-flex;
  height: 32px;
  justify-content: center;
  min-width: 32px;
  padding: 0;
  width: 32px;
}

.skin-library-open-icon {
  display: block;
  flex: none;
}
</style>
