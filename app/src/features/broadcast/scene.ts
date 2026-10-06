import type { BlockStore } from '@/stores/block'

import { normalizeLightingSettings } from '@/config/lighting'
import { PRESET_SETTING_KEYS } from '@/features/presets/types'

import type { BroadcastScene } from './types'

/** Project only the active visual state; never send the skin library or names. */
export function captureBroadcastScene(store: BlockStore): BroadcastScene {
  const dataUrl = store.customization3d.dmeloperSkinDataUrl
  const prefix = 'data:image/png;base64,'
  if (dataUrl && !dataUrl.startsWith(prefix)) throw new Error('Invalid broadcast skin.')
  const preset = store.customization3d.preset
  const rect = preset.manualViewportRect
  const eyebrows = preset.dmeloperEyebrows
  return JSON.parse(JSON.stringify({
    schemaVersion: 1,
    modelId: 'dmeloper',
    skinPngBase64: dataUrl?.slice(prefix.length),
    skinModel: store.customization3d.dmeloperSkinModel === 'slim' ? 'slim' : 'wide',
    preset: {
      ...Object.fromEntries(PRESET_SETTING_KEYS.map(key => [key, preset[key]])),
      lighting: normalizeLightingSettings(preset.lighting),
      manualViewportRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      dmeloperEyebrows: {
        enabled: eyebrows.enabled,
        color: eyebrows.color,
        centerOffsetPixels: eyebrows.centerOffsetPixels,
        heightOffsetPixels: eyebrows.heightOffsetPixels,
        spacingPixels: eyebrows.spacingPixels,
        widthPixels: eyebrows.widthPixels,
        thicknessPixels: eyebrows.thicknessPixels,
        depthPercent: eyebrows.depthPercent,
      },
      showDisplayArea: false,
      windowScalePercent: 100,
      viewportModeRevision: 0,
    },
    mirror: store.model.mirror,
    opacity: store.window.opacity,
    eyebrowAnimationEnabled: store.model.eyebrowAnimationEnabled,
    performance: {
      maxFPS: store.model.maxFPS,
      shadowsEnabled: store.model.shadowsEnabled,
      shadowQuality: store.model.shadowQuality,
      renderScalePercent: store.model.renderScalePercent,
      idlePowerSavingEnabled: store.model.idlePowerSavingEnabled,
      antialiasEnabled: store.model.antialiasEnabled,
      pixelFilterEnabled: store.model.pixelFilterEnabled,
    },
  })) as BroadcastScene
}

/** The OBS viewport owns output size; the authored crop keeps its aspect ratio. */
export function fitBroadcastOutput(crop: { width: number, height: number }, viewport: { width: number, height: number }) {
  const scale = Math.min(Math.max(1, viewport.width) / crop.width, Math.max(1, viewport.height) / crop.height)
  return {
    width: Math.max(1, Math.round(crop.width * scale)),
    height: Math.max(1, Math.round(crop.height * scale)),
  }
}
