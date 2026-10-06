export interface CurrentPerformanceMetrics {
  cpuPercent?: number
  gpuPercent?: number
  ramBytes?: number
}

export type CurrentPerformanceSample = CurrentPerformanceMetrics

export type PerformanceResource = 'cpu' | 'gpu' | 'ram'

const PERFORMANCE_UNAVAILABLE_REASONS = [
  'unsupported',
  'accessDenied',
  'processUnavailable',
  'processSnapshotFailed',
  'counterUnavailable',
  'counterReadFailed',
  'initializing',
  'intervalTooShort',
  'invalidSample',
  'samplingFailed',
] as const

export type PerformanceUnavailableReason = typeof PERFORMANCE_UNAVAILABLE_REASONS[number]
export type PerformanceUnavailableReasons = Partial<Record<PerformanceResource, PerformanceUnavailableReason | 'unknown'>>

/** Keep only current missing resources and recognized codes, never raw native errors. */
export function calculatePerformanceUnavailableReasons(
  metrics: CurrentPerformanceMetrics,
  nativeReasons?: Partial<Record<PerformanceResource, string>>,
): PerformanceUnavailableReasons {
  const values: Record<PerformanceResource, number | undefined> = {
    cpu: metrics.cpuPercent,
    gpu: metrics.gpuPercent,
    ram: metrics.ramBytes,
  }
  const reasons: PerformanceUnavailableReasons = {}
  for (const resource of ['cpu', 'gpu', 'ram'] as const) {
    if (values[resource] !== undefined) continue
    const reason = nativeReasons?.[resource]
    reasons[resource] = PERFORMANCE_UNAVAILABLE_REASONS.find(known => known === reason) ?? 'unknown'
  }
  return reasons
}

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
