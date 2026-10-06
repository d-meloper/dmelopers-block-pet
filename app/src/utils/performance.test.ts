/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { calculateCurrentPerformanceMetrics, calculatePerformanceUnavailableReasons, createPerformanceAverages } from './performance'

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

describe('current performance unavailability reasons', () => {
  it('identifies each missing resource independently without rejecting measured zero', () => {
    for (const [resource, key] of [
      ['cpu', 'cpuPercent'],
      ['gpu', 'gpuPercent'],
      ['ram', 'ramBytes'],
    ] as const) {
      const current = { cpuPercent: 0, gpuPercent: 0, ramBytes: 0, [key]: undefined }
      assert.deepEqual(calculatePerformanceUnavailableReasons(current, { [resource]: 'accessDenied' }), { [resource]: 'accessDenied' })
    }
    assert.deepEqual(calculatePerformanceUnavailableReasons({ cpuPercent: 0, gpuPercent: 0, ramBytes: 0 }), {})
  })

  it('normalizes absent and unrecognized native codes without retaining raw errors', () => {
    assert.deepEqual(calculatePerformanceUnavailableReasons({}, {
      cpu: 'FutureReason',
      gpu: 'RAW_PDH_0xC0000BBA',
      ram: 'processSnapshotFailed',
    }), { cpu: 'unknown', gpu: 'unknown', ram: 'processSnapshotFailed' })
    assert.deepEqual(calculatePerformanceUnavailableReasons({}), { cpu: 'unknown', gpu: 'unknown', ram: 'unknown' })
  })

  it('retains known codes only for missing current values and clears recovered resources', () => {
    assert.deepEqual(calculatePerformanceUnavailableReasons({ cpuPercent: 5 }, {
      cpu: 'samplingFailed',
      gpu: 'invalidSample',
      ram: 'processUnavailable',
    }), { gpu: 'invalidSample', ram: 'processUnavailable' })
    assert.deepEqual(calculatePerformanceUnavailableReasons({ cpuPercent: 5, gpuPercent: 6, ramBytes: 7 }, {
      cpu: 'samplingFailed',
      gpu: 'invalidSample',
      ram: 'processUnavailable',
    }), {})
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
