/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'

import { installBroadcastDiagnostics } from './diagnostics'

function harness() {
  const target = new EventTarget()
  const sent: string[] = []
  let connected = false
  let now = 0
  const logger = { warn: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => {} }
  const originalWarn = logger.warn
  const diagnostics = installBroadcastDiagnostics((code) => {
    if (!connected) return false
    sent.push(code)
    return true
  }, target as unknown as Window, logger, () => now)
  return { diagnostics, target, logger, sent, originalWarn, connect: () => {
    connected = true
    diagnostics.flush()
  }, advance: () => {
    now += 60000
  } }
}

it('forwards fixed failure categories only and throttles raw console messages while disconnected', () => {
  const h = harness()
  for (let index = 0; index < 1000; index++) {
    h.logger.warn(`private-path-${index}`, { token: 'secret', skin: 'private image' })
    h.logger.error('Failed to read the selected pet skin.', new Error('http://127.0.0.1/private-token'))
  }
  assert.deepEqual(h.sent, [])
  h.connect()
  assert.deepEqual(h.sent, ['renderer_warning', 'skin_read_failed'])
  h.logger.warn('another private message')
  h.diagnostics.flush()
  assert.equal(h.sent.length, 2)
  h.advance()
  h.logger.warn('The active pet WebGL context was lost.')
  assert.equal(h.sent.at(-1), 'context_lost')
  h.logger.warn('private message')
  assert.equal(h.sent.at(-1), 'renderer_warning')
  h.diagnostics.dispose()
  assert.equal(h.logger.warn, h.originalWarn)
})

it('keeps healthy setup, normal cancellation and disposal silent; reports unexpected browser exceptions', () => {
  const h = harness()
  h.connect()
  assert.deepEqual(h.sent, [])
  const rejection = (name: string) => {
    const event = new Event('unhandledrejection')
    Object.defineProperty(event, 'reason', { value: { name, message: 'private failure detail' } })
    h.target.dispatchEvent(event)
  }
  rejection('PetModelLoadCancelledError')
  rejection('AbortError')
  assert.deepEqual(h.sent, [])
  rejection('Error')
  h.target.dispatchEvent(new Event('error'))
  assert.deepEqual(h.sent, ['unhandled_rejection', 'script_error'])
  h.diagnostics.dispose()
  h.target.dispatchEvent(new Event('error'))
  h.diagnostics.report('renderer_error')
  assert.equal(h.sent.length, 2)
})

it('does not let failed diagnostic transport interrupt rendering and retries bounded codes', () => {
  let fail = true
  const sent: string[] = []
  const logger = { warn: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => {} }
  const diagnostics = installBroadcastDiagnostics((code) => {
    if (fail) throw new Error('socket closed during send')
    sent.push(code)
    return true
  }, new EventTarget() as unknown as Window, logger)
  assert.doesNotThrow(() => logger.error('private error'))
  fail = false
  diagnostics.flush()
  assert.deepEqual(sent, ['renderer_error'])
  diagnostics.dispose()
})
