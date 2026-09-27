import { isEqual } from 'es-toolkit'

import { reportDiagnostic } from '@/services/diagnostics'

export interface SettingsSnapshot {
  id: string
  state: Record<string, unknown>
}

export interface SettingsPersistenceSteps {
  flushFrontend: () => Promise<unknown>
  snapshots: () => SettingsSnapshot[]
  readBackend: (id: string) => Promise<Record<string, unknown>>
  saveNow: () => Promise<unknown>
  now?: () => number
  wait?: () => Promise<unknown>
  timeoutMs?: number
  /** Quiescence only: edits are locked, but a peer's queued state may still arrive. */
  followFrontendChanges?: boolean
}

function containsSnapshot(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) =>
    Object.prototype.hasOwnProperty.call(actual, key)
    && isEqual(actual[key], value),
  )
}

/**
 * Pinia's frontend watcher starts an async backend patch without returning it.
 * nextTick or saveAllNow alone therefore cannot acknowledge the changed value.
 * Verify every frontend-owned field in the public backend readback first, then
 * await the immediate disk save. Backend-only top-level legacy fields are left
 * intact; owned nested objects must match exactly, including user resets.
 */
export async function saveSynchronizedSettings(steps: SettingsPersistenceSteps): Promise<void> {
  try {
    await synchronizeSettings(steps)
  } catch (error) {
    reportDiagnostic('error', 'settings.persist', error)
    throw error
  }
}

async function synchronizeSettings(steps: SettingsPersistenceSteps): Promise<void> {
  const now = steps.now ?? (() => performance.now())
  const wait = steps.wait ?? (() => new Promise(resolve => setTimeout(resolve, 25)))
  const deadline = now() + (steps.timeoutMs ?? 5000)
  await steps.flushFrontend()
  // Match the JSON representation sent through Tauri, including omitted undefined fields.
  const readSnapshots = () => JSON.parse(JSON.stringify(steps.snapshots())) as SettingsSnapshot[]
  let snapshots = readSnapshots()
  while (true) {
    const backendStates = await Promise.all(snapshots.map(({ id }) => steps.readBackend(id)))
    if (steps.followFrontendChanges) {
      // A native read can race the peer's incoming Pinia patch. Observe its
      // actual frontend completion, never adopt the backend as the desired state.
      await steps.flushFrontend()
      const current = readSnapshots()
      if (now() >= deadline) throw new Error('Settings synchronization was not acknowledged.')
      if (!isEqual(current, snapshots)) {
        snapshots = current
        await wait()
        continue
      }
    }
    if (snapshots.every(({ state }, index) => containsSnapshot(backendStates[index], state))) {
      await steps.saveNow()
      return
    }
    if (now() >= deadline) throw new Error('Settings synchronization was not acknowledged.')
    await wait()
  }
}
