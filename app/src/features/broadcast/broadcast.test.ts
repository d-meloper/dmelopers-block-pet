/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { applyPresetSnapshot, createDefaultPresetSnapshot } from '@/features/presets/model'
import { useBlockStore } from '@/stores/block'
import { useGeneralStore } from '@/stores/general'

import type { BroadcastConfiguration, BroadcastScene, BroadcastStatus } from './types'

import { captureBroadcastScene, fitBroadcastOutput } from './scene'
import { createBroadcastSession } from './session'
import { createBroadcastSynchronizer } from './synchronizer'
import { isDesktopPetVisible } from './visibility'

function fixture() {
  setActivePinia(createPinia())
  const block = useBlockStore()
  return { block, scene: captureBroadcastScene(block), general: useGeneralStore() }
}

describe('broadcast settings and projection', () => {
  it('delivers high shadows without adding them to presets', () => {
    const { block } = fixture()
    block.shadowQualitySelection = 'high'
    const scene = captureBroadcastScene(block)
    assert.equal(scene.performance.shadowQuality, 'high')
    assert.ok(!('shadowQuality' in scene.preset))
  })

  it('applies the independent desktop choice only during broadcast output', () => {
    const { block, general } = fixture()
    for (const enabled of [false, true]) {
      for (const showOnDesktop of [false, true]) {
        for (const visible of [false, true]) {
          Object.assign(general.broadcast, { enabled, showOnDesktop })
          block.window.visible = visible
          assert.equal(isDesktopPetVisible(block.window.visible, general.broadcast), visible && (!enabled || showOnDesktop))
          applyPresetSnapshot(block, createDefaultPresetSnapshot())
          assert.equal(general.broadcast.showOnDesktop, showOnDesktop)
          assert.equal(isDesktopPetVisible(block.window.visible, general.broadcast), !enabled || showOnDesktop)
        }
      }
    }
  })

  it('persists the independent desktop choice and uses the authored default for missing values', async () => {
    for (const saved of [undefined, false, true]) {
      const { general } = fixture()
      general.$patch({ appearance: { language: 'en-US' }, migrated: true, broadcast: { enabled: true } })
      if (saved !== undefined) general.broadcast.showOnDesktop = saved
      await general.init()
      assert.equal(general.broadcast.showOnDesktop, saved === true)
      const persisted = JSON.parse(JSON.stringify(general.$state))
      const restored = fixture().general
      restored.$patch(persisted)
      await restored.init()
      assert.equal(restored.broadcast.showOnDesktop, saved === true)
      restored.reset()
      assert.equal(restored.broadcast.enabled, false)
      assert.equal(restored.broadcast.showOnDesktop, false)
    }
  })

  it('keeps the four desktop/broadcast combinations independent of taskbar and presets', () => {
    const { block, general } = fixture()
    assert.equal(general.broadcast.enabled, false)
    for (const enabled of [false, true]) {
      general.broadcast.enabled = enabled
      for (const visible of [false, true]) {
        applyPresetSnapshot(block, createDefaultPresetSnapshot())
        assert.equal(block.window.visible, true)
        block.window.visible = visible
        general.app.taskbarVisible = !visible
        assert.equal(block.window.visible, visible)
        assert.equal(general.broadcast.enabled, enabled)
        assert.equal(captureBroadcastScene(block).opacity, 100)
      }
    }
  })
  it('restores new settings additively and resets broadcast without touching pet visibility', async () => {
    const { general, block } = fixture()
    general.$patch({ appearance: { language: 'en-US' }, migrated: true, broadcast: { enabled: true } })
    await general.init()
    assert.equal(general.broadcast.enabled, true)
    block.window.visible = false
    general.reset()
    assert.equal(general.broadcast.enabled, false)
    assert.equal(block.window.visible, false)
  })
  it('projects visuals without library identities, desktop visibility or editing overlays', () => {
    const { block } = fixture()
    block.customization3d.minecraftSkinUsername = 'PrivateName'
    block.customization3d.activeSkinLibraryEntryId = 'private-entry'
    block.customization3d.preset.showDisplayArea = true
    Object.assign(block.customization3d.preset, { deskTransparent: false, deskHeightOffset: 0.75, deskWidthOffset: 0.6, deskDepthOffset: -0.8, deskColor: '#123456' })
    block.model.mirror = true
    block.window.opacity = 37
    const before = captureBroadcastScene(block)
    block.window.visible = false
    block.window.hideOnHover = true
    block.window.passThrough = true
    Object.assign(block.customization3d.preset, { legacyPrivatePath: 'private-path' })
    Object.assign(block.customization3d.preset.dmeloperEyebrows, { legacyPrivateName: 'private-name' })
    Object.assign(block.customization3d.preset.lighting.key, { legacyPrivateName: 'private-light-name' })
    assert.deepEqual(captureBroadcastScene(block), before)
    assert.equal(Object.keys(before.preset).length, 39)
    assert.equal('pixelFilterEnabled' in before.preset, false)
    assert.equal('antialiasEnabled' in before.preset, false)
    assert.equal(before.preset.showDisplayArea, false)
    assert.equal(before.mirror, true)
    assert.equal(before.opacity, 37)
    assert.equal(before.preset.deskTransparent, false)
    assert.equal(before.preset.deskHeightOffset, 0.75)
    assert.equal(before.preset.deskWidthOffset, 0.6)
    assert.equal(before.preset.deskDepthOffset, -0.8)
    assert.equal(before.preset.deskColor, '#123456')
    assert.ok(!JSON.stringify(before).includes('PrivateName'))
    assert.ok(!JSON.stringify(before).includes('private-entry'))
    block.customization3d.preset.mouseEnabled = false
    assert.equal(before.preset.mouseEnabled, true)
  })
  it('fits portrait and landscape outputs without stretching or overflow', () => {
    assert.deepEqual(fitBroadcastOutput({ width: 500, height: 250 }, { width: 800, height: 600 }), { width: 800, height: 400 })
    assert.deepEqual(fitBroadcastOutput({ width: 300, height: 600 }, { width: 800, height: 600 }), { width: 300, height: 600 })
  })

  it('publishes both independent performance choices outside presets', () => {
    const { block } = fixture()
    for (const antialias of [false, true]) {
      for (const filter of [false, true]) {
        block.model.antialiasEnabled = antialias
        block.model.pixelFilterEnabled = filter
        const scene = captureBroadcastScene(block)
        assert.equal(scene.performance.antialiasEnabled, antialias)
        assert.equal(scene.performance.pixelFilterEnabled, filter)
      }
    }
  })
})

