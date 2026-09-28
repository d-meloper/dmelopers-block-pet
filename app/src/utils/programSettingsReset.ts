import type { AutostartStatus } from '@/services/autostart'

import { reportDiagnostic } from '@/services/diagnostics'

export interface ProgramSettingsResetSteps {
  getAutostartStatus: () => Promise<AutostartStatus>
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

type ResetStage = 'preflight' | 'library' | 'autostart' | 'performance' | 'stores' | 'shortcuts' | 'window'

export class ProgramSettingsResetError extends Error {
  readonly cause: unknown

  constructor(
    readonly outcome: 'blocked' | 'preflight' | 'partial',
    readonly stage: ResetStage,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ProgramSettingsResetError'
    this.cause = cause
  }
}

/**
 * Preflight OS constraints before the destructive library gate. Once clear is
 * attempted, failures can leave a partial reset; this flow never rolls back.
 */
export async function runProgramSettingsReset(
  steps: ProgramSettingsResetSteps,
): Promise<void> {
  let stage: ResetStage = 'preflight'
  let mutationStarted = false
  try {
    const before = await steps.getAutostartStatus()
    if (before.enabled && !before.canDisable) {
      throw new ProgramSettingsResetError('blocked', stage, new Error('AUTOSTART_RESET_BLOCKED'))
    }
    stage = 'library'
    mutationStarted = true
    await steps.clearSkinLibrary()
    stage = 'autostart'
    await steps.resetAutostart()
    if ((await steps.getAutostartStatus()).enabled) throw new Error('AUTOSTART_RESET_NOT_DISABLED')
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
    const failure = error instanceof ProgramSettingsResetError
      ? error
      : new ProgramSettingsResetError(mutationStarted ? 'partial' : 'preflight', stage, error)
    reportDiagnostic('error', `settings.reset_${stage}`, failure)
    throw failure
  }
}
