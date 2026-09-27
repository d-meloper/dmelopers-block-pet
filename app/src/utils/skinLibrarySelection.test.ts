/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createSkinLibrarySelectionState,
  getSkinLibraryAutoApplyEntryId,
  getSkinLibrarySelectionControls,
  reconcileSkinLibrarySelection,
  selectSkinLibraryCard,
  toggleAllSkinLibraryEntries,
  toggleSkinLibraryCheckbox,
} from './skinLibrarySelection'

describe('skin library selection state', () => {
  it('uses exclusive card selection outside multi-select mode', () => {
    let state = createSkinLibrarySelectionState('active')
    state = selectSkinLibraryCard(state, 'next')
    assert.deepEqual(state, { multiSelect: false, selectedIds: ['next'] })
    assert.deepEqual(getSkinLibrarySelectionControls(state), {
      selectedCount: 1,
      canApply: true,
      canDelete: true,
      showMultiSelection: false,
    })
  })

  it('keeps the prior single card when a different checkbox enters multi-select', () => {
    let state = createSkinLibrarySelectionState('active')
    state = toggleSkinLibraryCheckbox(state, 'checked')
    assert.deepEqual(state, {
      multiSelect: true,
      selectedIds: ['active', 'checked'],
    })
    assert.deepEqual(getSkinLibrarySelectionControls(state), {
      selectedCount: 2,
      canApply: false,
      canDelete: true,
      showMultiSelection: true,
    })

    state = selectSkinLibraryCard(state, 'third')
    assert.deepEqual(state.selectedIds, ['active', 'checked', 'third'])
    state = selectSkinLibraryCard(state, 'checked')
    assert.deepEqual(state.selectedIds, ['active', 'third'])
  })

  it('selects all, clears all, and exits multi-select when selection is empty', () => {
    let state = toggleAllSkinLibraryEntries(
      createSkinLibrarySelectionState('one'),
      ['one', 'two', 'three'],
    )
    assert.deepEqual(state, {
      multiSelect: true,
      selectedIds: ['one', 'two', 'three'],
    })
    state = toggleAllSkinLibraryEntries(state, ['one', 'two', 'three'])
    assert.deepEqual(state, { multiSelect: false, selectedIds: [] })

    state = toggleSkinLibraryCheckbox(
      createSkinLibrarySelectionState('one'),
      'one',
    )
    state = toggleSkinLibraryCheckbox(state, 'one')
    assert.deepEqual(state, { multiSelect: false, selectedIds: [] })
  })

  it('preserves valid selection order and drops stale entries when selecting all', () => {
    const state = toggleAllSkinLibraryEntries({
      multiSelect: true,
      selectedIds: ['three', 'removed', 'one'],
    }, ['one', 'two', 'three', 'four'])
    assert.deepEqual(state, {
      multiSelect: true,
      selectedIds: ['three', 'one', 'two', 'four'],
    })
  })

  it('drops removed cards while preserving the surviving mode', () => {
    const state = reconcileSkinLibrarySelection({
      multiSelect: true,
      selectedIds: ['removed', 'kept'],
    }, ['kept', 'other'])
    assert.deepEqual(state, { multiSelect: true, selectedIds: ['kept'] })
    assert.deepEqual(
      reconcileSkinLibrarySelection(state, ['other']),
      { multiSelect: false, selectedIds: [] },
    )
  })
})

describe('skin library auto-apply target', () => {
  it('returns the selected card for new, changed, and repeated single selections', () => {
    const empty = createSkinLibrarySelectionState()
    const selected = selectSkinLibraryCard(empty, 'one')
    assert.equal(getSkinLibraryAutoApplyEntryId(empty, selected), 'one')

    const changed = selectSkinLibraryCard(selected, 'two')
    assert.equal(getSkinLibraryAutoApplyEntryId(selected, changed), 'two')

    const repeated = selectSkinLibraryCard(changed, 'two')
    assert.equal(getSkinLibraryAutoApplyEntryId(changed, repeated), 'two')
  })

  it('returns the first target when an empty selection starts from a checkbox or select-all', () => {
    const empty = createSkinLibrarySelectionState()
    const checked = toggleSkinLibraryCheckbox(empty, 'checked')
    assert.equal(getSkinLibraryAutoApplyEntryId(empty, checked), 'checked')

    const selectedAll = toggleAllSkinLibraryEntries(empty, ['first', 'second'])
    assert.equal(getSkinLibraryAutoApplyEntryId(empty, selectedAll), 'first')
  })

  it('does not change the target when an existing single selection enters multi-select', () => {
    const selected = createSkinLibrarySelectionState('active')
    const multi = toggleSkinLibraryCheckbox(selected, 'checked')
    assert.equal(getSkinLibraryAutoApplyEntryId(selected, multi), undefined)
  })

  it('does not change the target while a multi-selection is edited', () => {
    const initial = {
      multiSelect: true,
      selectedIds: ['first', 'second'],
    }
    const added = selectSkinLibraryCard(initial, 'third')
    assert.equal(getSkinLibraryAutoApplyEntryId(initial, added), undefined)

    const firstRemoved = selectSkinLibraryCard(added, 'first')
    assert.equal(getSkinLibraryAutoApplyEntryId(added, firstRemoved), undefined)

    const oneRemaining = selectSkinLibraryCard(firstRemoved, 'second')
    assert.deepEqual(oneRemaining, {
      multiSelect: true,
      selectedIds: ['third'],
    })
    assert.equal(
      getSkinLibraryAutoApplyEntryId(firstRemoved, oneRemaining),
      undefined,
    )
  })

  it('returns a new target after all entries are cleared', () => {
    const multi = {
      multiSelect: true,
      selectedIds: ['first'],
    }
    const cleared = selectSkinLibraryCard(multi, 'first')
    assert.deepEqual(cleared, createSkinLibrarySelectionState())
    assert.equal(getSkinLibraryAutoApplyEntryId(multi, cleared), undefined)

    const restarted = toggleSkinLibraryCheckbox(cleared, 'second')
    assert.equal(getSkinLibraryAutoApplyEntryId(cleared, restarted), 'second')
  })
})
