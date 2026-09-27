/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as vue from 'vue'

import type { BroadcastConfiguration, BroadcastStatus } from '@/features/broadcast/types'

import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'

import type { useBroadcast } from './useBroadcast'

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('./useBroadcast.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

async function harness(enabled = false, listenerFails = false, statusQuery?: () => Promise<BroadcastStatus>) {
  setActivePinia(createPinia())
  const cat = useCatStore()
  const general = useGeneralStore()
  general.broadcast.enabled = enabled
  const ready = vue.ref(false)
  const busy = vue.ref(false)
  const calls: BroadcastConfiguration[] = []
  const mounted: Array<() => Promise<void>> = []
  const unmounted: Array<() => void> = []
  let receive: ((value: { payload: unknown }) => void) | undefined
  let stopped = false
  let fail = false
  let configureReply: ((status: BroadcastStatus) => Promise<BroadcastStatus>) | undefined
  let native: BroadcastStatus = { enabled: false, clients: 0 }
  const module = { exports: {} as { useBroadcast: typeof useBroadcast } }
  runInNewContext(source, {
    exports: module.exports,
    module,
    console,
    require: (id: string) => {
      if (id === 'vue') return { ...vue, onMounted: (fn: () => Promise<void>) => mounted.push(fn), onBeforeUnmount: (fn: () => void) => unmounted.push(fn) }
      if (id === '@tauri-apps/api/core') {
        return { invoke: async (command: string, args: BroadcastConfiguration) => {
          if (command === 'get_broadcast_status') return statusQuery ? statusQuery() : native
          assert.equal(command, 'configure_broadcast')
          calls.push(JSON.parse(JSON.stringify(args)))
          if (fail) throw new Error('port occupied')
          native = { enabled: args.enabled, clients: 0 }
          return configureReply ? configureReply(native) : native
        } }
      }
      if (id === '@tauri-apps/api/event') {
        return { listen: async (_event: string, handler: typeof receive) => {
          if (listenerFails) throw new Error('bridge unavailable')
          receive = handler
          return () => {
            stopped = true
          }
        } }
      }
      if (id === '@/stores/cat') return { useCatStore: () => cat }
      if (id === '@/stores/general') return { useGeneralStore: () => general }
      if (id.startsWith('@/')) return require(fileURLToPath(new URL(`../${id.slice(2)}`, import.meta.url)))
      return require(id)
    },
  })
  const scope = vue.effectScope()
  const controller = scope.run(() => module.exports.useBroadcast(ready, busy))!
  const flush = async () => {
    await vue.nextTick()
    await new Promise(resolve => setImmediate(resolve))
    await vue.nextTick()
  }
  await flush()
  const mountedDone = Promise.all(mounted.map(mount => mount()))
  if (!statusQuery) await mountedDone
  return {
    cat,
    general,
    controller,
    mountedDone,
    ready,
    busy,
    calls,
    flush,
    event: (payload: unknown) => receive?.({ payload }),
    fail: (value: boolean) => {
      fail = value
    },
    listenerFailure: (value: boolean) => {
      listenerFails = value
    },
    configureReply: (reply: (status: BroadcastStatus) => Promise<BroadcastStatus>) => {
      configureReply = reply
    },
    stopped: () => stopped,
    dispose: () => {
      unmounted.forEach(fn => fn())
      scope.stop()
    },
  }
}

describe('broadcast preference owner', () => {
  it('keeps a newer client status when an earlier configure reply arrives late', async () => {
    const h = await harness()
    let release!: (status: BroadcastStatus) => void
    const reply = new Promise<BroadcastStatus>((resolve) => {
      release = resolve
    })
    h.configureReply(() => reply)
    h.ready.value = true
    h.general.broadcast.enabled = true
    await h.flush()
    h.event({ enabled: true, clients: 1 })
    release({ enabled: true, clients: 0 })
    await h.flush()
    assert.equal(h.controller.status.value.clients, 1)
    h.dispose()
  })

  it('retry restores a failed status subscription and continues receiving client changes', async () => {
    const h = await harness(false, true)
    h.listenerFailure(false)
    h.controller.retry()
    await h.flush()
    h.event({ enabled: true, clients: 2 })
    assert.equal(h.controller.status.value.clients, 2)
    h.dispose()
    assert.equal(h.stopped(), true)
  })

  it('retries native configuration even when status subscription still fails', async () => {
    const h = await harness(false, true)
    h.fail(true)
    h.ready.value = true
    h.general.broadcast.enabled = true
    await h.flush()
    const attempts = h.calls.length
    h.fail(false)
    h.controller.retry()
    await h.flush()
    assert.equal(h.calls.length, attempts + 1)
    assert.equal(h.controller.status.value.enabled, true)
    assert.equal(h.controller.status.value.error, 'unavailable')
    h.dispose()
  })

  for (const scenario of ['event', 'invalid-event', 'configure-error', 'invalid-scene']) {
    it(`preserves ${scenario} ordering while startup status is pending`, async () => {
      let resolveStatus!: (status: BroadcastStatus) => void
      const query = new Promise<BroadcastStatus>((resolve) => {
        resolveStatus = resolve
      })
      let started!: () => void
      const queryStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      const h = await harness(true, false, () => {
        started()
        return query
      })
      try {
        await queryStarted
        if (scenario === 'event' || scenario === 'invalid-event') {
          h.event({ enabled: true, clients: scenario === 'event' ? 1 : -1 })
        } else {
          if (scenario === 'configure-error') h.fail(true)
          else h.cat.customization3d.dmeloperSkinDataUrl = 'invalid-image'
          h.ready.value = true
          await h.flush()
        }
        const expected = scenario === 'invalid-event'
          ? { enabled: false, clients: 0 }
          : JSON.parse(JSON.stringify(h.controller.status.value))
        if (scenario === 'event') assert.equal(expected.clients, 1)
        if (scenario === 'configure-error') assert.equal(expected.error, 'unavailable')
        if (scenario === 'invalid-scene') assert.equal(expected.error, 'render_failed')
        resolveStatus({ enabled: false, clients: 0 })
        await h.mountedDone
        assert.deepEqual(JSON.parse(JSON.stringify(h.controller.status.value)), expected)
      } finally {
        h.dispose()
      }
    })
  }

  it('restores enabled output only after presets are ready and publishes complete transactions', async () => {
    const h = await harness(true)
    try {
      assert.equal(h.calls.length, 0)
      h.ready.value = true
      await h.flush()
      assert.equal(h.calls.length, 1)
      h.busy.value = true
      h.cat.customization3d.preset.cameraZoomPercent = 125
      await h.flush()
      h.cat.model.mirror = true
      h.cat.window.opacity = 40
      await h.flush()
      assert.equal(h.calls.length, 1)
      h.busy.value = false
      await h.flush()
      assert.equal(h.calls.length, 2)
      assert.equal(h.calls[1].scene?.preset.cameraZoomPercent, 125)
      assert.equal(h.calls[1].scene?.mirror, true)
      assert.equal(h.calls[1].scene?.opacity, 40)
      h.cat.window.visible = false
      h.cat.window.hideOnHover = true
      h.general.broadcast.showOnDesktop = false
      h.general.app.taskbarVisible = false
      await h.flush()
      assert.equal(h.calls.length, 2, 'desktop-only changes must not restart a broadcast scene')
      h.cat.model.antialiasEnabled = false
      await h.flush()
      assert.equal(h.calls.length, 3)
      assert.equal(h.calls.at(-1)?.scene?.performance.antialiasEnabled, false)
      h.cat.model.pixelFilterEnabled = true
      await h.flush()
      assert.equal(h.calls.at(-1)?.scene?.performance.pixelFilterEnabled, true)
      h.cat.customization3d.preset.mouseEnabled = false
      await h.flush()
      assert.equal(h.calls.at(-1)?.scene?.preset.mouseEnabled, false)
      h.busy.value = true
      h.general.reset()
      await h.flush()
      assert.deepEqual(h.calls.at(-1), { enabled: false })
    } finally {
      h.dispose()
    }
  })

  it('shows command errors, retries unchanged settings, and cleans up status listeners', async () => {
    const h = await harness()
    h.ready.value = true
    h.fail(true)
    h.general.broadcast.enabled = true
    await h.flush()
    assert.equal(h.controller.status.value.error, 'unavailable')
    h.fail(false)
    h.controller.retry()
    await h.flush()
    assert.equal(h.controller.status.value.enabled, true)
    assert.equal(h.controller.status.value.error, undefined)
    h.event({ enabled: true, clients: 2 })
    assert.equal(h.controller.status.value.clients, 2)
    h.event({ enabled: true, clients: -1 })
    assert.equal(h.controller.status.value.clients, 2)
    h.dispose()
    assert.equal(h.stopped(), true)
    h.event({ enabled: true, clients: 0 })
    assert.equal(h.controller.status.value.clients, 2)
  })

  it('surfaces bridge listener failure without an unhandled rejection', async () => {
    const h = await harness(false, true)
    assert.equal(h.controller.status.value.error, 'unavailable')
    h.dispose()
  })
})
