export interface CurrentPerformanceMetrics {
  cpuPercent?: number
  gpuPercent?: number
  ramBytes?: number
}

export type CurrentPerformanceSample = CurrentPerformanceMetrics

// Refresh native CPU/GPU delta baselines while setting-related renderer work
// settles. Only this bounded session prefix is excluded, never high values.
export const PERFORMANCE_WARMUP_SAMPLES = 2

function finiteValue(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined
}

export function calculateCurrentPerformanceMetrics(
  sample: CurrentPerformanceSample,
): CurrentPerformanceMetrics {
  return {
    cpuPercent: finiteValue(sample.cpuPercent),
    gpuPercent: finiteValue(sample.gpuPercent),
    ramBytes: finiteValue(sample.ramBytes),
  }
}

export type AveragePerformanceMetrics = Pick<CurrentPerformanceMetrics, 'cpuPercent' | 'gpuPercent' | 'ramBytes'>

/** Bounded, session-only accumulators; unavailable samples are not zeroes. */
export function createPerformanceAverages() {
  const cpu = { sum: 0, count: 0 }
  const gpu = { sum: 0, count: 0 }
  const ram = { sum: 0, count: 0 }
  const add = (total: typeof cpu, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) {
      total.sum += value
      total.count += 1
    }
    return total.count > 0 ? total.sum / total.count : undefined
  }
  return {
    add(sample: CurrentPerformanceMetrics): AveragePerformanceMetrics {
      return {
        cpuPercent: add(cpu, sample.cpuPercent),
        gpuPercent: add(gpu, sample.gpuPercent),
        ramBytes: add(ram, sample.ramBytes),
      }
    },
  }
}
