<script setup lang="ts">
import { Button, Flex, Input, Modal, Segmented, Select, Switch } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { DmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'
import type { PetModelId } from '@/config/model3d'
import type { Pet3dPreset } from '@/stores/cat'
import type { NormalizedVoxelSkin, VoxelSkinModel } from '@/utils/three3d/voxelSkin'

import ColorPicker from '@/components/color-picker/index.vue'
import DefaultSnapSlider from '@/components/default-snap-slider/index.vue'
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
import { resolveDefaultDmeloperPalmColor, resolveDmeloperSkinUrl } from '@/services/dmeloperSkin'
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
import { createDefaultPet3dPreset, useCatStore } from '@/stores/cat'
import { createSkinFaceThumbnailPngBase64 } from '@/utils/skinThumbnail'
import { decodeVoxelSkin, suggestVoxelSkinPalmColor } from '@/utils/three3d/voxelSkin'

const emit = defineEmits<{
  openSkinLibrary: []
}>()

const catStore = useCatStore()
const defaultPet3dPreset = createDefaultPet3dPreset()
const defaultDmeloperEyebrows = createDefaultDmeloperEyebrowPreset()
const { t } = useI18n()
const minecraftSkinError = ref<string>()
const minecraftSkinLoading = ref(false)
const skinLibraryMigrationLoading = ref(true)
const minecraftSkinUsernameDraft = ref(
  catStore.customization3d.minecraftSkinUsername ?? '',
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
  get: () => catStore.customization3d.selectedModelId,
  set: (modelId: PetModelId) => {
    if (modelId !== catStore.customization3d.selectedModelId) {
      invalidateMinecraftSkinRequest()
    }
    catStore.selectPetModel(modelId)
  },
})
const activePet3dPreset = computed(() => catStore.activePet3dPreset)
type PresetNumberKey = {
  [Key in keyof Pet3dPreset]: Pet3dPreset[Key] extends number ? Key : never
}[keyof Pet3dPreset]

function updateViewportSetting(
  key: PresetNumberKey,
  value: number,
) {
  Object.assign(activePet3dPreset.value, { [key]: value })
}

function createDmeloperEyebrowSetting<Key extends keyof DmeloperEyebrowPreset>(
  key: Key,
) {
  return computed<DmeloperEyebrowPreset[Key]>({
    get: () => activePet3dPreset.value.dmeloperEyebrows[key],
    set: value => catStore.updateDmeloperEyebrows({
      [key]: value,
    } as Partial<DmeloperEyebrowPreset>),
  })
}
const dmeloperEyebrowsEnabled = createDmeloperEyebrowSetting('enabled')
const dmeloperEyebrowColor = createDmeloperEyebrowSetting('color')
const dmeloperEyebrowHeight = createDmeloperEyebrowSetting('heightOffsetPixels')
const dmeloperEyebrowSpacing = createDmeloperEyebrowSetting('spacingPixels')
const dmeloperEyebrowWidth = createDmeloperEyebrowSetting('widthPixels')
const dmeloperEyebrowThickness = createDmeloperEyebrowSetting('thicknessPixels')
const dmeloperEyebrowCenter = createDmeloperEyebrowSetting('centerOffsetPixels')
const dmeloperEyebrowDepth = createDmeloperEyebrowSetting('depthPercent')
const automaticPalmColor = computed(() => {
  const analyzed = analyzedSkin.value
  if (!analyzed || analyzed.dataUrl !== catStore.customization3d.dmeloperSkinDataUrl) return undefined
  return suggestVoxelSkinPalmColor(analyzed.skin.data, dmeloperSkinModel.value)
})

function resetDmeloperPalmColor() {
  if (automaticPalmColor.value) catStore.resetDmeloperPalmColor(automaticPalmColor.value)
}

