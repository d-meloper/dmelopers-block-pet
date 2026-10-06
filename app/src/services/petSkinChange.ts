import { emitTo } from '@tauri-apps/api/event'

import type { PetSkinChangeRequest, PreparedPetSkin } from '@/features/petRuntime/types'

import { WINDOW_LABEL } from '@/constants'
import { PET_SKIN_CHANGE } from '@/features/petRuntime/types'

let notificationTail: Promise<unknown> = Promise.resolve()
function notify(request: PetSkinChangeRequest) {
  // Preserve starts/ends across rapid choices even when native delivery is async.
  const operation = notificationTail.catch(() => {}).then(() => emitTo(WINDOW_LABEL.MAIN, PET_SKIN_CHANGE, request))
  notificationTail = operation
  return operation
}

/** A replacement includes preparation in Preferences before the renderer sees PNG bytes. */
export function beginPetSkinChange(
  send: (request: PetSkinChangeRequest) => Promise<unknown> = notify,
) {
  const requestId = crypto.randomUUID()
  const ready = send({ requestId, phase: 'prepare' }).then(() => {})
  let completion: Promise<void> | undefined
  return {
    ready,
    finish: (skin?: PreparedPetSkin): Promise<void> => completion ??= ready
      .catch(() => {})
      .then(() => send({ requestId, phase: 'finish', skin }))
      .catch(async (error) => {
        // A failed handoff must not leave the pet holding this loading token.
        await send({ requestId, phase: 'finish' }).catch(() => {})
        throw error
      })
      .then(() => {}),
  }
}
