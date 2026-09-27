import { invoke } from '@tauri-apps/api/core'

import type { DiagnosticLevel } from './diagnosticsCore'

import { consoleOperation, createDiagnostic, createDiagnosticReporter } from './diagnosticsCore'

let source = 'bootstrap'
const report = createDiagnosticReporter((level, message) => invoke('plugin:log|log', {
  level: level === 'error' ? 5 : 4,
  message: JSON.stringify(message),
  // Deliberately omit plugin-log's default raw stack URL/location and keyValues.
}))

export function reportDiagnostic(level: DiagnosticLevel, operation: string, error?: unknown): void {
  const diagnostic = createDiagnostic(level, operation, error, source, new Error('diagnostic callsite'))
  report(diagnostic.level, diagnostic.message)
}

let installed = false
export function installDiagnostics(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  source = /^#\/preference(?:[/?]|$)/.test(location.hash) ? 'preference' : 'main'
  const logger: Pick<Console, 'warn' | 'error'> = console
  for (const level of ['warn', 'error'] as const) {
    const original = logger[level].bind(console)
    logger[level] = (...args: unknown[]) => {
      original(...args)
      // The callsite identifies the operation without copying console strings/payloads.
      reportDiagnostic(level, consoleOperation(level, args[0]), args.find(value => value instanceof Error)
      ?? args.find(value => value && typeof value === 'object') ?? args[0])
    }
  }
  window.addEventListener('error', (event) => {
    reportDiagnostic('error', event.error ? 'application.uncaught' : 'application.resource', event.error ?? event.message)
  }, true)
  window.addEventListener('unhandledrejection', (event) => {
    reportDiagnostic('error', 'application.unhandled_rejection', event.reason)
  })
}
