/* eslint-disable test/no-import-node-test */
import type { TrayIconEvent, TrayIconOptions } from '@tauri-apps/api/tray'

import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

import { APP_DISPLAY_NAME, WINDOW_LABEL } from '@/constants'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'
import { createLatestAsyncTaskQueue } from '@/utils/latestAsyncTask'

interface MenuSnapshot {
  visible: boolean
  scale: number
  rotation: number
  opacity: number
  keepInScreen: boolean
  alwaysOnTop: boolean
  language: string
}
interface MockMenu {
  snapshot: MenuSnapshot
  closed: boolean
  close: () => Promise<void>
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function flush() {
  for (let i = 0; i < 60; i += 1) await Promise.resolve()
}
function trayHarness() {
  const cat = vue.reactive({
    window: { visible: true, opacity: 100, keepInScreen: true, alwaysOnTop: false },
    activePet3dPreset: { cameraZoomPercent: 100, sceneRotationOffsetDegrees: 0 },
  })
  const general = vue.reactive({ app: { trayVisible: true }, appearance: { language: 'ko-KR' } })
  const created: MockMenu[] = []
  const attached: MockMenu[] = []
  const visibility: boolean[] = []
  const shown: string[] = []
  const requests: Array<{ label: string, event: string, visible: boolean }> = []
  let trayOptions: Pick<TrayIconOptions, 'action' | 'showMenuOnLeftClick'> = {}
  let focusWait = async () => {}
  const errors: unknown[] = []
  const unmounts: Array<() => void> = []
  let trayExists = false
  let buildWait: (menu: MockMenu) => Promise<void> = async () => {}
  let attachWait: (menu: MockMenu) => Promise<void> = async () => {}
  const tray = {
    setMenu: async (menu: MockMenu) => {
      await attachWait(menu)
      attached.push(menu)
    },
    setVisible: async (visible: boolean) => {
      visibility.push(visible)
    },
  }
  const exports = {} as { useTray: () => void }
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/app': { getVersion: async () => '0.2.0' },
    '@tauri-apps/api/event': { emitTo: async (label: string, event: string, payload: { visible: boolean }) => {
      requests.push({ label, event, visible: payload.visible })
      cat.window.visible = payload.visible
    } },
    '@tauri-apps/api/path': { resolveResource: async (path: string) => path },
    '@tauri-apps/api/tray': { TrayIcon: {
      getById: async () => trayExists ? tray : null,
      new: async ({ menu, tooltip, ...options }: { menu: MockMenu, tooltip: string } & typeof trayOptions) => {
        assert.equal(tooltip, `${APP_DISPLAY_NAME} v0.2.0`)
        trayOptions = options
        attached.push(menu)
        trayExists = true
        return tray
      },
    } },
    'vue': { ...vue, onBeforeUnmount: (fn: () => void) => unmounts.push(fn) },
    '@/constants': { APP_DISPLAY_NAME, WINDOW_LABEL },
    '@/features/presets/types': { PRESET_EDIT_REQUEST },
    '@/plugins/window': { showWindow: async (label: string) => {
      await focusWait()
      shown.push(label)
    } },
    '@/stores/cat': { useCatStore: () => cat },
    '@/stores/general': { useGeneralStore: () => general },
    '@/services/updateDelivery': { updateStatus: vue.ref({ phase: 'idle', targetVersion: null }), updateProgress: vue.ref(0) },
    '@/features/stateSafety': { editorsLocked: vue.ref(false) },
    '@/utils/latestAsyncTask': { createLatestAsyncTaskQueue },
    './useAppMenu': { useAppMenu: () => ({
      getAppMenu: async () => {
        const menu: MockMenu = {
          snapshot: {
            visible: cat.window.visible,
            scale: cat.activePet3dPreset.cameraZoomPercent,
            rotation: cat.activePet3dPreset.sceneRotationOffsetDegrees,
            opacity: cat.window.opacity,
            keepInScreen: cat.window.keepInScreen,
            alwaysOnTop: cat.window.alwaysOnTop,
            language: general.appearance.language,
          },
          closed: false,
          close: async () => {
            menu.closed = true
          },
        }
        created.push(menu)
        await buildWait(menu)
        return menu
      },
    }) },
  }
  const source = readFileSync(new URL('./useTray.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, console: { error: (...args: unknown[]) => errors.push(args) }, require: (name: string) => mocks[name] })
  const scope = vue.effectScope()
  scope.run(() => exports.useTray())
  return {
    cat,
    general,
    created,
    attached,
    visibility,
    shown,
    requests,
    errors,
    get trayOptions() {
      return trayOptions
    },
    click: (button: 'Left' | 'Right' | 'Middle', buttonState: 'Up' | 'Down') => {
      const event: TrayIconEvent = {
        type: 'Click',
        id: 'DMELOPERS_BLOCK_PET_TRAY',
        button,
        buttonState,
        position: new PhysicalPosition(0, 0),
        rect: { position: new PhysicalPosition(0, 0), size: new PhysicalSize(16, 16) },
      }
      trayOptions.action?.(event)
    },
    setFocusWait: (wait: typeof focusWait) => {
      focusWait = wait
    },
    setBuildWait: (wait: typeof buildWait) => {
      buildWait = wait
    },
    setAttachWait: (wait: typeof attachWait) => {
      attachWait = wait
    },
    stop: () => {
      unmounts.forEach(fn => fn())
      scope.stop()
    },
  }
}

describe('live shared tray menu', () => {
  it('focuses the pet once on left release and keeps the existing right-click menu', async () => {
    const h = trayHarness()
    try {
      await flush()
      const menu = h.attached.at(-1)!
      assert.equal(h.trayOptions.showMenuOnLeftClick, false)
      for (const button of ['Left', 'Right', 'Middle'] as const) h.click(button, 'Down')
      h.click('Right', 'Up')
      h.click('Middle', 'Up')
      await flush()
      assert.deepEqual(h.shown, [])

      h.click('Left', 'Up')
      await flush()
      assert.deepEqual(h.shown, [WINDOW_LABEL.MAIN])
      assert.deepEqual(h.requests, [])
      assert.equal(h.cat.window.alwaysOnTop, false)
      assert.equal(h.attached.at(-1), menu)
      assert.equal(menu.closed, false)
      assert.deepEqual(h.errors, [])
    } finally {
      h.stop()
    }
  })

  it('restores a hidden pet through its visibility owner before focusing an already visible pet', async () => {
    const h = trayHarness()
    try {
      h.cat.window.visible = false
      await flush()
      h.click('Left', 'Up')
      await flush()
      assert.deepEqual(h.requests, [{ label: WINDOW_LABEL.PREFERENCE, event: PRESET_EDIT_REQUEST, visible: true }])
      assert.equal(h.cat.window.visible, true)
      assert.equal(h.attached.at(-1)!.snapshot.visible, true)
      assert.deepEqual(h.shown, [])

      h.click('Left', 'Up')
      await flush()
      assert.deepEqual(h.shown, [WINDOW_LABEL.MAIN])
      assert.equal(h.requests.length, 1)
      assert.equal(h.cat.window.alwaysOnTop, false)
    } finally {
      h.stop()
    }
  })

  it('reports a focus failure and ignores clicks after unmount', async () => {
    const h = trayHarness()
    await flush()
    h.setFocusWait(async () => {
      throw new Error('focus request failed')
    })
    h.click('Left', 'Up')
    await flush()
    assert.equal(h.errors.length, 1)
    h.stop()
    h.setFocusWait(async () => {})
    h.click('Left', 'Up')
    await flush()
    assert.deepEqual(h.shown, [])
  })

  it('refreshes every menu setting and language and releases the replaced native menu', async () => {
    const h = trayHarness()
    try {
      await flush()
      assert.equal(h.attached.length, 1)
      const changes: Array<() => void> = [
        () => {
          h.cat.window.visible = false
        },
        () => {
          h.cat.activePet3dPreset.cameraZoomPercent = 63
        },
        () => {
          h.cat.activePet3dPreset.sceneRotationOffsetDegrees = 360
        },
        () => {
          h.cat.window.opacity = 44
        },
        () => {
          h.cat.window.keepInScreen = false
        },
        () => {
          h.cat.window.alwaysOnTop = true
        },
        () => {
          h.general.appearance.language = 'en-US'
        },
        () => {
          h.general.app.trayVisible = false
        },
      ]
      for (const change of changes) {
        const old = h.attached.at(-1)!
        const count: number = h.attached.length
        change()
        await flush()
        assert.equal(h.attached.length, count + 1)
        assert.equal(old.closed, true)
      }
      assert.deepEqual(h.attached.at(-1)!.snapshot, {
        visible: false,
        scale: 63,
        rotation: 360,
        opacity: 44,
        keepInScreen: false,
        alwaysOnTop: true,
        language: 'en-US',
      })
      assert.equal(h.visibility.at(-1), false)
      assert.deepEqual(h.errors, [])
    } finally {
      h.stop()
    }
  })

  it('discards a stale build and serializes native assignments so the newest menu wins', async () => {
    const h = trayHarness()
    try {
      await flush()
      const staleBuild = deferred()
      h.setBuildWait(async (menu) => {
        if (menu.snapshot.scale === 50) await staleBuild.promise
      })
      h.cat.activePet3dPreset.cameraZoomPercent = 50
      await flush()
      h.cat.activePet3dPreset.cameraZoomPercent = 60
      await flush()
      staleBuild.resolve()
      await flush()
      assert.equal(h.created.find(menu => menu.snapshot.scale === 50)!.closed, true)
      assert.equal(h.attached.some(menu => menu.snapshot.scale === 50), false)
      assert.equal(h.attached.at(-1)!.snapshot.scale, 60)

      const slowAssignment = deferred()
      h.setAttachWait(async (menu) => {
        if (menu.snapshot.scale === 70) await slowAssignment.promise
      })
      h.cat.activePet3dPreset.cameraZoomPercent = 70
      await flush()
      h.cat.activePet3dPreset.cameraZoomPercent = 80
      await flush()
      assert.equal(h.attached.at(-1)!.snapshot.scale, 60)
      slowAssignment.resolve()
      await flush()
      assert.deepEqual(h.attached.slice(-2).map(menu => menu.snapshot.scale), [70, 80])
      assert.equal(h.attached.at(-1)!.snapshot.scale, 80)
    } finally {
      h.stop()
    }
  })

  it('reports a native failure, recovers on the next change, and drops work after unmount', async () => {
    const h = trayHarness()
    await flush()
    h.setAttachWait(async () => {
      throw new Error('native menu failed')
    })
    h.cat.window.opacity = 50
    await flush()
    assert.equal(h.errors.length, 1)
    assert.equal(h.created.at(-1)!.closed, true)
    h.setAttachWait(async () => {})
    h.cat.window.opacity = 75
    await flush()
    assert.equal(h.attached.at(-1)!.snapshot.opacity, 75)
    const gate = deferred()
    h.setBuildWait(() => gate.promise)
    h.cat.window.opacity = 25
    await flush()
    h.stop()
    gate.resolve()
    await flush()
    assert.equal(h.created.at(-1)!.closed, true)
    assert.equal(h.attached.at(-1)!.snapshot.opacity, 75)
  })
})
