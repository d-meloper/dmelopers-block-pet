/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import * as model from '@/features/presets/model'
import * as transfer from '@/features/presets/transfer'

import type { PresetImportJournal } from './presetTransfer'

const source = ts.transpileModule(readFileSync(new URL('./presetTransfer.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function readJournal(record: PresetImportJournal) {
  const exports = {} as typeof import('./presetTransfer')
  runInNewContext(source, {
    exports,
    require: (name: string) => {
      if (name === '@tauri-apps/api/core') return { invoke: async () => record }
      if (name === '@/features/presets/model') return model
      if (name === '@/features/presets/transfer') return transfer
      throw new Error(`Unexpected module ${name}`)
    },
  })
  return exports.readPresetImport()
}

it('accepts completed legacy import receipts without rewriting their native rollback data', async () => {
  const snapshot = model.createDefaultPresetSnapshot()
  const record: PresetImportJournal = {
    operationId: crypto.randomUUID(),
    phase: 'committed',
    previous: {
      collection: {
        schemaVersion: 3,
        activeId: 'builtin:default',
        entries: [{ id: 'builtin:default', name: '', favorite: false, snapshot }],
      },
      snapshot,
      visible: false,
    },
  }
  const before = model.clonePreset(record)
  assert.equal(await readJournal(record), record)
  assert.deepEqual(record, before)
  record.phase = 'prepared'
  await assert.rejects(readJournal(record), /pages.preference.presets.errors.load/)
  assert.equal(record.previous.collection.schemaVersion, 3)
})

it('accepts a prepared empty catalog without choosing or creating a preset', async () => {
  const record: PresetImportJournal = {
    operationId: crypto.randomUUID(),
    phase: 'prepared',
    previous: { collection: model.createPresetCollection(), snapshot: model.createDefaultPresetSnapshot(), visible: false },
  }
  assert.equal(await readJournal(record), record)
  assert.deepEqual(record.previous.collection, { schemaVersion: 4, activeId: null, entries: [] })
})
