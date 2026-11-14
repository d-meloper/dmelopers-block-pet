import { computed, ref, shallowRef } from 'vue'

import { waitForRecovery } from '@/features/recovery/wait'

import type { ElevatedRestartPreparation, ElevationStatus } from './types'

interface Dependencies {
  status: () => Promise<ElevationStatus>
  prepare: () => Promise<ElevatedRestartPreparation>
  cancel: (ticket: string) => Promise<void>
  restart: (ticket: string, isCurrent: () => boolean) => Promise<void>
  persist?: (key: 'alwaysRunAsAdministrator' | 'administratorReminderDismissed', enabled: boolean, isCurrent: () => boolean) => Promise<void>
  reminderDismissed?: () => boolean
  report: (operation: 'status' | 'prepare' | 'cancel' | 'restart' | 'save', error: unknown) => void
}

/** Preferences owns explicit choices; bootstrap alone owns automatic elevation. */
export function createPreferenceElevation(deps: Dependencies, statusTimeoutMs = 5000) {
  const visible = ref(false)
  const blocked = ref(true)
  const status = shallowRef<ElevationStatus>()
  const checking = ref(false)
  const phase = ref<'saving' | 'preparing' | 'restarting'>()
  const action = ref<'once' | 'always' | 'dismiss' | 'settings'>()
  const feedback = ref<'cancelled' | 'failed' | 'saveFailed'>()
  const continued = ref(false)
  const requested = ref(false)
  const holdReminder = ref(false)
  const restartConfirmation = ref(false)
  const handoffUnconfirmed = ref(false)
  const lifetime = new AbortController()
  let disposed = false
  let visibilityGeneration = 0
  let actionGeneration = 0
  let statusRead: Promise<ElevationStatus> | undefined
  let statusWait: Promise<void> | undefined
  let pending: Promise<void> | undefined
  let restartChoice: 'once' | 'always' | undefined

  const open = computed(() => !disposed && visible.value && !blocked.value
    && status.value?.supported === true && !handoffUnconfirmed.value
    && (requested.value || (!continued.value && status.value.elevated === false
      && (!deps.reminderDismissed?.() || holdReminder.value || phase.value === 'saving'))))
  const busy = computed(() => phase.value !== undefined)
  // Retain the dialog's action layout through its closing animation.
  const showDismiss = ref(true)
  const canManage = computed(() => !disposed && visible.value && !blocked.value && !busy.value
    && status.value?.supported === true && !handoffUnconfirmed.value)

  async function cancel(ticket: string) {
    try {
      await deps.cancel(ticket)
    } catch (error) {
      // Cancellation only retires a prepared child. Never infer a changed token.
      deps.report('cancel', error)
    }
  }

  async function readStatus(generation: number) {
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
      if (!disposed && visible.value && generation === visibilityGeneration && !continued.value) {
        status.value = result
        if (result.startupAttempt === 'cancelled' || result.startupAttempt === 'failed') {
          continued.value = true
          feedback.value = result.startupAttempt
        }
      }
    } catch (error) {
      if (!disposed && visible.value && generation === visibilityGeneration) deps.report('status', error)
    } finally {
      if (!disposed && generation === visibilityGeneration) checking.value = false
    }
  }

  function setVisible(value: boolean): Promise<void> {
    if (disposed || visible.value === value) return statusWait ?? Promise.resolve()
    visible.value = value
    if (!value) {
      requested.value = false
      holdReminder.value = false
      restartChoice = undefined
    } else if (!continued.value) {
      restartConfirmation.value = false
    }
    visibilityGeneration++
    actionGeneration++
    // Token/support are stable for this process. Keep them for General settings
    // after a session dismissal, without rechecking merely because a tab mounts.
    if (!continued.value) {
      status.value = undefined
      feedback.value = undefined
    }
    checking.value = false
    if (!value || continued.value || handoffUnconfirmed.value) return Promise.resolve()
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
    restartChoice = undefined
    actionGeneration++
    feedback.value = undefined
  }

  function choose(always = false): Promise<void> {
    if (pending) return pending
    if (disposed || busy.value || !open.value || restartConfirmation.value
      || (!always && !showDismiss.value)) {
      return Promise.resolve()
    }
    feedback.value = undefined
    if (!always) {
      restartChoice = 'once'
      restartConfirmation.value = true
      return Promise.resolve()
    }
    const generation = actionGeneration
    const active = () => !disposed && visible.value && !blocked.value && (requested.value || !continued.value)
      && generation === actionGeneration
    action.value = 'always'
    phase.value = 'saving'
    const current = (async () => {
      try {
        if (!deps.persist) throw new Error('ELEVATION_PREFERENCE_UNAVAILABLE')
        await deps.persist('alwaysRunAsAdministrator', true, active)
        if (!active()) return
        if (status.value?.elevated) {
          continued.value = true
          requested.value = false
          restartChoice = undefined
        } else {
          restartChoice = 'always'
          restartConfirmation.value = true
        }
      } catch (error) {
        if (active()) {
          feedback.value = 'saveFailed'
          deps.report('save', error)
        }
      } finally {
        if (!disposed) {
          phase.value = undefined
          action.value = undefined
        }
      }
    })().finally(() => {
      if (pending === current) pending = undefined
    })
    pending = current
    return current
  }

  function confirmRestart(): Promise<void> {
    if (pending) return pending
    if (disposed || busy.value || !open.value || !restartConfirmation.value
      || !restartChoice || status.value?.elevated !== false) {
      return Promise.resolve()
    }
    const generation = actionGeneration
    const active = () => !disposed && visible.value && !blocked.value && (requested.value || !continued.value)
      && generation === actionGeneration
    feedback.value = undefined
    action.value = restartChoice
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
        phase.value = 'restarting'
        // The process owner now owns quiescence, persistence and native commit.
        transferred = true
        await deps.restart(ticket, active)
        if (!disposed) handoffUnconfirmed.value = true
      } catch (error) {
        if (active()) {
          feedback.value = 'failed'
          deps.report(transferred ? 'restart' : 'prepare', error)
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

  function persist(key: 'alwaysRunAsAdministrator' | 'administratorReminderDismissed', enabled: boolean, keepDialog = false): Promise<void> {
    if (pending || !canManage.value || !deps.persist) return Promise.resolve()
    const generation = actionGeneration
    const active = () => !disposed && visible.value && generation === actionGeneration
    if (keepDialog) {
      holdReminder.value = true
    } else {
      continued.value = true
      requested.value = false
      restartChoice = undefined
    }
    action.value = keepDialog ? 'dismiss' : 'settings'
    phase.value = 'saving'
    feedback.value = undefined
    const current = deps.persist(key, enabled, active).catch((error) => {
      if (active()) {
        feedback.value = 'saveFailed'
        deps.report('save', error)
      }
      throw error
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

  function setAlways(enabled: boolean): Promise<void> {
    if (!enabled) return persist('alwaysRunAsAdministrator', false)
    if (!canManage.value || pending) return Promise.resolve()
    // An explicit settings action can reopen the same dialog after Cancel or
    // permanent dismissal, including when this process is already elevated.
    // Keep the durable choice unchanged until Always is confirmed in the dialog.
    continued.value = true
    requested.value = true
    showDismiss.value = false
    restartConfirmation.value = false
    restartChoice = undefined
    feedback.value = undefined
    actionGeneration++
    return Promise.resolve()
  }

  return {
    open,
    busy,
    showDismiss,
    restartConfirmation,
    canManage,
    checking,
    status,
    phase,
    action,
    feedback,
    continued,
    handoffUnconfirmed,
    setVisible,
    setBlocked,
    continueNormally,
    restart: () => choose(),
    restartAlways: () => choose(true),
    confirmRestart,
    setAlways,
    setReminderDismissed: (enabled: boolean) => {
      if (!open.value || !showDismiss.value || restartConfirmation.value) return Promise.resolve()
      return persist('administratorReminderDismissed', enabled, true).catch(() => {})
    },
    dispose: () => {
      disposed = true
      visible.value = false
      requested.value = false
      restartChoice = undefined
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
