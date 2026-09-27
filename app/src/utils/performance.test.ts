/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { calculateCurrentPerformanceMetrics, createPerformanceAverages } from './performance'

describe('current performance metrics', () => {
  it('reports the latest CPU, GPU, and RAM values', () => {
    assert.deepEqual(calculateCurrentPerformanceMetrics({
      cpuPercent: 12.5,
      gpuPercent: 30,
      ramBytes: 512,
    }), {
      cpuPercent: 12.5,
      gpuPercent: 30,
      ramBytes: 512,
    })
  })

  it('leaves unavailable process metrics undefined instead of reporting zero', () => {
    assert.deepEqual(calculateCurrentPerformanceMetrics({
      cpuPercent: Number.NaN,
      gpuPercent: undefined,
      ramBytes: Number.POSITIVE_INFINITY,
    }), {
      cpuPercent: undefined,
      gpuPercent: undefined,
      ramBytes: undefined,
    })
  })

  it('preserves measured zero process usage', () => {
    assert.deepEqual(calculateCurrentPerformanceMetrics({
      cpuPercent: 0,
      gpuPercent: 0,
      ramBytes: 0,
    }), {
      cpuPercent: 0,
      gpuPercent: 0,
      ramBytes: 0,
    })
  })
})

describe('session performance averages', () => {
  it('averages CPU, GPU, and RAM independently, including zero and excluding invalid samples', () => {
    const averages = createPerformanceAverages()
    assert.deepEqual(averages.add({ cpuPercent: 0, gpuPercent: 40, ramBytes: 100 }), {
      cpuPercent: 0,
      gpuPercent: 40,
      ramBytes: 100,
    })
    assert.deepEqual(averages.add({ cpuPercent: 20, gpuPercent: Number.NaN, ramBytes: 0 }), {
      cpuPercent: 10,
      gpuPercent: 40,
      ramBytes: 50,
    })
    assert.deepEqual(averages.add({ cpuPercent: Number.POSITIVE_INFINITY, gpuPercent: 60, ramBytes: Number.NaN }), {
      cpuPercent: 10,
      gpuPercent: 50,
      ramBytes: 50,
    })
    assert.deepEqual(averages.add({ ramBytes: Number.POSITIVE_INFINITY }), { cpuPercent: 10, gpuPercent: 50, ramBytes: 50 })
    assert.deepEqual(averages.add({ ramBytes: Number.NEGATIVE_INFINITY }), { cpuPercent: 10, gpuPercent: 50, ramBytes: 50 })
    assert.deepEqual(averages.add({}), { cpuPercent: 10, gpuPercent: 50, ramBytes: 50 })
    assert.deepEqual(createPerformanceAverages().add({}), { cpuPercent: undefined, gpuPercent: undefined, ramBytes: undefined })
  })
})
