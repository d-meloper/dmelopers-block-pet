import { emitTo, listen } from '@tauri-apps/api/event'
import { message, Modal } from 'ant-design-vue'
import { h, onMounted, onUnmounted } from 'vue'

import { WINDOW_LABEL } from '@/constants'
import { createPetRuntimeRecoveryPrompt } from '@/features/petRuntime/recoveryPrompt'
import { PET_RUNTIME_RECOVERED, PET_RUNTIME_RECOVERY_QUERY, PET_RUNTIME_RESTART_REQUIRED } from '@/features/petRuntime/types'
import { waitForRecovery } from '@/features/recovery/wait'
import { restartApp } from '@/plugins/process'
import { showWindow } from '@/plugins/window'
import { reportDiagnostic } from '@/services/diagnostics'

/** Preferences owns the modal and delegates saving/restart to its process owner. */
export function usePetRuntimeRecovery(t: (key: string) => string): void {
  let disposed = false
  const lifetime = new AbortController()
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let listenerGeneration = 0
  let failedSetup = false
  const stops: Array<() => void> = []
  const release = (stop: () => void) => {
    const failed = (error: unknown) => reportDiagnostic('warn', 'pet_runtime.recovery_cleanup', error)
    try {
      void Promise.resolve(stop()).catch(failed)
    } catch (error) {
      failed(error)
    }
  }
  const prompt = createPetRuntimeRecoveryPrompt({
    open: restart => Modal.confirm({
      direction: typeof document !== 'undefined' && document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr',
      title: t('pages.preference.petRuntimeRecovery.title'),
      content: h('div', [
        h('p', t('pages.preference.petRuntimeRecovery.body')),
        h('p', t('recovery.guidance.logs')),
        h('p', t('recovery.guidance.lastResort')),
      ]),
      okText: t('pages.preference.petRuntimeRecovery.restart'),
      cancelText: t('pages.preference.petRuntimeRecovery.later'),
      maskClosable: false,
      onOk: restart,
    }),
    showWindow: () => showWindow(),
    restart: restartApp,
    reportWindowError: error => reportDiagnostic('error', 'pet_runtime.recovery_prompt', error),
    reportRestartError: () => message.error(t('composables.useAppMenu.errors.restart'), 8),
  })

  async function setup() {
    if (disposed) return
    const generation = stops.length === 2 ? listenerGeneration : ++listenerGeneration
    const register = async (event: string, handler: (payload: unknown) => void): Promise<boolean> => {
      const registration = listen<unknown>(event, ({ payload }) => {
        if (!disposed && listenerGeneration === generation) handler(payload)
      })
      let stop: () => void
      try {
        stop = await waitForRecovery(registration, 8000, lifetime.signal)
      } catch (error) {
        void registration.then(release).catch(() => {})
        throw error
      }
      if (disposed || listenerGeneration !== generation) {
        release(stop)
        return false
      }
      stops.push(stop)
      return true
    }
    try {
      // Recovery must be observable before a failure can open its prompt. A
      // healthy query intentionally has no failure to replay, so registering
      // these in parallel could leave a startup prompt stuck after recovery.
      if (stops.length !== 2) {
        if (!await register(PET_RUNTIME_RECOVERED, payload => prompt.recovered(payload))) return
        if (!await register(PET_RUNTIME_RESTART_REQUIRED, (payload) => {
          void prompt.failed(payload)
        })) {
          return
        }
      }
    } catch (error) {
      listenerGeneration++
      stops.splice(0).forEach(release)
      if (!disposed) {
        if (!failedSetup) reportDiagnostic('error', 'pet_runtime.recovery_subscription', error)
        failedSetup = true
        retryTimer = setTimeout(() => void setup(), 1000)
      }
      return
    }
    // Register both listeners first: a failure during window startup must replay.
    try {
      await waitForRecovery(emitTo(WINDOW_LABEL.MAIN, PET_RUNTIME_RECOVERY_QUERY), 8000, lifetime.signal)
      failedSetup = false
    } catch (error) {
      if (!disposed) {
        if (!failedSetup) reportDiagnostic('warn', 'pet_runtime.recovery_query', error)
        failedSetup = true
        retryTimer = setTimeout(() => void setup(), 1000)
      }
    }
  }
  onMounted(setup)
  onUnmounted(() => {
    disposed = true
    lifetime.abort()
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    prompt.dispose()
    stops.splice(0).forEach(release)
  })
}
