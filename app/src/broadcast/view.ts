import type { SemanticInputEvent } from '@/features/input/types'

import { fitBroadcastOutput } from '@/features/broadcast/scene'
import { applyPresetVisualSettings } from '@/features/presets/visualSettings'
import { Three3DRenderer } from '@/utils/three3d'

import type { BroadcastScene } from '../features/broadcast/types'

interface View {
  renderer: Three3DRenderer
  canvas: HTMLCanvasElement
  skinKey: string
  skinModel: BroadcastScene['skinModel']
  scene: BroadcastScene
}

export function createBroadcastView(container: HTMLElement, assetBase: URL) {
  let current: View | undefined
  let loading: View | undefined
  let crop = { width: 500, height: 422 }
  const resize = () => {
    if (!current) return
    const size = fitBroadcastOutput(crop, { width: container.clientWidth, height: container.clientHeight })
    current.renderer.resizeOutput(size.width, size.height)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)

  const configure = (view: View, scene: BroadcastScene) => {
    const { renderer } = view
    const quality = scene.performance
    renderer.setMaxFPS(quality.maxFPS)
    renderer.setIdlePowerSavingEnabled(quality.idlePowerSavingEnabled)
    renderer.setRenderScalePercent(quality.renderScalePercent)
    renderer.setShadowQuality(quality.shadowQuality)
    renderer.setShadowsEnabled(quality.shadowsEnabled)
    renderer.setPixelFilterEnabled(quality.pixelFilterEnabled === true)
    renderer.setEyebrowAnimationEnabled(scene.eyebrowAnimationEnabled)
    applyPresetVisualSettings(renderer, scene.preset)
    view.canvas.style.transform = scene.mirror ? 'scaleX(-1)' : ''
    view.canvas.style.opacity = String(scene.opacity / 100)
    renderer.setInputActive(true)
    renderer.setMouseInputActive(scene.preset.mouseEnabled)
  }
  const clear = () => {
    loading?.renderer.destroy()
    loading = undefined
    current?.renderer.destroy()
    current?.canvas.remove()
    current = undefined
  }

  return {
    async apply(scene: BroadcastScene, isCurrent: () => boolean) {
      if (!isCurrent()) return
      const skinKey = JSON.stringify(scene.skinPngBase64 ?? null)
      const skinUrl = scene.skinPngBase64 ? `data:image/png;base64,${scene.skinPngBase64}` : new URL('default.png', assetBase).href
      let view = current
      const replacement = !view || view.skinKey !== skinKey
      if (replacement) {
        view = { renderer: new Three3DRenderer(), canvas: document.createElement('canvas'), skinKey, skinModel: scene.skinModel, scene }
        loading = view
      }
      if (!view) return
      try {
        if (replacement) {
          view.renderer.setRenderScalePercent(scene.performance.renderScalePercent)
          await view.renderer.init(
            view.canvas,
            new URL('model.glb', assetBase).href,
            'dmeloper',
            skinUrl,
            scene.skinModel,
            { antialiasEnabled: scene.performance.antialiasEnabled },
          )
        } else if (view.skinModel !== scene.skinModel) {
          await view.renderer.setDmeloperSkin(skinUrl, scene.skinModel)
          view.skinModel = scene.skinModel
        }
        if (!isCurrent()) {
          if (replacement) view.renderer.destroy()
          return
        }
        if (!replacement) {
          const canvas = await view.renderer.setAntialiasEnabled(scene.performance.antialiasEnabled, isCurrent)
          if (!isCurrent()) return
          if (canvas) view.canvas = canvas
        }
        configure(view, scene)
        if (replacement) view.renderer.renderStillFrame()
        const measured = scene.preset.autoViewportEnabled ? await view.renderer.measureVisibleContentRect() : undefined
        if (!isCurrent()) {
          if (replacement) view.renderer.destroy()
          return
        }
        if (scene.preset.autoViewportEnabled && measured?.status === 'failure') {
          console.warn('The broadcast viewport is using conservative fallback bounds.')
        }
        const bounds = scene.preset.autoViewportEnabled
          ? measured?.status === 'success' ? measured.rect : view.renderer.getConservativeContentRect()
          : scene.preset.manualViewportRect
        view.renderer.setViewportCrop(bounds)
        if (replacement) {
          current?.renderer.destroy()
          current?.canvas.remove()
          container.append(view.canvas)
        }
        view.scene = scene
        current = view
        crop = bounds
        resize()
      } finally {
        if (replacement && view !== current) view.renderer.destroy()
        if (loading === view) loading = undefined
      }
    },
    input: (event: SemanticInputEvent) => current?.renderer.handleSemanticInput(event),
    reset() {
      if (!current) return
      current.renderer.setInputActive(false)
      current.renderer.setInputActive(true)
      current.renderer.setMouseInputActive(current.scene.preset.mouseEnabled)
    },
    clear,
    dispose() {
      observer.disconnect()
      clear()
    },
  }
}
