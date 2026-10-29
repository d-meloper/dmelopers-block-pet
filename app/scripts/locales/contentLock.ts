import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { hashText, inclusionSourceHash, projectPath, readInclusionPolicy, readJson, readRegistry } from './core'
import { INCLUSION_POLICY_PATH, inclusionMatches } from './inclusionPolicy'

// Public offline projection of the private operations lock. Keep its canonical
// hash contract identical to Translation/Core/hash; no provider/runtime imports.
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  throw new Error('LOCALE_LOCK_VALUE_INVALID')
}
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('LOCALE_LOCK_SCHEMA_INVALID')
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('LOCALE_LOCK_HASH_INVALID')
}
export const CONTENT_LOCK_PATH = 'src/locales/content-lock.json'
export function checkContentLock(root: string, options: { committed?: boolean } = {}): void {
  const lock = readJson(root, CONTENT_LOCK_PATH)
  fields(lock, ['schemaVersion', 'kind', 'sourceRevision', 'files', 'languages', 'snapshotInputsSha256', 'lockSha256'])
  if ((lock.schemaVersion !== 1 && lock.schemaVersion !== 2) || lock.kind !== 'BlockPetLocaleContentLock' || !Array.isArray(lock.files) || !Array.isArray(lock.languages)) throw new Error('LOCALE_LOCK_SCHEMA_INVALID')
  for (const value of [lock.sourceRevision, lock.snapshotInputsSha256, lock.lockSha256]) digest(value)
  const { lockSha256, ...body } = lock
  if (hashText(canonical(body)) !== lockSha256) throw new Error('LOCALE_LOCK_SELF_HASH_MISMATCH')
  const registry = readRegistry(root)
  const ready = Object.keys(registry.locales).filter(code => registry.locales[code].status === 'ready').sort()
  const expectedFiles = ['src/locales/registry.json', 'src/locales/reviews.json', ...ready.map(code => `src/locales/${code}.json`), ...(lock.schemaVersion === 2 ? [INCLUSION_POLICY_PATH] : [])].sort()
  const paths: string[] = []
  for (const file of lock.files) {
    fields(file, ['path', 'sha256'])
    digest(file.sha256)
    if (typeof file.path !== 'string' || !expectedFiles.includes(file.path) || paths.includes(file.path)) throw new Error('LOCALE_LOCK_FILE_SET_INVALID')
    paths.push(file.path)
    const bytes = readFileSync(projectPath(root, file.path))
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('LOCALE_LOCK_FILE_DRIFT')
  }
  if (canonical(paths.sort()) !== canonical(expectedFiles)) throw new Error('LOCALE_LOCK_FILE_SET_INVALID')
  const policy = lock.schemaVersion === 2 ? readInclusionPolicy(root) : undefined
  const sourceInputsSha256 = policy ? inclusionSourceHash(root) : ''
  if (lock.schemaVersion === 2 && !policy) throw new Error('LOCALE_LOCK_INCLUSION_REQUIRED')
  const codes: string[] = []
  for (const language of lock.languages) {
    fields(language, ['locale', 'provider', 'sourceRevision', 'translationContentSha256', 'catalogSha256', 'provenanceSha256', 'reviewState'])
    if (typeof language.locale !== 'string' || !ready.includes(language.locale) || codes.includes(language.locale)) throw new Error('LOCALE_LOCK_LANGUAGE_SET_INVALID')
    codes.push(language.locale)
    for (const value of [language.sourceRevision, language.translationContentSha256, language.catalogSha256, language.provenanceSha256]) digest(value)
    if (language.sourceRevision !== lock.sourceRevision) throw new Error('LOCALE_LOCK_SOURCE_MISMATCH')
    const firstParty = ['ko-KR', 'en-US'].includes(language.locale)
    if (language.provider !== (firstParty ? 'LocalFirstParty' : 'GoogleSheets') || !['Unknown', 'AiOnly', 'Mixed', 'HumanReady', 'HumanReleased'].includes(String(language.reviewState))) throw new Error('LOCALE_LOCK_PROVENANCE_INVALID')
    if (!firstParty && !['HumanReady', 'HumanReleased'].includes(String(language.reviewState))) {
      const inclusion = policy?.inclusions.find(entry => entry.locale === language.locale)
      if (!inclusion || !inclusionMatches(inclusion, language as unknown as Parameters<typeof inclusionMatches>[1], sourceInputsSha256)) throw new Error('LOCALE_LOCK_HUMAN_REVIEW_REQUIRED')
    }
    if (firstParty && language.reviewState !== 'Unknown') throw new Error('LOCALE_LOCK_FIRST_PARTY_STATE_INVALID')
    const catalog = lock.files.find(file => (file as Record<string, unknown>).path === `src/locales/${language.locale}.json`) as Record<string, unknown> | undefined
    if (catalog?.sha256 !== language.catalogSha256) throw new Error('LOCALE_LOCK_CATALOG_MISMATCH')
  }
  if (canonical(codes.sort()) !== canonical(ready)) throw new Error('LOCALE_LOCK_LANGUAGE_SET_INVALID')
  for (const inclusion of policy?.inclusions ?? []) {
    const language = lock.languages.find(language => (language as Record<string, unknown>).locale === inclusion.locale)
    if (!language || !inclusionMatches(inclusion, language as Parameters<typeof inclusionMatches>[1], sourceInputsSha256)) throw new Error('LOCALE_LOCK_INCLUSION_STALE')
  }
  if (options.committed) {
    // Explicit shipment preparation gate, never a live provider call. Public
    // source exports use their own Git tree and the same relative input paths.
    for (const path of [CONTENT_LOCK_PATH, ...paths]) {
      const committed = execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'buffer', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      if (!committed.equals(readFileSync(projectPath(root, path)))) throw new Error('LOCALE_LOCK_UNCOMMITTED_INPUT')
    }
  }
}
