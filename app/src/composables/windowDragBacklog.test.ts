/* eslint-disable test/no-import-node-test */
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import { WINDOW_LABEL } from '@/constants'

import type * as WindowStateModule from './useWindowState'

const sourceRequire = createRequire(import.meta.url)
const compiled = ts.transpileModule(readFileSync(new URL('./useWindowState.ts', import.meta.url), 'utf8').replace(/import\.meta\.hot/g, '__hot'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

function fixture(label: string = WINDOW_LABEL.MAIN) {
  type Reader = 'position' | 'size' | 'minimized'
  interface NativeEvent { payload: PhysicalPosition | PhysicalSize }
  const mounted: Array<() => void> = []
  const disposed: Array<() => void> = []
  const events: Partial<Record<'moved' | 'resized' | 'scale', (event: NativeEvent) => Promise<void> | void>> = {}
  const counts: Record<Reader, number> = { position: 0, size: 0, minimized: 0 }
  const outstanding: Record<Reader, number> = { position: 0, size: 0, minimized: 0 }
  const maximum: Record<Reader, number> = { position: 0, size: 0, minimized: 0 }
  const appStore = { windowState: {} as WindowStateModule.WindowState }
  const warnings: string[] = []
  let position = new PhysicalPosition(20, 30)
  let size = new PhysicalSize(200, 200)
  let blocked: ReturnType<typeof deferred> | undefined
  let failNext = false
  let released = 0
  let reconciliation: (() => Promise<void>) | undefined

  const read = async <T>(kind: Reader, value: () => T): Promise<T> => {
    counts[kind]++
    outstanding[kind]++
    maximum[kind] = Math.max(maximum[kind], outstanding[kind])
    await blocked?.promise
    outstanding[kind]--
    if (failNext) {
      failNext = false
      throw new Error('fixture readback failure')
    }
    return value()
  }
  const register = async (kind: keyof typeof events, callback: NonNullable<typeof events[typeof kind]>) => {
    events[kind] = callback
    return () => {
      released++
    }
  }
  const appWindow = {
    label,
    outerPosition: () => read('position', () => position),
    outerSize: async () => size,
    innerSize: () => read('size', () => size),
    isMinimized: () => read('minimized', () => false),
    scaleFactor: async () => 1,
    setSize: async (next: PhysicalSize) => {
      size = next
    },
    setPosition: async (next: PhysicalPosition) => {
      position = next
    },
    onMoved: (callback: NonNullable<typeof events.moved>) => register('moved', callback),
    onResized: (callback: NonNullable<typeof events.resized>) => register('resized', callback),
    onScaleChanged: (callback: NonNullable<typeof events.scale>) => register('scale', callback),
  }
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => appWindow },
    '@tauri-apps/api/window': { availableMonitors: async () => [] },
    '@vueuse/core': { useDebounceFn: (callback: (...args: unknown[]) => Promise<void>) => (...args: unknown[]) => {
      reconciliation = () => callback(...args)
    } },
    'vue': { onMounted: (callback: () => void) => mounted.push(callback), onScopeDispose: (callback: () => void) => disposed.push(callback), ref: (value: unknown) => ({ value }), watch: () => {} },
    '@/stores/app': { useAppStore: () => appStore },
    '@/stores/block': { useBlockStore: () => ({ window: { keepInScreen: false }, model: { mirror: false } }) },
  }
  const api = {} as typeof WindowStateModule
  runInNewContext(compiled, {
    exports: api,
    require: (id: string) => mocks[id] ?? sourceRequire(id),
    console: { ...console, warn: (...values: unknown[]) => warnings.push(values.map(String).join(' ')) },
    setTimeout,
    clearTimeout,
    __hot: undefined,
  })
  api.useWindowState()
  mounted.forEach(callback => callback())
  return {
    api,
    appStore,
    counts,
    outstanding,
    maximum,
    warnings,
    init: async () => {
      if (label === WINDOW_LABEL.MAIN) {
        await api.applyMainViewportGeometry({ mirrored: false, sourceRect: { x: 0, y: 0, width: 200, height: 200 }, virtualSize: { width: 400, height: 400 }, windowScalePercent: 100 })
      }
      await flush()
      for (const kind of Object.keys(counts) as Reader[]) {
        counts[kind] = 0
        maximum[kind] = 0
      }
    },
    block: () => {
      blocked = deferred()
    },
    release: () => {
      blocked?.resolve()
      blocked = undefined
    },
    move: (x: number, y: number) => {
      position = new PhysicalPosition(x, y)
      return events.moved!({ payload: position })
    },
    resize: (width: number, height: number) => {
      size = new PhysicalSize(width, height)
      return events.resized!({ payload: size })
    },
    staleMove: (x: number, y: number) => events.moved!({ payload: new PhysicalPosition(x, y) }),
    actualPosition: (x: number, y: number) => {
      position = new PhysicalPosition(x, y)
    },
    fail: () => {
      failNext = true
    },
    reconcile: () => reconciliation?.(),
    dispose: () => disposed.forEach(callback => callback()),
    released: () => released,
  }
}

