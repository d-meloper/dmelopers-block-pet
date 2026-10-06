/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import type { AntialiasSettingRequest } from '@/config/performance'

import { ANTIALIAS_SETTING_CANCEL, ANTIALIAS_SETTING_REQUEST } from '@/config/performance'
import { beginPresetNativeEdit, presetNativeEditPending } from '@/features/presets/operations'

import { createAntialiasSettingOwner } from './antialiasSetting'

function harness() {
  let current = true
  let resets = 0
  let failures = 0
  let rejectedDelivery = false
  const diagnostics: unknown[] = []
  const leaseCounts: number[] = []
  const messages: Array<{ event: string, payload: AntialiasSettingRequest }> = []
  const owner = createAntialiasSettingOwner({
    current: () => current,
    restore: (actual) => {
      assert.equal(presetNativeEditPending.value, 1, 'rollback completes before the save owner becomes ready')
      current = actual
      resets++
      owner.request(actual)
    },
    beginNativeEdit: () => {
      const release = beginPresetNativeEdit()
      leaseCounts.push(presetNativeEditPending.value)
      return () => {
        release()
        leaseCounts.push(presetNativeEditPending.value)
      }
    },
    send: async (event, payload) => {
      messages.push({ event, payload })
      if (rejectedDelivery) throw new Error('Delivery reply failed.')
    },
    failed: () => {
      failures++
    },
    report: error => diagnostics.push(error),
    timeoutMs: 1000,
    sessionId: 'test',
  })
  return {
    owner,
    messages,
    diagnostics,
    leaseCounts,
    current: () => current,
    resets: () => resets,
    failures: () => failures,
    change: (value: boolean) => {
      current = value
      owner.request(value)
    },
    latest: () => messages.filter(message => message.event === ANTIALIAS_SETTING_REQUEST).at(-1)!.payload,
    rejectDelivery: () => {
      rejectedDelivery = true
    },
  }
}

describe('antialias setting native-edit lease', () => {
  it('holds startup and each changed setting until its matching acknowledgement', () => {
    const h = harness()
    try {
      h.owner.request(true)
      assert.equal(presetNativeEditPending.value, 1)
      h.owner.accept({ ...h.latest(), actual: true, success: true })
      assert.equal(presetNativeEditPending.value, 0)
      h.change(false)
      assert.equal(presetNativeEditPending.value, 1)
      h.owner.accept({ ...h.latest(), actual: false, success: true })
      assert.equal(presetNativeEditPending.value, 0)
      assert.equal(h.current(), false)
      assert.equal(h.resets(), 0)
      assert.equal(h.failures(), 0)
    } finally {
      h.owner.dispose()
    }
  })

  it('restores a failed setting and resets measurements before releasing the save lease', () => {
    const h = harness()
    try {
      h.change(false)
      const response = { ...h.latest(), actual: true, success: false }
      h.owner.accept(response)
      assert.equal(h.current(), true)
      assert.equal(h.resets(), 1)
      assert.equal(h.failures(), 1)
      assert.equal(presetNativeEditPending.value, 0)
      assert.equal(h.messages.filter(message => message.event === ANTIALIAS_SETTING_REQUEST).length, 1)
      h.owner.accept(response)
      assert.equal(h.resets(), 1)
      assert.equal(h.failures(), 1)
    } finally {
      h.owner.dispose()
    }
  })

  it('keeps one continuous lease for rapid toggles and reset while discarding old or contradictory replies', () => {
    const h = harness()
    try {
      h.change(false)
      const first = h.latest()
      h.change(true)
      const reset = h.latest()
      h.change(false)
      const latest = h.latest()
      assert.equal(new Set([first.requestId, reset.requestId, latest.requestId]).size, 3)
      assert.equal(presetNativeEditPending.value, 1)
      assert.ok(h.leaseCounts.every(count => count > 0))
      for (const response of [
        { ...first, actual: true, success: false },
        { ...reset, actual: true, success: true },
        { ...latest, actual: true, success: true },
        { ...latest, requested: true, actual: true, success: false },
        null,
      ]) h.owner.accept(response)
      assert.equal(h.current(), false)
      assert.equal(h.resets(), 0)
      assert.equal(presetNativeEditPending.value, 1)
      h.owner.accept({ ...latest, actual: false, success: true })
      assert.equal(presetNativeEditPending.value, 0)
      assert.equal(h.messages.filter(message => message.event === ANTIALIAS_SETTING_CANCEL).length, 2)
    } finally {
      h.owner.dispose()
    }
  })

  it('preserves the requested value on an uncertain timeout and ignores late completion', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness()
    try {
      h.change(false)
      const stale = h.latest()
      mock.timers.tick(1000)
      assert.equal(h.current(), false)
      assert.equal(presetNativeEditPending.value, 0)
      assert.equal(h.resets(), 0)
      assert.equal(h.failures(), 1)
      assert.equal(h.messages.at(-1)?.event, ANTIALIAS_SETTING_CANCEL)
      h.owner.accept({ ...stale, actual: false, success: true })
      assert.equal(h.current(), false)
      assert.equal(h.resets(), 0)
    } finally {
      h.owner.dispose()
      mock.timers.reset()
    }
  })

  it('retains the lease after an uncertain transport reply and releases all work on unmount', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness()
    try {
      h.rejectDelivery()
      h.change(false)
      const response = { ...h.latest(), actual: true, success: false }
      await Promise.resolve()
      assert.equal(h.diagnostics.length, 1)
      assert.equal(presetNativeEditPending.value, 1)
      h.owner.dispose()
      h.owner.dispose()
      assert.equal(presetNativeEditPending.value, 0)
      h.owner.accept(response)
      mock.timers.tick(5000)
      h.owner.request(true)
      assert.equal(presetNativeEditPending.value, 0)
      assert.equal(h.resets(), 0)
      assert.equal(h.failures(), 0)
    } finally {
      h.owner.dispose()
      mock.timers.reset()
    }
  })
})
