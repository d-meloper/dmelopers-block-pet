interface RecoveryPromptOptions {
  open: (restart: () => Promise<void>) => { destroy: () => void }
  showWindow: () => Promise<void>
  restart: () => Promise<void>
  reportWindowError: (error: unknown) => void
  reportRestartError: (error: unknown) => void
}

function incidentOf(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return
  const incident = (value as { incident?: unknown }).incident
  return typeof incident === 'number' && Number.isSafeInteger(incident) && incident > 0
    ? incident
    : undefined
}

/** Window-local prompts never restart the application without a user action. */
export function createPetRuntimeRecoveryPrompt(options: RecoveryPromptOptions) {
  let disposed = false
  let latestIncident = 0
  let activeIncident: number | undefined
  let modal: { destroy: () => void } | undefined
  let restart: Promise<void> | undefined

  const close = () => {
    activeIncident = undefined
    modal?.destroy()
    modal = undefined
  }

  return {
    async failed(payload: unknown): Promise<void> {
      const incident = incidentOf(payload)
      if (disposed || incident === undefined || incident <= latestIncident) return
      latestIncident = incident
      close()
      activeIncident = incident
      modal = options.open(() => {
        if (disposed || activeIncident !== incident) return Promise.resolve()
        // The save/process owner is also single-flight; retain the same result
        // here so repeated modal clicks cannot start competing requests.
        restart ??= options.restart().catch((error: unknown) => {
          if (!disposed && activeIncident === incident) options.reportRestartError(error)
          throw error // Ant Design retains the modal when saving/restarting fails.
        }).finally(() => {
          restart = undefined
        })
        return restart
      })
      try {
        await options.showWindow()
      } catch (error) {
        // Keep the prompt available if the user subsequently opens Preferences.
        if (!disposed && activeIncident === incident) options.reportWindowError(error)
      }
    },
    recovered(payload: unknown) {
      const incident = incidentOf(payload)
      if (disposed || incident === undefined) return
      latestIncident = Math.max(latestIncident, incident)
      if (activeIncident !== undefined && activeIncident <= incident) close()
    },
    dispose() {
      disposed = true
      close()
    },
  }
}
