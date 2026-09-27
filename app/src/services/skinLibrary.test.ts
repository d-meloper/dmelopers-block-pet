/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import { INVOKE_KEY } from '@/constants'

import type { SkinLibraryStoreRequest } from './skinLibrary'

import {
  cleanupSkinLibrary,
  clearSkinLibrary,
  deleteSkinLibraryEntries,
  isValidSkinLibraryDisplayName,
  listSkinLibraryEntries,
  normalizeSkinLibraryError,
  readLocalSkinFile,
  readSkinLibraryEntry,
  renameSkinLibraryEntry,
  SkinLibraryError,
  storeSkinLibraryEntry,
} from './skinLibrary'

const JAVA_ID = 'a'.repeat(64)
const LOCAL_ID = 'b'.repeat(64)
const VALID_JAVA_ENTRY = {
  id: JAVA_ID,
  source: 'java' as const,
  displayName: 'jeb_',
  canonicalNickname: 'jeb_',
  model: 'wide' as const,
  pngSha256: 'c'.repeat(64),
  width: 64 as const,
  height: 64 as const,
  thumbnailPngBase64: 'iVBORw0KGgo=',
  addedAt: 2_000,
}
const VALID_LOCAL_ENTRY = {
  id: LOCAL_ID,
  source: 'local' as const,
  displayName: 'alex.png',
  originalFilename: 'alex.png',
  model: 'slim' as const,
  pngSha256: 'd'.repeat(64),
  width: 64 as const,
  height: 32 as const,
  thumbnailPngBase64: 'iVBORw0KGgo=',
  addedAt: 1_000,
}

