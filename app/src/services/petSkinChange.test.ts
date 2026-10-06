/* eslint-disable test/no-import-node-test */
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import assert from 'node:assert/strict'
import { it } from 'node:test'

import type { PetSkinChangeRequest } from '@/features/petRuntime/types'

import { isPetSkinChangeRequest } from '@/features/petRuntime/types'

import { beginPetSkinChange } from './petSkinChange'

it('orders an early cancellation after prepare delivery and ends its token only once', async () => {
  const sent: PetSkinChangeRequest[] = []
  let delivered!: () => void
  const prepare = new Promise<void>((resolve) => {
    delivered = resolve
  })
  const change = beginPetSkinChange(async (request) => {
    sent.push(request)
    if (request.phase === 'prepare') await prepare
  })
  const cancelled = change.finish()
  assert.equal(change.finish({ model: 'wide', palmColor: '#445566' }), cancelled)
  await Promise.resolve()
  assert.equal(sent.length, 1)
  delivered()
  await cancelled
  assert.deepEqual(sent.map(request => request.phase), ['prepare', 'finish'])
  assert.equal(sent[1].requestId, sent[0].requestId)
  assert.equal(sent[1].skin, undefined)
})

it('hands off only the prepared skin fields and attempts cleanup after delivery failure', async () => {
  const sent: PetSkinChangeRequest[] = []
  const change = beginPetSkinChange(async (request) => {
    sent.push(request)
    if (request.phase === 'prepare') throw new Error('delivery failed')
  })
  await assert.rejects(change.ready, /delivery failed/)
  await change.finish()
  assert.equal(sent[1].phase, 'finish')
  const successful = beginPetSkinChange(async (request) => {
    sent.push(request)
  })
  const skin = { dataUrl: 'data:image/png;base64,abc', model: 'slim' as const, palmColor: '#445566' }
  await successful.ready
  await successful.finish(skin)
  assert.deepEqual(sent.at(-1)?.skin, skin)
})

it('validates replacement tokens and rejects remote content or malformed preparation packets', () => {
  assert.equal(isPetSkinChangeRequest({ requestId: 'java-1', phase: 'prepare' }), true)
  assert.equal(isPetSkinChangeRequest({ requestId: 'java-1', phase: 'finish', skin: { model: 'wide', palmColor: '#445566' } }), true)
  for (const value of [null, {}, { requestId: '', phase: 'prepare' }, { requestId: 'java-1', phase: 'unknown' }, { requestId: 'java-1', phase: 'prepare', skin: { model: 'wide', palmColor: '#445566' } }, { requestId: 'java-1', phase: 'finish', skin: { model: 'wide', dataUrl: 'https://example.com/skin.png', palmColor: '#445566' } }, { requestId: 'java-1', phase: 'finish', skin: { model: 'auto', palmColor: '#445566' } }]) assert.equal(isPetSkinChangeRequest(value), false)
})

it('serializes native prepare delivery across rapid Java selections', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  const sent: PetSkinChangeRequest[] = []
  let deliverFirst!: () => void
  const firstDelivery = new Promise<void>((resolve) => {
    deliverFirst = resolve
  })
  mockIPC(async (command, args) => {
    assert.equal(command, 'plugin:event|emit_to')
    const request = (args as { payload: PetSkinChangeRequest }).payload
    sent.push(request)
    if (sent.length === 1) await firstDelivery
  })
  const first = beginPetSkinChange()
  const second = beginPetSkinChange()
  try {
    for (let index = 0; index < 10; index++) await Promise.resolve()
    assert.equal(sent.length, 1, 'a newer prepare must not overtake an older native delivery')
    deliverFirst()
    await Promise.all([first.ready, second.ready])
    await Promise.all([first.finish(), second.finish()])
    assert.deepEqual(sent.map(request => request.phase), ['prepare', 'prepare', 'finish', 'finish'])
    assert.equal(sent[2].requestId, sent[0].requestId)
    assert.equal(sent[3].requestId, sent[1].requestId)
  } finally {
    deliverFirst()
    await Promise.allSettled([first.ready, second.ready, first.finish(), second.finish()])
    clearMocks()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

it('releases the token with a small cancellation if prepared skin delivery fails', async () => {
  const sent: PetSkinChangeRequest[] = []
  const change = beginPetSkinChange(async (request) => {
    sent.push(request)
    if (request.skin) throw new Error('handoff failed')
  })
  await change.ready
  const completion = change.finish({ model: 'wide', palmColor: '#445566' })
  await assert.rejects(completion, /handoff failed/)
  assert.equal(sent.length, 3)
  assert.equal(sent[2].phase, 'finish')
  assert.equal(sent[2].skin, undefined)
  assert.equal(sent[2].requestId, sent[0].requestId)
  assert.equal(change.finish(), completion)
})
