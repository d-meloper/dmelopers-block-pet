/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import type { DeviceInputState, SemanticInputEvent } from '@/features/input/types'

import * as constants from '@/constants'
import * as inputTypes from '@/features/input/types'

import type * as DeviceModule from './useDevice'

const compiled = ts.transpileModule(readFileSync(new URL('./useDevice.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

function fixture(mouseEnabled = true) {
  const mounted: Array<() => unknown> = []
  const unmounted: Array<() => void> = []
  const watchers: Array<() => void> = []
  const events: Record<string, (event: { payload: SemanticInputEvent }) => void> = {}
  const timers = new Map<number, { due: number, callback: () => void }>()
  const frames = new Map<number, () => void>()
  const styles = new Map<string, string>()
  const dispatched: SemanticInputEvent[] = []
  const cursorIgnores: boolean[] = []
  const native = { position: { x: 100, y: 25 }, rect: { x: 0, y: 0, width: 200, height: 100 } }
  const store = { activePet3dPreset: { mouseEnabled }, window: { visible: true, passThrough: false, hideOnHover: false, hideOnHoverDelay: 0 } }
  let now = 0
  let timerId = 0
  let frameId = 0
  let epoch = 0
  let cursorReads = 0
  const mocks: Record<string, unknown> = {
    'vue': {
      onMounted: (callback: () => unknown) => mounted.push(callback),
      onUnmounted: (callback: () => void) => unmounted.push(callback),
      watch: (_source: unknown, callback: () => void) => watchers.push(callback),
    },
    '@tauri-apps/api/core': { invoke: async (_command: string, args: { active?: boolean, mouseEnabled?: boolean, enabled?: boolean } = {}): Promise<DeviceInputState> => ({ mouseEnabled: args.active === false ? false : args.mouseEnabled ?? args.enabled ?? true, mouseGeneration: ++epoch }) },
    '@tauri-apps/api/dpi': { PhysicalPosition: class {
      constructor(public x: number, public y: number) {}
    } },
    '@tauri-apps/api/event': { listen: async (name: string, callback: typeof events[string]) => {
      events[name] = callback
      return () => {
        delete events[name]
      }
    } },
    '@tauri-apps/api/window': { cursorPosition: async () => {
      cursorReads++
      return { ...native.position }
    } },
    'es-toolkit': { isNil: (value: unknown) => value == null },
    '@/features/input/types': inputTypes,
    '@/plugins/window': { setPetCursorEvents: async (ignore: boolean) => {
      cursorIgnores.push(ignore)
    } },
    '@/stores/app': { useAppStore: () => ({ windowState: { main: native.rect } }) },
    '@/stores/block': { useBlockStore: () => store },
    '@/utils/is': { inBetween: (value: number, minimum: number, maximum: number) => value >= minimum && value <= maximum },
    '@/utils/monitor': { getCursorMonitor: async () => ({ position: { x: 0, y: 0 }, size: { width: 200, height: 100 } }) },
    '@/utils/three3d': { default: { setInputActive: () => {}, setMouseEnabled: () => {}, setMouseInputActive: () => {}, handleSemanticInput: (event: SemanticInputEvent) => dispatched.push(event) } },
    '../constants': constants,
  }
  const api = {} as typeof DeviceModule
  runInNewContext(compiled, {
    exports: api,
    require: (id: string) => mocks[id],
    console,
    document: { body: { style: { setProperty: (name: string, value: string) => styles.set(name, value) } } },
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++timerId, { due: now + delay, callback })
      return timerId
    },
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++frameId, callback)
      return frameId
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })
  const device = api.useDevice()
  return {
    device,
    native,
    store,
    dispatched,
    cursorIgnores,
    cursorReads: () => cursorReads,
    opacity: () => styles.get('opacity'),
    mount: async () => {
      await Promise.all(mounted.splice(0).map(callback => callback()))
      await device.setInputActive(true)
      await device.startListening()
    },
    hover: (enabled: boolean) => {
      store.window.hideOnHover = enabled
      watchers.forEach(callback => callback())
    },
    point: (x: number, y: number, mouseGeneration = device.getInputState().mouseGeneration) => {
      native.position = { x, y }
      events[constants.LISTEN_KEY.SEMANTIC_INPUT]?.({ payload: { kind: 'pointer_activity', x, y, mouseGeneration } })
    },
    frame: async () => {
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach(callback => callback())
      await flush()
    },
    advance: async (milliseconds: number) => {
      await flush()
      const target = now + milliseconds
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0]
        if (timer.due > target) break
        now = timer.due
        timers.delete(id)
        timer.callback()
        await flush()
      }
      now = target
      await flush()
    },
    unmount: async () => {
      unmounted.splice(0).forEach(callback => callback())
      await flush()
    },
  }
}

