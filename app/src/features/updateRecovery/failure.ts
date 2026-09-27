export interface UpdateFailure {
  notificationId: string
  requestId: string | null
  reason: string
  outcome: 'unchanged' | 'recovering' | 'rolledBack' | 'failed' | 'unknown'
  sourceVersion: string | null
  targetVersion: string | null
}

/** A delayed initial read must never replace a newer recovery result. */
export async function observeUpdateFailure(options: {
  listen: (accept: (failure: UpdateFailure | null) => void) => Promise<() => void>
  read: () => Promise<UpdateFailure | null>
  accept: (failure: UpdateFailure | null) => void
  active: () => boolean
}): Promise<() => void> {
  let observed = false
  const stop = await options.listen((failure) => {
    observed = true
    if (options.active()) options.accept(failure)
  })
  if (!options.active()) {
    stop()
    return () => {}
  }
  try {
    const failure = await options.read()
    if (!observed && options.active()) options.accept(failure)
    return stop
  } catch (error) {
    stop()
    throw error
  }
}

export function failureReasonKey(reason: string): string {
  const code = reason.split(':')[0]
  if (code === 'UPDATE_SOURCE_INVALID') return 'sourceInvalid'
  if (['NETWORK_UNAVAILABLE', 'RATE_LIMITED'].includes(code!)) return 'network'
  if (['TRUST_NOT_CONFIGURED', 'WITHDRAWN', 'RELEASE_UNAVAILABLE', 'CHECK_REQUIRED'].includes(code!)) return 'unavailable'
  if (['SIGNATURE_INVALID', 'METADATA_INVALID', 'INTEGRITY_FAILED', 'REPOSITORY_MISMATCH', 'RELEASE_INVALID', 'ASSET_MISSING'].includes(code!)) return 'verification'
  if (['OTHER_ACCOUNT_RUNNING', 'PROCESS_STATE_UNKNOWN', 'PARENT_NOT_EXITED'].includes(code!)) return 'running'
  if (['PACKAGED_APP_REQUIRED', 'INSTALL_IDENTITY_INVALID', 'INSTALL_DRIFT'].includes(code!)) return 'installation'
  if (['QUIESCE_FAILED', 'QUIESCE_TIMEOUT', 'SETTINGS_NOT_READY', 'PRESETS_NOT_READY', 'RECOVERY_PREPARE_FAILED', 'SNAPSHOT_FAILED'].includes(code!)) return 'preparation'
  if (['INSTALLER_FAILED', 'REGISTRY_COMMIT_FAILED', 'PROGRAM_COMMIT_FAILED', 'PROGRAM_COMMIT_STATE_UNKNOWN', 'HELPER_FAILED', 'HELPER_LAUNCH_FAILED', 'HELPER_NOT_READY'].includes(code!)) return 'installer'
  if (['RESTART_FAILED', 'RENDER_FAILED', 'SKIN_LOAD_FAILED', 'HEALTH_PROOF_MISMATCH', 'HEALTH_DATA_MISMATCH', 'SAVE_VERIFICATION_FAILED', 'WINDOW_NATIVE_MISMATCH'].includes(code!)) return 'startup'
  if (['READ_FAILED', 'WRITE_FAILED', 'IO_ERROR', 'STORAGE_UNAVAILABLE', 'JOURNAL_WRITE_FAILED', 'RECOVERY_PATH_TOO_LONG'].includes(code!)) return 'storage'
  if (['ROLLBACK_FAILED', 'ROLLBACK_ALREADY_ATTEMPTED', 'PROGRAM_RECOVERY_PENDING'].includes(code!)) return 'recovery'
  if (['BUSY', 'OPERATION_BUSY', 'RECOVERY_REQUIRED'].includes(code!)) return 'busy'
  return 'unknown'
}
