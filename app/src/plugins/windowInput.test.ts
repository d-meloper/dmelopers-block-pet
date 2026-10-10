/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import { createWindowVisibilityQueue } from './windowVisibility'

it('orders cursor changes through native acknowledgement and recovers after rejection', async () => {
  const calls: Array<{ command: string, args: unknown }> = []
  let reject!: (error: Error) => void
  const held = new Promise<void>((_yes, no) => {
    reject = no
  })
  const exports = {} as { setPetCursorEvents: (ignore: boolean) => Promise<void>, popupPetMenu: (rid: number) => Promise<void> }
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/core': { invoke: (command: string, args: unknown) => {
      calls.push({ command, args })
      return calls.length === 1 ? held : Promise.resolve()
    } },
    './windowVisibility': { createWindowVisibilityQueue },
  }
  const source = readFileSync(new URL('./window.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => mocks[name] ?? {} })
  const first = exports.setPetCursorEvents(true)
  const restored = exports.setPetCursorEvents(false)
  await Promise.resolve()
  assert.equal(calls.length, 1, 'restoration waits for the earlier native effect')
  const failure = new Error('Native style failed')
  const rejected = assert.rejects(first, error => error === failure)
  reject(failure)
  await rejected
  await restored
  await exports.popupPetMenu(17)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { command: 'plugin:custom-window|set_pet_cursor_events', args: { ignore: true } },
    { command: 'plugin:custom-window|set_pet_cursor_events', args: { ignore: false } },
    { command: 'plugin:custom-window|popup_pet_menu', args: { rid: 17 } },
  ])
})
