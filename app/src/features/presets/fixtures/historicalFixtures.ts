import { readFileSync } from 'node:fs'

import type { PresetCollection, PresetSnapshot } from '../types'

export interface HistoricalFixture {
  fixtureVersion: number
  provenance: { kind: string, version: string, producerCommit: string, publicCommit: string | null, sources: Record<string, { gitBlob: string, sha256: string }> }
  catalogVersion: number
  portableVersion?: number
  presetKeys: string[]
  defaults: PresetSnapshot
  cases: Array<{ id: string, snapshot: PresetSnapshot, portable?: Record<string, any>, expectedLegacySettings?: Record<string, any> }>
  valueCases: Array<{ path: string[], values: unknown[] }>
  catalog: PresetCollection
  unsupportedCurrentPaths?: string[][]
}

export const historicalManifest = JSON.parse(readFileSync(new URL('./historical/manifest.json', import.meta.url), 'utf8')) as {
  fixtureVersion: number
  sources: Array<{ version: string, kind: string, producerCommit: string, publicCommit: string | null, file: string, sha256: string }>
}
export const historicalFixtures = historicalManifest.sources.map(binding => ({
  binding,
  // The immutable content digest uses UTF-8/LF, independent of checkout EOL.
  text: readFileSync(new URL(`./historical/${binding.file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
})).map(({ binding, text }) => ({ binding, text, fixture: JSON.parse(text) as HistoricalFixture }))

// Explicit approved additions: changing live defaults must not rewrite history.
export const releasedMissingDefaults = {
  petAnimationMode: 'default',
  petShoulderTorsoConnected: false,
  petRightArmDisabled: false,
  petLeftArmDisabled: false,
  petHeadbuttRecoilEnabled: true,
  petHeadbuttRecoilStrengthPercent: 50,
  petHeadbuttRecoilWobblePercent: 50,
  petTypingHandLiftPercent: 100,
  petTypingBodyMotionPercent: 100,
  petTypingReturnSpeedPercent: 100,
  petHeadbuttMaxRadiusOffset: 0,
  petTypingMaxRadiusOffset: 0,
}

export function historicalCurrentSettings(settings: Record<string, any>) {
  const next = JSON.parse(JSON.stringify(settings)) as Record<string, any>
  for (const [key, value] of Object.entries(releasedMissingDefaults)) {
    if (!Object.prototype.hasOwnProperty.call(next.preset, key)) next.preset[key] = value
  }
  return next
}

export function historicalSet(source: Record<string, any>, path: string[], value: unknown) {
  let target = source
  for (const part of path.slice(0, -1)) target = target[part]
  target[path[path.length - 1]] = value
}

export function historicalGet(source: unknown, path: string[]): unknown {
  return path.reduce<any>((value, key) => value?.[key], source)
}
