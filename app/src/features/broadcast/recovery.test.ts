/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'

import type { RecoveryReport } from '@/features/recovery/types'

import type { BroadcastStatus } from './types'

import { broadcastFailureCode, broadcastRecoveryGuidance, hasConfirmedBroadcastScene, runBroadcastRecovery } from './recovery'
import { isBroadcastStatus } from './types'

function harness(overrides: Partial<Parameters<typeof runBroadcastRecovery>[0]> = {}) {
  const reports: RecoveryReport[] = []
  const calls: string[] = []
  const abort = new AbortController()
  const healthy: BroadcastStatus = { enabled: true, clients: 1, sceneRevision: 1, confirmedClients: 1 }
  const options: Parameters<typeof runBroadcastRecovery>[0] = {
    enabled: true,
    ready: true,
    signal: abort.signal,
    subscribe: async () => {
      calls.push('subscribe')
      return true
    },
    apply: async () => {
      calls.push('apply')
      return undefined
    },
    read: async () => {
      calls.push('read')
      return healthy
    },
    rendered: () => ({ result: Promise.resolve(healthy), dispose: () => {} }),
    report: value => reports.push(value),
    ...overrides,
  }
  return { reports, calls, abort, options, run: () => runBroadcastRecovery(options) }
}

it('verifies actual status after subscription and configuration, then reports readiness', async () => {
  const h = harness()
  const report = await h.run()
  assert.deepEqual(h.calls, ['subscribe', 'apply', 'read'])
  assert.equal(report.status, 'recovered')
  assert.equal(report.summaryKey, 'recovery.broadcast.connected')
  assert.equal(report.steps.every(step => step.state === 'passed'), true)
})

it('a rejected current scene cannot be repaired by readback of the old working scene', async () => {
  const h = harness({ apply: async () => 'scene_invalid' })
  const report = await h.run()
  assert.equal(report.status, 'unresolved')
  assert.equal(report.cause, 'scene_invalid')
  assert.equal(report.steps.find(step => step.key.endsWith('configure'))?.state, 'failed')
  assert.ok(report.guidanceKeys?.includes('recovery.broadcast.guidance.scene'))
})

it('still attempts native recovery when notifications fail, but does not claim complete recovery', async () => {
  const h = harness({ subscribe: async () => false })
  const report = await h.run()
  assert.deepEqual(h.calls, ['apply', 'read'])
  assert.equal(report.status, 'unresolved')
  assert.ok(report.guidanceKeys?.includes('recovery.broadcast.guidance.bridge'))
})

it('a started server without a ready source reports waiting rather than repaired OBS appearance', async () => {
  const report = await harness({ read: async () => ({ enabled: true, clients: 0 }) }).run()
  assert.equal(report.summaryKey, 'recovery.broadcast.waiting')
  assert.equal(report.cause, 'waiting')
  assert.ok(report.guidanceKeys?.includes('recovery.broadcast.guidance.refresh'))
})

it('reports incomplete durable address backup separately from a working connection', async () => {
  const report = await harness({ read: async () => ({ enabled: true, clients: 1, warning: 'endpoint_backup_unavailable' }) }).run()
  assert.equal(report.status, 'unresolved')
  assert.equal(report.summaryKey, 'recovery.broadcast.backupWarning')
  assert.ok(report.guidanceKeys?.includes('recovery.guidance.storage'))
})

it('refuses success from an opposite enabled state or malformed readback', async () => {
  for (const observed of [{ enabled: false, clients: 0 }, { enabled: true, clients: -1 }]) {
    const report = await harness({ read: async () => observed }).run()
    assert.equal(report.status, 'unknown')
  }
})

it('waits for renderer readiness and always disposes the observation on timeout', async () => {
  let disposed = 0
  const report = await harness({
    timeoutMs: 1,
    read: async () => ({ enabled: true, clients: 1, error: 'render_failed' }),
    rendered: () => ({ result: new Promise(() => {}), dispose: () => {
      disposed++
    } }),
  }).run()
  assert.equal(report.status, 'unresolved')
  assert.equal(report.cause, 'render_failed')
  assert.equal(disposed, 1)
  assert.ok(report.guidanceKeys?.includes('recovery.broadcast.guidance.acceleration'))
})

