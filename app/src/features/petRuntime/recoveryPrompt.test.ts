/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPetRuntimeRecoveryPrompt } from './recoveryPrompt'

function fixture() {
  const dialogs: Array<{ restart: () => Promise<void>, closed: boolean }> = []
  const windowErrors: unknown[] = []
  const restartErrors: unknown[] = []
  let shown = 0
  let restarted = 0
  let failShow = false
  let restartWork = () => Promise.resolve()
  const controller = createPetRuntimeRecoveryPrompt({
    open: (restart) => {
      const dialog = { restart, closed: false }
      dialogs.push(dialog)
      return { destroy: () => {
        dialog.closed = true
      } }
    },
    showWindow: async () => {
      shown++
      if (failShow) throw new Error('native show failed')
    },
    restart: () => {
      restarted++
      return restartWork()
    },
    reportWindowError: error => windowErrors.push(error),
    reportRestartError: error => restartErrors.push(error),
  })
  return {
    controller,
    dialogs,
    windowErrors,
    restartErrors,
    shown: () => shown,
    restarted: () => restarted,
    failShow: () => {
      failShow = true
    },
    restartWith: (operation: () => Promise<void>) => {
      restartWork = operation
    },
  }
}

describe('pet runtime restart prompt', () => {
  it('opens once per incident and never restarts before the user confirms', async () => {
    const h = fixture()
    for (const payload of [null, {}, { incident: 0 }, { incident: '1' }, { incident: 1.1 }, { incident: Infinity }]) {
      await h.controller.failed(payload)
    }
    assert.equal(h.dialogs.length, 0)
    await Promise.all([h.controller.failed({ incident: 1 }), h.controller.failed({ incident: 1 })])
    assert.equal(h.dialogs.length, 1)
    assert.equal(h.shown(), 1)
    assert.equal(h.restarted(), 0)
    await h.dialogs[0].restart()
    assert.equal(h.restarted(), 1)
    h.controller.dispose()
  })

  it('shares the save/restart request and keeps the modal usable if saving fails', async () => {
    const h = fixture()
    let reject!: (error: Error) => void
    h.restartWith(() => new Promise<void>((_resolve, fail) => {
      reject = fail
    }))
    await h.controller.failed({ incident: 2 })
    const first = h.dialogs[0].restart()
    assert.equal(h.dialogs[0].restart(), first)
    const rejected = assert.rejects(first, /save refused/)
    reject(new Error('save refused'))
    await rejected
    assert.equal(h.dialogs[0].closed, false)
    assert.equal(h.restartErrors.length, 1)
    h.restartWith(() => Promise.resolve())
    await h.dialogs[0].restart()
    assert.equal(h.restarted(), 2)
    h.controller.dispose()
  })

  it('dismisses recovered incidents and ignores delayed failure replay', async () => {
    const h = fixture()
    await h.controller.failed({ incident: 1 })
    h.controller.recovered({ incident: 1 })
    assert.equal(h.dialogs[0].closed, true)
    await h.controller.failed({ incident: 1 })
    assert.equal(h.dialogs.length, 1)
    h.controller.recovered({ incident: 2 })
    await h.controller.failed({ incident: 2 })
    assert.equal(h.dialogs.length, 1)
    await h.controller.failed({ incident: 3 })
    h.controller.recovered({ incident: 1 })
    assert.equal(h.dialogs[1].closed, false)
    await h.dialogs[0].restart()
    assert.equal(h.restarted(), 0)
    h.controller.dispose()
  })

  it('retains a prompt after native showing fails so opening Preferences can reveal it', async () => {
    const h = fixture()
    h.failShow()
    await h.controller.failed({ incident: 1 })
    assert.equal(h.windowErrors.length, 1)
    assert.equal(h.dialogs.length, 1)
    assert.equal(h.dialogs[0].closed, false)
    assert.equal(h.restarted(), 0)
    h.controller.dispose()
  })

  it('replaces older prompts and rejects stale actions after disposal', async () => {
    const h = fixture()
    await h.controller.failed({ incident: 1 })
    await h.controller.failed({ incident: 2 })
    assert.equal(h.dialogs[0].closed, true)
    await h.dialogs[0].restart()
    assert.equal(h.restarted(), 0)
    h.controller.dispose()
    assert.equal(h.dialogs[1].closed, true)
    await h.dialogs[1].restart()
    await h.controller.failed({ incident: 3 })
    assert.equal(h.restarted(), 0)
    assert.equal(h.dialogs.length, 2)
  })
})
