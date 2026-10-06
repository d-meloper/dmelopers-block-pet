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
  const pending: Array<{ acknowledge: () => void, reject: () => void }> = []
  let releases = 0
  let releaseFailure: 'sync' | 'async' | undefined
  let releaseWait: Promise<void> | undefined
  const warnings: unknown[][] = []
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
        return new Promise<() => void | Promise<void>>((resolve, reject) => {
          pending.push({
            acknowledge: () => resolve(() => {
              releases += 1
              if (releaseFailure === 'sync') throw new TypeError('fixture private release error')
              if (releaseFailure === 'async') return Promise.reject(new TypeError('fixture private release error'))
              if (releaseWait) return releaseWait.then(() => listeners.delete(handler)).then(() => {})
              listeners.delete(handler)
            }),
            reject: () => reject(new Error('fixture private registration error')),
          })
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
  }).outputText, {
    exports,
    require: (name: string) => mocks[name],
    console: { warn: (...args: unknown[]) => warnings.push(args) },
  })
  return {
    use: exports.useTauriListen,
    mount: (index = 0) => mounts[index](),
    unmount: (index = 0) => unmounts[index](),
    acknowledge: (index = 0) => pending[index].acknowledge(),
    rejectRegistration: (index = 0) => pending[index].reject(),
    failRelease: (failure?: typeof releaseFailure) => {
      releaseFailure = failure
    },
    waitForRelease: (wait: Promise<void>) => {
      releaseWait = wait
    },
    emit: (event: unknown) => listeners.forEach(handler => handler(event)),
    active: () => listeners.size,
    releases: () => releases,
    calls,
    warnings,
  }
}

describe('native event subscription lifetime', () => {
  it('preserves event arguments and releases an acknowledged listener on unmount', async () => {
    const h = listenerHarness()
    const received: unknown[] = []
    function handler(this: unknown, event: unknown) {
      assert.equal(this, undefined, 'a wrapped callback retains the original unbound call contract')
      received.push(event)
    }
    const options = { target: { kind: 'WebviewWindow', label: 'main' } }
    h.use('pet-event', handler, options)
    const mounted = h.mount()
    h.acknowledge()
    await mounted
    assert.equal(h.calls[0][0], 'pet-event')
    assert.equal(h.calls[0][2], options)
    const payload = { payload: 1 }
    h.emit(payload)
    assert.equal(received[0], payload)
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

  it('rejects deliveries immediately while a disposed registration is awaiting acknowledgement', async () => {
    const h = listenerHarness()
    let deliveries = 0
    h.use('pet-event', () => deliveries++)
    const mounted = h.mount()
    h.unmount()
    h.emit({ payload: 'before-registration-ack' })
    assert.equal(h.active(), 1)
    assert.equal(deliveries, 0)
    h.acknowledge()
    await mounted
    assert.equal(h.active(), 0)
    assert.equal(h.releases(), 1)
  })

  it('rejects captured deliveries even after native removal succeeds', async () => {
    const h = listenerHarness()
    let deliveries = 0
    h.use('pet-event', () => deliveries++)
    const mounted = h.mount()
    h.acknowledge()
    await mounted
    const queued = h.calls[0][1] as (event: unknown) => void
    h.unmount()
    queued({ payload: 'already-queued' })
    assert.equal(deliveries, 0)
    assert.equal(h.active(), 0)
  })

  it('rejects deliveries while native removal is still pending', async () => {
    const h = listenerHarness()
    let finish!: () => void
    let deliveries = 0
    h.waitForRelease(new Promise<void>((resolve) => {
      finish = resolve
    }))
    h.use('pet-event', () => deliveries++)
    const mounted = h.mount()
    h.acknowledge()
    await mounted
    h.unmount()
    h.emit({ payload: 'before-removal-ack' })
    assert.equal(h.active(), 1)
    assert.equal(deliveries, 0)
    finish()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(h.active(), 0)
    assert.deepEqual(h.warnings, [])
  })

  for (const failure of ['sync', 'async'] as const) {
    it(`keeps retired callbacks inert when native removal has a ${failure} failure`, async () => {
      const h = listenerHarness()
      let retired = 0
      let current = 0
      h.use('pet-event', () => retired++)
      const first = h.mount(0)
      h.acknowledge(0)
      await first
      h.failRelease(failure)
      h.unmount(0)
      h.unmount(0)
      h.use('pet-event', () => current++)
      const second = h.mount(1)
      h.acknowledge(1)
      await second
      h.emit({ payload: 'replacement' })
      assert.equal(retired, 0)
      assert.equal(current, 1)
      assert.equal(h.active(), 2, 'the fixture deliberately retains the failed native listener')
      assert.equal(h.releases(), 1, 'each owner must attempt native removal only once')
      assert.deepEqual(h.warnings, [['Failed to release a native event subscription.']])
      h.failRelease()
      h.unmount(1)
      assert.equal(h.active(), 1)
      assert.equal(h.releases(), 2)
    })
  }

  it('handles a failed registration without exposing its raw error or leaking an active callback', async () => {
    const h = listenerHarness()
    let deliveries = 0
    h.use('pet-event', () => deliveries++)
    const mounted = h.mount()
    h.rejectRegistration()
    await mounted
    h.emit({ payload: 'failed-registration' })
    assert.equal(deliveries, 0)
    h.unmount()
    assert.equal(h.releases(), 0)
    assert.deepEqual(h.warnings, [['Failed to subscribe to a native event.']])
  })

  it('keeps a late registration inert when its native removal rejects', async () => {
    const h = listenerHarness()
    let deliveries = 0
    h.use('pet-event', () => deliveries++)
    const mounted = h.mount()
    h.unmount()
    h.failRelease('async')
    h.emit({ payload: 'before-registration-ack' })
    h.acknowledge()
    await mounted
    h.emit({ payload: 'failed-late-removal' })
    assert.equal(deliveries, 0)
    assert.equal(h.active(), 1, 'the fixture retains the listener after native removal fails')
    assert.equal(h.releases(), 1)
    assert.deepEqual(h.warnings, [['Failed to release a native event subscription.']])
  })

  it('does not register a subscription after its scope is already disposed', async () => {
    const h = listenerHarness()
    h.use('pet-event', () => {})
    h.unmount()
    const mounted = h.mount()
    assert.equal(h.calls.length, 0)
    await mounted
    assert.equal(h.releases(), 0)
  })
})
