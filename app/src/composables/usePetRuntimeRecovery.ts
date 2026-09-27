import { emitTo, listen } from '@tauri-apps/api/event'
import { message, Modal } from 'ant-design-vue'
import { onMounted, onUnmounted } from 'vue'

import { WINDOW_LABEL } from '@/constants'
import { createPetRuntimeRecoveryPrompt } from '@/features/petRuntime/recoveryPrompt'
import { PET_RUNTIME_RECOVERED, PET_RUNTIME_RECOVERY_QUERY, PET_RUNTIME_RESTART_REQUIRED } from '@/features/petRuntime/types'
import { restartApp } from '@/plugins/process'
import { showWindow } from '@/plugins/window'
import { reportDiagnostic } from '@/services/diagnostics'

/** Preferences owns the modal and delegates saving/restart to its process owner. */
export function usePetRuntimeRecovery(t: (key: string) => string): void {
  let disposed = false
  const stops: Array<() => void> = []
  const prompt = createPetRuntimeRecoveryPrompt({
    open: restart => Modal.confirm({
      title: t('pages.preference.petRuntimeRecovery.title'),
      content: t('pages.preference.petRuntimeRecovery.body'),
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

  onMounted(async () => {
    const register = async (event: string, handler: (payload: unknown) => void): Promise<boolean> => {
      const stop = await listen<unknown>(event, ({ payload }) => handler(payload))
      if (disposed) {
        stop()
        return false
      }
      stops.push(stop)
      return true
    }
    try {
      // Recovery must be observable before a failure can open its prompt. A
      // healthy query intentionally has no failure to replay, so registering
      // these in parallel could leave a startup prompt stuck after recovery.
      if (!await register(PET_RUNTIME_RECOVERED, payload => prompt.recovered(payload))) return
      if (!await register(PET_RUNTIME_RESTART_REQUIRED, (payload) => {
        void prompt.failed(payload)
      })) {
        return
      }
    } catch (error) {
      stops.splice(0).forEach(stop => stop())
      if (!disposed) reportDiagnostic('error', 'pet_runtime.recovery_subscription', error)
      return
    }
    // Register both listeners first: a failure during window startup must replay.
    await emitTo(WINDOW_LABEL.MAIN, PET_RUNTIME_RECOVERY_QUERY)
      .catch(error => reportDiagnostic('warn', 'pet_runtime.recovery_query', error))
  })
  onUnmounted(() => {
    disposed = true
    prompt.dispose()
    stops.splice(0).forEach(stop => stop())
  })
}