const dmeloperPalmColor = computed({
  get: () => activePet3dPreset.value.dmeloperPalmColor,
  set: color => catStore.updateDmeloperPalmColor(color),
})
const dmeloperSkinModel = computed<VoxelSkinModel>({
  get: () => catStore.customization3d.dmeloperSkinModel === 'slim' ? 'slim' : 'wide',
  set: (skinModel) => {
    markPresetUserEdit()
    catStore.setDmeloperSkinModel(skinModel)
  },
})
const dmeloperSkinModelOptions = computed(() => [
  {
    disabled: !wideAvailable.value,
    label: t('pages.preference.cat.options.dmeloperSkinModel.wide'),
    value: 'wide',
  },
  {
    label: t('pages.preference.cat.options.dmeloperSkinModel.slim'),
    value: 'slim',
  },
])
const minecraftSkinSourceStatus = computed(() => {
  if (getSkinSelectionId(catStore.customization3d) === BUILTIN_DMELOPER_SKIN.id) {
    return t('pages.preference.cat.status.defaultSkin')
  }
  const username = catStore.customization3d.minecraftSkinUsername
  if (username && catStore.customization3d.dmeloperSkinDataUrl) {
    return t('pages.preference.cat.status.minecraftSkinApplied', {
      name: username,
      model: t(`pages.preference.cat.options.dmeloperSkinModel.${dmeloperSkinModel.value}`),
    })
  }
  if (catStore.customization3d.dmeloperSkinDataUrl) {
    return t('pages.preference.cat.status.localSkin')
  }
  return t('pages.preference.cat.status.defaultSkin')
})

watch(
  () => catStore.customization3d.minecraftSkinUsername,
  (username) => {
    if (!minecraftSkinLoading.value) {
      minecraftSkinUsernameDraft.value = username ?? ''
    }
  },
)

watch(
  () => catStore.customization3d.dmeloperSkinDataUrl,
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
      if (!wideAvailable.value) catStore.setDmeloperSkinModel('slim')
      else if (catStore.customization3d.dmeloperSkinModel === 'auto') catStore.setDmeloperSkinModel(decoded.model)
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
    throw new Error(t('pages.preference.cat.errors.skinRead'))
  }
  return dataUrl.slice(prefix.length)
}

