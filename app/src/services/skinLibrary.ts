import { invoke } from '@tauri-apps/api/core'

import { INVOKE_KEY } from '@/constants'

export type SkinLibrarySource = 'java' | 'local'
export type SkinLibraryModel = 'wide' | 'slim'
export const SKIN_LIBRARY_ERROR_CODES = [
  'STORAGE_UNAVAILABLE',
  'INVALID_REQUEST',
  'INVALID_PNG',
  'INVALID_DIMENSIONS',
  'TOO_LARGE',
  'CATALOG_CORRUPT',
  'ENTRY_NOT_FOUND',
  'ENTRY_ALREADY_EXISTS',
  'IO_ERROR',
  'INVALID_RESPONSE',
] as const
export type SkinLibraryErrorCode = typeof SKIN_LIBRARY_ERROR_CODES[number]

export interface SkinLibraryEntry {
  id: string
  source: SkinLibrarySource
  displayName: string
  canonicalNickname?: string
  originalFilename?: string
  model: SkinLibraryModel
  pngSha256: string
  width: 64
  height: 32 | 64
  thumbnailPngBase64: string
  addedAt: number
}

export interface SkinLibraryEntryContent extends SkinLibraryEntry {
  pngBase64: string
}

export type SkinLibraryStoreRequest = Pick<
  SkinLibraryEntryContent,
  | 'source'
  | 'displayName'
  | 'canonicalNickname'
  | 'originalFilename'
  | 'model'
  | 'pngBase64'
  | 'thumbnailPngBase64'
> & {
  overwriteExisting?: boolean
}

export interface SkinLibraryCleanupResponse {
  cleanupPending: boolean
}

export interface SkinLibraryDeleteResponse extends SkinLibraryCleanupResponse {
  deletedEntryIds: string[]
}

export interface SkinLibraryClearResponse {
  deletedCount: number
}

export interface LocalSkinFileResponse {
  originalFilename: string
  pngBase64: string
}

type InvokeSkinLibrary = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>

const ENTRY_ID_PATTERN = /^[0-9a-f]{64}$/
const JAVA_NICKNAME_PATTERN = /^\w{3,16}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/i
const BASE64_PATTERN = /^(?:[A-Z\d+/]{4})*(?:[A-Z\d+/]{2}==|[A-Z\d+/]{3}=)?$/i
export const MAX_SKIN_LIBRARY_PNG_BYTES = 2 * 1024 * 1024
const MAX_PNG_BASE64_LENGTH = 4 * Math.ceil(MAX_SKIN_LIBRARY_PNG_BYTES / 3)
const MAX_THUMBNAIL_BASE64_LENGTH = 4 * Math.ceil((256 * 1024) / 3)
const MAX_NAME_LENGTH = 255
const PNG_BASE64_SIGNATURE = 'iVBORw0KGgo'
const ERROR_CODES = new Set<string>(SKIN_LIBRARY_ERROR_CODES)
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u

export class SkinLibraryError extends Error {
  readonly code: SkinLibraryErrorCode

  constructor(code: SkinLibraryErrorCode) {
    super(code)
    this.name = 'SkinLibraryError'
    this.code = code
  }
}

function invalidResponse(): never {
  throw new SkinLibraryError('INVALID_RESPONSE')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSafeEntryId(value: unknown): value is string {
  return typeof value === 'string' && ENTRY_ID_PATTERN.test(value)
}

export function isValidSkinLibraryDisplayName(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && [...value].length <= MAX_NAME_LENGTH
    && !CONTROL_CHARACTER_PATTERN.test(value)
}

function isPngBase64(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && value.startsWith(PNG_BASE64_SIGNATURE)
    && BASE64_PATTERN.test(value)
}

function isOriginalPngFilename(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && [...value].length <= MAX_NAME_LENGTH
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && !value.includes('/')
    && !value.includes('\\')
    && value !== '.'
    && value !== '..'
    && value.toLowerCase().endsWith('.png')
}

function parseErrorCode(error: unknown): SkinLibraryErrorCode {
  if (error instanceof SkinLibraryError) return error.code
  let payload: unknown = error
  if (typeof error === 'string') {
    try {
      payload = JSON.parse(error) as unknown
    } catch {
      return 'IO_ERROR'
    }
  }
  if (isPlainRecord(payload) && typeof payload.code === 'string' && ERROR_CODES.has(payload.code)) {
    return payload.code as SkinLibraryErrorCode
  }
  return 'IO_ERROR'
}

export function normalizeSkinLibraryError(error: unknown): SkinLibraryError {
  return error instanceof SkinLibraryError
    ? error
    : new SkinLibraryError(parseErrorCode(error))
}

async function invokeSkinLibrary(
  invokeCommand: InvokeSkinLibrary,
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invokeCommand<unknown>(command, args)
  } catch (error) {
    throw normalizeSkinLibraryError(error)
  }
}

function isEpochMilliseconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validateIdentity(
  source: SkinLibrarySource,
  canonicalNickname: unknown,
  originalFilename: unknown,
): boolean {
  if (source === 'java') {
    return typeof canonicalNickname === 'string'
      && JAVA_NICKNAME_PATTERN.test(canonicalNickname)
      && originalFilename === undefined
  }
  return canonicalNickname === undefined && isOriginalPngFilename(originalFilename)
}

function validateEntry(value: unknown): SkinLibraryEntry {
  if (!isPlainRecord(value)) invalidResponse()
  const source = value.source
  if (source !== 'java' && source !== 'local') invalidResponse()
  if (
    !isSafeEntryId(value.id)
    || !isValidSkinLibraryDisplayName(value.displayName)
    || !validateIdentity(source, value.canonicalNickname, value.originalFilename)
    || (value.model !== 'wide' && value.model !== 'slim')
    || typeof value.pngSha256 !== 'string'
    || !SHA256_PATTERN.test(value.pngSha256)
    || value.width !== 64
    || (value.height !== 32 && value.height !== 64)
    || !isPngBase64(value.thumbnailPngBase64, MAX_THUMBNAIL_BASE64_LENGTH)
    || !isEpochMilliseconds(value.addedAt)
  ) {
    invalidResponse()
  }
  return value as unknown as SkinLibraryEntry
}

function validateContent(value: unknown): SkinLibraryEntryContent {
  const entry = validateEntry(value)
  const pngBase64 = (value as Record<string, unknown>).pngBase64
  if (!isPngBase64(pngBase64, MAX_PNG_BASE64_LENGTH)) invalidResponse()
  return { ...entry, pngBase64 }
}

function validateStoreRequest(request: SkinLibraryStoreRequest): void {
  if (
    (request.source !== 'java' && request.source !== 'local')
    || !isValidSkinLibraryDisplayName(request.displayName)
    || !validateIdentity(
      request.source,
      request.canonicalNickname,
      request.originalFilename,
    )
    || (request.model !== 'wide' && request.model !== 'slim')
    || !isPngBase64(request.pngBase64, MAX_PNG_BASE64_LENGTH)
    || !isPngBase64(
      request.thumbnailPngBase64,
      MAX_THUMBNAIL_BASE64_LENGTH,
    )
    || (request.overwriteExisting !== undefined
      && typeof request.overwriteExisting !== 'boolean')
  ) {
    throw new SkinLibraryError('INVALID_REQUEST')
  }
}

export async function listSkinLibraryEntries(
  invokeCommand: InvokeSkinLibrary = invoke,
): Promise<SkinLibraryEntry[]> {
  const response = await invokeSkinLibrary(
    invokeCommand,
    INVOKE_KEY.LIST_SKIN_LIBRARY,
  )
  if (!Array.isArray(response)) invalidResponse()
  const entries = response.map(validateEntry)
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].addedAt < entries[index].addedAt) {
      invalidResponse()
    }
  }
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
    invalidResponse()
  }
  return entries
}

export async function storeSkinLibraryEntry(
  request: SkinLibraryStoreRequest,
  invokeCommand: InvokeSkinLibrary = invoke,
): Promise<SkinLibraryEntry> {
  validateStoreRequest(request)
  const response = await invokeSkinLibrary(
    invokeCommand,
    INVOKE_KEY.STORE_SKIN_LIBRARY_ENTRY,
    { request },
  )
  return validateEntry(response)
}

