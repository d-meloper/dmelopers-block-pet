/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { restoreShortcutState, serializeSettingsState, serializeShortcutState } from './persistedNames'

describe('shortcut storage-name compatibility', () => {
  it('restores old keys without mutating partial, empty or null settings', () => {
    for (const value of ['Control+KeyB', '', null]) {
      const state = { visibleCat: value, retained: { zero: 0 } }
      const restored = restoreShortcutState(state)
      assert.deepEqual(restored, { visibleBlock: value, retained: { zero: 0 } })
      assert.deepEqual(state, { visibleCat: value, retained: { zero: 0 } })
      assert.deepEqual(serializeShortcutState(restored), state)
    }
    assert.deepEqual(restoreShortcutState({ mirrorMode: '' }), { mirrorMode: '' })
  })

  it('prefers explicit frontend keys and emits only the existing wire key', () => {
    const state = { visibleCat: 'F8', visibleBlock: '', alwaysOnTop: 'F9' }
    assert.deepEqual(restoreShortcutState(state), { visibleBlock: '', alwaysOnTop: 'F9' })
    assert.deepEqual(serializeShortcutState(state), { visibleCat: '', alwaysOnTop: 'F9' })
    assert.equal(state.visibleCat, 'F8')
    assert.deepEqual(serializeShortcutState({ visibleCat: null }), { visibleCat: null })
    assert.equal(serializeSettingsState('general', state), state)
  })
})