describe('broadcast native synchronization', () => {
  it('serializes ON/OFF while discarding an obsolete ON acknowledgement', async () => {
    const calls: BroadcastConfiguration[] = []
    const accepted: BroadcastStatus[] = []
    let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const sync = createBroadcastSynchronizer({
      configure: async (configuration) => {
        calls.push(configuration)
        if (configuration.enabled) await wait
        return { enabled: configuration.enabled, clients: 0 }
      },
      accept: value => accepted.push(value),
      failed: () => assert.fail('unexpected error'),
      pending: () => {},
    })
    sync.update({ enabled: true, scene: fixture().scene })
    await Promise.resolve()
    sync.update({ enabled: false })
    release!()
    await sync.idle()
    assert.deepEqual(calls.map(value => value.enabled), [true, false])
    assert.deepEqual(accepted.map(value => value.enabled), [false])
  })
  it('coalesces rapid edits and does not publish an invalidated preset transaction', async () => {
    const calls: BroadcastConfiguration[] = []
    const sync = createBroadcastSynchronizer({
      configure: async (configuration) => {
        calls.push(configuration)
        return { enabled: true, clients: 0 }
      },
      accept: () => {},
      failed: () => {},
      pending: () => {},
    })
    sync.update({ enabled: true, scene: fixture().scene })
    sync.invalidate()
    await sync.idle()
    assert.equal(calls.length, 0)
    sync.update({ enabled: true, scene: fixture().scene })
    sync.update({ enabled: false })
    await sync.idle()
    assert.deepEqual(calls, [{ enabled: false }])
  })
})

describe('browser scene sessions', () => {
  it('ignores stale scene completion, retains earlier output on failure, and clears disconnected input', async () => {
    const { scene } = fixture()
    const accepted: number[] = []
    let release: (() => void) | undefined
    let clears = 0
    let resets = 0
    let inputs = 0
    const session = createBroadcastSession({
      apply: async (value) => {
        if (value.opacity === 10) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        if (value.opacity === 20) throw new Error('Invalid PNG')
      },
      ready: value => accepted.push(value),
      input: () => {
        inputs++
      },
      clear: () => {
        clears++
      },
      reset: () => {
        resets++
      },
    })
    const send = (revision: number, opacity: number) => session.receive({ type: 'scene', revision, scene: { ...scene, opacity } })
    send(1, 10)
    await Promise.resolve()
    send(2, 100)
    release!()
    await session.idle()
    assert.deepEqual(accepted, [2])
    send(3, 20)
    await session.idle()
    session.receive({ type: 'input', event: { kind: 'mouse_primary', active: true } })
    assert.equal(inputs, 1)
    assert.deepEqual(accepted, [2])
    send(4, 10)
    await Promise.resolve()
    session.disconnect()
    release!()
    await session.idle()
    session.receive({ type: 'input', event: { kind: 'mouse_primary', active: false } })
    assert.equal(inputs, 1)
    assert.equal(clears, 1)
    assert.equal(resets, 1)
    assert.deepEqual(accepted, [2])
    send(1, 100)
    await session.idle()
    assert.deepEqual(accepted, [2, 1])
  })
  it('isolates simultaneous browser clients and rejects unsupported scene versions', async () => {
    const { scene } = fixture()
    const ready: number[] = []
    const make = () => createBroadcastSession({
      apply: async (_: BroadcastScene) => {},
      input: () => {},
      reset: () => {},
      clear: () => {},
      ready: value => ready.push(value),
    })
    const first = make()
    const second = make()
    first.receive({ type: 'scene', revision: 1, scene: { ...scene, schemaVersion: 2 } })
    second.receive({ type: 'scene', revision: 1, scene })
    first.disconnect()
    await second.idle()
    assert.deepEqual(ready, [1])
  })
})

it('projects eyebrow depth into OBS without sharing mutable preset data', () => {
  const { block } = fixture()
  assert.equal(captureBroadcastScene(block).preset.dmeloperEyebrows.depthPercent, 50)
  for (const depthPercent of [0, 100, 200]) {
    block.updateDmeloperEyebrows({ depthPercent })
    const captured = captureBroadcastScene(block)
    assert.equal(captured.preset.dmeloperEyebrows.depthPercent, depthPercent)
    block.updateDmeloperEyebrows({ depthPercent: 75 })
    assert.equal(captured.preset.dmeloperEyebrows.depthPercent, depthPercent)
  }
})
