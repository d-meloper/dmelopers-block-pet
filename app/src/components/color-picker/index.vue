<script setup lang="ts">
import { Button, message, Popover, theme } from 'ant-design-vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { markPresetUserEdit, onPresetSelectionChange } from '@/features/presets/editIntent'
import { beginPresetNativeEdit, presetOperationInProgress, presetResetInProgress } from '@/features/presets/operations'
import { setColorPickerOpen } from '@/plugins/window'
import { cancelScreenColorPick, createScreenColorAppearance, pickScreenColor, screenColorPicking } from '@/services/screenColor'

import { hexToHsv, hexToRgb, hsvToHex, normalizeHex, pointToSv, rgbToHex } from './color'
import { activeColorPicker, createScreenColorSession } from './session'

const props = defineProps<{ value: string, label: string, disabled?: boolean }>()

const emit = defineEmits<{ 'update:value': [color: string] }>()

const { t } = useI18n()
const { token } = theme.useToken()
const color = computed(() => normalizeHex(props.value) ?? '#000000')
const rgb = computed(() => hexToRgb(color.value))
const hsv = ref(hexToHsv(color.value))
const hexDraft = ref(color.value)
const open = ref(false)
const opening = ref(false)
const trigger = ref<HTMLButtonElement>()
const panel = ref<HTMLDivElement>()
const blocked = computed(() => !!props.disabled || presetOperationInProgress.value || presetResetInProgress.value)
let requested = false
let disposed = false
let openingRevision = 0

watch(color, (value) => {
  hexDraft.value = value
  // Preserve hue/saturation while dragging through black or grey.
  if (hsvToHex(hsv.value) !== value) hsv.value = hexToHsv(value, hsv.value.h)
})

function applyColor(value: string) {
  const next = normalizeHex(value)
  if (disposed || blocked.value || !next || next === color.value) return
  markPresetUserEdit()
  emit('update:value', next)
}

const session = createScreenColorSession({
  pick: async (id) => {
    // Finish demoting the owner before creating its owned native overlay.
    // The session is already registered, so cancellation also covers this wait.
    await setColorPickerOpen(false)
    return pickScreenColor(id, t('pages.preference.colorPicker.screenInstruction'), createScreenColorAppearance(token.value))
  },
  cancel: cancelScreenColorPick,
  canApply: () => !disposed && !blocked.value,
  selected: applyColor,
  failed: () => message.error(t('pages.preference.colorPicker.screenError')),
})

function close() {
  openingRevision++
  requested = false
  opening.value = false
  open.value = false
  if (activeColorPicker.close === close) {
    activeColorPicker.close = undefined
    void setColorPickerOpen(false).catch(() => {})
  }
}

async function changeOpen(value: boolean) {
  if (!value) {
    close()
    return
  }
  if (requested || disposed || blocked.value || screenColorPicking.value) return
  activeColorPicker.close?.()
  activeColorPicker.close = close
  requested = true
  const revision = ++openingRevision
  opening.value = true
  hexDraft.value = color.value
  hsv.value = hexToHsv(color.value, hsv.value.h)
  try {
    await setColorPickerOpen(true)
    if (revision !== openingRevision || !requested || disposed || blocked.value) return
    open.value = true
    await nextTick()
    panel.value?.focus()
  } catch {
    if (revision === openingRevision && requested) {
      close()
      message.error(t('pages.preference.colorPicker.openError'))
    }
  } finally {
    if (revision === openingRevision) opening.value = false
  }
}

async function pick() {
  if (screenColorPicking.value || blocked.value || disposed) return
  screenColorPicking.value = true
  const release = beginPresetNativeEdit()
  close()
  try {
    await session.start(crypto.randomUUID())
  } finally {
    release()
    screenColorPicking.value = false
  }
}

function changeHsv(value: Partial<typeof hsv.value>) {
  if (!open.value || blocked.value) return
  hsv.value = { ...hsv.value, ...value }
  applyColor(hsvToHex(hsv.value))
}

function movePointer(event: PointerEvent) {
  const element = event.currentTarget as HTMLElement
  if (!element.hasPointerCapture(event.pointerId)) return
  const bounds = element.getBoundingClientRect()
  changeHsv(pointToSv(event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height))
}

function startPointer(event: PointerEvent) {
  if (event.button !== 0 || blocked.value) return
  const element = event.currentTarget as HTMLElement
  element.focus()
  element.setPointerCapture(event.pointerId)
  movePointer(event)
}

function moveKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 10 : 1
  const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowDown: [0, -step], ArrowUp: [0, step] }
  if (!delta[event.key]) return
  event.preventDefault()
  changeHsv({ s: Math.max(0, Math.min(100, hsv.value.s + delta[event.key][0])), v: Math.max(0, Math.min(100, hsv.value.v + delta[event.key][1])) })
}

function changeRgb(index: number, event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (!/^\d{1,3}$/.test(value) || Number(value) > 255) return
  const next = [...rgb.value]
  next[index] = Number(value)
  applyColor(rgbToHex(next))
}

function restoreRgb(index: number, event: FocusEvent) {
  (event.target as HTMLInputElement).value = String(rgb.value[index])
}

function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !requested) return
  event.preventDefault()
  event.stopPropagation()
  close()
  trigger.value?.focus()
}

function visibilityChanged() {
  if (document.hidden) {
    close()
    session.cancel()
  }
}

