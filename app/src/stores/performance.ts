import { invoke } from '@tauri-apps/api/core'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import type { AveragePerformanceMetrics, CurrentPerformanceMetrics } from '@/utils/performance'

import { INVOKE_KEY } from '@/constants'
import { reportDiagnostic } from '@/services/diagnostics'
import { calculateCurrentPerformanceMetrics, createPerformanceAverages } from '@/utils/performance'

interface AppPerformanceSample {
  cpuPercent: number | null
  gpuPercent: number | null
  ramBytes: number | null
  available: boolean
}

export const usePerformanceStore = defineStore('performance', () => {
  const isMonitoring = ref(false)
  const isTransitioning = ref(false)
  const currentMetrics = ref<CurrentPerformanceMetrics>({})
  const hasSampled = ref(false)
  const averageMetrics = ref<AveragePerformanceMetrics>({})
  const elapsedSeconds = ref(0)
  let averages = createPerformanceAverages()
  let measurementStartedAt: number | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let sampling = false
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
    if (isMonitoring.value) return
    clearMetrics()
    measurementGeneration += 1
    await invoke(INVOKE_KEY.PRIME_APP_PERFORMANCE_SAMPLER)
      .catch(error => reportDiagnostic('warn', 'performance.prime', error))
    measurementStartedAt = performance.now()
    isMonitoring.value = true
    timer = setInterval(() => {
      if (measurementStartedAt !== undefined) {
        elapsedSeconds.value = Math.floor((performance.now() - measurementStartedAt) / 1000)
      }
      void collectSample()
    }, 1000)
  }

  const stopMonitoring = async () => {
    if (!isMonitoring.value) return
    isMonitoring.value = false
    measurementGeneration += 1
    if (timer) clearInterval(timer)
    timer = undefined
  }

  const resetMetrics = async () => {
    if (isMonitoring.value) {
      await stopMonitoring()
      await startMonitoring()
    } else {
      clearMetrics()
      measurementGeneration += 1
    }
  }

  const start = () => enqueueTransition(startMonitoring)
  const stop = () => enqueueTransition(stopMonitoring)
  const reset = () => enqueueTransition(resetMetrics)
  const toggle = () => {
    if (isTransitioning.value) return Promise.resolve()
    return enqueueTransition(() => (
      isMonitoring.value ? stopMonitoring() : startMonitoring()
    ))
  }

  return {
    isMonitoring,
    isTransitioning,
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
