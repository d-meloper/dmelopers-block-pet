/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { PRESET_EDIT_REQUEST } from '@/features/presets/types'

import * as menuViewportSetting from './menuViewportSetting'

interface Item {
  text?: string
  item?: string
  checked?: boolean
  enabled?: boolean
  accelerator?: string
  action?: () => void | Promise<unknown>
  items?: Item[]
}

function createMenuHarness(language = 'ko-KR') {
  const cat = {
    window: { visible: true, opacity: 100, keepInScreen: true, passThrough: false, alwaysOnTop: false },
    activePet3dPreset: { cameraZoomPercent: 100, sceneRotationOffsetDegrees: 0 },
  }
  const translations = JSON.parse(readFileSync(new URL(`../locales/${language}.json`, import.meta.url), 'utf8')) as Record<string, unknown>
  const translate = (key: string) => {
    const value = key.split('.').reduce<unknown>((current, part) => {
      return current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
    }, translations)
    assert.equal(typeof value, 'string', `Missing translation: ${key}`)
    return value as string
  }
  const requests: Array<{ label: string, event: string, payload: unknown }> = []
  const shown: unknown[] = []
  const processCalls: string[] = []
  let quitFails = false
  const menus: Item[][] = []
  const apply = menuViewportSetting.createMenuViewportSettingHandler({
    ready: async () => {},
    apply: ({ key, value }) => {
      cat.activePet3dPreset[key] = value
    },
  })
  const exports = {} as { useAppMenu: () => { getAppMenu: () => Promise<{ items: Item[] }> } }
  const mocks: Record<string, unknown> = {
    '@tauri-apps/api/menu': {
      Menu: { new: async ({ items }: { items: Item[] }) => {
        menus.push(items)
        return { items }
      } },
    },
    '@tauri-apps/api/event': {
      emitTo: async (label: string, event: string, payload: unknown) => {
        requests.push({ label, event, payload })
        if (event === LISTEN_KEY.MENU_VIEWPORT_SETTING_REQUEST) await apply(payload)
        if (event === PRESET_EDIT_REQUEST) {
          const request = payload as { visible?: boolean, opacity?: number }
          if (typeof request.visible === 'boolean') cat.window.visible = request.visible
          if (typeof request.opacity === 'number') cat.window.opacity = request.opacity
        }
      },
    },
    '@tauri-apps/plugin-process': {
      exit: async (code: number) => {
        processCalls.push(`exit:${code}`)
      },
    },
    'vue-i18n': { useI18n: () => ({ t: translate }) },
    '@/constants': { LISTEN_KEY, WINDOW_LABEL },
    '@/features/presets/types': { PRESET_EDIT_REQUEST },
    '@/plugins/process': { APP_PROCESS_FAILED: 'app-process-failed', quitApp: async () => {
      processCalls.push('quitApp')
      if (quitFails) throw new Error('save or exit refused')
    }, restartApp: async () => {
      processCalls.push('restartApp')
      if (quitFails) throw new Error('save or restart refused')
    } },
    '@/plugins/window': { showWindow: async (request: unknown) => {
      shown.push(request)
    } },
    '@/stores/cat': { useCatStore: () => cat },
    '@/services/updateDelivery': { updateStatus: { value: { phase: 'idle', targetVersion: null } }, updateProgress: { value: 0 } },
    '@/features/stateSafety': { editorsLocked: { value: false } },
    './menuViewportSetting': menuViewportSetting,
  }
  const source = readFileSync(new URL('./useAppMenu.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => mocks[name] })
  return { cat, menus, requests, shown, processCalls, failQuit: () => {
    quitFails = true
  }, create: exports.useAppMenu }
}

describe('shared pet and tray native menu', () => {
  it('opens Preferences and routes rejected Quit to its existing error UI without invoking direct Exit', async () => {
    for (const language of ['ko-KR', 'en-US']) {
      for (const action of ['quit', 'restart'] as const) {
        const h = createMenuHarness(language)
        h.failQuit()
        const { items } = await h.create().getAppMenu()
        await items.at(action === 'quit' ? -1 : -2)!.action!()
        assert.deepEqual(h.processCalls, [action === 'quit' ? 'quitApp' : 'restartApp'])
        assert.deepEqual(JSON.parse(JSON.stringify(h.shown)), [{ label: 'preference', destination: 'presets' }])
        assert.deepEqual(h.requests.map(request => [request.label, request.event]), [['preference', 'app-process-failed']])
        assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].payload)), { action })
        const locale = JSON.parse(readFileSync(new URL(`../locales/${language}.json`, import.meta.url), 'utf8'))
        assert.equal(typeof locale.composables.useAppMenu.errors[action], 'string')
      }
    }
  })
  it('creates the exact Korean menu and named choices for both callers', async () => {
    const h = createMenuHarness()
    const pet = await h.create().getAppMenu()
    const tray = await h.create().getAppMenu()
    const expected = ['펫 설정', '펫 숨기기', 'Separator', '축소/확대', '회전', '투명도', '화면 안에 유지', '항상 위에 표시', 'Separator', '환경설정', '앱 다시시작', '앱 종료']
    for (const menu of [pet, tray]) {
      assert.deepEqual(Array.from(menu.items, item => item.text ?? item.item), expected)
      assert.deepEqual(Array.from(menu.items[3].items!, item => item.text), ['매우 작게 (25%)', '작게 (50%)', '조금 작게 (75%)', '기본 (100%)', '크게 (125%)', '아주크게 (150%)', '최대 (200%)'])
      assert.deepEqual(Array.from(menu.items[4].items!, item => item.text), ['기본 (0°)', '우측 사선 (45°)', '우측 측면 (90°)', '우측 뒷면 (135°)', '뒷면 (180°)', '좌측 뒷면 (225°)', '좌측 측면 (290°)'])
      assert.deepEqual(Array.from(menu.items[5].items!, item => item.text), ['25%', '50%', '75%', '100%'])
      assert.notEqual(menu.items[4].items![0].enabled, false)
      assert.equal(menu.items[4].items![0].checked, true)
    }
    assert.equal(h.cat.activePet3dPreset.sceneRotationOffsetDegrees, 0)
  })

  it('applies 75 percent through the shared menu and includes it in shortcut cycling', async () => {
    for (const language of ['ko-KR', 'en-US']) {
      const h = createMenuHarness(language)
      const { items } = await h.create().getAppMenu()
      const zoom = items[3].items!
      const entry = zoom.find(item => item.text?.endsWith('(75%)'))!
      assert.ok(entry)
      assert.equal(zoom.indexOf(entry), zoom.findIndex(item => item.text?.endsWith('(50%)')) + 1)
      await entry.action!()
      assert.equal(h.cat.activePet3dPreset.cameraZoomPercent, 75)
      const refreshed = await h.create().getAppMenu()
      assert.equal(refreshed.items[3].items!.find(item => item.text?.endsWith('(75%)'))!.checked, true)
      assert.equal(menuViewportSetting.nextViewportOption('cameraZoomPercent', 50), 75)
      assert.equal(menuViewportSetting.nextViewportOption('cameraZoomPercent', 75), 100)
      assert.equal(menuViewportSetting.nextViewportOption('cameraZoomPercent', 200), 25)
    }
  })

  it('keeps arbitrary settings exact and updates the same values used by Preferences', async () => {
    const h = createMenuHarness()
    h.cat.activePet3dPreset.cameraZoomPercent = 63.5
    h.cat.activePet3dPreset.sceneRotationOffsetDegrees = -27
    h.cat.window.opacity = 44
    const { items } = await h.create().getAppMenu()
    for (const [index, text] of [[3, '63.5%'], [4, '-27°'], [5, '44%']] as const) {
      const current = items[index].items![0]
      assert.equal(current.text, text)
      assert.equal(current.enabled, false)
      assert.equal(current.checked, true)
      assert.equal(current.action, undefined)
    }
    assert.equal(h.cat.activePet3dPreset.cameraZoomPercent, 63.5)
    assert.equal(h.cat.activePet3dPreset.sceneRotationOffsetDegrees, -27)
    assert.equal(h.cat.window.opacity, 44)
    await items[3].items!.find(item => item.text === '작게 (50%)')!.action!()
    await items[4].items!.find(item => item.text === '좌측 측면 (290°)')!.action!()
    assert.equal(h.cat.activePet3dPreset.cameraZoomPercent, 50)
    assert.equal(h.cat.activePet3dPreset.sceneRotationOffsetDegrees, 290)
    const fresh = await h.create().getAppMenu()
    assert.equal(fresh.items[4].items!.find(item => item.text === '좌측 측면 (290°)')!.checked, true)
    assert.equal(fresh.items[4].items!.length, 7)
    await fresh.items[4].items!.find(item => item.text === '기본 (0°)')!.action!()
    assert.equal(h.cat.activePet3dPreset.sceneRotationOffsetDegrees, 0)
    const reset = await h.create().getAppMenu()
    assert.equal(reset.items[4].items![0].checked, true)
    assert.equal(reset.items[4].items!.length, 7)
    assert.deepEqual(h.requests.map(request => [request.label, request.event, JSON.stringify(request.payload)]), [
      ['preference', LISTEN_KEY.MENU_VIEWPORT_SETTING_REQUEST, '{"key":"cameraZoomPercent","value":50}'],
      ['preference', LISTEN_KEY.MENU_VIEWPORT_SETTING_REQUEST, '{"key":"sceneRotationOffsetDegrees","value":290}'],
      ['preference', LISTEN_KEY.MENU_VIEWPORT_SETTING_REQUEST, '{"key":"sceneRotationOffsetDegrees","value":0}'],
    ])
    await items[5].items!.find(item => item.text === '75%')!.action!()
    assert.deepEqual(h.requests.slice(-1).map(request => [request.label, request.event, JSON.stringify(request.payload)]), [
      ['preference', PRESET_EDIT_REQUEST, '{"opacity":75}'],
    ])
    await items[6].action!()
    assert.equal(h.cat.window.opacity, 75)
    assert.equal(h.cat.window.keepInScreen, false)
    assert.equal(h.cat.window.passThrough, false)
    assert.equal(items[7].text, '항상 위에 표시')
    assert.equal(items[7].checked, false)
    await items[7].action!()
    assert.equal(h.cat.window.alwaysOnTop, true)
    assert.equal((await h.create().getAppMenu()).items[7].checked, true)
    h.cat.window.alwaysOnTop = false
    assert.equal((await h.create().getAppMenu()).items[7].checked, false)
  })

  it('opens the requested destination, toggles visibility, and preserves native process actions', async () => {
    const h = createMenuHarness('en-US')
    const { items } = await h.create().getAppMenu()
    assert.equal(items[0].text, 'Pet Settings')
    await items[0].action!()
    await items[9].action!()
    assert.deepEqual(JSON.parse(JSON.stringify(h.shown)), [
      { label: 'preference', destination: 'pet' },
      { label: 'preference', destination: 'general' },
    ])
    assert.equal(items[9].accelerator, '')
    await items[1].action!()
    const hidden = await h.create().getAppMenu()
    assert.equal(hidden.items[1].text, 'Show Pet')
    await hidden.items[1].action!()
    assert.equal(h.cat.window.visible, true)
    assert.deepEqual(h.requests.map(request => [request.label, request.event, JSON.stringify(request.payload)]), [
      ['preference', PRESET_EDIT_REQUEST, '{"visible":false}'],
      ['preference', PRESET_EDIT_REQUEST, '{"visible":true}'],
    ])
    await items[10].action!()
    await items[11].action!()
    assert.deepEqual(h.processCalls, ['restartApp', 'quitApp'])
    assert.equal(items[11].accelerator, '')
  })
})
