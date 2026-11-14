/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextTick, ref } from 'vue'

import { createPreferenceElevation } from './preferenceElevation'
import { createPreferencePromptPriority } from './preferencePrompts'

async function harness() {
  const elevation = createPreferenceElevation({
    status: async () => ({ supported: true, elevated: false }),
    prepare: async () => ({ outcome: 'cancelled' }),
    cancel: async () => {},
    restart: async () => {},
    report: () => {},
  })
  const state = {
    broadcastOpen: ref(false),
    broadcastActive: ref(false),
    updateVersion: ref<string>(),
    updateBusy: ref(false),
    updateHandoff: ref(false),
  }
  const prompts = createPreferencePromptPriority({ ...state, adminOpen: elevation.open, blockAdmin: elevation.setBlocked })
  const dispose = () => {
    prompts.dispose()
    elevation.dispose()
  }
  return { state, prompts, elevation, dispose }
}

test('update discovery and its reminder finish before the administrator offer', async () => {
  const h = await harness()
  h.state.updateBusy.value = true
  await h.elevation.setVisible(true)
  assert.equal(h.elevation.open.value, false)
  h.state.updateVersion.value = '1.2.3'
  h.state.updateBusy.value = false
  await nextTick()
  assert.equal(h.prompts.updateVersion.value, '1.2.3')
  assert.equal(h.elevation.open.value, false)
  h.state.updateVersion.value = undefined
  assert.equal(h.elevation.open.value, false)
  h.prompts.finishUpdate()
  assert.equal(h.elevation.open.value, true)
  h.dispose()
})

test('broadcast priority waits for an outgoing update modal, then for its own closing animation', async () => {
  const h = await harness()
  h.state.updateVersion.value = '1.2.3'
  await h.elevation.setVisible(true)
  h.state.broadcastActive.value = true
  h.state.broadcastOpen.value = true
  assert.equal(h.prompts.updateVersion.value, undefined)
  assert.equal(h.prompts.broadcastOpen.value, false)
  assert.equal(h.elevation.open.value, false)
  h.prompts.finishUpdate()
  assert.equal(h.prompts.broadcastOpen.value, true)
  h.state.broadcastOpen.value = false
  assert.equal(h.elevation.open.value, false)
  h.state.broadcastActive.value = false
  assert.equal(h.prompts.updateVersion.value, '1.2.3')
  assert.equal(h.elevation.open.value, false)
  h.state.updateVersion.value = undefined
  h.prompts.finishUpdate()
  assert.equal(h.elevation.open.value, true)
  h.dispose()
})

for (const higher of ['broadcast', 'update'] as const) {
  test(`${higher} waits for an outgoing administrator modal before opening`, async () => {
    const h = await harness()
    await h.elevation.setVisible(true)
    assert.equal(h.elevation.open.value, true)
    if (higher === 'broadcast') {
      h.state.broadcastActive.value = true
      h.state.broadcastOpen.value = true
      assert.equal(h.prompts.broadcastOpen.value, false)
    } else {
      h.state.updateVersion.value = '1.2.3'
      assert.equal(h.prompts.updateVersion.value, undefined)
    }
    assert.equal(h.elevation.open.value, false)
    h.prompts.finishAdmin()
    if (higher === 'broadcast') assert.equal(h.prompts.broadcastOpen.value, true)
    else assert.equal(h.prompts.updateVersion.value, '1.2.3')
    assert.equal(h.elevation.open.value, false)
    h.dispose()
  })
}

test('a successful update handoff does not offer another restart', async () => {
  const h = await harness()
  h.state.updateHandoff.value = true
  await h.elevation.setVisible(true)
  assert.equal(h.elevation.open.value, false)
  h.dispose()
})

test('an offer superseded before its first render cannot leave an animation gate behind', async () => {
  const h = await harness()
  h.state.updateVersion.value = '1.2.3'
  h.state.broadcastActive.value = true
  h.state.broadcastOpen.value = true
  await nextTick()
  assert.equal(h.prompts.broadcastOpen.value, true)
  assert.equal(h.prompts.updateVersion.value, undefined)
  h.state.broadcastOpen.value = false
  h.state.updateVersion.value = undefined
  h.state.broadcastActive.value = false
  await h.elevation.setVisible(true)
  assert.equal(h.elevation.open.value, true)
  h.dispose()
})