describe('native geometry event backlog', () => {
  for (const label of [WINDOW_LABEL.MAIN, WINDOW_LABEL.PREFERENCE]) {
    for (const event of ['move', 'resize'] as const) {
      for (const count of [1, 600, 3600]) {
        it(`bounds ${label} ${event} readbacks across ${count} delayed events`, async () => {
          const h = fixture(label)
          await h.init()
          h.block()
          const completions = Array.from({ length: count }, (_, index) => h[event](100 + index, 200 + index))
          const kind = label === WINDOW_LABEL.MAIN ? event === 'move' ? 'position' : 'size' : 'minimized'
          assert.equal(h.counts[kind], 1)
          assert.equal(h.outstanding[kind], 1)
          assert.equal(completions.at(-1), completions[0], 'all events share the native drain completion')
          h.release()
          await Promise.all(completions)
          assert.equal(h.maximum[kind], 1)
          assert.equal(h.counts[kind], count === 1 ? 1 : 2)
          if (event === 'move' || label === WINDOW_LABEL.PREFERENCE) {
            assert.equal(h.appStore.windowState[label]?.[event === 'move' ? 'x' : 'width'], 99 + count)
            assert.equal(h.appStore.windowState[label]?.[event === 'move' ? 'y' : 'height'], 199 + count)
          }
          h.dispose()
        })
      }
    }
  }

  it('persists confirmed native position when a delayed event payload differs', async () => {
    const h = fixture()
    await h.init()
    h.block()
    const moving = h.move(80, 90)
    h.actualPosition(777, 888)
    h.release()
    await moving
    assert.equal(h.appStore.windowState.main?.x, 777)
    assert.equal(h.appStore.windowState.main?.y, 888)
    await h.staleMove(-100, -100)
    assert.equal(h.appStore.windowState.main?.x, 777)
    h.dispose()
  })

  it('recovers the newest move after a rejected readback', async () => {
    const h = fixture()
    await h.init()
    h.block()
    const moving = [h.move(100, 100), h.move(900, 900)]
    h.fail()
    h.release()
    await Promise.all(moving)
    assert.equal(h.warnings.length, 1)
    assert.equal(h.counts.position, 2)
    assert.equal(h.appStore.windowState.main?.x, 900)
    h.dispose()
  })

  for (const event of ['move', 'resize'] as const) {
    const warning = event === 'move'
      ? 'Failed to read the current native window position.'
      : 'Failed to read the current native window size.'

    it(`reports a failed preference ${event} read with fixed text and recovers on the next event`, async () => {
      const h = fixture(WINDOW_LABEL.PREFERENCE)
      await h.init()
      h.fail()
      await h[event](100, 100)
      assert.deepEqual(h.warnings, [warning], 'report one known category without raw exception details')
      assert.equal(h.appStore.windowState.preference, undefined)
      await h[event](900, 900)
      assert.equal(h.counts.minimized, 2)
      assert.equal(h.appStore.windowState.preference?.[event === 'move' ? 'x' : 'width'], 900)
      assert.deepEqual(h.warnings, [warning])
      h.dispose()
    })

    it(`continues the newest queued preference ${event} after a failed read`, async () => {
      const h = fixture(WINDOW_LABEL.PREFERENCE)
      await h.init()
      h.block()
      const work = [h[event](100, 100), h[event](900, 900)]
      h.fail()
      h.release()
      await Promise.all(work)
      assert.equal(h.counts.minimized, 2)
      assert.equal(h.maximum.minimized, 1)
      assert.deepEqual(h.warnings, [warning])
      assert.equal(h.appStore.windowState.preference?.[event === 'move' ? 'x' : 'width'], 900)
      h.dispose()
    })

    it(`silences a retired preference ${event} read failure and drops pending work`, async () => {
      const h = fixture(WINDOW_LABEL.PREFERENCE)
      await h.init()
      h.block()
      const work = [h[event](100, 100), h[event](900, 900)]
      h.fail()
      h.dispose()
      h.release()
      await Promise.all(work)
      assert.equal(h.counts.minimized, 1)
      assert.equal(h.appStore.windowState.preference, undefined)
      assert.deepEqual(h.warnings, [])
      await h[event](500, 500)
      assert.equal(h.counts.minimized, 1)
      assert.equal(h.appStore.windowState.preference, undefined)
    })

    it(`keeps the existing handled main ${event} read warning single`, async () => {
      const h = fixture()
      await h.init()
      h.fail()
      await h[event](100, 100)
      assert.deepEqual(h.warnings, [warning])
      h.dispose()
    })
  }

  for (const event of ['move', 'resize'] as const) {
    it(`retires queued ${event} events before releasing an old owner`, async () => {
      const h = fixture()
      await h.init()
      h.block()
      const work = [h[event](100, 100), h[event](900, 900)]
      h.dispose()
      h.release()
      await Promise.all(work)
      assert.equal(h.counts[event === 'move' ? 'position' : 'size'], 1)
      assert.equal(h.released(), 3)
      assert.equal(h.api.getMainViewportSnapshot()?.nativeRect.x, 20)
      assert.equal(h.appStore.windowState.main?.x, 20)
      assert.equal(h.appStore.windowState.main?.width, 200)
      await h.reconcile()
      const before = { ...h.counts }
      await h[event](500, 500)
      assert.deepEqual(h.counts, before)
    })
  }
})
