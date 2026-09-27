/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { ref, watch } from 'vue'

import type { SceneViewportState } from '@/features/scene/types'

import * as constants from '@/constants'
import * as presetEditIntent from '@/features/presets/editIntent'
import * as presetOperations from '@/features/presets/operations'
import * as sceneTypes from '@/features/scene/types'

import type { useSceneViewport } from './useSceneViewport'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

function state(automatic = true): SceneViewportState {
  return {
    automatic,
    revision: 0,
    rect: { x: -20, y: -40, width: 620, height: 510 },
    monitorSize: { width: 1920, height: 1080 },
  }
}

function viewportHarness(emitRequest?: Parameters<typeof useSceneViewport>[0]) {
  const listeners = new Map<string, (event: { payload: unknown }) => void>()
  const mounted: Array<() => void> = []
  const unmounted: Array<() => void> = []
  const timers = new Map<number, () => void>()
  const events: Array<{ target: string, name: string, payload: { requestId: string, automatic?: boolean } }> = []
  const store = {
    activePet3dPreset: {
      autoViewportEnabled: true,
      viewportModeRevision: 0,
      manualViewportRect: { x: 0, y: 0, width: 500, height: 422 },
      cameraHorizontalOffset: 0.4,
      cameraVerticalOffset: -0.6,
    },
  }
  let nextId = 0
  let nextTimer = 0
  let focus: ((event: { payload: boolean }) => void) | undefined
  let delayedEmission: ReturnType<typeof deferred> | undefined
  let registrationDelay: ReturnType<typeof deferred> | undefined
  const source = readFileSync(new URL('./useSceneViewport.ts', import.meta.url), 'utf8')
  const context = {
    exports: {} as { useSceneViewport: typeof useSceneViewport },
    crypto: { randomUUID: () => `viewport-${++nextId}` },
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback)
      return nextTimer
    },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => {
      if (name === 'vue') return { ref, watch, onMounted: (fn: () => void) => mounted.push(fn), onBeforeUnmount: (fn: () => void) => unmounted.push(fn) }
      if (name === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
      if (name === '@/constants') return constants
      if (name === '@/features/scene/types') return sceneTypes
      if (name === '@/features/presets/editIntent') return presetEditIntent
      if (name === '@/features/presets/operations') return presetOperations
      if (name === '@/stores/cat') return { useCatStore: () => store }
      if (name === '@tauri-apps/api/event') {
        return {
          emitTo: async (target: string, event: string, payload: typeof events[number]['payload']) => {
            events.push({ target, name: event, payload })
            const delay = delayedEmission
            delayedEmission = undefined
            if (delay) await delay.promise
          },
          listen: async (event: string, callback: (event: { payload: unknown }) => void) => {
            listeners.set(event, callback)
            if (registrationDelay) await registrationDelay.promise
            return () => listeners.delete(event)
          },
        }
      }
      if (name === '@tauri-apps/api/webviewWindow') {
        return {
          getCurrentWebviewWindow: () => ({
            onFocusChanged: async (callback: typeof focus) => {
              focus = callback
              if (registrationDelay) await registrationDelay.promise
              return () => {
                focus = undefined
              }
            },
          }),
        }
      }
      throw new Error(`Unexpected import: ${name}`)
    },
  }
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  const api = context.exports.useSceneViewport(emitRequest)
  const reply = (payload: unknown) => listeners.get(sceneTypes.SCENE_VIEWPORT_RESPONSE)?.({ payload })
  const ack = (value = state(), requestId = events.at(-1)!.payload.requestId) => reply({ requestId, success: true, state: value })
  return {
    api,
    store,
    events,
    listeners,
    timers,
    ack,
    reply,
    publish: (payload: unknown) => listeners.get(sceneTypes.SCENE_VIEWPORT_STATE)?.({ payload }),
    mount: async () => {
      mounted.forEach(fn => fn())
      await flush()
    },
    unmount: () => unmounted.forEach(fn => fn()),
    focus: async () => {
      focus?.({ payload: true })
      await flush()
    },
    timeout: async () => {
      assert.equal(timers.size, 1)
      timers.values().next().value!()
      await flush()
    },
    delayEmission: () => {
      delayedEmission = deferred()
      return delayedEmission
    },
    delayRegistration: () => {
      registrationDelay = deferred()
      return registrationDelay
    },
  }
}