export async function readSkinLibraryEntry(
  entryId: string,
  invokeCommand: InvokeSkinLibrary = invoke,
): Promise<SkinLibraryEntryContent> {
  if (!isSafeEntryId(entryId)) throw new SkinLibraryError('INVALID_REQUEST')
  const response = await invokeSkinLibrary(
    invokeCommand,
    INVOKE_KEY.READ_SKIN_LIBRARY_ENTRY,
    { entryId },
  )
  const content = validateContent(response)
  if (content.id !== entryId) invalidResponse()
  return content
}

export async function readLocalSkinFile(
  filePath: string,
  invokeCommand: InvokeSkinLibrary = invoke,
): Promise<LocalSkinFileResponse> {
  if (
    filePath.length === 0
    || filePath.trim() !== filePath
    || filePath.length > 32_767
    || [...filePath].includes('\0')
  ) {
    throw new SkinLibraryError('INVALID_REQUEST')
  }
  const response = await invokeSkinLibrary(
    invokeCommand,
    INVOKE_KEY.READ_LOCAL_SKIN_FILE,
    { filePath },
  )
  if (
    !isPlainRecord(response)
    || !isOriginalPngFilename(response.originalFilename)
    || !isPngBase64(response.pngBase64, MAX_PNG_BASE64_LENGTH)
  ) {
    invalidResponse()
  }
  return {
    originalFilename: response.originalFilename,
    pngBase64: response.pngBase64,
  }
}

export async function renameSkinLibraryEntry(
  entryId: string,
  displayName: string,
  invokeCommand: InvokeSkinLibrary = invoke,
): Promise<SkinLibraryEntry> {
  if (!isSafeEntryId(entryId) || !isValidSkinLibraryDisplayName(displayName)) {
    throw new SkinLibraryError('INVALID_REQUEST')
  }
  const response = await invokeSkinLibrary(
    invokeCommand,
    INVOKE_KEY.RENAME_SKIN_LIBRARY_ENTRY,
    { entryId, displayName },
  )
  const entry = validateEntry(response)
  if (entry.id !== entryId || entry.displayName !== displayName) {
    invalidResponse()
  }
  return entry
}

export async function deleteSkinLibraryEntries(
  entryIds: readonly string[],
  invokeCommand: InvokeSkinLibrary = invoke,
): Promise<SkinLibraryDeleteResponse> {
  if (
    entryIds.length === 0
    || entryIds.some(entryId => !isSafeEntryId(entryId))
    || new Set(entryIds).size !== entryIds.length
  ) {
    throw new SkinLibraryError('INVALID_REQUEST')
  }
  const response = await invokeSkinLibrary(
    invokeCommand,
    INVOKE_KEY.DELETE_SKIN_LIBRARY_ENTRIES,
    { entryIds: [...entryIds] },
  )
  if (!isPlainRecord(response) || !Array.isArray(response.deletedEntryIds) || typeof response.cleanupPending !== 'boolean') {
    invalidResponse()
  }
  const deletedEntryIds = response.deletedEntryIds
  if (
    deletedEntryIds.some(entryId => !isSafeEntryId(entryId))
    || new Set(deletedEntryIds).size !== deletedEntryIds.length
    || deletedEntryIds.some(entryId => !entryIds.includes(entryId))
  ) {
    invalidResponse()
  }
  return { deletedEntryIds, cleanupPending: response.cleanupPending }
}

/** Retry only unreferenced files under the native app-owned library root. */
export async function cleanupSkinLibrary(
  invokeCommand: InvokeSkinLibrary = invoke,
): Promise<SkinLibraryCleanupResponse> {
  const response = await invokeSkinLibrary(invokeCommand, INVOKE_KEY.CLEANUP_SKIN_LIBRARY)
  if (!isPlainRecord(response) || typeof response.cleanupPending !== 'boolean') invalidResponse()
  return { cleanupPending: response.cleanupPending }
}

export async function clearSkinLibrary(
  invokeCommand: InvokeSkinLibrary = invoke,
): Promise<SkinLibraryClearResponse> {
  const response = await invokeSkinLibrary(
    invokeCommand,
    INVOKE_KEY.CLEAR_SKIN_LIBRARY,
  )
  if (
    !isPlainRecord(response)
    || !Number.isSafeInteger(response.deletedCount)
    || (response.deletedCount as number) < 0
  ) {
    invalidResponse()
  }
  return { deletedCount: response.deletedCount as number }
}
