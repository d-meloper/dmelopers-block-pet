import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

export type DistributionChannel = 'github' | 'store' | 'test' | 'development'
export interface DistributionInfo {
  channel: DistributionChannel
  dataRoot: string
  localDataRoot: string
  updateUrl: string
  dataSchema: number
}

export async function getDistributionInfo(): Promise<DistributionInfo> {
  await invoke('await_native_startup')
  return invoke<DistributionInfo>('distribution_info')
}

export async function openStore(isCurrent: () => boolean = () => true): Promise<void> {
  const info = await getDistributionInfo()
  // Retire stale preparation; an already issued opener retains its own result.
  if (!isCurrent()) return
  const isStoreDestination = info.updateUrl === 'ms-windows-store://downloadsandupdates'
    || /^https:\/\/apps\.microsoft\.com\/detail\/[A-Z0-9]{12}$/i.test(info.updateUrl)
  if (info.channel !== 'store' || !isStoreDestination) {
    throw new Error('STORE_ID_UNAVAILABLE')
  }
  await openUrl(info.updateUrl)
}