describe('hover cursor polling during native pointer activity', () => {
  for (const mouseEnabled of [true, false]) {
    it(`reuses 600 motion points without redundant hover queries (mouse enabled: ${mouseEnabled})`, async () => {
      const h = fixture(mouseEnabled)
      await h.mount()
      h.hover(true)
      await h.advance(0)
      assert.equal(h.cursorReads(), 1)
      for (let index = 0; index < 600; index++) {
        h.point(50 + index % 100, 25)
        await h.frame()
        await h.advance(1000 / 60)
      }
      assert.equal(h.cursorReads(), 1)
      assert.equal(h.dispatched.length, 600)
      assert.deepEqual({ ...h.dispatched.at(-1) }, { kind: 'pointer_activity', x: 0.745, y: 0.25, mouseGeneration: h.device.getInputState().mouseGeneration })
      assert.equal(h.opacity(), '0')
      assert.equal(h.cursorIgnores.at(-1), true)
      assert.equal(h.device.getInputState().mouseEnabled, mouseEnabled)
      assert.equal(h.store.activePet3dPreset.mouseEnabled, mouseEnabled)
      h.native.position = { x: -10, y: -10 }
      await h.advance(300)
      assert.ok(h.cursorReads() > 1, 'quiet motion resumes native polling')
      assert.equal(h.opacity(), 'unset')
      assert.equal(h.cursorIgnores.at(-1), false)
      await h.unmount()
    })
  }

  it('rechecks the accepted point against changed window geometry without another cursor IPC', async () => {
    const h = fixture(false)
    await h.mount()
    h.hover(true)
    await h.advance(0)
    h.point(100, 25)
    await h.frame()
    h.native.rect.x = 500
    await h.advance(100)
    assert.equal(h.cursorReads(), 1)
    assert.equal(h.opacity(), 'unset')
    assert.equal(h.cursorIgnores.at(-1), false)
    await h.unmount()
  })

  it('starts with fresh cursor readback after suspension and rejects retired pointer epochs', async () => {
    const h = fixture()
    await h.mount()
    h.hover(true)
    await h.advance(0)
    const oldEpoch = h.device.getInputState().mouseGeneration
    h.point(100, 25)
    await h.frame()
    await h.device.setInputActive(false)
    h.native.position = { x: -10, y: -10 }
    await h.device.setInputActive(true)
    await h.advance(0)
    assert.equal(h.cursorReads(), 2)
    assert.equal(h.opacity(), 'unset')
    const count = h.dispatched.length
    h.point(100, 25, oldEpoch)
    await h.frame()
    assert.equal(h.dispatched.length, count)
    h.native.position = { x: -10, y: -10 }
    await h.advance(100)
    assert.equal(h.cursorReads(), 3, 'rejected pointer does not suppress polling')
    await h.unmount()
    const queries = h.cursorReads()
    await h.advance(1000)
    assert.equal(h.cursorReads(), queries)
  })

  it('keeps default motion free of hover polling and stops polling when disabled', async () => {
    const h = fixture()
    await h.mount()
    h.point(100, 25)
    await h.frame()
    await h.advance(1000)
    assert.equal(h.cursorReads(), 0)
    h.hover(true)
    await h.advance(0)
    const queries = h.cursorReads()
    h.hover(false)
    h.point(120, 25)
    await h.frame()
    await h.advance(1000)
    assert.equal(h.cursorReads(), queries)
    await h.unmount()
  })
})
