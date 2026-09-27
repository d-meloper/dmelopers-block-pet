import { editorsLocked } from '@/features/stateSafety/bridge'

// App mounts before Preferences finishes restoring. Retain menu/shortcut edits
// until the single preset owner is ready to handle them.
let owner: ((payload: unknown) => void) | undefined
const pending: unknown[] = []

export function requestPresetEdit(payload: unknown): void {
  if (editorsLocked.value) return
  if (owner) owner(payload)
  else pending.push(payload)
}

export function registerPresetEditOwner(handler: (payload: unknown) => void): () => void {
  owner = handler
  pending.splice(0).forEach(handler)
  return () => {
    if (owner === handler) owner = undefined
  }
}