describe('scene viewport request acknowledgements', () => {
  it('confirms a user edit even when synchronization applied the same state before its reply', async () => {
    const h = viewportHarness()
    let confirmations = 0
    const stop = presetEditIntent.onPresetUserEditConfirmed(() => {
      confirmations++
    })
    try {
      await h.mount()
      assert.equal(presetOperations.presetNativeEditPending.value, 1)
      h.ack()
      assert.equal(confirmations, 0)
      assert.equal(presetOperations.presetNativeEditPending.value, 0)
      const request = h.api.requestViewportMode(false)
      await flush()
      Object.assign(h.store.activePet3dPreset, {
        autoViewportEnabled: false,
        cameraHorizontalOffset: 0,
        cameraVerticalOffset: 0,
        manualViewportRect: { ...state(false).rect },
      })
      h.ack(state(false))
      assert.equal(await request, true)
      assert.equal(confirmations, 1)
      assert.equal(presetOperations.presetNativeEditPending.value, 0)
      await h.focus()
      h.ack(state(false))
      assert.equal(confirmations, 1)
    } finally {
      stop()
      h.unmount()
    }
  })

  it('cancels stale replies when selection changes and blocks requests during a managed operation', async () => {
    const h = viewportHarness()
    await h.mount()
    h.ack()
    const request = h.api.requestViewportMode(false)
    await flush()
    const staleId = h.events.at(-1)!.payload.requestId
    presetEditIntent.invalidatePresetSelection()
    assert.equal(await request, false)
    assert.equal(presetOperations.presetNativeEditPending.value, 0)
    h.ack(state(false), staleId)
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, true)
    const release = presetOperations.beginPresetOperation()
    try {
      assert.equal(await h.api.requestViewportMode(false), false)
      assert.equal(presetOperations.presetNativeEditPending.value, 0)
    } finally {
      release()
    }
    await flush()
    assert.equal(h.api.viewportPending.value, true)
    h.ack()
    h.unmount()
    assert.equal(presetOperations.presetNativeEditPending.value, 0)
  })

  it('discards a queued packet if its owner changes before event delivery', async () => {
    const earlierEvent = deferred()
    const delivered: sceneTypes.SceneViewportRequest[] = []
    const h = viewportHarness(async (request, isCurrent) => {
      await earlierEvent.promise
      if (isCurrent?.()) delivered.push(request)
    })
    await h.mount()
    presetEditIntent.invalidatePresetSelection()
    earlierEvent.resolve()
    await flush()
    assert.deepEqual(delivered, [])
    assert.equal(presetOperations.presetNativeEditPending.value, 0)
    h.unmount()
  })

  it('uses the shared preference event queue before publishing mode requests', async () => {
    const earlierEvent = deferred()
    const requests: sceneTypes.SceneViewportRequest[] = []
    const h = viewportHarness(async (request) => {
      await earlierEvent.promise
      requests.push(request)
    })
    await h.mount()
    assert.equal(h.api.viewportPending.value, true)
    assert.equal(h.events.length, 0)
    assert.equal(requests.length, 0)
    earlierEvent.resolve()
    await flush()
    assert.equal(requests.length, 1)
    h.reply({ requestId: requests[0].requestId, success: true, state: state() })
    assert.equal(h.api.viewportPending.value, false)
    h.unmount()
  })

  it('preserves camera pan on refresh and resets it only after an explicit mode acknowledgement', async () => {
    const h = viewportHarness()
    await h.mount()
    assert.equal(h.api.viewportPending.value, true)
    assert.equal(h.events[0].target, constants.WINDOW_LABEL.MAIN)
    assert.equal(h.events[0].name, sceneTypes.SCENE_VIEWPORT_REQUEST)
    assert.equal(h.events[0].payload.automatic, undefined)
    h.ack()
    assert.equal(h.store.activePet3dPreset.cameraHorizontalOffset, 0.4)
    assert.equal(h.store.activePet3dPreset.cameraVerticalOffset, -0.6)
    const request = h.api.requestViewportMode(false)
    await flush()
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, true)
    assert.equal(h.store.activePet3dPreset.cameraHorizontalOffset, 0.4)
    h.ack(state(false))
    assert.equal(await request, true)
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, false)
    assert.equal(h.store.activePet3dPreset.cameraHorizontalOffset, 0)
    assert.equal(h.store.activePet3dPreset.cameraVerticalOffset, 0)
    assert.deepEqual({ ...h.store.activePet3dPreset.manualViewportRect }, state(false).rect)
    h.store.activePet3dPreset.cameraHorizontalOffset = 0.8
    h.store.activePet3dPreset.cameraVerticalOffset = -0.9
    await h.focus()
    h.ack(state(false))
    assert.equal(h.store.activePet3dPreset.cameraHorizontalOffset, 0.8)
    assert.equal(h.store.activePet3dPreset.cameraVerticalOffset, -0.9)
    assert.equal(h.api.viewportPending.value, false)
    h.unmount()
  })

  it('serializes mode requests, preserves state on failure, and ignores stale replies after timeout', async () => {
    const h = viewportHarness()
    await h.mount()
    h.ack()
    const first = h.api.requestViewportMode(false)
    await flush()
    const expiredId = h.events.at(-1)!.payload.requestId
    assert.equal(await h.api.requestViewportMode(true), false)
    await h.timeout()
    assert.equal(await first, false)
    assert.equal(h.api.viewportError.value, 'pages.preference.scene.errors.timeout')
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, true)
    const second = h.api.requestViewportMode(false)
    await flush()
    h.ack(state(false), expiredId)
    assert.equal(h.api.viewportPending.value, true)
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, true)
    h.reply({ requestId: h.events.at(-1)!.payload.requestId, success: false })
    assert.equal(await second, false)
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, true)
    assert.equal(h.store.activePet3dPreset.cameraHorizontalOffset, 0.4)
    h.unmount()
  })

  it('requires a valid matching native state before reporting a successful mode change', async () => {
    const h = viewportHarness()
    await h.mount()
    h.ack()
    for (const nativeState of [undefined, { ...state(false), rect: { width: Number.NaN } }, state(true)]) {
      const request = h.api.requestViewportMode(false)
      await flush()
      h.reply({ requestId: h.events.at(-1)!.payload.requestId, success: true, state: nativeState })
      assert.equal(await request, false)
      assert.equal(h.store.activePet3dPreset.autoViewportEnabled, true)
      assert.equal(h.store.activePet3dPreset.cameraHorizontalOffset, 0.4)
      assert.equal(h.api.viewportError.value, 'pages.preference.scene.errors.unavailable')
    }
    h.unmount()
  })

  it('does not let a delayed old delivery failure cancel a newer request', async () => {
    const h = viewportHarness()
    await h.mount()
    h.ack()
    const delayed = h.delayEmission()
    const first = h.api.requestViewportMode(false)
    await flush()
    await h.timeout()
    assert.equal(await first, false)
    const second = h.api.requestViewportMode(false)
    await flush()
    delayed.reject(new Error('Old native delivery failed'))
    await flush()
    assert.equal(h.api.viewportPending.value, true)
    assert.equal(h.api.viewportError.value, undefined)
    h.ack(state(false))
    assert.equal(await second, true)
    h.unmount()
  })

  for (const failure of ['rejection', 'timeout'] as const) {
    it(`rechecks a failed refresh after fresh native state arrives (${failure})`, async () => {
      const h = viewportHarness()
      try {
        await h.mount()
        if (failure === 'timeout') await h.timeout()
        else h.reply({ requestId: h.events.at(-1)!.payload.requestId, success: false })
        assert.ok(h.api.viewportError.value)
        h.publish({ ...state(), revision: -1 })
        await flush()
        assert.equal(h.events.length, 1, 'invalid state cannot trigger recovery')
        h.publish(state())
        h.publish(state())
        await flush()
        assert.equal(h.events.length, 2, 'recovery is a single serialized readback')
        assert.equal(h.events.at(-1)!.payload.automatic, undefined)
        assert.equal(h.api.viewportPending.value, true)
        assert.equal(h.store.activePet3dPreset.cameraHorizontalOffset, 0.4)
        h.ack()
        assert.equal(h.api.viewportPending.value, false)
        assert.equal(h.api.viewportError.value, undefined)
      } finally {
        h.unmount()
      }
    })
  }

  it('does not mistake unsolicited state for recovery of a failed explicit mode change', async () => {
    const h = viewportHarness()
    try {
      await h.mount()
      h.ack()
      const change = h.api.requestViewportMode(false)
      await flush()
      h.reply({ requestId: h.events.at(-1)!.payload.requestId, success: false })
      assert.equal(await change, false)
      h.publish(state())
      await flush()
      assert.equal(h.events.length, 2)
      assert.equal(h.api.viewportError.value, 'pages.preference.scene.errors.unavailable')
      assert.equal(h.store.activePet3dPreset.autoViewportEnabled, true)
    } finally {
      h.unmount()
    }
  })

  it('accepts unsolicited applied bounds without persisting unrequested pan or mode changes', async () => {
    const h = viewportHarness()
    await h.mount()
    h.ack()
    const updated = { ...state(), rect: { x: -500, y: -400, width: 3000, height: 2000 } }
    h.publish(updated)
    assert.deepEqual(h.api.viewportState.value, updated)
    assert.equal(h.store.activePet3dPreset.cameraHorizontalOffset, 0.4)
    h.publish({ ...updated, monitorSize: { width: 0, height: 0 } })
    assert.deepEqual(h.api.viewportState.value, updated)
    assert.equal(h.api.viewportPending.value, false)
    h.unmount()
  })

  it('cancels pending work on unmount and removes late-registered listeners', async () => {
    const h = viewportHarness()
    await h.mount()
    h.ack()
    const request = h.api.requestViewportMode(false)
    await flush()
    h.unmount()
    assert.equal(await request, false)
    assert.equal(h.api.viewportPending.value, false)
    assert.equal(h.listeners.size, 0)
    assert.equal(h.timers.size, 0)
    assert.equal(await h.api.requestViewportMode(true), false)
    const late = viewportHarness()
    const registration = late.delayRegistration()
    await late.mount()
    late.unmount()
    registration.resolve()
    await flush()
    assert.equal(late.listeners.size, 0)
    assert.equal(late.events.length, 0)
  })

  it('rejects older revisions from either applied state or persisted mode while accepting same-revision bounds', async () => {
    const h = viewportHarness()
    await h.mount()
    h.ack({ ...state(), revision: 5 })
    const manualBefore = { ...h.store.activePet3dPreset.manualViewportRect }
    const latest = { ...state(), revision: 5, rect: { x: -100, y: -100, width: 800, height: 700 } }
    h.publish(latest)
    assert.deepEqual(h.api.viewportState.value, latest)
    assert.deepEqual(h.store.activePet3dPreset.manualViewportRect, manualBefore)
    h.publish({ ...state(), revision: 4 })
    assert.deepEqual(h.api.viewportState.value, latest)

    let request = h.api.requestViewportMode(false)
    await flush()
    h.ack({ ...state(false), revision: 4 })
    assert.equal(await request, false)
    assert.equal(h.store.activePet3dPreset.viewportModeRevision, 5)
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, true)
    assert.equal(h.store.activePet3dPreset.cameraHorizontalOffset, 0.4)

    h.store.activePet3dPreset.viewportModeRevision = 6
    h.publish({ ...state(), revision: 5 })
    assert.deepEqual(h.api.viewportState.value, latest)
    request = h.api.requestViewportMode(false)
    await flush()
    h.ack({ ...state(false), revision: 5 })
    assert.equal(await request, false)
    assert.equal(h.store.activePet3dPreset.viewportModeRevision, 6)

    request = h.api.requestViewportMode(false)
    await flush()
    h.ack({ ...state(false), revision: 6 })
    assert.equal(await request, true)
    assert.equal(h.store.activePet3dPreset.viewportModeRevision, 6)
    assert.equal(h.store.activePet3dPreset.autoViewportEnabled, false)
    h.unmount()
  })
})
