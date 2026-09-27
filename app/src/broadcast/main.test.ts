/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import { createBroadcastSession } from '@/features/broadcast/session'

import { installBroadcastDiagnostics } from './diagnostics'

const source = ts.transpileModule(readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function harness(apply: () => Promise<void> = async () => {}) {
  const sockets: Socket[] = []
  const timers = new Map<number, () => void>()
  const intervals = new Map<number, () => void>()
  let timerId = 0
  let now = 0
  let pagehide!: () => void
  const effects = { inputs: 0, clears: 0, disposed: 0 }
  class Socket {
    static OPEN = 1
    readyState = 1
    sent: string[] = []
    closeCalls = 0
    onmessage?: (event: { data: unknown }) => void
    onopen?: () => void
    onerror?: () => void
    onclose?: () => void
    constructor(public url: URL) {
      sockets.push(this)
    }

    send(text: string) {
      this.sent.push(text)
    }

    close() {
      this.closeCalls++
      this.readyState = 2
    }
  }
  runInNewContext(source, {
    exports: {},
    require: (id: string) => id === '@/features/broadcast/session'
      ? { createBroadcastSession }
      : id === './diagnostics'
        ? { installBroadcastDiagnostics: (send: Parameters<typeof installBroadcastDiagnostics>[0]) => installBroadcastDiagnostics(
            send,
            new EventTarget() as unknown as Window,
            { warn: () => {}, error: () => {} },
            () => now,
          ) }
        : { createBroadcastView: () => ({
            apply,
            input: () => {
              effects.inputs++
            },
            reset: () => {},
            clear: () => {
              effects.clears++
            },
            dispose: () => {
              effects.disposed++
            },
          }) },
    location: { href: `http://127.0.0.1:12345/${'a'.repeat(64)}/` },
    document: { body: {} },
    window: { addEventListener: (_: string, callback: () => void) => {
      pagehide = callback
    } },
    URL,
    WebSocket: Socket,
    Date: { now: () => now },
    setTimeout: (callback: () => void) => {
      timers.set(++timerId, callback)
      return timerId
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void) => {
      intervals.set(++timerId, callback)
      return timerId
    },
    clearInterval: (id: number) => intervals.delete(id),
  })
  return {
    sockets,
    timers,
    intervals,
    effects,
    pagehide: () => pagehide(),
    advance: (milliseconds: number) => {
      now += milliseconds
      intervals.forEach(callback => callback())
    },
    reconnect: () => {
      const callbacks = [...timers.values()]
      timers.clear()
      callbacks.forEach(callback => callback())
    },
  }
}

const scene = { type: 'scene', revision: 1, scene: { schemaVersion: 1, modelId: 'dmeloper', preset: {}, performance: {} } }
const input = { type: 'input', event: { kind: 'mouse_primary', active: true } }
const flush = () => new Promise(resolve => setImmediate(resolve))

it('reconnects with a fresh revision and ignores messages from the retired socket', async () => {
  const h = harness()
  const first = h.sockets[0]
  assert.equal(first.url.href, `ws://127.0.0.1:12345/${'a'.repeat(64)}/ws`)
  first.onmessage!({ data: JSON.stringify(scene) })
  await flush()
  assert.deepEqual(first.sent.map(text => JSON.parse(text)), [{ type: 'ready', revision: 1 }])
  first.onmessage!({ data: JSON.stringify(input) })
  assert.equal(h.effects.inputs, 1)
  first.onclose!()
  assert.equal(first.sent.some(text => JSON.parse(text).type === 'diagnostic'), false, 'normal close must stay silent')
  assert.equal(h.effects.clears, 1)
  h.reconnect()
  first.onmessage!({ data: JSON.stringify(input) })
  assert.equal(h.effects.inputs, 1)
  const second = h.sockets[1]
  second.onmessage!({ data: JSON.stringify(scene) })
  await flush()
  second.onmessage!({ data: JSON.stringify(input) })
  assert.equal(h.effects.inputs, 2)
  h.pagehide()
  second.onclose!()
  assert.equal(h.timers.size, 0)
  assert.equal(h.intervals.size, 0)
  assert.equal(h.effects.disposed, 1)
  assert.equal(second.sent.some(text => JSON.parse(text).type === 'diagnostic'), false, 'page disposal must stay silent')
})

it('clears stale output on heartbeat timeout and cancels reconnect when the page closes', async () => {
  const h = harness()
  const socket = h.sockets[0]
  socket.onmessage!({ data: JSON.stringify(scene) })
  await flush()
  h.advance(6000)
  assert.equal(socket.closeCalls, 0)
  socket.onmessage!({ data: '{"type":"heartbeat"}' })
  h.advance(6000)
  assert.equal(socket.closeCalls, 0)
  h.advance(3000)
  assert.equal(socket.closeCalls, 1)
  assert.equal(h.effects.clears, 1)
  socket.onclose!()
  assert.equal(h.timers.size, 1)
  h.pagehide()
  h.reconnect()
  assert.equal(h.sockets.length, 1)
})

it('closes malformed messages and reports renderer failure without acknowledging readiness', async () => {
  const h = harness(async () => {
    throw new Error('WebGL unavailable')
  })
  const socket = h.sockets[0]
  socket.onmessage!({ data: JSON.stringify(scene) })
  await flush()
  assert.deepEqual(socket.sent.map(text => JSON.parse(text)), [{ type: 'render_error', revision: 1 }])
  socket.onmessage!({ data: JSON.stringify(input) })
  assert.equal(h.effects.inputs, 0)
  socket.onmessage!({ data: '{broken' })
  assert.equal(socket.closeCalls, 1)
  h.pagehide()
})
