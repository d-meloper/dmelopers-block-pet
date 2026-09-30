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

import type { useTray } from './useTray'

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
function trayHarness(existingTray = false) {
  const cat = vue.reactive({
    window: { visible: true, opacity: 100, keepInScreen: true, alwaysOnTop: false },
    activePet3dPreset: { cameraZoomPercent: 100, sceneRotationOffsetDegrees: 0 },
  })
  const general = vue.reactive({ app: { trayVisible: true }, appearance: { language: 'ko-KR' }, broadcast: { enabled: false, showOnDesktop: false } })
  const locked = vue.ref(false)
  const editable = vue.ref(true)
  const created: MockMenu[] = []
  const attached: MockMenu[] = []
  const visibility: boolean[] = []
  const shown: Array<string | undefined> = []
  const requests: Array<{ label: string, event: string, visible: boolean }> = []
  let trayOptions: Pick<TrayIconOptions, 'action' | 'showMenuOnLeftClick'> = {}
  let focusWait = async () => {}
  const errors: unknown[] = []
  const unmounts: Array<() => void> = []
  let trayExists = existingTray
  let creations = 0
  let removals = 0
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
  const exports = {} as { useTray: typeof useTray }
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/app': { getVersion: async () => '0.2.0' },
    '@tauri-apps/api/event': { emitTo: async (label: string, event: string, payload: { visible: boolean }) => {
      requests.push({ label, event, visible: payload.visible })
      cat.window.visible = payload.visible
    } },
    '@tauri-apps/api/path': { resolveResource: async (path: string) => path },
    '@tauri-apps/api/tray': { TrayIcon: {
      getById: async () => trayExists ? tray : null,
      removeById: async (id: string) => {
        assert.equal(id, 'DMELOPERS_BLOCK_PET_TRAY')
        assert.equal(trayExists, true)
        removals++
        trayExists = false
        trayOptions = {}
      },
      new: async ({ menu, tooltip, ...options }: { menu: MockMenu, tooltip: string } & typeof trayOptions) => {
        assert.equal(trayExists, false, 'Replace a retained native icon before creating another')
        creations++
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
    '@/plugins/window': { showWindow: async (label?: string) => {
      await focusWait()
      shown.push(label)
    } },
    '@/stores/cat': { useCatStore: () => cat },
    '@/stores/general': { useGeneralStore: () => general },
    '@/features/stateSafety': { editorsLocked: locked },
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
  const state = scope.run(() => exports.useTray(() => editable.value))!
  return {
    state,
    locked,
    editable,
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
    get creations() {
      return creations
    },
    get removals() {
      return removals
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
  it('reclaims a retained native tray after reload and keeps the new click handler across menu refreshes', async () => {
    const h = trayHarness(true)
    try {
      h.general.broadcast.enabled = true
      h.general.broadcast.showOnDesktop = false
      await flush()
      h.click('Left', 'Up')
      await flush()
      assert.equal(h.state.broadcastPromptOpen.value, true)
      assert.deepEqual(h.shown, [undefined])
      assert.equal(h.removals, 1)
      assert.equal(h.creations, 1)
      assert.equal(h.trayOptions.showMenuOnLeftClick, false)

      h.state.cancelBroadcastRestore()
      h.state.finishBroadcastPrompt()
      h.general.appearance.language = 'en-US'
      await flush()
      h.click('Left', 'Up')
      await flush()
      assert.equal(h.state.broadcastPromptOpen.value, true)
      assert.equal(h.removals, 1)
      assert.equal(h.creations, 1)
      h.state.confirmBroadcastRestore()
      assert.equal(h.general.broadcast.showOnDesktop, true)
      assert.equal(h.cat.window.visible, true)
      assert.equal(h.general.broadcast.enabled, true)
      assert.deepEqual(h.errors, [])
    } finally {
      h.stop()
    }
  })

  it('offers restore only for broadcast-enabled hidden combinations and preserves all settings until confirmation', async () => {
    for (const enabled of [false, true]) {
      for (const visible of [false, true]) {
        for (const showOnDesktop of [false, true]) {
          const h = trayHarness()
          try {
            h.general.broadcast.enabled = enabled
            h.general.broadcast.showOnDesktop = showOnDesktop
            h.cat.window.visible = visible
            await flush()
            const before = JSON.stringify({ cat: h.cat, general: h.general })
            h.click('Left', 'Up')
            await flush()
            const needsPrompt = enabled && (!visible || !showOnDesktop)
            assert.equal(h.state.broadcastPromptOpen.value, needsPrompt)
            if (needsPrompt) {
              assert.deepEqual(h.shown, [undefined]) // Native current window; no navigation destination.
              assert.deepEqual(h.requests, [])
              assert.equal(JSON.stringify({ cat: h.cat, general: h.general }), before)
              const preset = JSON.stringify(h.cat.activePet3dPreset)
              h.state.confirmBroadcastRestore()
              assert.equal(h.cat.window.visible, true)
              assert.equal(h.general.broadcast.showOnDesktop, true)
              assert.equal(h.general.broadcast.enabled, true)
              assert.equal(JSON.stringify(h.cat.activePet3dPreset), preset)
              assert.equal(h.state.broadcastPromptOpen.value, false)
              assert.equal(h.state.broadcastPromptActive.value, true)
              h.state.finishBroadcastPrompt()
              assert.equal(h.state.broadcastPromptActive.value, false)
            } else {
              assert.deepEqual(h.shown, visible ? [WINDOW_LABEL.MAIN] : [])
              assert.equal(h.requests.length, visible ? 0 : 1)
              assert.equal(h.general.broadcast.showOnDesktop, showOnDesktop)
            }
          } finally {
            h.stop()
          }
        }
      }
    }
  })

  it('does not duplicate a prompt or mutate cancelled choices, including its closing transition', async () => {
    const h = trayHarness()
    try {
      h.general.broadcast.enabled = true
      h.cat.window.visible = false
      await flush()
      for (const button of ['Right', 'Middle'] as const) h.click(button, 'Up')
      h.click('Left', 'Down')
      assert.equal(h.state.broadcastPromptActive.value, false)
      h.click('Left', 'Up')
      h.click('Left', 'Up')
      await flush()
      assert.equal(h.state.broadcastPromptOpen.value, true)
      h.state.cancelBroadcastRestore()
      h.state.confirmBroadcastRestore() // A stale OK callback cannot accept a cancelled prompt.
      h.click('Left', 'Up')
      assert.equal(h.state.broadcastPromptOpen.value, false)
      assert.equal(h.state.broadcastPromptActive.value, true)
      assert.equal(h.cat.window.visible, false)
      assert.equal(h.general.broadcast.showOnDesktop, false)
      h.state.finishBroadcastPrompt()
      h.click('Left', 'Up')
      assert.equal(h.state.broadcastPromptOpen.value, true)
    } finally {
      h.stop()
    }
  })

  it('blocks both opening and confirmation during editor locks or preset work, and ignores stale callbacks after unmount', async () => {
    const h = trayHarness()
    h.general.broadcast.enabled = true
    h.cat.window.visible = false
    await flush()
    for (const block of [h.locked, h.editable]) {
      block.value = block === h.locked
      h.click('Left', 'Up')
      assert.equal(h.state.broadcastPromptOpen.value, false)
      block.value = block !== h.locked
    }
    h.click('Left', 'Up')
    for (const block of [h.locked, h.editable]) {
      block.value = block === h.locked
      assert.equal(h.state.broadcastRestoreDisabled.value, true)
      h.state.confirmBroadcastRestore()
      assert.equal(h.cat.window.visible, false)
      assert.equal(h.general.broadcast.showOnDesktop, false)
      block.value = block !== h.locked
    }
    h.stop()
    h.state.confirmBroadcastRestore()
    h.click('Left', 'Up')
    assert.equal(h.state.broadcastPromptOpen.value, false)
    assert.equal(h.state.broadcastPromptActive.value, false)
    assert.equal(h.cat.window.visible, false)
    assert.equal(h.general.broadcast.showOnDesktop, false)
  })

  it('retains a failed-to-show prompt for a later tray retry without changing visibility', async () => {
    const h = trayHarness()
    try {
      h.general.broadcast.enabled = true
      h.setFocusWait(async () => {
        throw new Error('native show failed')
      })
      await flush()
      h.click('Left', 'Up')
      await flush()
      assert.equal(h.errors.length, 1)
      assert.equal(h.state.broadcastPromptOpen.value, true)
      assert.equal(h.general.broadcast.showOnDesktop, false)
      h.setFocusWait(async () => {})
      h.click('Left', 'Up')
      await flush()
      assert.deepEqual(h.shown, [undefined])
    } finally {
      h.stop()
    }
  })

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
          h.general.broadcast.enabled = true
        },
        () => {
          h.general.broadcast.showOnDesktop = true
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
        alwaysOnTop: false,
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
