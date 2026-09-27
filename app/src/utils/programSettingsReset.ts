import { reportDiagnostic } from '@/services/diagnostics'

export interface ProgramSettingsResetSteps {
  clearSkinLibrary: () => Promise<unknown>
  resetAutostart: () => Promise<unknown>
  stopPerformance: () => Promise<unknown>
  resetPerformanceMetrics: () => Promise<unknown>
  resetCat: () => void
  resetGeneral: () => void
  initializeGeneral: () => Promise<unknown>
  resetShortcut: () => void
  resetWindowState: () => void
  resetWindowGeometry: () => Promise<unknown>
}

/**
 * Run the destructive library clear as the transaction gate. Nothing else is
 * mutated until that durable operation has succeeded.
 */
export async function runProgramSettingsReset(
  steps: ProgramSettingsResetSteps,
): Promise<void> {
  let stage = 'library'
  try {
    await steps.clearSkinLibrary()
    stage = 'autostart'
    await steps.resetAutostart()
    stage = 'performance'
    await steps.stopPerformance()
    await steps.resetPerformanceMetrics()
    stage = 'stores'
    steps.resetCat()
    steps.resetGeneral()
    await steps.initializeGeneral()
    stage = 'shortcuts'
    steps.resetShortcut()
    stage = 'window'
    steps.resetWindowState()
    await steps.resetWindowGeometry()
  } catch (error) {
    reportDiagnostic('error', `settings.reset_${stage}`, error)
    throw error
  }
}
