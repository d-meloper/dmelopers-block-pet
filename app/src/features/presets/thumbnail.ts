import { convertFileSrc } from '@tauri-apps/api/core'
import { resolveResource } from '@tauri-apps/api/path'

import { getPetModelOption, MODEL_3D_CONFIG } from '@/config/model3d'
import { resolveDmeloperSkinUrl } from '@/services/dmeloperSkin'
import { createDefaultPet3dPreset } from '@/stores/block'
import { Three3DRenderer } from '@/utils/three3d'

import type { PresetSnapshot } from './types'

import { applyPresetVisualSettings } from './visualSettings'

export interface PresetThumbnailBatch {
  render: (snapshot: PresetSnapshot) => Promise<string>
  dispose: () => void
}

/** One serial, input-free renderer owned only by the current list work batch. */
export function createPresetThumbnailBatch(): PresetThumbnailBatch {
  let current: { key: string, renderer: Three3DRenderer, canvas: HTMLCanvasElement } | undefined
  let disposed = false
  let tail: Promise<unknown> = Promise.resolve()
  const release = () => {
    const previous = current
    current = undefined
    previous?.renderer.destroy()
  }
  const assertActive = () => {
    if (disposed) throw new Error('Thumbnail batch has been disposed.')
  }
  const render = async (snapshot: PresetSnapshot): Promise<string> => {
    assertActive()
    try {
      const modelId = snapshot.appearance.selectedModelId
      const modelUrl = convertFileSrc(await resolveResource(getPetModelOption(modelId).resourcePath))
      assertActive()
      const skinUrl = await resolveDmeloperSkinUrl(snapshot.appearance.dmeloperSkinDataUrl)
      assertActive()
      const preset = { ...createDefaultPet3dPreset(), ...snapshot.preset }
      // Initial composition is fitted before visual settings. Asset/model changes
      // and the startup mouse state use a fresh renderer to keep that cold fit.
      const key = JSON.stringify([modelUrl, modelId, skinUrl, snapshot.appearance.dmeloperSkinModel, preset.mouseEnabled, window.devicePixelRatio])
      if (!current || current.key !== key) {
        release()
        const renderer = new Three3DRenderer()
        const canvas = document.createElement('canvas')
        current = { key, renderer, canvas }
        renderer.setRenderScalePercent(100)
        renderer.setMouseEnabled(preset.mouseEnabled)
        await renderer.init(canvas, modelUrl, modelId, skinUrl, snapshot.appearance.dmeloperSkinModel, { automaticFrames: false })
        assertActive()
      } else {
        const { width, height } = MODEL_3D_CONFIG.baseWindow
        current.renderer.setViewportCrop({ x: 0, y: 0, width, height })
        current.renderer.resizeOutput(width, height)
        applyPresetVisualSettings(current.renderer, { ...createDefaultPet3dPreset(), mouseEnabled: preset.mouseEnabled })
        current.renderer.resetStillFramePose()
      }
      const { renderer, canvas } = current
      applyPresetVisualSettings(renderer, preset)
      renderer.setEyebrowAnimationEnabled(false)
      renderer.renderStillFrame()
      const bounds = preset.autoViewportEnabled
        ? renderer.getConservativeContentRect()
        : preset.manualViewportRect
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
    } catch (error) {
      release()
      throw error
    }
  }
  return {
    render: (snapshot) => {
      const next = tail.catch(() => {}).then(() => render(snapshot))
      tail = next
      return next
    },
    dispose: () => {
      disposed = true
      release()
    },
  }
}

export async function renderPresetThumbnail(snapshot: PresetSnapshot): Promise<string> {
  const batch = createPresetThumbnailBatch()
  try {
    return await batch.render(snapshot)
  } finally {
    batch.dispose()
  }
}
