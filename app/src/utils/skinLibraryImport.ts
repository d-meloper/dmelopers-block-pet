export interface SkinLibraryImportFailure<TInput> {
  input: TInput
  index: number
  error: unknown
}

export interface SkinLibraryImportSuccess<TInput, TValue> {
  input: TInput
  index: number
  value: TValue
}

export interface SkinLibraryImportBatchResult<TInput, TValue> {
  successes: SkinLibraryImportSuccess<TInput, TValue>[]
  failures: SkinLibraryImportFailure<TInput>[]
}

export interface SkinLibraryImportBatchHandlers<TInput, TValue> {
  importOne: (input: TInput, index: number) => Promise<TValue>
  refresh: () => Promise<void>
  applyLast: (
    value: TValue,
    input: TInput,
    index: number,
  ) => Promise<void> | void
}

export interface SkinLibraryImportIdentityEntry {
  source: 'java' | 'local'
  displayName: string
  originalFilename?: string
}

export interface SkinLibraryPreparedImport<T> {
  originalFilename: string
  value: T
}

export interface SkinLibraryPlannedImport<T> extends SkinLibraryPreparedImport<T> {
  overwriteExisting: boolean
}

export interface SkinLibraryOverwritePlan<T> {
  candidates: SkinLibraryPlannedImport<T>[]
  collisionCount: number
  collisionFilenames: string[]
}

export interface SkinLibraryOverwriteResolution<T> {
  candidates: SkinLibraryPlannedImport<T>[]
  skippedCount: number
}

function filenameIdentity(filename: string): string {
  return filename.toLowerCase()
}

export function planSkinLibraryOverwrites<T>(
  candidates: readonly SkinLibraryPreparedImport<T>[],
  existingEntries: readonly SkinLibraryImportIdentityEntry[],
): SkinLibraryOverwritePlan<T> {
  const occupiedIdentities = new Set(
    existingEntries
      .filter(entry => entry.source === 'local' && entry.originalFilename)
      .map(entry => filenameIdentity(entry.originalFilename!)),
  )
  const collisionFilenames: string[] = []
  const candidatesWithPolicy = candidates.map((candidate) => {
    const identity = filenameIdentity(candidate.originalFilename)
    const overwriteExisting = occupiedIdentities.has(identity)
    occupiedIdentities.add(identity)
    if (overwriteExisting) collisionFilenames.push(candidate.originalFilename)
    return { ...candidate, overwriteExisting }
  })

  return {
    candidates: candidatesWithPolicy,
    collisionCount: collisionFilenames.length,
    collisionFilenames,
  }
}

export function resolveSkinLibraryOverwrites<T>(
  plan: SkinLibraryOverwritePlan<T>,
  overwriteConfirmed: boolean,
): SkinLibraryOverwriteResolution<T> {
  if (overwriteConfirmed || plan.collisionCount === 0) {
    return { candidates: plan.candidates, skippedCount: 0 }
  }
  return {
    candidates: plan.candidates.filter(candidate => !candidate.overwriteExisting),
    skippedCount: plan.collisionCount,
  }
}

export async function importSkinLibraryBatch<TInput, TValue>(
  inputs: readonly TInput[],
  handlers: SkinLibraryImportBatchHandlers<TInput, TValue>,
): Promise<SkinLibraryImportBatchResult<TInput, TValue>> {
  const successes: SkinLibraryImportSuccess<TInput, TValue>[] = []
  const failures: SkinLibraryImportFailure<TInput>[] = []

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index]
    try {
      successes.push({
        input,
        index,
        value: await handlers.importOne(input, index),
      })
    } catch (error) {
      failures.push({ input, index, error })
    }
  }

  const lastSuccess = successes.at(-1)
  if (lastSuccess) {
    await handlers.refresh()
    await handlers.applyLast(
      lastSuccess.value,
      lastSuccess.input,
      lastSuccess.index,
    )
  }

  return { successes, failures }
}
