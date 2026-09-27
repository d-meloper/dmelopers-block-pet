import { computed, ref, shallowRef } from 'vue'

import type { DistributionChannel } from '@/services/distribution'
import type { AppUpdateInfo, UpdatePhase } from '@/services/inAppUpdates'

export const UPDATE_REMINDER_WEEK = 7 * 24 * 60 * 60 * 1000

interface Dependencies {
  channel: () => Promise<DistributionChannel>
  checkApp: (force: boolean) => Promise<AppUpdateInfo>
  install: (onPhase: (phase: UpdatePhase) => void, onProgress: (percent: number) => void) => Promise<void>
  cancel: () => Promise<void>
  hiddenUntil: () => number
  hideUntil: (deadline: number) => void
  report: (operation: 'check' | 'install', error: unknown) => void
  now?: () => number
}

/** One owner for the persistent preference window and its About tab. */
export function createPreferenceUpdates(deps: Dependencies) {
  const channel = ref<DistributionChannel>()
  const checking = ref(false)
  const failed = ref(false)
  const appInfo = shallowRef<AppUpdateInfo>()
  const phase = ref<UpdatePhase>()
  const percent = ref(0)
  const reminderVersion = ref<string>()
  const busy = computed(() => checking.value || !!phase.value)
  const canCancel = computed(() => phase.value === 'downloading' || phase.value === 'verifying')
  const cancelling = ref(false)
  const now = deps.now ?? Date.now
  let visible = false
  let disposed = false
  let generation = 0
  let pending: Promise<void> | undefined

  function offer(version: string | null | undefined) {
    const deadline = deps.hiddenUntil()
    if (version && !(Number.isFinite(deadline) && deadline > now())) reminderVersion.value = version
  }

  async function check(force = true): Promise<void> {
    if (disposed || !visible || phase.value) return
    if (pending) return pending
    if (checking.value) return
    const current = generation
    const active = () => !disposed && visible && current === generation
    checking.value = true
    failed.value = false
    pending = (async () => {
      try {
        channel.value ??= await deps.channel()
        if (!active()) return
        if (channel.value === 'github' || channel.value === 'test') {
          const result = await deps.checkApp(force)
          if (!active()) return
          appInfo.value = result
          if (result.available) offer(result.version)
        }
      } catch (error) {
        if (active()) {
          failed.value = true
          deps.report('check', error)
        }
      }
    })()
    await pending
    pending = undefined
    checking.value = false
    // A hidden window can reopen before an earlier request settles.
    if (!disposed && visible && current !== generation) await check(false)
  }

  async function setVisible(value: boolean) {
    if (disposed || visible === value) return
    visible = value
    generation += 1
    reminderVersion.value = undefined
    if (value) await check(false)
  }

  function dismiss() {
    if (!busy.value) reminderVersion.value = undefined
  }

  function snooze() {
    if (busy.value) return
    deps.hideUntil(now() + UPDATE_REMINDER_WEEK)
    dismiss()
  }

  async function update() {
    if (disposed || !visible || busy.value) return
    if (channel.value !== 'github' && channel.value !== 'test') return
    const acceptedVersion = reminderVersion.value ?? appInfo.value?.version
    if (!acceptedVersion) return
    const current = generation
    checking.value = true
    failed.value = false
    try {
      // The native selection expires. Revalidate on the user's click, before
      // downloading, and ask again if the available version changed meanwhile.
      const result = await deps.checkApp(true)
      if (disposed || !visible || current !== generation) return
      appInfo.value = result
      if (!result.available || !result.version) {
        reminderVersion.value = undefined
        return
      }
      if (result.version !== acceptedVersion) {
        reminderVersion.value = result.version
        return
      }
      percent.value = 0
      await deps.install((value) => {
        phase.value = value
      }, (value) => {
        percent.value = value
      })
      reminderVersion.value = undefined
    } catch (error) {
      if (String(error).includes('UPDATE_CANCELLED')) {
        reminderVersion.value = undefined
      } else {
        failed.value = true
        deps.report('install', error)
      }
    } finally {
      checking.value = false
      phase.value = undefined
      if (!disposed && visible && current !== generation) await check(false)
    }
  }

  async function cancel() {
    if (!canCancel.value || cancelling.value) return
    cancelling.value = true
    try {
      await deps.cancel()
    } catch (error) {
      if (!String(error).includes('UPDATE_TOO_LATE')) deps.report('install', error)
    } finally {
      cancelling.value = false
    }
  }

  return {
    channel,
    checking,
    failed,
    appInfo,
    phase,
    percent,
    reminderVersion,
    busy,
    canCancel,
    cancelling,
    cancel,
    check,
    setVisible,
    dismiss,
    snooze,
    update,
    dispose: () => {
      disposed = true
      visible = false
      generation += 1
      reminderVersion.value = undefined
    },
  }
}

export type PreferenceUpdates = ReturnType<typeof createPreferenceUpdates>
