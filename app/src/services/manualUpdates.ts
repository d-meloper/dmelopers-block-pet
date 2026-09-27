import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

export interface LatestVersionResponse {
  status: 'upToDate' | 'available' | 'localNewer' | 'unknown'
  currentVersion: string
  latestVersion: string | null
  lastSuccessAt: number | null
  lastAttemptAt: number | null
  errorCode: string | null
  fromCache: boolean
}

/** The native service owns source validation, request coalescing and cache freshness. */
export async function checkLatestVersion(): Promise<LatestVersionResponse> {
  await invoke('await_native_startup')
  return invoke<LatestVersionResponse>('check_latest_version')
}

/** Only an explicit user action opens the native build's fixed releases list. */
export async function openReleaseDownloads(): Promise<void> {
  const url = await invoke<string>('latest_version_releases_url')
  if (![
    'https://github.com/d-meloper/dmelopers-block-pet/releases',
    'https://github.com/oup030416/dmelopers-block-pet-test/releases',
  ].includes(url)) {
    throw new Error('Unexpected release source')
  }
  await openUrl(url)
}
