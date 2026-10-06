import { invoke } from '@tauri-apps/api/core'

import type { PortablePetPreset } from '@/features/presets/transfer'
import type { PresetCollection, PresetSnapshot } from '@/features/presets/types'

import { isPresetSnapshot, migratePresetCollection, validatePresetCollection } from '@/features/presets/model'
import { MAX_PET_PRESET_BYTES, parsePortablePreset, PresetTransferError, serializePortablePreset } from '@/features/presets/transfer'

import type { SkinLibraryStoreRequest } from './skinLibrary'

export interface PresetImportPrevious {
  collection: PresetCollection
  snapshot: PresetSnapshot
  visible: boolean
}
export interface PresetImportJournal {
  operationId: string
  phase: 'prepared' | 'committed'
  previous: PresetImportPrevious
}

export async function readPortablePreset(source: File | string): Promise<PortablePetPreset> {
  if (typeof source === 'string') {
    const document = await invoke<string>('read_pet_preset', { filePath: source })
    if (typeof document !== 'string') throw new PresetTransferError('invalidFormat')
    return parsePortablePreset(new TextEncoder().encode(document))
  }
  if (!source.name.toLowerCase().endsWith('.petpreset')) throw new PresetTransferError('invalidFormat')
  if (source.size > MAX_PET_PRESET_BYTES) throw new PresetTransferError('tooLarge')
  return parsePortablePreset(new Uint8Array(await source.arrayBuffer()))
}

export async function writePortablePreset(preset: PortablePetPreset): Promise<boolean> {
  const saved = await invoke<unknown>('export_pet_preset', { document: serializePortablePreset(preset) })
  if (typeof saved !== 'boolean') throw new PresetTransferError('export')
  return saved
}

export async function readPresetImport(): Promise<PresetImportJournal | undefined> {
  const record = await invoke<PresetImportJournal | null>('read_preset_import')
  if (record === null) return undefined
  if (!record || !/^[\da-f-]{36}$/i.test(record.operationId)
    || !['prepared', 'committed'].includes(record.phase)
    || !record.previous || typeof record.previous.visible !== 'boolean' || !isPresetSnapshot(record.previous.snapshot)) {
    throw new PresetTransferError('recovery')
  }
  // Completed receipts retain historical rollback data. Validate a normalized
  // copy while preserving the native receipt's original identity and contents.
  validatePresetCollection(record.phase === 'committed'
    ? migratePresetCollection(record.previous.collection)
    : record.previous.collection)
  return record
}

export async function preparePresetImport(operationId: string, presetId: string, previous: PresetImportPrevious, request: SkinLibraryStoreRequest): Promise<string> {
  const entry = await invoke<{ id: string }>('prepare_preset_import', { operationId, presetId, previous, request })
  if (!entry || !/^[\da-f]{64}$/.test(entry.id)) throw new PresetTransferError('library')
  return entry.id
}

export async function finishPresetImport(operationId: string, commit: boolean, expected: PresetImportPrevious): Promise<void> {
  await invoke('finish_preset_import', { operationId, commit, expected })
}
