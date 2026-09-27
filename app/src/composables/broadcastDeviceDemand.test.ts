/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import type { DeviceInputState } from '@/features/input/types'

import * as inputTypes from '@/features/input/types'

import type * as DeviceModule from './useDevice'

const source = ts.transpileModule(readFileSync(new URL('./useDevice.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

it('releases all desktop input while hidden, keeps settings, and resumes with a fresh input epoch', async () => {
  const exports = {} as typeof DeviceModule
  runInNewContext(source, { exports, require: (id: string) => id === '@/features/input/types' ? inputTypes : {} })
  let desktop: boolean | undefined
  let epoch = 0
  let failure = false
  const saved: boolean[] = []
  const activity: Array<[boolean, boolean]> = []
  const session = exports.createDeviceInputSession({
    readSetting: () => true,
    start: async () => assert.fail('legacy start must not acquire a hidden desktop lease'),
    configure: async () => assert.fail('legacy configure must not reacquire a hidden desktop lease'),
    stop: async () => {
      desktop = undefined
    },
    activity: async (active, mouseEnabled): Promise<DeviceInputState> => {
      activity.push([active, mouseEnabled])
      if (failure) throw new Error('native activity failed')
      desktop = active ? mouseEnabled : undefined
      return { mouseEnabled: active && mouseEnabled, mouseGeneration: ++epoch }
    },
    onConfirmed: enabled => saved.push(enabled),
    onGate: () => {},
  })
  await session.start()
  assert.equal(desktop, undefined)
  assert.deepEqual(activity, [[false, true]])
  assert.equal(session.status().mouseEnabled, true)
  await session.setActive(true)
  assert.equal(desktop, true)
  const held = { kind: 'mouse_primary' as const, active: true, mouseGeneration: epoch }
  assert.equal(session.accepts(held), true)
  await session.setActive(false)
  assert.equal(desktop, undefined)
  assert.equal(session.accepts({ kind: 'typing', active: true, intensity: 1 }), false)
  await session.request(false)
  await session.request(true)
  assert.equal(desktop, undefined)
  assert.deepEqual(saved, [true, false, true])
  failure = true
  await assert.rejects(session.setActive(true), /native activity failed/)
  assert.equal(session.accepts({ kind: 'typing', active: true, intensity: 1 }), false)
  failure = false
  await session.setActive(true, true)
  assert.equal(desktop, true)
  assert.equal(session.accepts(held), false)
  assert.equal(session.accepts({ ...held, mouseGeneration: epoch }), true)
  await session.dispose()
  assert.equal(desktop, undefined)
})
