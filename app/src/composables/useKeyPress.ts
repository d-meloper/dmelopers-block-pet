import type { ShortcutHandler } from '@tauri-apps/plugin-global-shortcut'
import type { Ref } from 'vue'

import {
  isRegistered,
  register,
  unregister,
} from '@tauri-apps/plugin-global-shortcut'
import { onUnmounted, watch } from 'vue'

import { editorsLocked, reportShortcutConflict, stateOwners } from '@/features/stateSafety/bridge'
import { shortcutIdentity } from '@/utils/shortcutIdentity'

const activeShortcutOwners = new Set<string>()
const suppressedShortcutPresses = new Set<string>()
const shortcutRecorders = new Set<{ released: Set<string>, cancel: () => void }>()
let shortcutUpdates = Promise.resolve()
stateOwners.drainShortcuts = () => shortcutUpdates

export function beginShortcutRecording(cancel: () => void): (value?: string) => void {
  const recorder = { released: new Set<string>(), cancel }
  shortcutRecorders.add(recorder)
  return (value) => {
    if (!shortcutRecorders.delete(recorder) || !value) return
    const identity = shortcutIdentity(value)
    // A native Pressed event may arrive after the input has automatically blurred.
    // Unregistered candidates have no outstanding native release to wait for.
    if (activeShortcutOwners.has(identity) && !recorder.released.has(identity)) {
      suppressedShortcutPresses.add(identity)
    }
  }
}

export function cancelShortcutRecording() {
  for (const recorder of [...shortcutRecorders]) recorder.cancel()
}

export function useKeyPress(shortcut: Ref<string | undefined, string>, callback: ShortcutHandler) {
  let registeredShortcut: string | undefined
  let disposed = false

  function synchronize() {
    shortcutUpdates = shortcutUpdates.then(async () => {
      const value = disposed ? undefined : shortcut.value || undefined
      if (registeredShortcut === value) return
      if (registeredShortcut) {
        await unregister(registeredShortcut)
        activeShortcutOwners.delete(shortcutIdentity(registeredShortcut))
        suppressedShortcutPresses.delete(shortcutIdentity(registeredShortcut))
        registeredShortcut = undefined
      }
      if (!value || disposed) return
      if (activeShortcutOwners.has(shortcutIdentity(value))) throw new Error('A shortcut already has an active owner.')
      // Development restart reloads webviews while keeping native registrations.
      // Reclaim those retired handlers without removing another live owner's key.
      if (await isRegistered(value)) await unregister(value)
      if (disposed) return
      await register(value, (event) => {
        if (disposed || shortcut.value !== value) return
        const identity = shortcutIdentity(value)
        if (event.state === 'Released') {
          suppressedShortcutPresses.delete(identity)
          for (const recorder of shortcutRecorders) recorder.released.add(identity)
          return
        }
        if (editorsLocked.value) return
        if (shortcutRecorders.size || suppressedShortcutPresses.has(identity)) {
          suppressedShortcutPresses.add(identity)
          for (const recorder of shortcutRecorders) recorder.released.delete(identity)
          return
        }
        callback(event)
      })
      registeredShortcut = value
      activeShortcutOwners.add(shortcutIdentity(value))
    }).catch((error) => {
      if (shortcut.value) reportShortcutConflict(shortcut.value)
      console.error('Failed to synchronize a global shortcut.', error)
    })
  }

  // Native registration is asynchronous. Drain an older registration before
  // replacing it, including when unmount happens before it is acknowledged.
  watch(shortcut, synchronize, { immediate: true })
  onUnmounted(() => {
    disposed = true
    synchronize()
  })
}
