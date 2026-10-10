/* eslint-disable test/no-import-node-test */
import { Menu } from '@tauri-apps/api/menu'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'

import * as menuViewportSetting from '@/composables/menuViewportSetting'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { isDesktopPetVisible } from '@/features/broadcast/visibility'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'

const appMenuSource = readFileSync(new URL('../../composables/useAppMenu.ts', import.meta.url), 'utf8')
const mainSource = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content
const syntax = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const popupFunction = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'showContextMenu')!

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

interface Channel {
  id: number
  onmessage: (message: string) => unknown
}
interface NativeItem { id?: string, handler?: Channel, items?: NativeItem[] }
interface NativeOptions { id?: string, items?: NativeItem[] }

/** Real pinned JS SDK; native tables model the inspected Tauri menu plugin. */
function nativeHarness() {
  const resources = new Map<number, NativeOptions>()
  const channels = new Map<string, Channel>()
  const callbacks = new Map<number, (message: { end: boolean, index: number }) => void>()
  let callbackId = 0
  let nextRid = 0
  let generatedId = 0
  let creations = 0
  let popups = 0
  let closes = 0
  let construction: ReturnType<typeof deferred> | undefined
  let popup: ReturnType<typeof deferred> | undefined
  let constructionError: Error | undefined
  let popupError: Error | undefined
  let closeError: Error | undefined
  function retain(id: string | undefined, handler: Channel) {
    const key = id ?? `generated-${++generatedId}`
    const previous = channels.get(key)
    // Rust ChannelInner::drop signals the replaced channel's end.
    if (previous) callbacks.get(previous.id)?.({ end: true, index: 0 })
    channels.set(key, handler)
  }
  const runtime = {
    transformCallback: (callback: (message: { end: boolean, index: number }) => void) => {
      callbacks.set(++callbackId, callback)
      return callbackId
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    invoke: async (command: string, args: { options: NativeOptions, handler: Channel, rid: number }) => {
      if (command === 'plugin:menu|new') {
        creations++
        if (constructionError) throw constructionError
        const visit = (items: NativeItem[]) => items.forEach((item) => {
          if (item.handler) retain(item.id, item.handler)
          if (item.items) visit(item.items)
        })
        visit(args.options.items ?? [])
        retain(args.options.id, args.handler)
        const rid = ++nextRid
        resources.set(rid, args.options)
        await construction?.promise
        return [rid, args.options.id ?? `generated-${++generatedId}`]
      }
      if (command === 'plugin:custom-window|popup_pet_menu') {
        assert.ok(resources.has(args.rid), 'popup owns a live native resource')
        popups++
        await popup?.promise
        if (popupError) throw popupError
        return
      }
      if (command === 'plugin:resources|close') {
        closes++
        assert.ok(resources.delete(args.rid), 'each resource is closed exactly once')
        if (closeError) throw closeError
        return
      }
      assert.fail(`Unexpected native command: ${command}`)
    },
  }
  Object.defineProperty(globalThis, 'window', { value: { __TAURI_INTERNALS__: runtime }, configurable: true })
  return {
    resources,
    channels,
    callbacks,
    counts: () => ({ creations, popups, closes }),
    holdConstruction: () => (construction = deferred()),
    holdPopup: () => (popup = deferred()),
    failConstruction: (error?: Error) => {
      constructionError = error
    },
    failPopup: (error?: Error) => {
      popupError = error
    },
    failClose: (error?: Error) => {
      closeError = error
    },
  }
}

function menuHarness(label: string) {
  const block = {
    window: { visible: true, opacity: 100, keepInScreen: true, alwaysOnTop: true },
    activePet3dPreset: { cameraZoomPercent: 100, sceneRotationOffsetDegrees: 0 },
  }
  const general = { broadcast: { enabled: false, showOnDesktop: false } }
  const requests: Array<{ label: string, event: string, payload: unknown }> = []
  let language = 'ko-KR'
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/menu': { Menu },
    '@tauri-apps/api/event': { emitTo: async (label: string, event: string, payload: unknown) => {
      requests.push({ label, event, payload })
    } },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({ label }) },
    'vue-i18n': { useI18n: () => ({ t: (key: string) => `${language}:${key}` }) },
    '@/constants': { LISTEN_KEY, WINDOW_LABEL },
    '@/features/broadcast/visibility': { isDesktopPetVisible },
    '@/features/presets/types': { PRESET_EDIT_REQUEST },
    '@/features/stateSafety': { editorsLocked: { value: false } },
    '@/plugins/process': { quitApp: async () => {}, restartApp: async () => {} },
    '@/plugins/window': { showWindow: async () => {} },
    '@/stores/block': { useBlockStore: () => block },
    '@/stores/general': { useGeneralStore: () => general },
    './menuViewportSetting': menuViewportSetting,
  }
  const exports = {} as { useAppMenu: () => { getAppMenu: () => Promise<Menu> } }
  runInNewContext(ts.transpileModule(appMenuSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => mocks[name] })
  const owner = exports.useAppMenu()
  const warnings: unknown[][] = []
  const context = {
    componentMounted: true,
    blockStore: block,
    getAppMenu: owner.getAppMenu,
    popupPetMenu: (rid: number) => (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: { rid: number }) => Promise<void> } }).__TAURI_INTERNALS__.invoke('plugin:custom-window|popup_pet_menu', { rid }),
    console: { warn: (...args: unknown[]) => warnings.push(args) },
    popup: undefined as undefined | (() => Promise<void>),
    pending: undefined as undefined | (() => boolean),
  }
  runInNewContext(ts.transpileModule(`let contextMenuPending = false
${popupFunction.getText(syntax)}
globalThis.popup = showContextMenu
globalThis.pending = () => contextMenuPending`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  return {
    ...owner,
    block,
    context,
    requests,
    warnings,
    popup: () => context.popup!(),
    pending: () => context.pending!(),
    language: (value: string) => {
      language = value
    },
  }
}

describe('native pet context menu ownership', () => {
  it('keeps the resource until native popup completion even if the frontend owner retires', async () => {
    const native = nativeHarness()
    const h = menuHarness('main')
    const held = native.holdPopup()
    const pending = h.popup()
    for (let index = 0; index < 20 && native.counts().popups === 0; index++) await Promise.resolve()
    assert.equal(native.counts().popups, 1)
    h.context.componentMounted = false
    assert.equal(native.resources.size, 1)
    assert.equal(native.counts().closes, 0)
    held.resolve()
    await pending
    assert.deepEqual(native.counts(), { creations: 1, popups: 1, closes: 1 })
    assert.equal(h.pending(), false)
  })

  it('bounds real SDK resources and callback channels over repeated and changed menus', async () => {
    const native = nativeHarness()
    const h = menuHarness('main')
    for (let index = 0; index < 30; index++) {
      h.block.window.visible = index % 2 === 0
      h.block.activePet3dPreset.cameraZoomPercent = index % 2 ? 63.5 : 100
      h.block.activePet3dPreset.sceneRotationOffsetDegrees = index % 2 ? -27 : 0
      h.block.window.opacity = index % 2 ? 44 : 100
      h.language(index % 2 ? 'en-US' : 'ko-KR')
      await h.popup()
      assert.equal(native.resources.size, 0)
      assert.equal(native.channels.size, index === 0 ? 25 : 26)
      assert.equal(native.callbacks.size, index === 0 ? 25 : 26)
    }
    assert.deepEqual(native.counts(), { creations: 30, popups: 30, closes: 30 })
    await native.channels.get('block-pet-app-menu:main:zoom:50')!.onmessage('zoom')
    assert.deepEqual(JSON.parse(JSON.stringify(h.requests.at(-1)!.payload)), { key: 'cameraZoomPercent', value: 50 })
  })

  it('separates simultaneous pet and tray action owners while replacing their old channels', async () => {
    const native = nativeHarness()
    const main = menuHarness('main')
    const tray = menuHarness('preference')
    const firstTray = await tray.getAppMenu()
    await main.popup()
    main.block.window.visible = false
    const secondTray = await tray.getAppMenu()
    await firstTray.close()
    await main.popup()
    assert.equal(native.resources.size, 1)
    assert.equal(native.channels.size, 51)
    assert.equal(native.callbacks.size, 51)
    await native.channels.get('block-pet-app-menu:main:visibility:show')!.onmessage('visibility')
    await native.channels.get('block-pet-app-menu:preference:visibility:hide')!.onmessage('visibility')
    assert.deepEqual(JSON.parse(JSON.stringify(main.requests.at(-1)!.payload)), { desktopVisible: true })
    assert.deepEqual(JSON.parse(JSON.stringify(tray.requests.at(-1)!.payload)), { desktopVisible: false })
    await secondTray.close()
    assert.equal(native.resources.size, 0)
  })

  it('retains the attached tray menu actions when a replacement cannot be attached', async () => {
    const native = nativeHarness()
    const h = menuHarness('preference')
    const attached = await h.getAppMenu()
    const attachedVisibilityId = native.resources.get(attached.rid)!.items![0].id!
    h.block.window.visible = false
    const rejectedReplacement = await h.getAppMenu()
    // Native setMenu fails: the previous "Hide Pet" menu remains attached.
    await rejectedReplacement.close()
    await native.channels.get(attachedVisibilityId)!.onmessage('visibility')
    assert.deepEqual(JSON.parse(JSON.stringify(h.requests.at(-1)!.payload)), { desktopVisible: false })
    await attached.close()
  })

  it('blocks duplicate construction and closes a menu received after its component retires', async () => {
    const native = nativeHarness()
    const h = menuHarness('main')
    const held = native.holdConstruction()
    const pending = h.popup()
    assert.equal(h.pending(), true)
    await h.popup()
    assert.equal(native.counts().creations, 1)
    h.context.componentMounted = false
    held.resolve()
    await pending
    assert.deepEqual(native.counts(), { creations: 1, popups: 0, closes: 1 })
    assert.equal(native.resources.size, 0)
    assert.equal(h.pending(), false)
    await h.popup()
    assert.equal(native.counts().creations, 1)
  })

  it('keeps the native menu alive during popup, blocks duplicates, and preserves the saved setting', async () => {
    const native = nativeHarness()
    const h = menuHarness('main')
    const held = native.holdPopup()
    const pending = h.popup()
    for (let index = 0; index < 10 && native.counts().popups === 0; index++) await Promise.resolve()
    assert.equal(native.counts().popups, 1)
    assert.equal(native.resources.size, 1)
    await h.popup()
    assert.equal(native.counts().creations, 1)
    h.block.window.alwaysOnTop = false
    held.resolve()
    await pending
    assert.equal(native.resources.size, 0)
    assert.equal(h.block.window.alwaysOnTop, false)
    assert.equal(h.pending(), false)
    await h.popup()
    assert.equal(native.counts().creations, 2)
  })

  it('attempts independent cleanup without replacing the original popup error and permits retry', async () => {
    const native = nativeHarness()
    const h = menuHarness('main')
    const popupError = new Error('Popup failed')
    native.failPopup(popupError)
    native.failClose(new Error('Close acknowledgement lost'))
    await assert.rejects(h.popup(), error => error === popupError)
    assert.equal(h.warnings.length, 1)
    assert.equal(native.resources.size, 0)
    assert.equal(h.pending(), false)
    native.failPopup()
    native.failClose()
    await h.popup()
    assert.deepEqual(native.counts(), { creations: 2, popups: 2, closes: 2 })
  })

  it('releases the duplicate guard when construction fails before a resource exists', async () => {
    const native = nativeHarness()
    const h = menuHarness('main')
    const failure = new Error('Menu unavailable')
    native.failConstruction(failure)
    await assert.rejects(h.popup(), error => error === failure)
    assert.equal(h.pending(), false)
    assert.equal(native.resources.size, 0)
    native.failConstruction()
    await h.popup()
    assert.deepEqual(native.counts(), { creations: 2, popups: 1, closes: 1 })
  })
})
