/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { PresetApplyRequest } from './types'

import { createDefaultPresetSnapshot } from './model'
import { createPresetRequestClient } from './request'
import { PRESET_APPLY_CANCEL } from './types'

describe('preset native acknowledgement', () => {
  it('rejects stale acknowledgements and only accepts a valid response to the current request', async () => {
    let id = ''
    const client = createPresetRequestClient(async (_event, payload) => {
      id = (payload as { requestId: string }).requestId
    })
    const snapshot = createDefaultPresetSnapshot()
    const pending = client.apply(snapshot)
    assert.equal(client.accept({ requestId: 'stale', success: true, revision: 5, snapshot }), false)
    assert.equal(client.accept({ requestId: id, success: true, revision: -1, snapshot }), false)
    assert.equal(client.accept({ requestId: id, success: true, revision: 5 }), false)
    assert.equal(client.accept({ requestId: id, success: true, revision: 5, snapshot }), true)
    assert.equal((await pending).revision, 5)
  })

  it('reports native failure and prevents concurrent requests', async () => {
    let id = ''
    const client = createPresetRequestClient(async (_event, payload) => {
      id = (payload as { requestId: string }).requestId
    })
    const pending = client.apply(createDefaultPresetSnapshot())
    await assert.rejects(client.apply(createDefaultPresetSnapshot()))
    client.accept({ requestId: id, success: false, revision: 4 })
    await assert.rejects(pending)
  })

  it('cancels timed-out work rather than letting it apply after the caller moved on', async () => {
    const events: string[] = []
    const client = createPresetRequestClient(async (event) => {
      events.push(event)
    }, 5)
    await assert.rejects(client.apply(createDefaultPresetSnapshot()), { name: 'PresetApplyUncertainError' })
    assert.equal(events[1], PRESET_APPLY_CANCEL)
  })

  it('carries rollback visibility only as transient request metadata', async () => {
    let request!: PresetApplyRequest
    const client = createPresetRequestClient(async (_event, payload) => {
      request = payload as PresetApplyRequest
    })
    const snapshot = createDefaultPresetSnapshot()
    const rollback = client.apply(snapshot, false)
    assert.equal(request.restoreVisibility, false)
    assert.equal('visible' in request.snapshot, false)
    client.accept({ requestId: request.requestId, success: true, revision: 5, snapshot })
    await rollback
    const normal = client.apply(snapshot)
    assert.equal('restoreVisibility' in request, false)
    client.accept({ requestId: request.requestId, success: true, revision: 6, snapshot })
    await normal
  })
})