function formatMinecraftSkinError(error: unknown): string {
  const normalized = normalizeMinecraftSkinError(error)
  const baseMessage = t(
    `pages.preference.cat.errors.minecraftSkin.${normalized.code}`,
  )
  if (!normalized.retryable) return baseMessage
  if (normalized.retryAfterSeconds !== undefined) {
    return `${baseMessage} ${t('pages.preference.cat.errors.minecraftSkin.retryAfter', {
      seconds: normalized.retryAfterSeconds,
    })}`
  }
  return `${baseMessage} ${t('pages.preference.cat.errors.minecraftSkin.retry')}`
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
      const palmColor = await resolveDefaultDmeloperPalmColor()
      if (!minecraftSkinRequestGate.isCurrent(generation)) return
      minecraftSkinUsernameDraft.value = ''
      wideAvailable.value = true
      catStore.resetDmeloperSkinToDefault(palmColor)
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
      'pages.preference.cat.errors.minecraftSkin.INVALID_USERNAME',
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

    const applied = catStore.applyMinecraftSkin({
      dataUrl,
      canonicalName: response.canonicalName,
      skinModel: decoded.model,
      palmColor: decoded.suggestedPalmColor,
      libraryEntryId: storedEntry.id,
    })
    if (!applied) {
      throw new MinecraftSkinError({ code: 'INVALID_RESPONSE', retryable: false })
    }
    catStore.completeSkinLibraryMigration(storedEntry.id)

    wideAvailable.value = decoded.wideArmLayoutCompatible
    minecraftSkinUsernameDraft.value = response.canonicalName
  } catch (error) {
    if (minecraftSkinRequestGate.isCurrent(generation)) {
      reportDiagnostic('error', 'skin.apply_java', error)
      minecraftSkinError.value = error instanceof SkinLibraryError
        ? t('pages.preference.cat.errors.skinStore')
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
    const migration = catStore.getPendingSkinLibraryMigration()
    if (!migration) {
      if (!catStore.customization3d.skinLibraryMigrationCompleted) {
        catStore.completeSkinLibraryMigration()
      }
      return
    }
    const blob = await fetch(migration.dataUrl).then((response) => {
      if (!response.ok) throw new Error(t('pages.preference.cat.errors.skinRead'))
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
      && !catStore.customization3d.skinLibraryMigrationCompleted
      && catStore.customization3d.dmeloperSkinDataUrl === migration.dataUrl
    ) {
      catStore.completeSkinLibraryMigration(storedEntry.id, migration.dataUrl)
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

function confirmPetBehaviorReset() {
  Modal.confirm({
    title: t('pages.preference.cat.confirm.resetPetBehavior'),
    okType: 'danger',
    onOk: () => catStore.resetPetBehavior(),
  })
}

function confirmEyebrowReset() {
  if (!dmeloperEyebrowsEnabled.value) return
  Modal.confirm({
    title: t('pages.preference.cat.confirm.resetEyebrows'),
    okType: 'danger',
    onOk: () => {
      if (dmeloperEyebrowsEnabled.value) catStore.resetDmeloperEyebrows()
    },
  })
}
</script>

<template>
  <PreferenceSections>
    <ProList :title="$t('pages.preference.cat.title')">
      <ProListItem
        :description="$t('pages.preference.general.hints.visible')"
        :title="$t('pages.preference.general.labels.visible')"
      >
        <Switch
          v-model:checked="catStore.window.visible"
          data-preset-common-setting
        />
      </ProListItem>

      <ProListItem
        v-if="PET_MODEL_OPTIONS.length > 1"
        :description="$t('pages.preference.cat.hints.petModel')"
        :title="$t('pages.preference.cat.labels.petModel')"
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
        :description="$t('pages.preference.cat.hints.minecraftSkinUsername')"
        :title="$t('pages.preference.cat.labels.minecraftSkinUsername')"
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
              :aria-label="$t('pages.preference.cat.labels.minecraftSkinUsername')"
              autocomplete="off"
              class="min-w-0 flex-1"
              :disabled="minecraftSkinLoading"
              :enter-button="$t('pages.preference.cat.labels.applyMinecraftSkin')"
              :loading="minecraftSkinLoading"
              :maxlength="16"
              :placeholder="$t('pages.preference.cat.placeholders.minecraftSkinUsername')"
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
            {{ $t('pages.preference.cat.status.minecraftSkinLoading') }}
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
        :description="$t('pages.preference.cat.hints.dmeloperSkinModel')"
        :title="$t('pages.preference.cat.labels.dmeloperSkinModel')"
      >
        <Segmented
          v-model:value="dmeloperSkinModel"
          :disabled="minecraftSkinLoading"
          :options="dmeloperSkinModelOptions"
        />
      </ProListItem>
    </ProList>

    <ProList :title="$t('pages.preference.cat.labels.petBehaviorSettings')">
      <ProListItem
        :description="$t('pages.preference.cat.hints.petHeadScale')"
        :title="$t('pages.preference.cat.labels.petHeadScale')"
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
          class="m-[0]!"
          :default-value="defaultPet3dPreset.petDeskOffset"
          :max="presetRanges.preset.petDeskOffset.max"
          :min="presetRanges.preset.petDeskOffset.min"
          :value="activePet3dPreset.petDeskOffset"
          @update:value="updateViewportSetting('petDeskOffset', $event)"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.cat.hints.petRightArmBend')"
        :title="$t('pages.preference.cat.labels.petRightArmBend')"
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
        :description="$t('pages.preference.cat.hints.petRightArmSpread')"
        :title="$t('pages.preference.cat.labels.petRightArmSpread')"
        vertical
      >
        <DefaultSnapSlider
          class="m-[0]!"
          :default-value="defaultPet3dPreset.petRightArmSpreadDegrees"
          :max="45"
          :min="-45"
          :value="activePet3dPreset.petRightArmSpreadDegrees"
          @update:value="updateViewportSetting('petRightArmSpreadDegrees', $event)"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.cat.hints.petLeftArmBend')"
        :title="$t('pages.preference.cat.labels.petLeftArmBend')"
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
        :description="$t('pages.preference.cat.hints.petLeftArmSpread')"
        :title="$t('pages.preference.cat.labels.petLeftArmSpread')"
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

      <Button
        block
        :danger="true"
        @click="confirmPetBehaviorReset"
      >
        {{ $t('pages.preference.cat.labels.resetPetBehavior') }}
      </Button>
    </ProList>

    <ProList
      v-if="selectedModelId === 'dmeloper'"
      :title="$t('pages.preference.cat.labels.dmeloperPalmSettings')"
    >
      <ProListItem
        :description="$t('pages.preference.cat.hints.dmeloperPalmColor')"
        :title="$t('pages.preference.cat.labels.dmeloperPalmColor')"
      >
        <ColorPicker
          v-model:value="dmeloperPalmColor"
          :label="$t('pages.preference.cat.labels.dmeloperPalmColor')"
        />
      </ProListItem>

      <Button
        block
        :disabled="!automaticPalmColor"
        @click="resetDmeloperPalmColor"
      >
        {{ $t('pages.preference.cat.labels.resetDmeloperPalmColor') }}
      </Button>
    </ProList>

    <ProList
      v-if="selectedModelId === 'dmeloper'"
      :title="$t('pages.preference.cat.labels.dmeloperEyebrowSettings')"
    >
      <ProListItem
        :description="$t('pages.preference.cat.hints.dmeloperEyebrowsEnabled')"
        :title="$t('pages.preference.cat.labels.dmeloperEyebrowsEnabled')"
      >
        <Switch v-model:checked="dmeloperEyebrowsEnabled" />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.cat.hints.eyebrowAnimation')"
        :title="$t('pages.preference.cat.labels.eyebrowAnimation')"
      >
        <Switch
          v-model:checked="catStore.model.eyebrowAnimationEnabled"
          :disabled="!dmeloperEyebrowsEnabled"
        />
      </ProListItem>

      <ProListItem
        :description="$t('pages.preference.cat.hints.dmeloperEyebrowColor')"
        :title="$t('pages.preference.cat.labels.dmeloperEyebrowColor')"
      >
        <ColorPicker
          v-model:value="dmeloperEyebrowColor"
          :disabled="!dmeloperEyebrowsEnabled"
          :label="$t('pages.preference.cat.labels.dmeloperEyebrowColor')"
        />
      </ProListItem>

      <ProListItem
        :title="$t('pages.preference.cat.labels.dmeloperEyebrowHeight')"
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
        :title="$t('pages.preference.cat.labels.dmeloperEyebrowSpacing')"
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
        :title="$t('pages.preference.cat.labels.dmeloperEyebrowWidth')"
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
        :title="$t('pages.preference.cat.labels.dmeloperEyebrowThickness')"
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
        :title="$t('pages.preference.cat.labels.dmeloperEyebrowCenter')"
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
        :title="$t('pages.preference.cat.labels.dmeloperEyebrowDepth')"
        vertical
      >
        <DefaultSnapSlider
          v-model:value="dmeloperEyebrowDepth"
          class="m-[0]!"
          :default-value="defaultDmeloperEyebrows.depthPercent"
          :disabled="!dmeloperEyebrowsEnabled"
          :max="DMELOPER_EYEBROW_LIMITS.depthPercent.max"
          :min="DMELOPER_EYEBROW_LIMITS.depthPercent.min"
        />
      </ProListItem>

      <Button
        block
        :danger="true"
        :disabled="!dmeloperEyebrowsEnabled"
        @click="confirmEyebrowReset"
      >
        {{ $t('pages.preference.cat.labels.resetDmeloperEyebrows') }}
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
