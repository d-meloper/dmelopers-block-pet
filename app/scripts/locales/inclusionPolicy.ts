/** Sanitized, exact-content maintainer decisions; never human-review evidence. */
export const INCLUSION_POLICY_PATH = 'src/locales/inclusion-policy.json'
export const INCLUSION_SOURCE_PATHS = ['src/locales/en-US.json', 'src/locales/ko-KR.json', 'src/locales/registry.json', 'src/locales/reviews.json']

export interface MaintainerLocaleInclusion {
  locale: string
  reviewState: 'AiOnly' | 'Mixed'
  sourceInputsSha256: string
  sourceRevision: string
  translationContentSha256: string
  catalogSha256: string
  provenanceSha256: string
  decisionSha256: string
}
export interface MaintainerLocalePolicy {
  schemaVersion: 1
  kind: 'BlockPetMaintainerLocaleInclusions'
  inclusions: MaintainerLocaleInclusion[]
}

export function assertInclusionPolicy(value: unknown): asserts value is MaintainerLocalePolicy {
  const exact = (object: unknown, fields: string[]): object is Record<string, unknown> => !!object && typeof object === 'object' && !Array.isArray(object) && JSON.stringify(Object.keys(object).sort()) === JSON.stringify(fields.sort())
  if (!exact(value, ['schemaVersion', 'kind', 'inclusions']) || value.schemaVersion !== 1 || value.kind !== 'BlockPetMaintainerLocaleInclusions' || !Array.isArray(value.inclusions) || !value.inclusions.length) throw new Error('LOCALE_INCLUSION_POLICY_INVALID')
  const seen = new Set<string>()
  for (const entry of value.inclusions) {
    if (!exact(entry, ['locale', 'reviewState', 'sourceInputsSha256', 'sourceRevision', 'translationContentSha256', 'catalogSha256', 'provenanceSha256', 'decisionSha256']) || typeof entry.locale !== 'string' || !/^[a-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(entry.locale) || ['ko-KR', 'en-US'].includes(entry.locale) || seen.has(entry.locale) || !['AiOnly', 'Mixed'].includes(String(entry.reviewState))) throw new Error('LOCALE_INCLUSION_POLICY_INVALID')
    seen.add(entry.locale)
    for (const field of ['sourceInputsSha256', 'sourceRevision', 'translationContentSha256', 'catalogSha256', 'provenanceSha256', 'decisionSha256']) {
      if (typeof entry[field] !== 'string' || !/^[a-f0-9]{64}$/.test(entry[field])) throw new Error('LOCALE_INCLUSION_POLICY_INVALID')
    }
  }
}

export function inclusionSourceProjection(files: Array<{ path: string, sha256: string }>): string {
  return JSON.stringify(INCLUSION_SOURCE_PATHS.map((path) => {
    const matches = files.filter(file => file.path === path)
    if (matches.length !== 1) throw new Error('LOCALE_INCLUSION_SOURCE_MISSING')
    return matches[0]
  }))
}

export function inclusionMatches(entry: MaintainerLocaleInclusion | undefined, binding: Pick<MaintainerLocaleInclusion, 'locale' | 'sourceRevision' | 'translationContentSha256' | 'catalogSha256' | 'provenanceSha256'> & { reviewState: string }, sourceInputsSha256: string): boolean {
  return !!entry && entry.sourceInputsSha256 === sourceInputsSha256
    && (['locale', 'reviewState', 'sourceRevision', 'translationContentSha256', 'catalogSha256', 'provenanceSha256'] as const).every(key => entry[key] === binding[key])
}
