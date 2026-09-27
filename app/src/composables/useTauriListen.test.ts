/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function listenerHarness() {
  const mounts: Array<() => Promise<void>> = []
  const unmounts: Array<() => void> = []
  const listeners = new Set<(event: unknown) => void>()
  const pending: Array<() => void> = []
  let releases = 0
  const exports = {} as {
    useTauriListen: (event: string, handler: (event: unknown) => void, options?: unknown) => void
  }
  const calls: unknown[][] = []
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/event': {
      listen: (...args: [string, (event: unknown) => void, unknown]) => {
        calls.push(args)
        const handler = args[1]
        listeners.add(handler)
        return new Promise<() => void>((resolve) => {
          pending.push(() => resolve(() => {
            releases += 1
            listeners.delete(handler)
          }))
        })
      },
    },
    '@vueuse/core': { noop: () => {} },
    'vue': {
      ref: (value: unknown) => ({ value }),
      onMounted: (callback: () => Promise<void>) => mounts.push(callback),
      onUnmounted: (callback: () => void) => unmounts.push(callback),
    },
  }
  const source = readFileSync(new URL('./useTauriListen.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => mocks[name] })
  return {
    use: exports.useTauriListen,
    mount: (index = 0) => mounts[index](),
    unmount: (index = 0) => unmounts[index](),
    acknowledge: (index = 0) => pending[index](),
    emit: (event: unknown) => listeners.forEach(handler => handler(event)),
    active: () => listeners.size,
    releases: () => releases,
    calls,
  }
}

describe('native event subscription lifetime', () => {
  it('preserves event arguments and releases an acknowledged listener on unmount', async () => {
    const h = listenerHarness()
    const received: unknown[] = []
    const handler = (event: unknown) => received.push(event)
    const options = { target: { kind: 'WebviewWindow', label: 'main' } }
    h.use('pet-event', handler, options)
    const mounted = h.mount()
    h.acknowledge()
    await mounted
    assert.deepEqual(h.calls, [['pet-event', handler, options]])
    h.emit({ payload: 1 })
    assert.deepEqual(received, [{ payload: 1 }])
    h.unmount()
    h.emit({ payload: 2 })
    assert.equal(h.active(), 0)
    assert.equal(h.releases(), 1)
    assert.equal(received.length, 1)
  })

  it('releases registration that completes after its component has unmounted', async () => {
    const h = listenerHarness()
    let deliveries = 0
    h.use('pet-event', () => deliveries++)
    const mounted = h.mount()
    h.unmount()
    h.acknowledge()
    await mounted
    h.emit({ payload: 'late' })
    assert.equal(h.active(), 0, 'no orphaned native listener may remain')
    assert.equal(h.releases(), 1)
    assert.equal(deliveries, 0)
  })

  it('does not let a retired registration release a replacement subscription', async () => {
    const h = listenerHarness()
    let retired = 0
    let current = 0
    h.use('pet-event', () => retired++)
    const first = h.mount(0)
    h.unmount(0)
    h.use('pet-event', () => current++)
    const second = h.mount(1)
    h.acknowledge(1)
    await second
    h.acknowledge(0)
    await first
    h.emit({ payload: 'current' })
    assert.equal(retired, 0)
    assert.equal(current, 1)
    assert.equal(h.active(), 1)
    h.unmount(1)
    assert.equal(h.active(), 0)
    assert.equal(h.releases(), 2)
  })
})
