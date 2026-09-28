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

export async function openStore(): Promise<void> {
  const info = await getDistributionInfo()
  if (info.channel !== 'store' || !/^https:\/\/apps\.microsoft\.com\/detail\/[A-Z0-9]{12}$/i.test(info.updateUrl)) {
    throw new Error('STORE_ID_UNAVAILABLE')
  }
  await openUrl(info.updateUrl)
}
