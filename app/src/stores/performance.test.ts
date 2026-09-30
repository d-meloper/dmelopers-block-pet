/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import * as Pinia from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'

import { INVOKE_KEY } from '@/constants'
import * as metrics from '@/utils/performance'

import type { usePerformanceStore } from './performance'

function harness() {
  Pinia.setActivePinia(Pinia.createPinia())
  let clock = 0
  let tick: (() => void) | undefined
  let timerStarts = 0
  let primeCalls = 0
  let sampleCalls = 0
  const diagnostics: Array<{ level: string, operation: string, error: unknown }> = []
  let prime: () => Promise<unknown> = async () => undefined
  let sample: () => Promise<object> = async () => ({ cpuPercent: 10, gpuPercent: 20, ramBytes: 512, available: true })
  let options: unknown
  const source = readFileSync(new URL('./performance.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const module = { exports: {} as { usePerformanceStore: typeof usePerformanceStore } }
  // Exercise the actual store with deterministic native replies and a monotonic clock.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', 'performance', 'setInterval', 'clearInterval', compiled.outputText)(
    (id: string) => {
      if (id === 'vue') return Vue
      if (id === 'pinia') {
        return {
          ...Pinia,
          defineStore: (...args: Parameters<typeof Pinia.defineStore>) => {
            options = args[2]
            return Pinia.defineStore(...args)
          },
        }
      }
      if (id === '@/constants') return { INVOKE_KEY }
      if (id === '@/utils/performance') return metrics
      if (id === '@/services/diagnostics') return { reportDiagnostic: (level: string, operation: string, error: unknown) => diagnostics.push({ level, operation, error }) }
      if (id === '@tauri-apps/api/core') {
        return {
          invoke: (key: string) => {
            if (key === INVOKE_KEY.SAMPLE_APP_PERFORMANCE) {
              sampleCalls += 1
              return sample()
            }
            primeCalls += 1
            return prime()
          },
        }
      }
      throw new Error(`Unexpected import: ${id}`)
    },
    module,
    module.exports,
    { now: () => clock },
    (callback: () => void) => {
      timerStarts += 1
      tick = callback
      return 1
    },
    () => {
      tick = undefined
    },
  )
  const store = module.exports.usePerformanceStore()
  const advance = async (milliseconds: number) => {
    clock += milliseconds
    tick?.()
    await new Promise(resolve => setImmediate(resolve))
  }
  return {
    store,
    diagnostics,
    get hasTimer() {
      return tick !== undefined
    },
    get timerStarts() {
      return timerStarts
    },
    get primeCalls() {
      return primeCalls
    },
    get sampleCalls() {
      return sampleCalls
    },
    get timerCallback() {
      return tick
    },
    setPrime: (next: typeof prime) => {
      prime = next
    },
    options,
    setSample: (next: typeof sample) => {
      sample = next
    },
    advance,
    async finishWarmup() {
      await advance(1000)
      await advance(1000)
    },
  }
}

describe('performance monitoring sessions', () => {
  it('excludes exactly the two preparation samples and retains all later high or zero values', async () => {
    const h = harness()
    const samples = [
      { cpuPercent: 99, gpuPercent: 98, ramBytes: 4096, available: true },
      { cpuPercent: 88, gpuPercent: 87, ramBytes: 3072, available: true },
      { cpuPercent: 10, gpuPercent: 20, ramBytes: 512, available: true },
      { cpuPercent: 100, gpuPercent: 100, ramBytes: 8192, available: true },
      { cpuPercent: 0, gpuPercent: 0, ramBytes: 0, available: true },
    ]
    h.setSample(async () => samples.shift()!)
    await h.store.start()
    assert.equal(h.store.isWarmingUp, true)
    for (let sample = 1; sample <= 2; sample++) {
      await h.advance(1000)
      assert.equal(h.sampleCalls, sample)
      assert.equal(h.store.isWarmingUp, sample < 2)
      assert.equal(h.store.hasSampled, false)
      assert.equal(h.store.elapsedSeconds, 0)
      assert.deepEqual(h.store.currentMetrics, {})
      assert.deepEqual(h.store.averageMetrics, {})
    }
    await h.advance(1000)
    assert.equal(h.store.hasSampled, true)
    assert.equal(h.store.elapsedSeconds, 1)
    assert.deepEqual(h.store.currentMetrics, { cpuPercent: 10, gpuPercent: 20, ramBytes: 512 })
    assert.deepEqual(h.store.averageMetrics, h.store.currentMetrics)
    await h.advance(1000)
    assert.deepEqual(h.store.currentMetrics, { cpuPercent: 100, gpuPercent: 100, ramBytes: 8192 })
    assert.deepEqual(h.store.averageMetrics, { cpuPercent: 55, gpuPercent: 60, ramBytes: 4352 })
    await h.advance(1000)
    assert.deepEqual(h.store.currentMetrics, { cpuPercent: 0, gpuPercent: 0, ramBytes: 0 })
    assert.deepEqual(h.store.averageMetrics, { cpuPercent: 110 / 3, gpuPercent: 40, ramBytes: 8704 / 3 })
    assert.equal(h.store.elapsedSeconds, 3)
    await h.store.stop()
  })

  it('bounds preparation even when the counters fail or some metrics are unavailable', async () => {
    const h = harness()
    h.setSample(async () => {
      throw new Error('unavailable')
    })
    await h.store.start()
    await h.finishWarmup()
    assert.equal(h.store.isWarmingUp, false)
    assert.equal(h.store.hasSampled, false)
    assert.equal(h.store.elapsedSeconds, 0)
    await h.advance(1000)
    assert.equal(h.store.hasSampled, true)
    assert.equal(h.store.elapsedSeconds, 1)
    assert.deepEqual(h.store.currentMetrics, { cpuPercent: undefined, gpuPercent: undefined, ramBytes: undefined })
    h.setSample(async () => ({ cpuPercent: 0, gpuPercent: null, ramBytes: 512, available: true }))
    await h.advance(1000)
    assert.deepEqual(h.store.averageMetrics, { cpuPercent: 0, gpuPercent: undefined, ramBytes: 512 })
    await h.store.stop()
  })

  it('starts elapsed time after the final completed preparation collection, not its request', async () => {
    const h = harness()
    let finishSample!: (value: object) => void
    h.setSample(() => new Promise((resolve) => {
      finishSample = resolve
    }))
    await h.store.start()
    await h.advance(1000)
    await h.advance(9000)
    assert.equal(h.sampleCalls, 1, 'an in-flight native collection is never overlapped')
    assert.equal(h.store.isWarmingUp, true)
    assert.equal(h.store.elapsedSeconds, 0)
    finishSample({ cpuPercent: 99, gpuPercent: 99, ramBytes: 999, available: true })
    await new Promise(resolve => setImmediate(resolve))
    h.setSample(async () => ({ cpuPercent: 40, gpuPercent: 50, ramBytes: 1024, available: true }))
    await h.advance(1000)
    assert.equal(h.store.isWarmingUp, false)
    assert.equal(h.store.elapsedSeconds, 0)
    await h.advance(1000)
    assert.equal(h.store.elapsedSeconds, 1)
    assert.deepEqual(h.store.averageMetrics, { cpuPercent: 40, gpuPercent: 50, ramBytes: 1024 })
    await h.store.stop()
  })

  it('restarts preparation on reset and ignores old callbacks, replies and hidden work', async () => {
    const h = harness()
    await h.store.start()
    const oldTimer = h.timerCallback!
    let finishOld!: (value: object) => void
    h.setSample(() => new Promise((resolve) => {
      finishOld = resolve
    }))
    await h.advance(1000)
    await h.store.reset()
    const calls = h.sampleCalls
    oldTimer()
    assert.equal(h.sampleCalls, calls, 'a stale timer cannot sample a new generation')
    finishOld({ cpuPercent: 99, gpuPercent: 99, ramBytes: 999, available: true })
    await new Promise(resolve => setImmediate(resolve))
    h.setSample(async () => ({ cpuPercent: 5, gpuPercent: 6, ramBytes: 7, available: true }))
    await h.advance(1000)
    assert.equal(h.store.isWarmingUp, true, 'the old reply did not consume new preparation')
    assert.equal(h.store.elapsedSeconds, 0)
    assert.deepEqual(h.store.averageMetrics, {})
    await h.store.stop()
    assert.equal(h.store.isWarmingUp, false)
    const stoppedCalls = h.sampleCalls
    await h.advance(5000)
    assert.equal(h.sampleCalls, stoppedCalls)
    assert.equal(h.hasTimer, false)
    await h.store.start()
    await h.finishWarmup()
    assert.deepEqual(h.store.averageMetrics, {})
    await h.advance(1000)
    assert.deepEqual(h.store.averageMetrics, { cpuPercent: 5, gpuPercent: 6, ramBytes: 7 })
    await h.store.stop()
  })

  it('does not start a queued session after the preference owner stops it', async () => {
    const h = harness()
    const starting = h.store.start()
    const stopping = h.store.stop()
    await Promise.all([starting, stopping])
    assert.equal(h.store.isMonitoring, false)
    assert.equal(h.hasTimer, false)
    assert.equal(h.primeCalls, 0)
    assert.equal(h.timerStarts, 0)
  })

  it('cancels a delayed initial or reset prime when hidden or unmounted', async () => {
    for (const operation of ['start', 'reset'] as const) {
      const h = harness()
      if (operation === 'reset') {
        await h.store.start()
        await h.finishWarmup()
        await h.advance(2000)
      }
      const timerStarts = h.timerStarts
      let resolvePrime!: () => void
      h.setPrime(() => new Promise<void>((resolve) => {
        resolvePrime = resolve
      }))
      const pending = h.store[operation]()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(h.store.isMonitoring, false)
      assert.equal(h.hasTimer, false)
      const stopping = h.store.stop()
      assert.equal(h.store.isWarmingUp, false)
      resolvePrime()
      await Promise.all([pending, stopping])
      assert.equal(h.store.isMonitoring, false)
      assert.equal(h.hasTimer, false)
      assert.equal(h.timerStarts, timerStarts)
      assert.deepEqual(h.store.currentMetrics, {})
      assert.deepEqual(h.store.averageMetrics, {})
      assert.equal(h.store.elapsedSeconds, 0)
      await h.store.reset()
      await h.advance(5000)
      assert.equal(h.store.elapsedSeconds, 0)
      assert.equal(h.timerStarts, timerStarts)
    }
  })

  it('reopens with one new timer after a stopped pending prime settles', async () => {
    const h = harness()
    let resolveOldPrime!: () => void
    h.setPrime(() => new Promise<void>((resolve) => {
      resolveOldPrime = resolve
    }))
    const initial = h.store.start()
    await new Promise(resolve => setImmediate(resolve))
    const stopping = h.store.stop()
    h.setPrime(async () => undefined)
    const reopened = h.store.start()
    resolveOldPrime()
    await Promise.all([initial, stopping, reopened])
    assert.equal(h.store.isMonitoring, true)
    assert.equal(h.primeCalls, 2)
    assert.equal(h.timerStarts, 1)
    await h.store.stop()
  })

  it('clears a reset overtaken by stop without another native prime or timer', async () => {
    for (const order of [['reset', 'stop'], ['stop', 'reset']] as const) {
      const h = harness()
      await h.store.start()
      await h.finishWarmup()
      await h.advance(2000)
      assert.equal(h.store.hasSampled, true)
      assert.notDeepEqual(h.store.currentMetrics, {})
      assert.notDeepEqual(h.store.averageMetrics, {})
      assert.equal(h.store.elapsedSeconds, 2)
      const pending = order.map(action => h.store[action]())
      await Promise.all(pending)
      assert.deepEqual(h.store.currentMetrics, {})
      assert.deepEqual(h.store.averageMetrics, {})
      assert.equal(h.store.hasSampled, false)
      assert.equal(h.store.elapsedSeconds, 0)
      assert.equal(h.store.isMonitoring, false)
      assert.equal(h.hasTimer, false)
      assert.equal(h.primeCalls, 1)
      assert.equal(h.timerStarts, 1)
      await h.advance(5000)
      assert.deepEqual(h.store.currentMetrics, {})
      assert.equal(h.store.elapsedSeconds, 0)
      // Reopening is a new session; duplicate lifecycle reconciliation still
      // creates only one sampler prime and timer.
      h.setSample(async () => ({ cpuPercent: 40, gpuPercent: 50, ramBytes: 1024, available: true }))
      await Promise.all([h.store.start(), h.store.start()])
      assert.equal(h.primeCalls, 2)
      assert.equal(h.timerStarts, 2)
      await h.finishWarmup()
      await h.advance(1000)
      assert.deepEqual(h.store.averageMetrics, { cpuPercent: 40, gpuPercent: 50, ramBytes: 1024 })
      await h.store.stop()
    }
  })

  it('ignores a native prime failure after the owner cancels that session', async () => {
    const h = harness()
    let rejectPrime!: (error: Error) => void
    h.setPrime(() => new Promise((_, reject) => {
      rejectPrime = reject
    }))
    const starting = h.store.start()
    await new Promise(resolve => setImmediate(resolve))
    const stopping = h.store.stop()
    rejectPrime(new Error('late prime failure'))
    await Promise.all([starting, stopping])
    assert.deepEqual(h.diagnostics, [])
    assert.equal(h.hasTimer, false)
  })

  it('keeps measurements out of persistence and resets only on a new session', async () => {
    const h = harness()
    assert.deepEqual(h.options, { tauri: { autoStart: false, save: false, sync: false } })
    await h.store.start()
    assert.equal(h.store.elapsedSeconds, 0)
    assert.deepEqual(h.store.averageMetrics, {})
    await h.finishWarmup()
    await h.advance(125000)
    assert.equal(h.store.elapsedSeconds, 125)
    assert.deepEqual(h.store.averageMetrics, { cpuPercent: 10, gpuPercent: 20, ramBytes: 512 })
    await h.store.start()
    assert.equal(h.store.elapsedSeconds, 125)
    await h.store.stop()
    await h.advance(5000)
    assert.equal(h.store.elapsedSeconds, 125)
    await h.store.start()
    assert.equal(h.store.elapsedSeconds, 0)
    assert.equal(h.store.hasSampled, false)
    assert.deepEqual(h.store.averageMetrics, {})
    await h.finishWarmup()
    await h.advance(1000)
    await h.store.reset()
    assert.equal(h.store.isMonitoring, true)
    assert.equal(h.store.elapsedSeconds, 0)
    assert.deepEqual(h.store.currentMetrics, {})
    assert.deepEqual(h.store.averageMetrics, {})
    assert.equal(h.store.hasSampled, false)
    await h.store.stop()
    await h.store.reset()
    assert.equal(h.store.isMonitoring, false)
    assert.deepEqual(h.diagnostics, [])
  })

  it('reports actual sampler failures and ignores failures after monitoring stops', async () => {
    const h = harness()
    const failure = new Error('sampler denied')
    h.setPrime(async () => {
      throw failure
    })
    await h.store.start()
    assert.deepEqual(h.diagnostics, [{ level: 'warn', operation: 'performance.prime', error: failure }])
    h.setSample(async () => {
      throw failure
    })
    await h.advance(1000)
    assert.equal(h.diagnostics.at(-1)?.operation, 'performance.sample')
    let rejectPending!: (error: Error) => void
    h.setSample(() => new Promise((_, reject) => {
      rejectPending = reject
    }))
    await h.advance(1000)
    await h.store.stop()
    const count = h.diagnostics.length
    rejectPending(failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.diagnostics.length, count)
  })

  it('discards replies from before stop or reset and preserves averages on failure', async () => {
    for (const restart of ['stop', 'reset'] as const) {
      const h = harness()
      let resolveOld: (sample: object) => void = () => {}
      h.setSample(() => new Promise((resolve) => {
        resolveOld = resolve
      }))
      await h.store.start()
      await h.advance(1000)
      if (restart === 'stop') {
        await h.store.stop()
        await h.store.start()
      } else {
        await h.store.reset()
      }
      resolveOld({ cpuPercent: 99, gpuPercent: 99, ramBytes: 999, available: true })
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(h.store.averageMetrics, {})
      assert.equal(h.store.hasSampled, false)
      h.setSample(async () => ({ cpuPercent: 0, gpuPercent: null, ramBytes: 0, available: true }))
      await h.finishWarmup()
      await h.advance(1000)
      assert.deepEqual(h.store.averageMetrics, { cpuPercent: 0, gpuPercent: undefined, ramBytes: 0 })
      h.setSample(async () => {
        throw new Error('Unavailable')
      })
      await h.advance(1000)
      assert.deepEqual(h.store.averageMetrics, { cpuPercent: 0, gpuPercent: undefined, ramBytes: 0 })
      h.setSample(async () => ({ cpuPercent: 30, gpuPercent: null, ramBytes: 300, available: false }))
      await h.advance(1000)
      assert.deepEqual(h.store.currentMetrics, { cpuPercent: undefined, gpuPercent: undefined, ramBytes: undefined })
      assert.deepEqual(h.store.averageMetrics, { cpuPercent: 0, gpuPercent: undefined, ramBytes: 0 })
      h.setSample(async () => ({ cpuPercent: 20, gpuPercent: null, ramBytes: 512, available: true }))
      await h.advance(1000)
      assert.deepEqual(h.store.averageMetrics, { cpuPercent: 10, gpuPercent: undefined, ramBytes: 256 })
      await h.store.stop()
    }
  })
})