it('accepts a verified renderer recovery after a failed render, then releases its watcher', async () => {
  let disposed = 0
  const report = await harness({
    read: async () => ({ enabled: true, clients: 1, error: 'render_failed' }),
    rendered: () => ({ result: Promise.resolve({ enabled: true, clients: 1, sceneRevision: 1, confirmedClients: 1 }), dispose: () => {
      disposed++
    } }),
  }).run()
  assert.equal(report.status, 'recovered')
  assert.equal(disposed, 1)
})

it('stops after a changed intent without issuing the next readback', async () => {
  const h = harness()
  h.options.apply = async () => {
    h.abort.abort()
    return undefined
  }
  const report = await h.run()
  assert.equal(report.status, 'cancelled')
  assert.equal(h.calls.includes('read'), false)
})

it('an unresponsive operation produces an uncertain outcome and cannot change it later', async () => {
  let complete!: (value: string | undefined) => void
  const h = harness({ timeoutMs: 1, apply: () => new Promise((resolve) => {
    complete = resolve
  }) })
  const report = await h.run()
  assert.equal(report.status, 'unknown')
  complete(undefined)
  await Promise.resolve()
  assert.equal(h.reports.at(-1)?.status, 'unknown')
  assert.equal(h.calls.includes('read'), false)
})

it('does not start scene recovery while a preset transaction is not ready', async () => {
  const h = harness({ ready: false })
  assert.equal((await h.run()).cause, 'not_ready')
  assert.deepEqual(h.calls, [])
})

it('keeps cause guidance specific and never extracts codes from a raw path or message', () => {
  assert.equal(broadcastFailureCode('scene_invalid'), 'scene_invalid')
  assert.equal(broadcastFailureCode(new Error('skin_invalid')), 'skin_invalid')
  assert.equal(broadcastFailureCode('C:/private/scene_invalid/file.png'), 'unavailable')
  assert.equal(broadcastFailureCode(new Error('Error: scene_invalid at private/path')), 'unavailable')
  assert.ok(broadcastRecoveryGuidance('port_in_use').includes('recovery.broadcast.guidance.port'))
  assert.ok(broadcastRecoveryGuidance('endpoint_conflict').includes('recovery.broadcast.guidance.noReset'))
  assert.equal(broadcastRecoveryGuidance('unavailable').at(-1), 'recovery.guidance.lastResort')
  assert.ok(!broadcastRecoveryGuidance('port_in_use').includes('recovery.guidance.lastResort'))
})

it('cannot verify a current scene from legacy readiness or an old revision acknowledgement', async () => {
  const old = { enabled: true, clients: 1, sceneRevision: 2, confirmedClients: 1 }
  assert.equal(hasConfirmedBroadcastScene(old, 3), false)
  assert.equal(hasConfirmedBroadcastScene(old, 2), true)
  assert.equal(isBroadcastStatus({ ...old, confirmedClients: 2 }), false)
  assert.equal(isBroadcastStatus({ enabled: true, clients: 1, confirmedClients: 1 }), false)
  const report = await harness({ read: async () => ({ enabled: true, clients: 1 }) }).run()
  assert.equal(report.status, 'unknown')
  assert.equal(report.summaryKey, 'recovery.broadcast.renderUnconfirmed')
})

it('reports a current scene that never acknowledges readiness as uncertain, with refresh guidance', async () => {
  let disposed = false
  const report = await harness({
    timeoutMs: 1,
    read: async () => ({ enabled: true, clients: 1, sceneRevision: 2, confirmedClients: 0 }),
    rendered: () => ({ result: new Promise(() => {}), dispose: () => {
      disposed = true
    } }),
  }).run()
  assert.equal(report.status, 'unknown')
  assert.equal(report.cause, 'render_pending')
  assert.equal(disposed, true)
})

it('rejects a completed renderer observation for a different scene revision', async () => {
  const report = await harness({
    read: async () => ({ enabled: true, clients: 1, sceneRevision: 2, confirmedClients: 0 }),
    rendered: () => ({ result: Promise.resolve({ enabled: true, clients: 1, sceneRevision: 1, confirmedClients: 1 }), dispose: () => {} }),
  }).run()
  assert.equal(report.status, 'unknown')
  assert.equal(report.steps.at(-1)?.state, 'failed')
})
