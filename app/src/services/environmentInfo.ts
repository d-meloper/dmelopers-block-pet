import { getTauriVersion, getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { availableMonitors } from '@tauri-apps/api/window'
import { arch, platform, version } from '@tauri-apps/plugin-os'

import { APP_DISPLAY_NAME } from '@/constants/branding'
import { isDesktopPetVisible } from '@/features/broadcast/visibility'
import { useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'

import { getDistributionInfo } from './distribution'

interface SupportSystemInfo {
  windowsEdition: string | null
  windowsRelease: string | null
  windowsBuild: string
  webview2Version: string | null
}

function captureGraphics() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const gl = canvas.getContext('webgl2')
  // This isolated probe does not describe the live pet or OBS renderer.
  const scope = 'preference-webgl2-probe'
  if (!gl) return { scope, contextAvailable: false, renderer: null }
  try {
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      scope,
      contextAvailable: !gl.isContextLost(),
      renderer: gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) as string,
    }
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    canvas.width = canvas.height = 0
  }
}

/** Bound each read, omit raw errors, and preserve partial results. */
export async function collectEnvironmentSources<T extends Record<string, () => unknown>>(sources: T, timeoutMs = 2500) {
  const unavailable: Array<{ section: string, reason: 'failed' | 'timeout' }> = []
  const entries = await Promise.all(Object.entries(sources).map(async ([section, operation]) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      Promise.resolve().then(operation).then(
        value => ({ value }),
        () => ({ reason: 'failed' as const }),
      ),
      new Promise<{ reason: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ reason: 'timeout' }), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    if ('reason' in outcome) {
      unavailable.push({ section, reason: outcome.reason })
      return [section, null]
    }
    return [section, outcome.value]
  }))
  return {
    values: Object.fromEntries(entries) as { [K in keyof T]: Awaited<ReturnType<T[K]>> | null },
    unavailable: unavailable.sort((a, b) => a.section.localeCompare(b.section)),
  }
}

export async function collectEnvironmentInfo() {
  const result = await collectEnvironmentSources({
    appVersion: getVersion,
    distributionChannel: async () => (await getDistributionInfo()).channel,
    tauriVersion: getTauriVersion,
    platform,
    platformArch: arch,
    platformVersion: version,
    system: async () => {
      const info = await invoke<SupportSystemInfo>('support_system_info')
      return { windowsEdition: info.windowsEdition, windowsRelease: info.windowsRelease, windowsBuild: info.windowsBuild, webview2Version: info.webview2Version }
    },
    graphics: captureGraphics,
    displays: async () => (await availableMonitors()).map(monitor => ({
      width: monitor.size.width,
      height: monitor.size.height,
      scaleFactor: monitor.scaleFactor,
    })),
    rendering: () => {
      const { model } = useBlockStore()
      return {
        maxFPS: model.maxFPS,
        renderScalePercent: model.renderScalePercent,
        shadowQuality: model.shadowsEnabled ? model.shadowQuality : 'off',
        antialiasEnabled: model.antialiasEnabled,
        pixelFilterEnabled: model.pixelFilterEnabled,
        idlePowerSavingEnabled: model.idlePowerSavingEnabled,
      }
    },
    visibility: () => {
      const block = useBlockStore()
      const { broadcast } = useGeneralStore()
      return {
        petVisible: block.window.visible,
        effectiveDesktopVisible: isDesktopPetVisible(block.window.visible, broadcast),
        clickThrough: block.window.passThrough,
        broadcastEnabled: broadcast.enabled,
      }
    },
  })
  // Never spread store/API objects: paths, skin/preset content and tokens stay private.
  return { appName: APP_DISPLAY_NAME, ...result.values, unavailable: result.unavailable }
}
