import type { AutostartStatus } from '@/services/autostart'

import { reportDiagnostic } from '@/services/diagnostics'

export interface ProgramSettingsResetOptions {
  deleteSkins: boolean
  resetPresets: boolean
}

export const DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS: Readonly<ProgramSettingsResetOptions> = {
  deleteSkins: false,
  resetPresets: false,
}

export interface ProgramSettingsResetSteps {
  checkPresetImport: () => Promise<void>
  getAutostartStatus: () => Promise<AutostartStatus>
  clearSkinLibrary: () => Promise<unknown>
  resetAutostart: () => Promise<unknown>
  stopPerformance: () => Promise<unknown>
  resetPerformanceMetrics: () => Promise<unknown>
  resetBlock: (options: ProgramSettingsResetOptions) => void
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
 * Preflight OS constraints before any destructive work. Once a mutation is
 * attempted, failures can leave a partial reset; this flow never rolls back.
 */
export async function runProgramSettingsReset(
  steps: ProgramSettingsResetSteps,
  options: ProgramSettingsResetOptions = DEFAULT_PROGRAM_SETTINGS_RESET_OPTIONS,
): Promise<void> {
  const selection = { ...options }
  let stage: ResetStage = 'preflight'
  let mutationStarted = false
  try {
    await steps.checkPresetImport()
    const before = await steps.getAutostartStatus()
    if (before.enabled && !before.canDisable) {
      throw new ProgramSettingsResetError('blocked', stage, new Error('AUTOSTART_RESET_BLOCKED'))
    }
    if (selection.deleteSkins) {
      stage = 'library'
      mutationStarted = true
      await steps.clearSkinLibrary()
    }
    stage = 'autostart'
    mutationStarted = true
    await steps.resetAutostart()
    if ((await steps.getAutostartStatus()).enabled) throw new Error('AUTOSTART_RESET_NOT_DISABLED')
    stage = 'performance'
    await steps.stopPerformance()
    await steps.resetPerformanceMetrics()
    stage = 'stores'
    steps.resetBlock(selection)
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
