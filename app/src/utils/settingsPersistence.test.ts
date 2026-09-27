/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SettingsPersistenceSteps } from './settingsPersistence'

import { saveSynchronizedSettings } from './settingsPersistence'

function harness() {
  const calls: string[] = []
  let now = 0
  let backend = { model: { antialiasEnabled: false } }
  const steps: SettingsPersistenceSteps = {
    flushFrontend: async () => {
      calls.push('frontend')
    },
    snapshots: () => [{ id: 'cat', state: { model: { antialiasEnabled: false } } }],
    readBackend: async (id) => {
      calls.push(`read:${id}`)
      return backend
    },
    saveNow: async () => {
      calls.push('disk')
    },
    now: () => now,
    wait: async () => {
      calls.push('wait')
      now += 25
    },
    timeoutMs: 50,
  }
  return { calls, steps, setBackend: (state: typeof backend) => {
    backend = state
  } }
}

describe('settings persistence acknowledgement', () => {
  it('revalidates every owned field when incoming frontend state changes during a quiescence read', async () => {
    const h = harness()
    h.steps.followFrontendChanges = true
    let state = { model: { antialiasEnabled: true }, entries: ['old'] }
    h.steps.snapshots = () => [{ id: 'cat', state }, { id: 'general', state: { language: 'ko-KR' } }]
    let catReads = 0
    let generalReads = 0
    h.steps.readBackend = async (id) => {
      if (id === 'general') {
        generalReads++
        return { language: 'ko-KR' }
      }
      catReads++
      state = { model: { antialiasEnabled: false }, entries: ['new'] }
      return state
    }
    await saveSynchronizedSettings(h.steps)
    assert.equal(catReads, 2)
    assert.equal(generalReads, 2, 'a changed snapshot requires fresh readback of every owned store')
    assert.equal(h.calls.filter(call => call === 'disk').length, 1)
  })

  it('does not accept a read that matched the old snapshot after the real frontend changed', async () => {
    const h = harness()
    h.steps.followFrontendChanges = true
    let frontend = { opacity: 100 }
    h.steps.snapshots = () => [{ id: 'cat', state: frontend }]
    h.steps.readBackend = async () => {
      frontend = { opacity: 75 }
      return { opacity: 100 }
    }
    await assert.rejects(saveSynchronizedSettings(h.steps), /not acknowledged/)
    assert.equal(h.calls.includes('disk'), false)
  })

  it('waits for an actual queued incoming update instead of trusting newer backend data', async () => {
    const h = harness()
    h.steps.followFrontendChanges = true
    let frontend = { opacity: 100 }
    let incomingPending = false
    let reads = 0
    h.steps.snapshots = () => [{ id: 'cat', state: frontend }]
    h.steps.readBackend = async () => {
      reads++
      if (reads === 1) incomingPending = true
      return { opacity: 75 }
    }
    h.steps.flushFrontend = async () => {
      if (incomingPending) {
        incomingPending = false
        frontend = { opacity: 75 }
      }
    }
    await saveSynchronizedSettings(h.steps)
    assert.equal(reads, 2)
    assert.equal(h.calls.at(-1), 'disk')
  })

  it('preserves unsent user values and rejects missing incoming synchronization in quiescence', async () => {
    for (const [desired, backend] of [[75, 100], [100, 75]]) {
      const h = harness()
      h.steps.followFrontendChanges = true
      const frontend = { opacity: desired }
      h.steps.snapshots = () => [{ id: 'cat', state: frontend }]
      h.steps.readBackend = async () => ({ opacity: backend })
      await assert.rejects(saveSynchronizedSettings(h.steps), /not acknowledged/)
      assert.equal(frontend.opacity, desired)
      assert.equal(h.calls.includes('disk'), false)
    }
  })

  it('keeps the original deadline even when the frontend changes on every native read', async () => {
    const h = harness()
    h.steps.followFrontendChanges = true
    let revision = 0
    h.steps.snapshots = () => [{ id: 'cat', state: { revision } }]
    h.steps.readBackend = async () => ({ revision: ++revision })
    await assert.rejects(saveSynchronizedSettings(h.steps), /not acknowledged/)
    assert.equal(revision, 3)
    assert.equal(h.calls.filter(call => call === 'wait').length, 2)
    assert.equal(h.calls.includes('disk'), false)
  })

  it('retains the fixed snapshot contract for ordinary saves when live state changes mid-read', async () => {
    const h = harness()
    let frontend = { opacity: 100 }
    h.steps.snapshots = () => [{ id: 'cat', state: frontend }]
    let reads = 0
    h.steps.readBackend = async () => {
      reads++
      frontend = { opacity: 75 }
      return { opacity: 75 }
    }
    await assert.rejects(saveSynchronizedSettings(h.steps), /not acknowledged/)
    assert.equal(reads, 3)
    assert.equal(h.calls.includes('disk'), false)
  })
  it('waits for the actual backend value after the frontend watcher has run', async () => {
    const h = harness()
    h.setBackend({ model: { antialiasEnabled: true } })
    h.steps.wait = async () => {
      h.calls.push('wait')
      h.setBackend({ model: { antialiasEnabled: false } })
    }
    await saveSynchronizedSettings(h.steps)
    assert.deepEqual(h.calls, ['frontend', 'read:cat', 'wait', 'read:cat', 'disk'])
  })

  it('does not save on a lost synchronization or failed backend read', async () => {
    const h = harness()
    h.setBackend({ model: { antialiasEnabled: true } })
    await assert.rejects(saveSynchronizedSettings(h.steps), /not acknowledged/)
    assert.equal(h.calls.includes('disk'), false)
    h.steps.readBackend = async () => {
      throw new Error('native bridge unavailable')
    }
    await assert.rejects(saveSynchronizedSettings(h.steps), /native bridge unavailable/)
    assert.equal(h.calls.includes('disk'), false)
  })

  it('waits for disk completion and propagates save failure', async () => {
    const h = harness()
    h.steps.saveNow = async () => {
      throw new Error('disk unavailable')
    }
    await assert.rejects(saveSynchronizedSettings(h.steps), /disk unavailable/)
  })

  it('matches nested settings and ordered arrays using their persisted JSON shape', async () => {
    const h = harness()
    h.steps.snapshots = () => [{
      id: 'cat',
      state: { model: { antialiasEnabled: false, removed: undefined }, selection: ['b', 'a'] },
    }]
    let readCount = 0
    h.steps.readBackend = async () => {
      readCount += 1
      return {
        selection: readCount === 1 ? ['a', 'b'] : ['b', 'a'],
        model: { antialiasEnabled: false },
        oldBackendOnlyKey: true,
      }
    }
    await saveSynchronizedSettings(h.steps)
    assert.equal(readCount, 2)
    assert.equal(h.calls.at(-1), 'disk')
  })

  it('waits until a nested object or array reset has actually removed old values', async () => {
    const h = harness()
    h.steps.snapshots = () => [{ id: 'app', state: { windowState: {}, entries: [] } }]
    let readCount = 0
    h.steps.readBackend = async () => {
      readCount += 1
      return readCount === 1
        ? { windowState: { main: { width: 500 } }, entries: ['old'] }
        : { windowState: {}, entries: [] }
    }
    await saveSynchronizedSettings(h.steps)
    assert.equal(readCount, 2)
  })
})
