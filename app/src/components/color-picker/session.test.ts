/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createScreenColorSession } from './session'

function harness() {
  let resolve!: (color: unknown) => void
  let reject!: (error: Error) => void
  let enabled = true
  let calls = 0
  let failures = 0
  const colors: string[] = []
  const cancellations: string[] = []
  const session = createScreenColorSession({
    pick: () => {
      calls++
      return new Promise((yes, no) => {
        resolve = yes
        reject = no
      })
    },
    cancel: async (id) => {
      cancellations.push(id)
    },
    canApply: () => enabled,
    selected: color => colors.push(color),
    failed: () => failures++,
  })
  return { session, colors, cancellations, resolve: (value: unknown) => resolve(value), reject: () => reject(new Error('native failure')), disable: () => {
    enabled = false
  }, calls: () => calls, failures: () => failures }
}

describe('color picker screen selection lifetime', () => {
  it('applies one validated color and ignores duplicate clicks while waiting', async () => {
    const h = harness()
    const pending = h.session.start('first')
    await h.session.start('duplicate')
    assert.equal(h.calls(), 1)
    h.resolve('#a1b2c3')
    await pending
    assert.deepEqual(h.colors, ['#A1B2C3'])
  })

  it('keeps the previous color on Escape and allows another selection', async () => {
    const h = harness()
    const pending = h.session.start('cancelled')
    h.resolve(null)
    await pending
    assert.deepEqual(h.colors, [])
    assert.equal(h.failures(), 0)
    const next = h.session.start('next')
    h.resolve('#112233')
    await next
    assert.deepEqual(h.colors, ['#112233'])
  })

  it('cancels on preset change/unmount and discards a late successful completion', async () => {
    const h = harness()
    const pending = h.session.start('old-preset')
    h.session.cancel()
    h.session.cancel()
    h.resolve('#112233')
    await pending
    assert.deepEqual(h.cancellations, ['old-preset'])
    assert.deepEqual(h.colors, [])
    assert.equal(h.failures(), 0)
  })

  it('never starts a disabled control or applies a result after it becomes disabled', async () => {
    const h = harness()
    const pending = h.session.start('mouse-on')
    h.disable()
    h.resolve('#112233')
    await pending
    await h.session.start('mouse-off')
    assert.equal(h.calls(), 1)
    assert.deepEqual(h.colors, [])
  })

  it('reports native failure and invalid output without changing color', async () => {
    for (const invalid of [undefined, '#fff', '#11223344', { color: '#112233' }]) {
      const h = harness()
      const pending = h.session.start('invalid')
      h.resolve(invalid)
      await pending
      assert.equal(h.failures(), 1)
      assert.deepEqual(h.colors, [])
    }
    const h = harness()
    const pending = h.session.start('failed')
    h.reject()
    await pending
    assert.equal(h.failures(), 1)
    assert.deepEqual(h.colors, [])
  })
})
