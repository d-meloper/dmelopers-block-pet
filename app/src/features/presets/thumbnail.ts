import { convertFileSrc } from '@tauri-apps/api/core'
import { resolveResource } from '@tauri-apps/api/path'

import { getPetModelOption } from '@/config/model3d'
import { resolveDmeloperSkinUrl } from '@/services/dmeloperSkin'
import { createDefaultPet3dPreset } from '@/stores/cat'
import { Three3DRenderer } from '@/utils/three3d'

import type { PresetSnapshot } from './types'

import { applyPresetVisualSettings } from './visualSettings'

export async function renderPresetThumbnail(snapshot: PresetSnapshot): Promise<string> {
  const renderer = new Three3DRenderer()
  const canvas = document.createElement('canvas')
  try {
    renderer.setRenderScalePercent(100)
    renderer.setMouseEnabled(snapshot.preset.mouseEnabled)
    await renderer.init(
      canvas,
      convertFileSrc(await resolveResource(getPetModelOption(snapshot.appearance.selectedModelId).resourcePath)),
      snapshot.appearance.selectedModelId,
      await resolveDmeloperSkinUrl(snapshot.appearance.dmeloperSkinDataUrl),
      snapshot.appearance.dmeloperSkinModel,
      { automaticFrames: false },
    )
    applyPresetVisualSettings(renderer, { ...createDefaultPet3dPreset(), ...snapshot.preset })
    renderer.setEyebrowAnimationEnabled(false)
    renderer.renderStillFrame()
    const bounds = snapshot.preset.autoViewportEnabled
      ? renderer.getConservativeContentRect()
      : snapshot.preset.manualViewportRect
    renderer.setViewportCrop(bounds)
    const scale = Math.min(448 / bounds.width, 256 / bounds.height)
    const width = Math.max(1, Math.round(bounds.width * scale))
    const height = Math.max(1, Math.round(bounds.height * scale))
    renderer.resizeOutput(width, height)
    renderer.renderStillFrame()
    const output = document.createElement('canvas')
    output.width = 448
    output.height = 256
    const context = output.getContext('2d')
    if (!context) throw new Error('Thumbnail canvas is unavailable.')
    context.globalAlpha = snapshot.opacity / 100
    if (snapshot.mirror) {
      context.translate(448, 0)
      context.scale(-1, 1)
    }
    context.drawImage(canvas, (448 - width) / 2, (256 - height) / 2, width, height)
    return output.toDataURL('image/png')
  } finally {
    renderer.destroy()
  }
}
