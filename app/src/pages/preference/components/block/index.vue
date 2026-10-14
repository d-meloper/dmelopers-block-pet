<script setup lang="ts">
import { Button, Flex, Input, Modal, Segmented, Select, Switch, TabPane, Tabs } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { DmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'
import type { HeadbuttRecoilSettings } from '@/config/headbuttRecoil'
import type { PetModelId } from '@/config/model3d'
import type { PetAnimationMode } from '@/config/petAnimation'
import type { TypingMotionSettings } from '@/config/typingMotion'
import type { Pet3dPreset } from '@/stores/block'
import type { NormalizedVoxelSkin, VoxelSkinModel } from '@/utils/three3d/voxelSkin'

import ColorPicker from '@/components/color-picker/index.vue'
import { toSliderDisplayValue } from '@/components/default-snap-slider/displayValue'
import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
import OptionTransition from '@/components/option-transition/index.vue'
import { vStableDetailHeight } from '@/components/preference-detail-tabs/height'
import PreferenceOptionGroup from '@/components/preference-option-group/index.vue'
import PreferenceSections from '@/components/preference-sections/index.vue'
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { createDefaultDmeloperEyebrowPreset, DMELOPER_EYEBROW_LIMITS } from '@/config/dmeloperEyebrows'
import { normalizeHeadbuttMaxRadiusOffset } from '@/config/headbuttRadius'
import { normalizeHeadbuttRecoilSettings } from '@/config/headbuttRecoil'
import { PET_MODEL_OPTIONS } from '@/config/model3d'
import presetRanges from '@/config/presetRanges.json'
import { BUILTIN_DMELOPER_SKIN, getSkinSelectionId } from '@/config/skinIdentity'
import { normalizeTypingMotionSettings } from '@/config/typingMotion'
import { markPresetUserEdit, onPresetSelectionChange } from '@/features/presets/editIntent'
import { beginPresetNativeEdit } from '@/features/presets/operations'
import { armControlOrderRotation, commitArmControlOrderRotation } from '@/features/scene/armControlOrder'
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

import HeadbuttRecoilOptions from './headbutt-recoil-options.vue'
import TypingMotionOptions from './typing-motion-options.vue'

const emit = defineEmits<{
  openSkinLibrary: []
}>()

const blockStore = useBlockStore()
const defaultPet3dPreset = createDefaultPet3dPreset()
const defaultDmeloperEyebrows = createDefaultDmeloperEyebrowPreset()
const { t } = useI18n()
type PetDetailTab = 'body' | 'arms' | 'eyebrows' | 'motion'
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
watch(activePet3dPreset, preset => commitArmControlOrderRotation(preset.sceneRotationOffsetDegrees), { immediate: true })
const petAnimationMode = computed<PetAnimationMode>({
  get: () => activePet3dPreset.value.petAnimationMode,
  set: (mode) => {
    if (editorsLocked.value || mode === activePet3dPreset.value.petAnimationMode
      || (mode !== 'default' && mode !== 'headbutt')) {
      return
    }
    markPresetUserEdit()
    activePet3dPreset.value.petAnimationMode = mode
  },
})
const petAnimationModeOptions = computed(() => ['default', 'headbutt'].map(value => ({
  value,
  label: t(`pages.preference.block.options.petAnimationMode.${value}`),
})))
function updateHeadbuttRecoilSettings(settings: HeadbuttRecoilSettings) {
  if (editorsLocked.value || petAnimationMode.value !== 'headbutt') return
  const next = normalizeHeadbuttRecoilSettings(settings, activePet3dPreset.value)
  if (Object.entries(next).every(([key, value]) => activePet3dPreset.value[key as keyof HeadbuttRecoilSettings] === value)) return
  markPresetUserEdit()
  blockStore.updateActivePet3dPreset(next)
}
function updateHeadbuttMaxRadiusOffset(value: number) {
  if (editorsLocked.value || petAnimationMode.value !== 'headbutt' || !Number.isFinite(value)) return
  const next = normalizeHeadbuttMaxRadiusOffset(value)
  if (next === activePet3dPreset.value.petHeadbuttMaxRadiusOffset) return
  markPresetUserEdit()
  blockStore.updateActivePet3dPreset({ petHeadbuttMaxRadiusOffset: next })
}
function updateTypingMotionSettings(settings: TypingMotionSettings) {
  if (editorsLocked.value || petAnimationMode.value !== 'default') return
  const next = normalizeTypingMotionSettings(settings, activePet3dPreset.value)
  if (Object.entries(next).every(([key, value]) => activePet3dPreset.value[key as keyof TypingMotionSettings] === value)) return
  markPresetUserEdit()
  blockStore.updateActivePet3dPreset(next)
}
const petShoulderTorsoConnected = computed({
  get: () => activePet3dPreset.value.petShoulderTorsoConnected === true,
  set: (enabled: boolean) => {
    if (editorsLocked.value || enabled === activePet3dPreset.value.petShoulderTorsoConnected) return
    markPresetUserEdit()
    activePet3dPreset.value.petShoulderTorsoConnected = enabled
  },
})
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
const armControlDefinitions = {
  right: { disabledKey: 'petRightArmDisabled', visibleLabel: 'petRightArmVisible', bendKey: 'petRightArmBendPercent', spreadKey: 'petRightArmSpreadDegrees', bendLabel: 'petRightArmBend', spreadLabel: 'petRightArmSpread' },
  left: { disabledKey: 'petLeftArmDisabled', visibleLabel: 'petLeftArmVisible', bendKey: 'petLeftArmBendPercent', spreadKey: 'petLeftArmSpreadDegrees', bendLabel: 'petLeftArmBend', spreadLabel: 'petLeftArmSpread' },
} as const
const armControls = computed(() => {
  const rotation = toSliderDisplayValue(armControlOrderRotation.value, { min: -360, max: 360, defaultValue: defaultPet3dPreset.sceneRotationOffsetDegrees })
  const leftFirst = (rotation >= 0.3 && rotation <= 0.8) || (rotation >= -0.7 && rotation <= -0.2)
  const order = leftFirst ? ['left', 'right'] as const : ['right', 'left'] as const
  return order.map(side => ({ side, ...armControlDefinitions[side] }))
})

function isArmVisible(side: 'right' | 'left') {
  return activePet3dPreset.value[armControlDefinitions[side].disabledKey] !== true
}

function updateArmVisibility(side: 'right' | 'left', visible: boolean) {
  const key = armControlDefinitions[side].disabledKey
  const disabled = !visible
  if (editorsLocked.value || activePet3dPreset.value[key] === disabled) return
  markPresetUserEdit()
  activePet3dPreset.value[key] = disabled
}

function updateArmSetting(side: 'right' | 'left', setting: 'bend' | 'spread', value: number) {
  const arm = armControlDefinitions[side]
  if (editorsLocked.value || !isArmVisible(side)) return
  updateViewportSetting(setting === 'bend' ? arm.bendKey : arm.spreadKey, value)
}

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
          petShoulderTorsoConnected: defaults.petShoulderTorsoConnected,
        })
      } else if (tab === 'motion') {
        blockStore.updateActivePet3dPreset({
          petAnimationMode: defaults.petAnimationMode,
          petHeadbuttRecoilEnabled: defaults.petHeadbuttRecoilEnabled,
          petHeadbuttMaxRadiusOffset: defaults.petHeadbuttMaxRadiusOffset,
          petHeadbuttRecoilStrengthPercent: defaults.petHeadbuttRecoilStrengthPercent,
          petHeadbuttRecoilWobblePercent: defaults.petHeadbuttRecoilWobblePercent,
          petTypingHandLiftPercent: defaults.petTypingHandLiftPercent,
          petTypingMaxRadiusOffset: defaults.petTypingMaxRadiusOffset,
          petTypingBodyMotionPercent: defaults.petTypingBodyMotionPercent,
          petTypingReturnSpeedPercent: defaults.petTypingReturnSpeedPercent,
        })
      } else {
        blockStore.updateActivePet3dPreset({
          petRightArmDisabled: defaults.petRightArmDisabled,
          petLeftArmDisabled: defaults.petLeftArmDisabled,
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
              v-if="selectedModelId === 'dmeloper'"
              :description="$t('pages.preference.block.hints.petShoulderTorsoConnected')"
              :title="$t('pages.preference.block.labels.petShoulderTorsoConnected')"
            >
              <Switch
                v-model:checked="petShoulderTorsoConnected"
                :aria-label="$t('pages.preference.block.labels.petShoulderTorsoConnected')"
                :disabled="editorsLocked"
              />
            </ProListItem>
            <ProListItem
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
            <div class="grid grid-cols-2 items-start gap-4">
              <PreferenceOptionGroup
                v-for="arm in armControls"
                :key="arm.side"
              >
                <ProListItem
                  plain
                  :title="$t(`pages.preference.block.labels.${arm.visibleLabel}`)"
                >
                  <Switch
                    :aria-label="$t(`pages.preference.block.labels.${arm.visibleLabel}`)"
                    :checked="isArmVisible(arm.side)"
                    :disabled="editorsLocked"
                    @update:checked="updateArmVisibility(arm.side, $event)"
                  />
                </ProListItem>
                <OptionTransition>
                  <Flex
                    v-show="isArmVisible(arm.side)"
                    data-detail-height-option
                    :gap="32"
                    vertical
                  >
                    <ProListItem
                      plain
                      :title="$t(`pages.preference.block.labels.${arm.bendLabel}`)"
                      vertical
                    >
                      <DefaultSnapSlider
                        class="m-[0]!"
                        :default-value="defaultPet3dPreset[arm.bendKey]"
                        :disabled="editorsLocked || !isArmVisible(arm.side)"
                        :max="400"
                        :min="0"
                        :value="activePet3dPreset[arm.bendKey]"
                        @update:value="updateArmSetting(arm.side, 'bend', $event)"
                      />
                    </ProListItem>

                    <ProListItem
                      plain
                      :title="$t(`pages.preference.block.labels.${arm.spreadLabel}`)"
                      vertical
                    >
                      <DefaultSnapSlider
                        class="m-[0]!"
                        :default-value="arm.side === 'right' ? 0 - defaultPet3dPreset[arm.spreadKey] : defaultPet3dPreset[arm.spreadKey]"
                        :disabled="editorsLocked || !isArmVisible(arm.side)"
                        :max="45"
                        :min="-45"
                        :value="arm.side === 'right' ? 0 - activePet3dPreset[arm.spreadKey] : activePet3dPreset[arm.spreadKey]"
                        @update:value="updateArmSetting(arm.side, 'spread', arm.side === 'right' ? 0 - $event : $event)"
                      />
                    </ProListItem>
                  </Flex>
                </OptionTransition>
              </PreferenceOptionGroup>
            </div>

            <ProListItem
              v-if="selectedModelId === 'dmeloper'"
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
          <PreferenceOptionGroup>
            <ProListItem
              plain
              :title="$t('pages.preference.block.labels.dmeloperEyebrowsEnabled')"
            >
              <Switch v-model:checked="dmeloperEyebrowsEnabled" />
            </ProListItem>

            <OptionTransition>
              <Flex
                v-show="dmeloperEyebrowsEnabled"
                data-detail-height-option
                :gap="32"
                vertical
              >
                <ProListItem
                  plain
                  :title="$t('pages.preference.block.labels.eyebrowAnimation')"
                >
                  <Switch
                    v-model:checked="eyebrowAnimationEnabled"
                    :disabled="!dmeloperEyebrowsEnabled"
                  />
                </ProListItem>
                <ProListItem
                  plain
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
                    plain
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
                    plain
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
                    plain
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
                    plain
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
                    plain
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
                    plain
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
          </PreferenceOptionGroup>
        </TabPane>
        <TabPane
          key="motion"
          force-render
          :tab="$t('pages.preference.block.detailTabs.motion')"
        >
          <Flex
            gap="middle"
            vertical
          >
            <ProListItem :title="$t('pages.preference.block.labels.petAnimationMode')">
              <Segmented
                v-model:value="petAnimationMode"
                :disabled="editorsLocked"
                :options="petAnimationModeOptions"
              />
            </ProListItem>
            <OptionTransition>
              <TypingMotionOptions
                v-show="petAnimationMode === 'default'"
                data-detail-height-option
                :disabled="editorsLocked || petAnimationMode !== 'default'"
                :settings="activePet3dPreset"
                @update:settings="updateTypingMotionSettings"
              />
            </OptionTransition>
            <OptionTransition>
              <Flex
                v-show="petAnimationMode === 'headbutt'"
                data-detail-height-option
                gap="middle"
                vertical
              >
                <ProListItem
                  :description="$t('pages.preference.block.hints.petHeadbuttMaxRadius')"
                  :title="$t('pages.preference.block.labels.petHeadbuttMaxRadius')"
                  vertical
                >
                  <DefaultSnapSlider
                    class="m-[0]!"
                    :default-value="defaultPet3dPreset.petHeadbuttMaxRadiusOffset"
                    :disabled="editorsLocked || petAnimationMode !== 'headbutt'"
                    display-mode="centered"
                    :display-step="0.1"
                    :max="presetRanges.preset.petHeadbuttMaxRadiusOffset.max"
                    :min="presetRanges.preset.petHeadbuttMaxRadiusOffset.min"
                    :value="activePet3dPreset.petHeadbuttMaxRadiusOffset"
                    @update:value="updateHeadbuttMaxRadiusOffset"
                  />
                </ProListItem>
                <HeadbuttRecoilOptions
                  :disabled="editorsLocked || petAnimationMode !== 'headbutt'"
                  :settings="activePet3dPreset"
                  @update:settings="updateHeadbuttRecoilSettings"
                />
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