const stopSelection = onPresetSelectionChange(() => {
  close()
  session.cancel()
})
watch(blocked, (value) => {
  if (value) {
    close()
    session.cancel()
  }
})
onMounted(() => {
  window.addEventListener('blur', close)
  window.addEventListener('keydown', escape, true)
  document.addEventListener('visibilitychange', visibilityChanged)
})
onBeforeUnmount(() => {
  disposed = true
  close()
  session.cancel()
  stopSelection()
  window.removeEventListener('blur', close)
  window.removeEventListener('keydown', escape, true)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <Popover
    :open="open"
    placement="bottomRight"
    trigger="click"
    @open-change="changeOpen"
  >
    <template #content>
      <div
        ref="panel"
        :aria-label="label"
        class="color-picker"
        role="dialog"
        tabindex="-1"
      >
        <div class="mb-3 flex items-center justify-between gap-3">
          <span class="text-sm font-medium">{{ label }}</span>
          <Button
            :aria-label="t('pages.preference.colorPicker.close')"
            size="small"
            type="text"
            @click="close(); trigger?.focus()"
          >
            <span
              aria-hidden="true"
              class="i-lucide:x block size-4"
            />
          </Button>
        </div>
        <div
          :aria-label="t('pages.preference.colorPicker.saturationValue')"
          aria-valuemax="100"
          aria-valuemin="0"
          :aria-valuenow="Math.round(hsv.s)"
          :aria-valuetext="t('pages.preference.colorPicker.saturationValueText', { s: Math.round(hsv.s), v: Math.round(hsv.v) })"
          class="color-picker__area"
          role="slider"
          :style="{ backgroundColor: `hsl(${hsv.h}, 100%, 50%)` }"
          tabindex="0"
          @keydown="moveKey"
          @pointerdown.prevent="startPointer"
          @pointermove="movePointer"
        >
          <span
            class="color-picker__handle"
            :style="{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, backgroundColor: color }"
          />
        </div>
        <input
          :aria-label="t('pages.preference.colorPicker.hue')"
          class="color-picker__hue"
          max="360"
          min="0"
          step="1"
          type="range"
          :value="hsv.h"
          @input="changeHsv({ h: Number(($event.target as HTMLInputElement).value) })"
        >
        <div class="flex items-end gap-2">
          <label class="min-w-0 flex-1 text-xs">HEX
            <input
              v-model="hexDraft"
              :aria-invalid="!normalizeHex(hexDraft)"
              class="color-picker__input"
              maxlength="7"
              spellcheck="false"
              type="text"
              @blur="hexDraft = color"
              @input="applyColor(hexDraft)"
            >
          </label>
          <Button
            :aria-label="t('pages.preference.colorPicker.screenPick')"
            class="items-center justify-center inline-flex!"
            :disabled="screenColorPicking || blocked"
            :title="t('pages.preference.colorPicker.screenPick')"
            @click="pick"
          >
            <template #icon>
              <div
                aria-hidden="true"
                class="i-lucide:pipette size-4"
              />
            </template>
          </Button>
        </div>
        <div class="mt-3 flex gap-2">
          <label
            v-for="(channel, index) in ['R', 'G', 'B']"
            :key="channel"
            class="min-w-0 flex-1 text-xs"
          >{{ channel }}
            <input
              class="color-picker__input"
              max="255"
              min="0"
              step="1"
              type="number"
              :value="rgb[index]"
              @blur="restoreRgb(index, $event)"
              @input="changeRgb(index, $event)"
            >
          </label>
        </div>
      </div>
    </template>
    <button
      ref="trigger"
      :aria-expanded="open"
      aria-haspopup="dialog"
      :aria-label="`${label}: ${color}`"
      class="color-picker__trigger"
      :disabled="blocked || opening || screenColorPicking"
      type="button"
    >
      <span :style="{ backgroundColor: color }" />
    </button>
  </Popover>
</template>

<style scoped>
.color-picker {
  width: 240px;
  max-width: calc(100vw - 56px);
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  padding: 2px 6px;
  outline: none;
}
.color-picker__trigger {
  width: 48px;
  height: 32px;
  flex-shrink: 0;
  border: 1px solid var(--ant-color-border, #8888);
  border-radius: 6px;
  padding: 3px;
  background: transparent;
  cursor: pointer;
}
.color-picker__trigger span {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 3px;
}
.color-picker__trigger:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.color-picker__area {
  position: relative;
  height: 150px;
  border-radius: 4px;
  background-image: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent);
  touch-action: none;
  cursor: crosshair;
}
.color-picker__handle {
  position: absolute;
  width: 12px;
  height: 12px;
  border: 2px solid white;
  border-radius: 50%;
  box-shadow: 0 0 0 1px #0009;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.color-picker__hue {
  display: block;
  width: 100%;
  height: 14px;
  margin: 16px 0;
  border-radius: 7px;
  appearance: none;
  background: linear-gradient(to right, red, #ff0, #0f0, #0ff, #00f, #f0f, red);
  cursor: pointer;
}
.color-picker__hue::-webkit-slider-thumb {
  width: 14px;
  height: 18px;
  border: 2px solid white;
  border-radius: 4px;
  appearance: none;
  background: transparent;
  box-shadow: 0 0 0 1px #0009;
}
.color-picker__input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  margin-top: 4px;
  padding: 4px 7px;
  border: 1px solid #8888;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 13px;
}
.color-picker__input[aria-invalid='true'] {
  border-color: #dc4446;
}
.color-picker__trigger:focus-visible,
.color-picker__area:focus-visible,
.color-picker__hue:focus-visible,
.color-picker__input:focus-visible {
  outline: 2px solid #4096ff;
  outline-offset: 3px;
}
</style>
