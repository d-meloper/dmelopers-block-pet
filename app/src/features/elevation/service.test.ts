/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import * as types from './types'

function harness(result: unknown) {
  const calls: { command: string, args?: unknown }[] = []
  const exports = {} as typeof import('@/services/elevation')
  const source = ts.transpileModule(readFileSync(new URL('../../services/elevation.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(source, {
    exports,
    require: (name: string) => name === '@/features/elevation/types'
      ? types
      : { invoke: async (command: string, args?: unknown) => {
          calls.push({ command, args })
          return result
        } },
  })
  return { service: exports, calls }
}

test('service maps only the status, preparation and ticket-cancel APIs', async () => {
  const status = harness({ supported: true, elevated: false })
  await status.service.getElevationStatus()
  assert.equal(status.calls[0].command, 'elevation_status')
  const ready = harness({ outcome: 'ready', ticket: 'a'.repeat(64) })
  await ready.service.prepareElevatedRestart()
  await ready.service.cancelElevatedRestart('a'.repeat(64))
  assert.deepEqual(ready.calls.map(call => call.command), ['prepare_elevated_restart', 'cancel_elevated_restart'])
  assert.equal((ready.calls[1].args as { ticket: string }).ticket, 'a'.repeat(64))
  assert.deepEqual(await harness({ outcome: 'cancelled' }).service.prepareElevatedRestart(), { outcome: 'cancelled' })
})

test('service rejects malformed native state instead of inferring supported or elevated', async () => {
  for (const result of [
    null,
    {},
    { supported: true },
    { supported: 1, elevated: false },
    { supported: false, elevated: 'false' },
    { supported: true, elevated: false, startupAttempt: 'approved' },
    { supported: true, elevated: false, alwaysRunAsAdministrator: 'true' },
    { supported: true, elevated: false, administratorReminderDismissed: 1 },
  ]) {
    await assert.rejects(harness(result).service.getElevationStatus(), /ELEVATION_INVALID_STATUS/)
  }
  for (const result of [null, {}, { outcome: 'ready' }, { outcome: 'ready', ticket: '' }, { outcome: 'ready', ticket: 'g'.repeat(64) }, { outcome: 'cancelled', ticket: 'a'.repeat(64) }]) {
    await assert.rejects(harness(result).service.prepareElevatedRestart(), /ELEVATION_INVALID_PREPARATION/)
  }
})
