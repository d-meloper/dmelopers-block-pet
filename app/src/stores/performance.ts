import { invoke } from '@tauri-apps/api/core'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import type { AveragePerformanceMetrics, CurrentPerformanceMetrics } from '@/utils/performance'

import { INVOKE_KEY } from '@/constants'
import { reportDiagnostic } from '@/services/diagnostics'
import { calculateCurrentPerformanceMetrics, createPerformanceAverages, PERFORMANCE_WARMUP_SAMPLES } from '@/utils/performance'

interface AppPerformanceSample {
  cpuPercent: number | null
  gpuPercent: number | null
  ramBytes: number | null
  available: boolean
}

export const usePerformanceStore = defineStore('performance', () => {
  const isMonitoring = ref(false)
  const isTransitioning = ref(false)
  const isWarmingUp = ref(false)
  const currentMetrics = ref<CurrentPerformanceMetrics>({})
  const hasSampled = ref(false)
  const averageMetrics = ref<AveragePerformanceMetrics>({})
  const elapsedSeconds = ref(0)
  let averages = createPerformanceAverages()
  let measurementStartedAt: number | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let sampling = false
  let monitoringRequested = false
  let warmupSamplesRemaining = 0
  let measurementGeneration = 0
  let pendingTransitions = 0
  let transitionQueue = Promise.resolve()

  const collectSample = async () => {
    if (!isMonitoring.value || sampling) return
    const generation = measurementGeneration
    sampling = true
    try {
      const appSample = await invoke<AppPerformanceSample>(INVOKE_KEY.SAMPLE_APP_PERFORMANCE)
        .catch((error) => {
          if (isMonitoring.value && generation === measurementGeneration) {
            reportDiagnostic('warn', 'performance.sample', error)
          }
          return { cpuPercent: null, gpuPercent: null, ramBytes: null, available: false }
        })
      if (!isMonitoring.value || generation !== measurementGeneration) return
      if (warmupSamplesRemaining > 0) {
        // Keep collecting native counters so the first retained sample covers
        // a new interval. Unavailable replies count too: preparation is bounded
        // and must not hide a sampler failure or sustained high usage.
        warmupSamplesRemaining -= 1
        if (warmupSamplesRemaining === 0) {
          isWarmingUp.value = false
          measurementStartedAt = performance.now()
        }
        return
      }
      currentMetrics.value = calculateCurrentPerformanceMetrics({
        cpuPercent: appSample.available && appSample.cpuPercent !== null
          ? appSample.cpuPercent
          : undefined,
        gpuPercent: appSample.gpuPercent !== null
          && Number.isFinite(appSample.gpuPercent)
          ? appSample.gpuPercent
          : undefined,
        ramBytes: appSample.available && appSample.ramBytes !== null
          ? appSample.ramBytes
          : undefined,
      })
      averageMetrics.value = averages.add(currentMetrics.value)
      hasSampled.value = true
      if (measurementStartedAt !== undefined) {
        elapsedSeconds.value = Math.floor((performance.now() - measurementStartedAt) / 1000)
      }
    } finally {
      sampling = false
    }
  }

  const clearMetrics = () => {
    currentMetrics.value = {}
    hasSampled.value = false
    averageMetrics.value = {}
    averages = createPerformanceAverages()
    elapsedSeconds.value = 0
    measurementStartedAt = undefined
    isWarmingUp.value = false
    warmupSamplesRemaining = 0
  }

  const enqueueTransition = (operation: () => Promise<void>): Promise<void> => {
    pendingTransitions += 1
    isTransitioning.value = true
    const result = transitionQueue.then(operation, operation)
    transitionQueue = result
      .then(() => undefined, () => undefined)
      .finally(() => {
        pendingTransitions -= 1
        if (pendingTransitions === 0) isTransitioning.value = false
      })
    return result
  }

  const startMonitoring = async () => {
    if (!monitoringRequested || isMonitoring.value) return
    clearMetrics()
    warmupSamplesRemaining = PERFORMANCE_WARMUP_SAMPLES
    isWarmingUp.value = true
    const generation = ++measurementGeneration
    await invoke(INVOKE_KEY.PRIME_APP_PERFORMANCE_SAMPLER)
      .catch((error) => {
        if (monitoringRequested && generation === measurementGeneration) {
          reportDiagnostic('warn', 'performance.prime', error)
        }
      })
    // A hidden/closed preference window may request stop while native priming
    // is still pending. Never let that old continuation create a new timer.
    if (!monitoringRequested || generation !== measurementGeneration) return
    isMonitoring.value = true
    timer = setInterval(() => {
      if (!isMonitoring.value || generation !== measurementGeneration) return
      if (measurementStartedAt !== undefined) {
        elapsedSeconds.value = Math.floor((performance.now() - measurementStartedAt) / 1000)
      }
      void collectSample()
    }, 1000)
  }

  const stopMonitoring = async () => {
    isWarmingUp.value = false
    warmupSamplesRemaining = 0
    if (!isMonitoring.value) return
    isMonitoring.value = false
    measurementGeneration += 1
    if (timer) clearInterval(timer)
    timer = undefined
  }

  const resetMetrics = async () => {
    // Clearing is the reset's own responsibility even if a concurrent stop
    // prevents startMonitoring from restarting this session.
    clearMetrics()
    measurementGeneration += 1
    if (isMonitoring.value) {
      await stopMonitoring()
      await startMonitoring()
    }
  }

  const start = () => {
    monitoringRequested = true
    return enqueueTransition(startMonitoring)
  }
  const stop = () => {
    monitoringRequested = false
    isWarmingUp.value = false
    warmupSamplesRemaining = 0
    // Invalidate pending samples and primes before the serialized stop executes.
    measurementGeneration += 1
    return enqueueTransition(stopMonitoring)
  }
  const reset = () => enqueueTransition(resetMetrics)
  const toggle = () => {
    if (isTransitioning.value) return Promise.resolve()
    return isMonitoring.value ? stop() : start()
  }

  return {
    isMonitoring,
    isTransitioning,
    isWarmingUp,
    currentMetrics,
    averageMetrics,
    elapsedSeconds,
    hasSampled,
    start,
    stop,
    reset,
    toggle,
  }
}, {
  tauri: {
    // Measurements belong only to this window's current monitoring session.
    autoStart: false,
    save: false,
    sync: false,
  },
})
