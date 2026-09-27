/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'

import { createBroadcastSynchronizer } from './synchronizer'

for (const initial of [false, true]) {
  it(`restores ${initial ? 'ON' : 'OFF'} after an opposite in-flight change`, async () => {
    const calls: boolean[] = []
    let native = initial
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const sync = createBroadcastSynchronizer({
      configure: async ({ enabled }) => {
        calls.push(enabled)
        if (enabled !== initial) await blocked
        native = enabled
        return { enabled, clients: 0 }
      },
      accept: () => {},
      failed: () => assert.fail('unexpected failure'),
      pending: () => {},
    })
    sync.update({ enabled: initial })
    await sync.idle()
    sync.update({ enabled: !initial })
    await Promise.resolve()
    sync.update({ enabled: initial })
    release()
    await sync.idle()
    assert.equal(native, initial)
    assert.deepEqual(calls, [initial, !initial, initial])
    sync.update({ enabled: initial })
    await sync.idle()
    assert.equal(calls.length, 3, 'unchanged confirmed state remains deduplicated')
  })
}
