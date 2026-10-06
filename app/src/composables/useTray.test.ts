/* eslint-disable test/no-import-node-test */
import type { TrayIconEvent, TrayIconOptions } from '@tauri-apps/api/tray'

import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

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
function trayHarness(existingTray = false, legacyTrayVisible?: boolean) {
  const block = vue.reactive({
    window: { visible: true, opacity: 100, keepInScreen: true, alwaysOnTop: false },
    activePet3dPreset: { cameraZoomPercent: 100, sceneRotationOffsetDegrees: 0 },
  })
  const general = vue.reactive({ app: { broadcastRestorePromptDismissed: false } as { trayVisible?: boolean, broadcastRestorePromptDismissed: boolean }, appearance: { language: 'ko-KR' }, broadcast: { enabled: false, showOnDesktop: false } })
  if (legacyTrayVisible !== undefined) general.app.trayVisible = legacyTrayVisible
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
  let iconVisible = existingTray && legacyTrayVisible !== false
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
      iconVisible = visible
    },
  }
  const exports = {} as { useTray: typeof useTray }
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/app': { getVersion: async () => '0.2.0' },
    '@tauri-apps/api/event': { emitTo: async (label: string, event: string, payload: { visible: boolean }) => {
      requests.push({ label, event, visible: payload.visible })
      block.window.visible = payload.visible
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
        iconVisible = true
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
    '@/stores/block': { useBlockStore: () => block },
    '@/stores/general': { useGeneralStore: () => general },
    '@/features/stateSafety': { editorsLocked: locked },
    '@/utils/latestAsyncTask': { createLatestAsyncTaskQueue },
    './useAppMenu': { useAppMenu: () => ({
      getAppMenu: async () => {
        const menu: MockMenu = {
          snapshot: {
            visible: block.window.visible,
            scale: block.activePet3dPreset.cameraZoomPercent,
            rotation: block.activePet3dPreset.sceneRotationOffsetDegrees,
            opacity: block.window.opacity,
            keepInScreen: block.window.keepInScreen,
            alwaysOnTop: block.window.alwaysOnTop,
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
    block,
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
    get iconVisible() {
      return iconVisible
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
  it('keeps the tray active with legacy OFF settings, including a hidden native icon retained across reload', async () => {
    for (const existingTray of [false, true]) {
      const h = trayHarness(existingTray, false)
      try {
        await flush()
        assert.equal(h.iconVisible, true)
        assert.equal(h.creations, 1)
        assert.equal(h.removals, existingTray ? 1 : 0)
        const menuCount = h.attached.length
        h.general.app.trayVisible = true
        await flush()
        h.general.app.trayVisible = false
        await flush()
        assert.equal(h.attached.length, menuCount, 'Retired visibility data cannot trigger tray work')
        assert.equal(h.iconVisible, true)
        h.general.appearance.language = 'en-US'
        await flush()
        assert.equal(h.attached.at(-1)!.snapshot.language, 'en-US')
        assert.equal(h.iconVisible, true)
        assert.equal(h.creations, 1)
        assert.deepEqual(h.visibility, [])
        assert.deepEqual(h.errors, [])
      } finally {
        h.stop()
      }
    }
  })

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
      assert.equal(h.block.window.visible, true)
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
            h.block.window.visible = visible
            await flush()
            const before = JSON.stringify({ block: h.block, general: h.general })
            h.click('Left', 'Up')
            await flush()
            const needsPrompt = enabled && (!visible || !showOnDesktop)
            assert.equal(h.state.broadcastPromptOpen.value, needsPrompt)
            if (needsPrompt) {
              assert.deepEqual(h.shown, [undefined]) // Native current window; no navigation destination.
              assert.deepEqual(h.requests, [])
              assert.equal(JSON.stringify({ block: h.block, general: h.general }), before)
              const preset = JSON.stringify(h.block.activePet3dPreset)
              h.state.confirmBroadcastRestore()
              assert.equal(h.block.window.visible, true)
              assert.equal(h.general.broadcast.showOnDesktop, true)
              assert.equal(h.general.broadcast.enabled, true)
              assert.equal(JSON.stringify(h.block.activePet3dPreset), preset)
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
      h.block.window.visible = false
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
      assert.equal(h.block.window.visible, false)
      assert.equal(h.general.broadcast.showOnDesktop, false)
      h.state.finishBroadcastPrompt()
      h.click('Left', 'Up')
      assert.equal(h.state.broadcastPromptOpen.value, true)
    } finally {
      h.stop()
    }
  })

  it('dismisses the prompt permanently and opens only Preferences across closing and broadcast toggles', async () => {
    const h = trayHarness()
    try {
      h.general.broadcast.enabled = true
      h.block.window.visible = false
      await flush()
      h.click('Left', 'Up')
      h.state.cancelBroadcastRestore()
      assert.equal(h.general.app.broadcastRestorePromptDismissed, false)
      h.state.finishBroadcastPrompt()
      h.click('Left', 'Up')
      h.state.dismissBroadcastRestore()
      assert.equal(h.general.app.broadcastRestorePromptDismissed, true)
      assert.equal(h.state.broadcastPromptOpen.value, false)
      h.state.confirmBroadcastRestore()
      h.click('Left', 'Up')
      assert.equal(h.state.broadcastPromptOpen.value, false, 'closing animation cannot revive the dismissed prompt')
      h.state.finishBroadcastPrompt()
      h.general.broadcast.enabled = false
      h.general.broadcast.enabled = true
      h.click('Left', 'Up')
      await flush()
      assert.deepEqual(h.shown, [undefined, undefined, undefined, undefined])
      assert.deepEqual(h.requests, [])
      assert.equal(h.block.window.visible, false)
      assert.equal(h.general.broadcast.showOnDesktop, false)
      assert.equal(h.general.broadcast.enabled, true)
    } finally {
      h.stop()
    }
  })

  it('renders the actual prompt footer in order with matching neutral buttons and guarded actions', async () => {
    const h = trayHarness()
    try {
      h.general.broadcast.enabled = true
      await flush()
      h.click('Left', 'Up')
      const shell = readFileSync(new URL('../pages/preference/index.vue', import.meta.url), 'utf8')
      const template = parse(shell).descriptor.template!.content.match(/<Modal[\s\S]*?<\/Modal>/)![0]
      const component = compileScript(parse(`<script setup lang="ts">
        import { Button, Flex, Modal } from 'ant-design-vue'
        const { tray } = defineProps<{ tray: unknown }>()
        const t = (key: string) => key
      </script><template>${template}</template>`).descriptor, { id: 'broadcast-footer', inlineTemplate: true })
      const exports = {} as { default: { setup: (props: object, context: object) => (_context: object, cache: unknown[]) => vue.VNode } }
      runInNewContext(ts.transpileModule(component.content, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText, { exports, require: (name: string) => name === 'vue' ? vue : { Button: 'button', Flex: 'div', Modal: { name: 'modal' } } })
      const render = exports.default.setup({ tray: h.state }, {})
      const footer = () => {
        const modal = render({}, [])
        return (modal.children as { footer: () => vue.VNode[] }).footer()[0].children as vue.VNode[]
      }
      const buttons = Array.from(footer())
      const buttonText = (button: vue.VNode) => (Array.isArray(button.children)
        ? button.children.map(child => vue.isVNode(child) ? child.children : child).join('')
        : button.children as string).trim()
      assert.deepEqual(buttons.map(buttonText), [
        'pages.preference.broadcastRestore.dismiss',
        'pages.preference.broadcastRestore.cancel',
        'pages.preference.broadcastRestore.enable',
      ])
      assert.equal(buttons[0].props?.type, buttons[1].props?.type)
      assert.equal(buttons[2].props?.type, 'primary')
      assert.equal(buttons[0].props?.disabled, false)
      h.locked.value = true
      assert.equal(footer()[0].props?.disabled, true)
      h.locked.value = false
      buttons[0].props!.onClick()
      assert.equal(h.general.app.broadcastRestorePromptDismissed, true)
      assert.equal(h.state.broadcastPromptOpen.value, false)
      assert.equal(h.general.broadcast.showOnDesktop, false)
    } finally {
      h.stop()
    }
  })

  it('uses the retained dismissal after a new tray owner is created', async () => {
    const h = trayHarness(true)
    try {
      h.general.app.broadcastRestorePromptDismissed = true
      h.general.broadcast.enabled = true
      await flush()
      h.click('Left', 'Up')
      await flush()
      assert.equal(h.state.broadcastPromptOpen.value, false)
      assert.deepEqual(h.shown, [undefined])
      assert.deepEqual(h.requests, [])
      assert.equal(h.general.broadcast.showOnDesktop, false)
    } finally {
      h.stop()
    }
  })

  it('blocks both opening and confirmation during editor locks or preset work, and ignores stale callbacks after unmount', async () => {
    const h = trayHarness()
    h.general.broadcast.enabled = true
    h.block.window.visible = false
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
      h.state.dismissBroadcastRestore()
      assert.equal(h.general.app.broadcastRestorePromptDismissed, false)
      assert.equal(h.block.window.visible, false)
      assert.equal(h.general.broadcast.showOnDesktop, false)
      block.value = block !== h.locked
    }
    h.stop()
    h.state.confirmBroadcastRestore()
    h.state.dismissBroadcastRestore()
    assert.equal(h.general.app.broadcastRestorePromptDismissed, false)
    h.click('Left', 'Up')
    assert.equal(h.state.broadcastPromptOpen.value, false)
    assert.equal(h.state.broadcastPromptActive.value, false)
    assert.equal(h.block.window.visible, false)
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
      assert.equal(h.block.window.alwaysOnTop, false)
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
      h.block.window.visible = false
      await flush()
      h.click('Left', 'Up')
      await flush()
      assert.deepEqual(h.requests, [{ label: WINDOW_LABEL.PREFERENCE, event: PRESET_EDIT_REQUEST, visible: true }])
      assert.equal(h.block.window.visible, true)
      assert.equal(h.attached.at(-1)!.snapshot.visible, true)
      assert.deepEqual(h.shown, [])

      h.click('Left', 'Up')
      await flush()
      assert.deepEqual(h.shown, [WINDOW_LABEL.MAIN])
      assert.equal(h.requests.length, 1)
      assert.equal(h.block.window.alwaysOnTop, false)
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
          h.block.window.visible = false
        },
        () => {
          h.block.activePet3dPreset.cameraZoomPercent = 63
        },
        () => {
          h.block.activePet3dPreset.sceneRotationOffsetDegrees = 360
        },
        () => {
          h.block.window.opacity = 44
        },
        () => {
          h.block.window.keepInScreen = false
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
      assert.equal(h.iconVisible, true)
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
      h.block.activePet3dPreset.cameraZoomPercent = 50
      await flush()
      h.block.activePet3dPreset.cameraZoomPercent = 60
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
      h.block.activePet3dPreset.cameraZoomPercent = 70
      await flush()
      h.block.activePet3dPreset.cameraZoomPercent = 80
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
    h.block.window.opacity = 50
    await flush()
    assert.equal(h.errors.length, 1)
    assert.equal(h.created.at(-1)!.closed, true)
    h.setAttachWait(async () => {})
    h.block.window.opacity = 75
    await flush()
    assert.equal(h.attached.at(-1)!.snapshot.opacity, 75)
    const gate = deferred()
    h.setBuildWait(() => gate.promise)
    h.block.window.opacity = 25
    await flush()
    h.stop()
    gate.resolve()
    await flush()
    assert.equal(h.created.at(-1)!.closed, true)
    assert.equal(h.attached.at(-1)!.snapshot.opacity, 75)
  })
})
