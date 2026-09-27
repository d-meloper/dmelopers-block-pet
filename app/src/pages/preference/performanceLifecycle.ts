export interface PreferencePerformanceState {
  activeTab: number
  performanceTab: number
  visible: boolean
  minimized: boolean
  closing: boolean
}

export function shouldMonitorPreferencePerformance(
  state: PreferencePerformanceState,
): boolean {
  return state.activeTab === state.performanceTab
    && state.visible
    && !state.minimized
    && !state.closing
}
