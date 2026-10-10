import type { PresetApplyResponse, PresetSnapshot } from './types'

import { isExecutablePresetSnapshot } from './model'
import { PRESET_APPLY_CANCEL, PRESET_APPLY_REQUEST } from './types'

export function createPresetRequestClient(emit: (event: string, payload: unknown) => Promise<unknown>, timeoutMs = 15000) {
  let pending: { id: string, resolve: (response: PresetApplyResponse) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> } | undefined
  return {
    apply(snapshot: PresetSnapshot, restoreVisibility?: boolean): Promise<PresetApplyResponse> {
      if (!isExecutablePresetSnapshot(snapshot)) return Promise.reject(new Error('pages.preference.presets.errors.apply'))
      if (pending) return Promise.reject(new Error('pages.preference.presets.errors.apply'))
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        pending = {
          id,
          resolve,
          reject,
          timer: setTimeout(() => {
            if (pending?.id !== id) return
            pending = undefined
            void emit(PRESET_APPLY_CANCEL, { requestId: id }).catch(() => undefined)
            const error = new Error('pages.preference.presets.errors.apply')
            error.name = 'PresetApplyUncertainError'
            console.error('The preset application acknowledgement timed out.', error)
            reject(error)
          }, timeoutMs),
        }
        void emit(PRESET_APPLY_REQUEST, { requestId: id, snapshot, ...(restoreVisibility === undefined ? {} : { restoreVisibility }) }).catch((error) => {
          if (pending?.id !== id) return
          console.error('The preset application request could not be delivered.', error)
          clearTimeout(pending.timer)
          pending = undefined
          reject(new Error('pages.preference.presets.errors.apply'))
        })
      })
    },
    accept(value: unknown): boolean {
      const response = value as PresetApplyResponse | undefined
      if (!response || !pending || response.requestId !== pending.id) return false
      if (typeof response.success !== 'boolean' || !Number.isSafeInteger(response.revision)
        || response.revision < 0 || (response.success && !isExecutablePresetSnapshot(response.snapshot))) {
        console.warn('The preset application acknowledgement was invalid.')
        return false
      }
      const request = pending
      pending = undefined
      clearTimeout(request.timer)
      if (response.success) {
        request.resolve(response)
      } else {
        const error = new Error('pages.preference.presets.errors.apply')
        if (response.restored !== true) error.name = 'PresetApplyUncertainError'
        request.reject(error)
      }
      return true
    },
    dispose() {
      if (!pending) return
      void emit(PRESET_APPLY_CANCEL, { requestId: pending.id }).catch(() => undefined)
      clearTimeout(pending.timer)
      pending.reject(new Error('pages.preference.presets.errors.apply'))
      pending = undefined
    },
  }
}
