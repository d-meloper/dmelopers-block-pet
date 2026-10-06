/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'

import type * as PreferenceNavigation from '../pages/preference/navigation'
import type * as WindowPlugin from './window'

import * as windowNavigation from './windowNavigation'
import { createWindowVisibilityQueue } from './windowVisibility'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}
function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/preference', component: {} }, { path: '/', component: {} }],
  })
}
function preferenceNavigation(router: ReturnType<typeof makeRouter>) {
  const exports = {} as typeof PreferenceNavigation
  const mocks: Record<string, unknown> = {
    'vue': vue,
    'vue-router': {
      useRoute: () => ({ get query() {
        return router.currentRoute.value.query
      } }),
      useRouter: () => router,
    },
    '@/plugins/windowNavigation': windowNavigation,
  }
  const source = readFileSync(new URL('../pages/preference/navigation.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => mocks[name] })
  return exports.usePreferenceNavigation()
}

describe('window destination and preference navigation', () => {
  it('starts on General in a fresh session and retains each selected tab when reopening', async () => {
    const router = makeRouter()
    await router.push('/preference')
    const page = preferenceNavigation(router)
    const shown: number[] = []
    const handler = windowNavigation.createShowWindowRequestHandler({
      label: 'preference',
      router,
      show: async () => {
        shown.push(page.current.value)
      },
    })
    await handler('preference')
    assert.deepEqual(shown, [6])
    for (const tab of [1, 2, 3, 0, 4, 6, 5, 7]) {
      page.current.value = tab
      await flush()
      await handler('preference')
      assert.equal(shown.at(-1), tab)
    }
    const restartedRouter = makeRouter()
    await restartedRouter.push('/preference')
    assert.equal(preferenceNavigation(restartedRouter).current.value, 6)
  })

  it('stores the skin target before the hidden preference page is ready, then shows and focuses it', async () => {
    const router = makeRouter()
    const ready = deferred()
    const shown: string[] = []
    const handler = windowNavigation.createShowWindowRequestHandler({
      label: 'preference',
      router: { ...router, isReady: () => ready.promise },
      show: async () => {
        shown.push(router.currentRoute.value.fullPath)
      },
    })
    const request = handler({ label: 'preference', destination: 'skin-library' })
    await flush()
    assert.deepEqual(shown, [])
    await router.push('/preference?retained=yes')
    ready.resolve()
    await request
    assert.deepEqual(shown, ['/preference?retained=yes&view=skin-library'])
    // The page mounts after the root listener has already retained the target.
    const page = preferenceNavigation(router)
    assert.equal(page.current.value, 6)
    assert.equal(page.innerView.value, 'skin-library')
    await page.closeInnerView()
    assert.equal(page.current.value, 1)
    assert.equal(page.innerView.value, undefined)
    assert.equal(router.currentRoute.value.query.retained, 'yes')
  })

  it('closes the library for ordinary Preferences while preserving the prior tab, and Back returns to Pet', async () => {
    const router = makeRouter()
    await router.push('/preference')
    const page = preferenceNavigation(router)
    const shown: string[] = []
    const handler = windowNavigation.createShowWindowRequestHandler({
      label: 'preference',
      router,
      show: async () => {
        shown.push(router.currentRoute.value.fullPath)
      },
    })
    page.current.value = 2
    await flush()
    await handler({ label: 'preference', destination: 'skin-library' })
    assert.equal(page.innerView.value, 'skin-library')
    await handler('preference')
    assert.equal(page.innerView.value, undefined)
    assert.equal(page.current.value, 2)
    await handler({ label: 'preference', destination: 'skin-library' })
    await page.closeInnerView()
    assert.equal(page.current.value, 1)
    await page.openSkinLibrary()
    assert.equal(page.innerView.value, 'skin-library')
    assert.equal(shown.length, 3)
  })

  it('opens Presets from other tabs and the library, and allows selecting another tab before reopening', async () => {
    const router = makeRouter()
    await router.push('/preference?tab=4&view=skin-library&retained=yes')
    const page = preferenceNavigation(router)
    const shown: Array<{ tab: number, view: string | undefined }> = []
    const handler = windowNavigation.createShowWindowRequestHandler({
      label: 'preference',
      router,
      show: async () => {
        shown.push({ tab: page.current.value, view: page.innerView.value })
      },
    })
    assert.equal(page.current.value, 4)
    await handler({ label: 'preference', destination: 'presets' })
    assert.deepEqual(shown, [{ tab: 0, view: undefined }])
    assert.equal(router.currentRoute.value.query.retained, 'yes')
    // A page mounted after the request also opens the retained destination.
    assert.equal(preferenceNavigation(router).current.value, 0)

    page.current.value = 2
    await flush()
    await handler('preference')
    assert.equal(page.current.value, 2)
    await handler({ label: 'preference', destination: 'presets' })
    await handler({ label: 'preference', destination: 'presets' })
    assert.equal(page.current.value, 0)
    assert.deepEqual(shown.slice(-2), [{ tab: 0, view: undefined }, { tab: 0, view: undefined }])

    await page.openSkinLibrary()
    await page.closeInnerView()
    assert.equal(page.current.value, 1)
    await handler({ label: 'preference', destination: 'presets' })
    assert.equal(page.current.value, 0)
    assert.equal(page.innerView.value, undefined)

    for (const [destination, tab] of [['pet', 1], ['general', 6]] as const) {
      await page.openSkinLibrary()
      await handler({ label: 'preference', destination })
      assert.deepEqual(shown.at(-1), { tab, view: undefined })
      assert.equal(router.currentRoute.value.query.retained, 'yes')
      assert.equal(preferenceNavigation(router).current.value, tab)
    }
  })

  it('serializes rapid destination requests and keeps later requests usable after a native failure', async () => {
    const router = makeRouter()
    await router.push('/preference')
    const firstShow = deferred()
    const showStarted = deferred()
    const shown: string[] = []
    const handler = windowNavigation.createShowWindowRequestHandler({
      label: 'preference',
      router,
      show: async () => {
        shown.push(router.currentRoute.value.fullPath)
        if (shown.length === 1) {
          showStarted.resolve()
          await firstShow.promise
          throw new Error('native show failed')
        }
      },
    })
    const first = handler({ label: 'preference', destination: 'skin-library' })
    const second = handler('preference')
    await showStarted.promise
    assert.equal(router.currentRoute.value.query.view, 'skin-library')
    assert.equal(shown.length, 1)
    firstShow.resolve()
    await assert.rejects(first, /native show failed/)
    await second
    assert.deepEqual(shown, ['/preference?view=skin-library', '/preference'])
  })

  it('ignores mismatched and invalid requests and does not navigate the main window', async () => {
    const router = makeRouter()
    await router.push('/')
    let shown = 0
    const handler = windowNavigation.createShowWindowRequestHandler({
      label: 'main',
      router,
      show: async () => {
        shown += 1
      },
    })
    for (const request of [null, {}, 'unknown', 'preference', { label: 'main', destination: 'unknown' }]) {
      await handler(request)
    }
    assert.equal(shown, 0)
    await handler('main')
    assert.equal(shown, 1)
    assert.equal(router.currentRoute.value.fullPath, '/')
  })

  it('reports blocked navigation without showing the wrong view and accepts repeated destinations', async () => {
    const router = makeRouter()
    await router.push('/preference')
    let shown = 0
    const handler = windowNavigation.createShowWindowRequestHandler({
      label: 'preference',
      router,
      show: async () => {
        shown += 1
      },
    })
    const removeGuard = router.beforeEach(() => false)
    await assert.rejects(handler({ label: 'preference', destination: 'skin-library' }))
    assert.equal(shown, 0)
    removeGuard()
    await handler({ label: 'preference', destination: 'skin-library' })
    await handler({ label: 'preference', destination: 'skin-library' })
    assert.equal(shown, 2)
    assert.equal(router.currentRoute.value.query.view, 'skin-library')
  })

  it('keeps the existing string-label and current-window plugin calls compatible', async () => {
    const emitted: unknown[][] = []
    const invoked: string[] = []
    const exports = {} as typeof WindowPlugin
    const mocks: Record<string, unknown> = {
      '@tauri-apps/api/core': { invoke: async (command: string) => {
        invoked.push(command)
      } },
      '@tauri-apps/api/event': { emit: async (...args: unknown[]) => {
        emitted.push(args)
      } },
      '../constants': { LISTEN_KEY, WINDOW_LABEL },
      './windowVisibility': { createWindowVisibilityQueue },
    }
    const source = readFileSync(new URL('./window.ts', import.meta.url), 'utf8')
    runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, require: (name: string) => mocks[name] ?? {} })
    await exports.showWindow()
    await exports.showWindow('preference')
    await exports.showWindow({ label: 'preference', destination: 'skin-library' })
    assert.deepEqual(invoked, ['plugin:custom-window|show_window'])
    assert.deepEqual(emitted, [
      ['show-window', 'preference'],
      ['show-window', { label: 'preference', destination: 'skin-library' }],
    ])
  })
})