describe('skin library frontend IPC contract', () => {
  it('validates the recent-first list and keeps Java/local identities separate', async () => {
    const invokeCommand = async <T>(command: string) => {
      assert.equal(command, INVOKE_KEY.LIST_SKIN_LIBRARY)
      return [VALID_JAVA_ENTRY, VALID_LOCAL_ENTRY] as T
    }
    assert.deepEqual(
      await listSkinLibraryEntries(invokeCommand),
      [VALID_JAVA_ENTRY, VALID_LOCAL_ENTRY],
    )

    await assert.rejects(
      listSkinLibraryEntries(async <T>() => [
        VALID_LOCAL_ENTRY,
        VALID_JAVA_ENTRY,
      ] as T),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'INVALID_RESPONSE',
    )
  })

  it('sends a strict source-specific store request and validates the response', async () => {
    const request = {
      source: 'java' as const,
      displayName: 'jeb_',
      canonicalNickname: 'jeb_',
      model: 'wide' as const,
      pngBase64: 'iVBORw0KGgo=',
      thumbnailPngBase64: 'iVBORw0KGgo=',
    }
    const stored = await storeSkinLibraryEntry(
      request,
      async <T>(command: string, args?: Record<string, unknown>) => {
        assert.equal(command, INVOKE_KEY.STORE_SKIN_LIBRARY_ENTRY)
        assert.deepEqual(args, { request })
        return VALID_JAVA_ENTRY as T
      },
    )
    assert.deepEqual(stored, VALID_JAVA_ENTRY)

    const noOverwriteRequest = {
      ...request,
      source: 'local' as const,
      displayName: 'Alex.png',
      canonicalNickname: undefined,
      originalFilename: 'Alex.png',
      overwriteExisting: false,
    }
    await storeSkinLibraryEntry(
      noOverwriteRequest,
      async <T>(command: string, args?: Record<string, unknown>) => {
        assert.equal(command, INVOKE_KEY.STORE_SKIN_LIBRARY_ENTRY)
        assert.deepEqual(args, { request: noOverwriteRequest })
        return VALID_LOCAL_ENTRY as T
      },
    )

    await assert.rejects(
      storeSkinLibraryEntry({
        ...request,
        originalFilename: 'must-not-coexist.png',
      }),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'INVALID_REQUEST',
    )
    await assert.rejects(
      storeSkinLibraryEntry({
        ...request,
        overwriteExisting: 'yes',
      } as unknown as SkinLibraryStoreRequest),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'INVALID_REQUEST',
    )
  })

  it('reads exact PNG bytes and rejects a mismatched or unsafe entry ID', async () => {
    const content = { ...VALID_LOCAL_ENTRY, pngBase64: 'iVBORw0KGgo=' }
    assert.deepEqual(
      await readSkinLibraryEntry(
        LOCAL_ID,
        async <T>(command: string, args?: Record<string, unknown>) => {
          assert.equal(command, INVOKE_KEY.READ_SKIN_LIBRARY_ENTRY)
          assert.deepEqual(args, { entryId: LOCAL_ID })
          return content as T
        },
      ),
      content,
    )
    await assert.rejects(
      readSkinLibraryEntry('../catalog.json'),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'INVALID_REQUEST',
    )
    await assert.rejects(
      readSkinLibraryEntry(
        LOCAL_ID,
        async <T>() => ({ ...content, id: JAVA_ID }) as T,
      ),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'INVALID_RESPONSE',
    )
  })

  it('reads a dropped local PNG through the strict IPC response contract', async () => {
    const filePath = 'C:\\Skins\\Alex.PNG'
    const response = {
      originalFilename: 'Alex.PNG',
      pngBase64: 'iVBORw0KGgo=',
    }
    assert.deepEqual(
      await readLocalSkinFile(
        filePath,
        async <T>(command: string, args?: Record<string, unknown>) => {
          assert.equal(command, INVOKE_KEY.READ_LOCAL_SKIN_FILE)
          assert.deepEqual(args, { filePath })
          return response as T
        },
      ),
      response,
    )

    await assert.rejects(
      readLocalSkinFile(''),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'INVALID_REQUEST',
    )
    for (const invalidResponse of [
      { ...response, originalFilename: '../Alex.PNG' },
      { ...response, originalFilename: 'Alex.jpg' },
      { ...response, pngBase64: 'not-png' },
    ]) {
      await assert.rejects(
        readLocalSkinFile(filePath, async <T>() => invalidResponse as T),
        (error: unknown) => error instanceof SkinLibraryError
          && error.code === 'INVALID_RESPONSE',
      )
    }
  })

  it('preserves actual OneDrive-style Unicode and special-character file paths at the IPC boundary', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'skin-path-'))
    const folder = join(fixture, 'OneDrive - 회사 安 😶 #100% [팀] & O\'Brien', '바탕 화면', '내 스킨')
    const png = readFileSync(new URL('../../src-tauri/assets/models/dmeloper/default.png', import.meta.url))
    try {
      const longFolder = join(folder, ...Array.from({ length: 10 }, () => '깊은 사용자 스킨 보관함 😶 [100%]'))
      assert.ok(longFolder.length > 260)
      for (const directory of [folder, longFolder]) {
        mkdirSync(directory, { recursive: true })
        for (const filename of ['스킨 😶 #100% [원본] & O\'Brien.PNG', ' 스킨 😶 #100% [원본].png']) {
          const filePath = join(directory, filename)
          writeFileSync(filePath, png)
          const read = await readLocalSkinFile(filePath, async <T>(command: string, args?: Record<string, unknown>) => {
            assert.equal(command, INVOKE_KEY.READ_LOCAL_SKIN_FILE)
            assert.equal(args?.filePath, filePath)
            const literalPath = args!.filePath as string
            return { originalFilename: basename(literalPath), pngBase64: readFileSync(literalPath).toString('base64') } as T
          })
          assert.equal(read.originalFilename, filename)
          assert.equal(read.pngBase64, png.toString('base64'))
          const request = { ...VALID_LOCAL_ENTRY, ...read, displayName: filename.trim() }
          const stored = await storeSkinLibraryEntry(request, async <T>(_command: string, args?: Record<string, unknown>) => {
            assert.equal((args?.request as SkinLibraryStoreRequest).originalFilename, filename)
            return request as T
          })
          assert.equal(stored.originalFilename, filename)
          assert.equal(stored.displayName, filename.trim())
        }
      }
    } finally {
      assert.equal(dirname(fixture), tmpdir())
      assert.ok(basename(fixture).startsWith('skin-path-'))
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('renames only through a validated entry ID and display name contract', async () => {
    const renamed = { ...VALID_LOCAL_ENTRY, displayName: 'Favorite Alex' }
    assert.deepEqual(
      await renameSkinLibraryEntry(
        LOCAL_ID,
        renamed.displayName,
        async <T>(command: string, args?: Record<string, unknown>) => {
          assert.equal(command, INVOKE_KEY.RENAME_SKIN_LIBRARY_ENTRY)
          assert.deepEqual(args, {
            entryId: LOCAL_ID,
            displayName: renamed.displayName,
          })
          return renamed as T
        },
      ),
      renamed,
    )

    for (const invalidName of ['', ' padded ', 'bad\0name', 'a'.repeat(256)]) {
      await assert.rejects(
        renameSkinLibraryEntry(LOCAL_ID, invalidName),
        (error: unknown) => error instanceof SkinLibraryError
          && error.code === 'INVALID_REQUEST',
      )
    }
    await assert.rejects(
      renameSkinLibraryEntry('../entry', 'Safe name'),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'INVALID_REQUEST',
    )
    await assert.rejects(
      renameSkinLibraryEntry(
        LOCAL_ID,
        'Favorite Alex',
        async <T>() => ({ ...renamed, id: JAVA_ID }) as T,
      ),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'INVALID_RESPONSE',
    )
  })

  it('matches Rust display-name validation for Unicode scalars and controls', () => {
    assert.equal(isValidSkinLibraryDisplayName('🐈'.repeat(255)), true)
    assert.equal(isValidSkinLibraryDisplayName('🐈'.repeat(256)), false)
    assert.equal(isValidSkinLibraryDisplayName('line\nbreak'), false)
    assert.equal(isValidSkinLibraryDisplayName(`c1${String.fromCharCode(0x85)}`), false)
  })

  it('validates batch deletion and whole-library clear responses', async () => {
    assert.deepEqual(
      await deleteSkinLibraryEntries(
        [JAVA_ID, LOCAL_ID],
        async <T>(command: string, args?: Record<string, unknown>) => {
          assert.equal(command, INVOKE_KEY.DELETE_SKIN_LIBRARY_ENTRIES)
          assert.deepEqual(args, { entryIds: [JAVA_ID, LOCAL_ID] })
          return { deletedEntryIds: [JAVA_ID, LOCAL_ID], cleanupPending: false } as T
        },
      ),
      { deletedEntryIds: [JAVA_ID, LOCAL_ID], cleanupPending: false },
    )
    await assert.rejects(
      deleteSkinLibraryEntries([JAVA_ID, JAVA_ID]),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'INVALID_REQUEST',
    )
    assert.deepEqual(
      await clearSkinLibrary(async <T>(command: string) => {
        assert.equal(command, INVOKE_KEY.CLEAR_SKIN_LIBRARY)
        return { deletedCount: 2 } as T
      }),
      { deletedCount: 2 },
    )
  })

  it('keeps committed deletions distinct from pending cleanup and uses a path-free retry', async () => {
    assert.deepEqual(
      await deleteSkinLibraryEntries([JAVA_ID], async <T>() => ({ deletedEntryIds: [JAVA_ID], cleanupPending: true }) as T),
      { deletedEntryIds: [JAVA_ID], cleanupPending: true },
    )
    for (const cleanupPending of [false, true]) {
      assert.deepEqual(await cleanupSkinLibrary(async <T>(command: string, args?: Record<string, unknown>) => {
        assert.equal(command, INVOKE_KEY.CLEANUP_SKIN_LIBRARY)
        assert.equal(args, undefined)
        return { cleanupPending } as T
      }), { cleanupPending })
    }
    for (const response of [{}, { cleanupPending: 'false' }, { cleanupPending: null }]) {
      await assert.rejects(cleanupSkinLibrary(async <T>() => response as T), /INVALID_RESPONSE/)
      await assert.rejects(deleteSkinLibraryEntries([JAVA_ID], async <T>() => ({ deletedEntryIds: [JAVA_ID], ...response }) as T), /INVALID_RESPONSE/)
    }
    await assert.rejects(cleanupSkinLibrary(async () => {
      throw new SkinLibraryError('IO_ERROR')
    }), /IO_ERROR/)
  })

  it('fails closed on malformed catalog fields', async () => {
    const invalidEntries = [
      { ...VALID_JAVA_ENTRY, id: '../entry' },
      { ...VALID_JAVA_ENTRY, originalFilename: 'mixed-source.png' },
      { ...VALID_JAVA_ENTRY, pngSha256: 'not-a-hash' },
      { ...VALID_JAVA_ENTRY, thumbnailPngBase64: '../file.png' },
      { ...VALID_JAVA_ENTRY, addedAt: Number.NaN },
      { ...VALID_LOCAL_ENTRY, originalFilename: '../alex.png' },
    ]
    for (const invalidEntry of invalidEntries) {
      await assert.rejects(
        listSkinLibraryEntries(async <T>() => [invalidEntry] as T),
        (error: unknown) => error instanceof SkinLibraryError
          && error.code === 'INVALID_RESPONSE',
      )
    }
  })

  it('normalizes structured backend failures for localized UI handling', async () => {
    const corrupt = normalizeSkinLibraryError({ code: 'CATALOG_CORRUPT' })
    assert.equal(corrupt.code, 'CATALOG_CORRUPT')
    assert.equal(
      normalizeSkinLibraryError(JSON.stringify({ code: 'ENTRY_NOT_FOUND' })).code,
      'ENTRY_NOT_FOUND',
    )
    assert.equal(normalizeSkinLibraryError('not-json').code, 'IO_ERROR')
    assert.equal(
      normalizeSkinLibraryError({ code: 'ENTRY_ALREADY_EXISTS' }).code,
      'ENTRY_ALREADY_EXISTS',
    )

    await assert.rejects(
      storeSkinLibraryEntry({
        source: 'local',
        displayName: 'race.png',
        originalFilename: 'race.png',
        model: 'wide',
        pngBase64: 'iVBORw0KGgo=',
        thumbnailPngBase64: 'iVBORw0KGgo=',
        overwriteExisting: false,
      }, async () => {
        throw Object.assign(new Error('entry exists'), {
          code: 'ENTRY_ALREADY_EXISTS',
        })
      }),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'ENTRY_ALREADY_EXISTS',
    )

    await assert.rejects(
      listSkinLibraryEntries(async () => {
        throw Object.assign(new Error('storage unavailable'), {
          code: 'STORAGE_UNAVAILABLE',
        })
      }),
      (error: unknown) => error instanceof SkinLibraryError
        && error.code === 'STORAGE_UNAVAILABLE',
    )
  })
})
