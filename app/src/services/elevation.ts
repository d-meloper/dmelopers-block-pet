import { invoke } from '@tauri-apps/api/core'

import type { ElevatedRestartPreparation, ElevationStatus } from '@/features/elevation/types'

import { isElevatedRestartPreparation, isElevationStatus } from '@/features/elevation/types'

export async function getElevationStatus(): Promise<ElevationStatus> {
  const result = await invoke<unknown>('elevation_status')
  if (!isElevationStatus(result)) throw new Error('ELEVATION_INVALID_STATUS')
  return result
}

/** UAC is deliberately outside the process owner's bounded save/commit wait. */
export async function prepareElevatedRestart(): Promise<ElevatedRestartPreparation> {
  const result = await invoke<unknown>('prepare_elevated_restart')
  if (!isElevatedRestartPreparation(result)) throw new Error('ELEVATION_INVALID_PREPARATION')
  return result
}

export async function cancelElevatedRestart(ticket: string): Promise<void> {
  await invoke('cancel_elevated_restart', { ticket })
}

/** Retires the approved input worker; the UI remains in the original account. */
export async function disableElevatedInput(): Promise<ElevationStatus> {
  const result = await invoke<unknown>('disable_elevated_input')
  if (!isElevationStatus(result)) throw new Error('ELEVATION_INVALID_STATUS')
  return result
}
