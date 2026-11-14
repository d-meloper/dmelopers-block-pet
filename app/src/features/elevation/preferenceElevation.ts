import { computed, ref, shallowRef } from 'vue'

import { waitForRecovery } from '@/features/recovery/wait'
import { diagnosticCode } from '@/services/diagnosticsCore'

import type { ElevatedRestartPreparation, ElevationStatus } from './types'

interface Dependencies {
  status: () => Promise<ElevationStatus>
  prepare: () => Promise<ElevatedRestartPreparation>
  cancel: (ticket: string) => Promise<void>
  restart: (ticket: string, isCurrent: () => boolean) => Promise<void>
  disableInput?: () => Promise<ElevationStatus>
  persist?: (key: 'alwaysRunAsAdministrator' | 'administratorReminderDismissed', enabled: boolean, isCurrent: () => boolean) => Promise<void>
  reminderDismissed?: () => boolean
  report: (operation: 'status' | 'prepare' | 'cancel' | 'restart' | 'save' | 'disable', error: unknown) => void
}

/** Preferences owns explicit choices; bootstrap alone owns automatic elevation. */
export function createPreferenceElevation(deps: Dependencies, statusTimeoutMs = 5000) {
  const visible = ref(false)
  const blocked = ref(true)
  const status = shallowRef<ElevationStatus>()
  const checking = ref(false)
  const phase = ref<'saving' | 'preparing' | 'restarting' | 'disabling'>()
  const action = ref<'enable' | 'disable' | 'dismiss'>()
  const feedback = ref<'cancelled' | 'failed' | 'saveFailed' | 'identityMismatch' | 'disableFailed' | 'requiresNormalLaunch'>()
  const continued = ref(false)
  const requested = ref(false)
  const holdReminder = ref(false)
  const lifetime = new AbortController()
  let disposed = false
  let visibilityGeneration = 0
  let actionGeneration = 0
  let statusGeneration = 0
  let statusRead: Promise<ElevationStatus> | undefined
  let statusWait: Promise<void> | undefined
  let pending: Promise<void> | undefined

  const isActive = computed(() => status.value?.elevated === true || status.value?.inputElevated === true)
  const open = computed(() => !disposed && visible.value && !blocked.value
    && status.value?.supported === true
    && !isActive.value && (requested.value || (!continued.value && status.value.elevated === false
      && (!deps.reminderDismissed?.() || holdReminder.value || phase.value === 'saving'))))
  const busy = computed(() => phase.value !== undefined)
  // Retain the dialog's action layout through its closing animation.
  const showDismiss = ref(true)
  const canManage = computed(() => !disposed && visible.value && !blocked.value && !busy.value && !checking.value
    && status.value?.supported === true)

  async function cancel(ticket: string) {
    try {
      await deps.cancel(ticket)
    } catch (error) {
      // Cancellation only retires a prepared child. Never infer a changed token.
      deps.report('cancel', error)
    }
  }

  async function readStatus(generation: number) {
    const observation = statusGeneration
    checking.value = true
    statusRead ??= Promise.resolve().then(deps.status)
    const read = statusRead
    void read.then(() => {
      if (statusRead === read) statusRead = undefined
    }, () => {
      if (statusRead === read) statusRead = undefined
    })
    try {
      const result = await waitForRecovery(read, statusTimeoutMs, lifetime.signal)
      if (!disposed && visible.value && generation === visibilityGeneration && observation === statusGeneration) {
        status.value = result
        if (result.inputElevated) continued.value = true
        if (!continued.value && (result.startupAttempt === 'cancelled' || result.startupAttempt === 'failed')) {
          continued.value = true
          feedback.value = result.startupAttempt
        }
      }
    } catch (error) {
      if (!disposed && visible.value && generation === visibilityGeneration && observation === statusGeneration) {
        status.value = undefined
        deps.report('status', error)
      }
    } finally {
      if (!disposed && generation === visibilityGeneration && observation === statusGeneration) checking.value = false
    }
  }

  function setVisible(value: boolean): Promise<void> {
    if (disposed || visible.value === value) return statusWait ?? Promise.resolve()
    visible.value = value
    if (!value) {
      requested.value = false
      holdReminder.value = false
    }
    visibilityGeneration++
    actionGeneration++
    // The UI token is stable; the separate input worker can exit while hidden.
    if (!continued.value) {
      status.value = undefined
      feedback.value = undefined
    }
    checking.value = false
    if (!value) return Promise.resolve()
    const current = readStatus(visibilityGeneration)
    statusWait = current
    void current.finally(() => {
      if (statusWait === current) statusWait = undefined
    })
    return current
  }

  function setBlocked(value: boolean) {
    if (disposed || blocked.value === value) return
    blocked.value = value
    if (value) actionGeneration++
  }

  function continueNormally() {
    if (disposed || busy.value) return
    continued.value = true
    requested.value = false
    actionGeneration++
    feedback.value = undefined
  }

  function enable(): Promise<void> {
    if (pending) return pending
    if (disposed || busy.value || !open.value || isActive.value) return Promise.resolve()
    const generation = actionGeneration
    const active = () => !disposed && visible.value && !blocked.value && (requested.value || !continued.value)
      && generation === actionGeneration
    feedback.value = undefined
    action.value = 'enable'
    phase.value = 'preparing'
    const work = async () => {
      let ticket: string | undefined
      let transferred = false
      try {
        // UAC may wait indefinitely, outside either bounded settings save.
        const result = await deps.prepare()
        if (result.outcome === 'cancelled') {
          if (active()) feedback.value = 'cancelled'
          return
        }
        ticket = result.ticket
        if (!active()) return
        phase.value = 'saving'
        if (!deps.persist) throw new Error('ELEVATION_PREFERENCE_UNAVAILABLE')
        await deps.persist('alwaysRunAsAdministrator', true, active)
        if (!active()) return
        phase.value = 'restarting'
        // The process owner now owns quiescence, persistence and native commit.
        transferred = true
        await deps.restart(ticket, active)
        if (active()) {
          // Discard older observations and verify worker liveness after commit.
          // The UI process, current account and data writers remain here.
          statusGeneration++
          statusRead = undefined
          checking.value = false
          const started = await waitForRecovery(Promise.resolve().then(deps.status), statusTimeoutMs, lifetime.signal)
          if (!active()) return
          if (!started.inputElevated && !started.elevated) throw new Error('ELEVATION_INVALID_ACTIVATION')
          status.value = started
          continued.value = true
          requested.value = false
        }
      } catch (error) {
        if (active()) {
          feedback.value = phase.value === 'saving' ? 'saveFailed' : diagnosticCode(error) === 'ELEVATION_IDENTITY_MISMATCH' ? 'identityMismatch' : 'failed'
          deps.report(phase.value === 'saving' ? 'save' : transferred ? 'restart' : 'prepare', error)
        }
      } finally {
        // Once transferred, the process owner also owns failure cancellation.
        if (ticket && !transferred) await cancel(ticket)
        if (!disposed) {
          phase.value = undefined
          action.value = undefined
        }
      }
    }
    const current = work().finally(() => {
      if (pending === current) pending = undefined
    })
    pending = current
    return current
  }

  function disable(): Promise<void> {
    if (pending) return pending
    if (!canManage.value || !isActive.value || !deps.persist || !deps.disableInput) return Promise.resolve()
    const generation = actionGeneration
    const active = () => !disposed && visible.value && !blocked.value && generation === actionGeneration
    continued.value = true
    requested.value = false
    action.value = 'disable'
    phase.value = 'saving'
    feedback.value = undefined
    const work = async () => {
      try {
        await deps.persist!('alwaysRunAsAdministrator', false, active)
        if (!active()) return
        phase.value = 'disabling'
        const stopped = await deps.disableInput!()
        if (!active()) return
        statusGeneration++
        statusRead = undefined
        checking.value = false
        status.value = stopped
        if (stopped.inputElevated) throw new Error('ELEVATION_INVALID_DEACTIVATION')
        // An externally elevated UI cannot lose its own token in place.
        if (stopped.elevated) feedback.value = 'requiresNormalLaunch'
      } catch (error) {
        if (active()) {
          const operation = phase.value === 'saving' ? 'save' : 'disable'
          feedback.value = operation === 'save' ? 'saveFailed' : 'disableFailed'
          deps.report(operation, error)
          statusGeneration++
          statusRead = undefined
          checking.value = false
          await readStatus(visibilityGeneration)
          throw error
        }
      } finally {
        if (!disposed) {
          phase.value = undefined
          action.value = undefined
        }
      }
    }
    const current = work().finally(() => {
      if (pending === current) pending = undefined
    })
    pending = current
    return current
  }

  function setReminderDismissed(enabled: boolean): Promise<void> {
    if (pending || !open.value || !showDismiss.value || !canManage.value || !deps.persist) return Promise.resolve()
    const generation = actionGeneration
    const active = () => !disposed && visible.value && generation === actionGeneration
    holdReminder.value = true
    action.value = 'dismiss'
    phase.value = 'saving'
    feedback.value = undefined
    const current = deps.persist('administratorReminderDismissed', enabled, active).catch((error) => {
      if (active()) {
        feedback.value = 'saveFailed'
        deps.report('save', error)
      }
    }).finally(() => {
      if (!disposed) {
        phase.value = undefined
        action.value = undefined
      }
      if (pending === current) pending = undefined
    })
    pending = current
    return current
  }

  function requestEnable(): void {
    if (!canManage.value || pending || isActive.value) return
    // Explicit activation reuses the reminder even after session/permanent dismissal.
    continued.value = true
    requested.value = true
    showDismiss.value = false
    feedback.value = undefined
    actionGeneration++
  }

  return {
    open,
    busy,
    showDismiss,
    canManage,
    checking,
    status,
    isActive,
    phase,
    action,
    feedback,
    continued,
    refreshStatus: () => visible.value && !disposed && !busy.value ? readStatus(visibilityGeneration) : Promise.resolve(),
    setVisible,
    setBlocked,
    continueNormally,
    enable,
    disable,
    requestEnable,
    setReminderDismissed,
    dispose: () => {
      disposed = true
      visible.value = false
      requested.value = false
      status.value = undefined
      feedback.value = undefined
      checking.value = false
      visibilityGeneration++
      actionGeneration++
      lifetime.abort()
    },
  }
}

export type PreferenceElevation = ReturnType<typeof createPreferenceElevation>
