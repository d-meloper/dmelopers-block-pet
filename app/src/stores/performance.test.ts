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
          invoke: (key: string) => key === INVOKE_KEY.SAMPLE_APP_PERFORMANCE ? sample() : prime(),
        }
      }
      throw new Error(`Unexpected import: ${id}`)
    },
    module,
    module.exports,
    { now: () => clock },
    (callback: () => void) => {
      tick = callback
      return 1
    },
    () => {
      tick = undefined
    },
  )
  const store = module.exports.usePerformanceStore()
  return {
    store,
    diagnostics,
    setPrime: (next: typeof prime) => {
      prime = next
    },
    options,
    setSample: (next: typeof sample) => {
      sample = next
    },
    async advance(milliseconds: number) {
      clock += milliseconds
      tick?.()
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

describe('performance monitoring sessions', () => {
  it('keeps measurements out of persistence and resets only on a new session', async () => {
    const h = harness()
    assert.deepEqual(h.options, { tauri: { autoStart: false, save: false, sync: false } })
    await h.store.start()
    assert.equal(h.store.elapsedSeconds, 0)
    assert.deepEqual(h.store.averageMetrics, {})
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
    await h.advance(1000)
    await h.store.reset()
    assert.equal(h.store.isMonitoring, true)
    assert.equal(h.store.elapsedSeconds, 0)
    assert.deepEqual(h.store.averageMetrics, {})
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
