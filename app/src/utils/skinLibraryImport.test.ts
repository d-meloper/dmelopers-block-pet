/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  importSkinLibraryBatch,
  planSkinLibraryOverwrites,
  resolveSkinLibraryOverwrites,
} from './skinLibraryImport'

describe('skin library overwrite preflight', () => {
  const prepared = (originalFilename: string, value = originalFilename) => ({
    originalFilename,
    value,
  })

  it('matches existing local original filenames case-insensitively and ignores display names', () => {
    const plan = planSkinLibraryOverwrites([
      prepared('alex.PNG'),
      prepared('renamed.png'),
      prepared('java-display.png'),
    ], [
      {
        source: 'local',
        displayName: 'A completely renamed skin',
        originalFilename: 'Alex.png',
      },
      {
        source: 'local',
        displayName: 'renamed.png',
        originalFilename: 'original.png',
      },
      {
        source: 'java',
        displayName: 'java-display.png',
      },
    ])

    assert.deepEqual(
      plan.candidates.map(candidate => candidate.overwriteExisting),
      [true, false, false],
    )
    assert.deepEqual(plan.collisionFilenames, ['alex.PNG'])
  })

  it('marks later same-batch filenames as collisions while preserving input order', () => {
    const plan = planSkinLibraryOverwrites([
      prepared('Alex.png', 'first'),
      prepared('other.png', 'other'),
      prepared('alex.PNG', 'last'),
    ], [])

    assert.deepEqual(
      plan.candidates.map(candidate => ({
        value: candidate.value,
        overwriteExisting: candidate.overwriteExisting,
      })),
      [
        { value: 'first', overwriteExisting: false },
        { value: 'other', overwriteExisting: false },
        { value: 'last', overwriteExisting: true },
      ],
    )
    assert.equal(plan.collisionCount, 1)
  })

  it('does not treat byte-identical values under different filenames as collisions', () => {
    const sameBytes = { pngBase64: 'same-content' }
    const plan = planSkinLibraryOverwrites([
      { originalFilename: 'first.png', value: sameBytes },
      { originalFilename: 'second.png', value: sameBytes },
    ], [])

    assert.deepEqual(
      plan.candidates.map(candidate => candidate.overwriteExisting),
      [false, false],
    )
    assert.equal(plan.collisionCount, 0)
  })

  it('keeps collision authorization only after confirmation and skips it on cancel', () => {
    const plan = planSkinLibraryOverwrites([
      prepared('kept.png'),
      prepared('new.png'),
    ], [{
      source: 'local',
      displayName: 'Renamed kept skin',
      originalFilename: 'KEPT.PNG',
    }])

    assert.deepEqual(resolveSkinLibraryOverwrites(plan, true), {
      candidates: plan.candidates,
      skippedCount: 0,
    })
    assert.deepEqual(resolveSkinLibraryOverwrites(plan, false), {
      candidates: [plan.candidates[1]],
      skippedCount: 1,
    })
  })

  it('imports only new files after cancel and applies the last new success', async () => {
    const plan = planSkinLibraryOverwrites([
      prepared('existing.png'),
      prepared('new-one.png'),
      prepared('new-two.png'),
    ], [{
      source: 'local',
      displayName: 'Renamed existing skin',
      originalFilename: 'existing.PNG',
    }])
    const resolution = resolveSkinLibraryOverwrites(plan, false)
    const stored: string[] = []
    let applied = ''
    let refreshCount = 0

    await importSkinLibraryBatch(resolution.candidates, {
      importOne: async (candidate) => {
        assert.equal(candidate.overwriteExisting, false)
        stored.push(candidate.value)
        return candidate.value
      },
      refresh: async () => {
        refreshCount += 1
      },
      applyLast: (value) => {
        applied = value
      },
    })

    assert.deepEqual(stored, ['new-one.png', 'new-two.png'])
    assert.equal(applied, 'new-two.png')
    assert.equal(refreshCount, 1)
  })

  it('does not import, refresh, or apply when every candidate is canceled', async () => {
    const plan = planSkinLibraryOverwrites([
      prepared('existing.png'),
    ], [{
      source: 'local',
      displayName: 'Anything',
      originalFilename: 'EXISTING.PNG',
    }])
    const resolution = resolveSkinLibraryOverwrites(plan, false)
    let operationCount = 0

    const result = await importSkinLibraryBatch(resolution.candidates, {
      importOne: async candidate => candidate.value,
      refresh: async () => {
        operationCount += 1
      },
      applyLast: () => {
        operationCount += 1
      },
    })

    assert.deepEqual(result, { successes: [], failures: [] })
    assert.equal(resolution.skippedCount, 1)
    assert.equal(operationCount, 0)
  })
})

describe('skin library batch import', () => {
  it('imports sequentially, refreshes once, and applies only the last success', async () => {
    const events: string[] = []
    const result = await importSkinLibraryBatch(
      ['first.png', 'second.png', 'third.png'],
      {
        importOne: async (input) => {
          events.push(`import:${input}`)
          return `stored:${input}`
        },
        refresh: async () => {
          events.push('refresh')
        },
        applyLast: async (value) => {
          events.push(`apply:${value}`)
        },
      },
    )

    assert.deepEqual(events, [
      'import:first.png',
      'import:second.png',
      'import:third.png',
      'refresh',
      'apply:stored:third.png',
    ])
    assert.deepEqual(result.failures, [])
    assert.deepEqual(
      result.successes.map(success => success.index),
      [0, 1, 2],
    )
  })

  it('continues after failures and applies the last successful input', async () => {
    const applied: string[] = []
    let refreshCount = 0
    const result = await importSkinLibraryBatch(
      ['first.png', 'broken.png', 'second.png', 'last-broken.png'],
      {
        importOne: async (input) => {
          if (input.includes('broken')) throw new Error(input)
          return input
        },
        refresh: async () => {
          refreshCount += 1
        },
        applyLast: (value) => {
          applied.push(value)
        },
      },
    )

    assert.deepEqual(result.successes.map(success => success.value), [
      'first.png',
      'second.png',
    ])
    assert.deepEqual(result.failures.map(failure => failure.index), [1, 3])
    assert.equal(refreshCount, 1)
    assert.deepEqual(applied, ['second.png'])
  })

  it('does not refresh or apply when every input fails', async () => {
    let refreshCount = 0
    let applyCount = 0
    const result = await importSkinLibraryBatch(['one.png', 'two.png'], {
      importOne: async () => {
        throw new Error('invalid skin')
      },
      refresh: async () => {
        refreshCount += 1
      },
      applyLast: () => {
        applyCount += 1
      },
    })

    assert.equal(result.successes.length, 0)
    assert.equal(result.failures.length, 2)
    assert.equal(refreshCount, 0)
    assert.equal(applyCount, 0)
  })

  it('preserves duplicate filename order so the last replacement is applied', async () => {
    const imported: string[] = []
    let applied = ''
    const result = await importSkinLibraryBatch(
      ['Alex.png:first', 'other.png', 'alex.PNG:last'],
      {
        importOne: async (input) => {
          imported.push(input)
          return input.split(':').at(-1) ?? input
        },
        refresh: async () => undefined,
        applyLast: (value) => {
          applied = value
        },
      },
    )

    assert.deepEqual(imported, [
      'Alex.png:first',
      'other.png',
      'alex.PNG:last',
    ])
    assert.equal(result.successes.length, 3)
    assert.equal(applied, 'last')
  })
})
