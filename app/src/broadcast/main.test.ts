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

it('settles same-skin automatic scenes at the current input time before measuring, preserving manual and preview paths', async () => {
  const viewSource = ts.transpileModule(readFileSync(new URL('./view.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const events: Array<{ kind: string, timestamp?: number }> = []
  const bounds = { x: 10, y: 20, width: 300, height: 400 }
  let created = 0
  // Run the actual view owner; GL/DOM adapters alone are fake. The real rig
  // and held-input consequences are covered by three3d/pet.test.ts.
  function createRenderer() {
    created++
    let canvas: unknown
    const methods: Record<string, unknown> = {
      init: async (value: unknown) => {
        canvas = value
      },
      setAntialiasEnabled: async () => canvas,
      renderStillFrame: (timestamp?: number) => events.push({ kind: 'settle', timestamp }),
      measureVisibleContentRect: async () => {
        events.push({ kind: 'measure' })
        return { status: 'success', rect: bounds }
      },
    }
    return new Proxy(methods, { get: (target, property) => target[String(property)] ?? (() => {}) })
  }
  const exports: { createBroadcastView?: (container: unknown, base: URL) => {
    apply: (scene: unknown, isCurrent: () => boolean) => Promise<void>
    dispose: () => void
  } } = {}
  runInNewContext(viewSource, {
    exports,
    require: (id: string) => id === '@/utils/three3d'
      ? { Three3DRenderer: createRenderer }
      : id === '@/features/presets/visualSettings'
        ? { applyPresetVisualSettings: () => {} }
        : { fitBroadcastOutput: () => ({ width: 300, height: 400 }) },
    document: { createElement: () => ({ style: {}, remove: () => {} }) },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    performance: { now: () => 50_000 },
    URL,
  })
  const view = exports.createBroadcastView!({ clientWidth: 800, clientHeight: 600, append: () => {} }, new URL('http://127.0.0.1/assets/'))
  const scene = { skinModel: 'wide', performance: { antialiasEnabled: true }, preset: { autoViewportEnabled: true }, opacity: 100 }
  await view.apply(scene, () => true)
  assert.deepEqual(events, [{ kind: 'settle', timestamp: undefined }, { kind: 'measure' }], 'new scene retains deterministic preview settling')
  events.length = 0
  await view.apply(scene, () => true)
  assert.deepEqual(events, [{ kind: 'settle', timestamp: 50_000 }, { kind: 'measure' }], 'live pose is applied before crop measurement')
  events.length = 0
  await view.apply({ ...scene, preset: { autoViewportEnabled: false, manualViewportRect: bounds } }, () => true)
  assert.deepEqual(events, [], 'manual crop does not settle or measure')
  assert.equal(created, 1, 'same-skin edits reuse the renderer')
  view.dispose()
})
