import type { StoreHooks } from '@tauri-store/pinia'
import type { PiniaPlugin } from 'pinia'

import { createPlugin } from '@tauri-store/pinia'

interface SettingsSyncPolicy {
  isSavingAllowed: () => boolean
  beforeBackendSync: NonNullable<StoreHooks['beforeBackendSync']>
}

export function createSettingsStorePlugin(policy: SettingsSyncPolicy): PiniaPlugin {
  return (context) => {
    const options = context.options.tauri
    const hooks = options?.hooks
    // The upstream plugin merges options shallowly. A store's migration hook
    // must retain the shared save barrier, without mutating its definition.
    return createPlugin({ saveOnChange: true, save: policy.isSavingAllowed() })({
      ...context,
      options: {
        ...context.options,
        tauri: {
          ...options,
          hooks: {
            ...hooks,
            beforeBackendSync(state) {
              const allowed = policy.beforeBackendSync(state)
              if (allowed == null) return allowed
              return hooks?.beforeBackendSync ? hooks.beforeBackendSync(allowed) : allowed
            },
          },
        },
      },
    })
  }
}
