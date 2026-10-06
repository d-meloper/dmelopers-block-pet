import { LogicalSize } from '@tauri-apps/api/dpi'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getAllWebviewWindows } from '@tauri-apps/api/webviewWindow'
import { availableMonitors } from '@tauri-apps/api/window'

import type { MainViewportResetComplete } from '@/utils/mainViewportReset'
import type { ProgramSettingsResetOptions } from '@/utils/programSettingsReset'

import { DEFAULT_PREFERENCE_SIZE } from '@/config/window'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { withPresetReset } from '@/features/presets/operations'
import { getAutostartStatus, setAutostartEnabled } from '@/services/autostart'
import { readPresetImport } from '@/services/presetTransfer'
import { clearSkinLibrary } from '@/services/skinLibrary'
import { useAppStore } from '@/stores/app'
import { useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'
import { usePerformanceStore } from '@/stores/performance'
import { useShortcutStore } from '@/stores/shortcut'
import {
  requestMainViewportReset,
} from '@/utils/mainViewportReset'
import { DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS, runProgramSettingsReset } from '@/utils/programSettingsReset'

const DEFAULT_PREFERENCE_LOGICAL_SIZE = new LogicalSize(DEFAULT_PREFERENCE_SIZE.width, DEFAULT_PREFERENCE_SIZE.height)

export function useProgramSettingsReset() {
  const appStore = useAppStore()
  const blockStore = useBlockStore()
  const generalStore = useGeneralStore()
  const performanceStore = usePerformanceStore()
  const shortcutStore = useShortcutStore()

  const resetWindowGeometry = async () => {
    const windows = await getAllWebviewWindows()
    const resets = windows
      .filter(window => window.label !== WINDOW_LABEL.MAIN)
      .map(async (window) => {
        const monitors = await availableMonitors()
        const position = await window.outerPosition()
        const monitor = monitors.find(item => position.x >= item.position.x && position.x < item.position.x + item.size.width
          && position.y >= item.position.y && position.y < item.position.y + item.size.height) ?? monitors[0]
        const size = monitor
          ? new LogicalSize(
              Math.min(DEFAULT_PREFERENCE_SIZE.width, monitor.workArea.size.width / monitor.scaleFactor),
              Math.min(DEFAULT_PREFERENCE_SIZE.height, Math.max(100, monitor.workArea.size.height / monitor.scaleFactor - 40)),
            )
          : DEFAULT_PREFERENCE_LOGICAL_SIZE
        await window.setSize(size)
        await window.center()
      })
    if (windows.some(window => window.label === WINDOW_LABEL.MAIN)) {
      resets.push(requestMainViewportReset({
        emit: payload => emitTo(
          WINDOW_LABEL.MAIN,
          LISTEN_KEY.MAIN_VIEWPORT_RESET_REQUEST,
          payload,
        ),
        listen: handler => listen<MainViewportResetComplete>(
          LISTEN_KEY.MAIN_VIEWPORT_RESET_COMPLETE,
          ({ payload }) => handler(payload),
        ),
      }))
    }
    await Promise.all(resets)
  }

  const resetProgramSettings = async (options: ProgramSettingsResetOptions = DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS) => {
    const selection = { ...options }
    await withPresetReset(() => runProgramSettingsReset({
      checkPresetImport: async () => {
        // A prepared journal can later restore pre-reset settings and presets.
        // This gate is independent of skin deletion and runs after active work.
        if ((await readPresetImport())?.phase === 'prepared') throw new Error('PRESET_IMPORT_RECOVERY_REQUIRED')
      },
      getAutostartStatus,
      clearSkinLibrary,
      resetAutostart: () => setAutostartEnabled(false),
      stopPerformance: performanceStore.stop,
      resetPerformanceMetrics: performanceStore.reset,
      resetBlock: blockStore.resetAllSettings,
      resetGeneral: generalStore.reset,
      initializeGeneral: generalStore.init,
      resetShortcut: shortcutStore.reset,
      resetWindowState: appStore.resetWindowState,
      resetWindowGeometry,
    }, selection))
  }

  return { resetProgramSettings }
}
