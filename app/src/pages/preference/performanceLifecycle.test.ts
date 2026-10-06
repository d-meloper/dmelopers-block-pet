/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { parse } from 'vue/compiler-sfc'

import { shouldMonitorPreferencePerformance } from './performanceLifecycle'

const activeState = {
  activeTab: 4,
  performanceTab: 4,
  visible: true,
  minimized: false,
  closing: false,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function windowLifecycleHarness() {
  const current = Vue.ref(4)
  const innerView = Vue.ref<string>()
  const closing = Vue.ref(false)
  const document = { hidden: false }
  const calls: string[] = []
  const listVisibility: boolean[] = []
  const diagnostics: string[] = []
  const watches: Array<() => void> = []
  const domListeners = new Map<string, () => void>()
  const nativeListeners = new Map<string, (event: { payload: boolean }) => void>()
  const queries: Array<{ visible: ReturnType<typeof deferred<boolean>>, minimized: ReturnType<typeof deferred<boolean>> }> = []
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const source = ts.createSourceFile('preference-lifecycle.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true)
  // Exercise the live window coordinator and its event/watch wiring without
  // mounting unrelated preference pages or invoking native services.
  const names = new Set(['performanceLifecycleGeneration', 'nativePreferenceVisible', 'locallyAllowsPerformanceMonitoring', 'reconcilePerformanceMonitoring'])
  const selected = source.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement)) return !!statement.name && names.has(statement.name.text)
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && names.has(declaration.name.text))
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
    const call = statement.expression
    if (!ts.isIdentifier(call.expression)) return false
    if (call.expression.text === 'useTauriListen') return ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'preference-visibility-changed'
    if (call.expression.text === 'useEventListener') return ts.isStringLiteral(call.arguments[1]) && call.arguments[1].text === 'visibilitychange'
    return call.expression.text === 'watch' && ts.isArrayLiteralExpression(call.arguments[0])
      && call.arguments[0].elements.map(element => element.getText(source)).join(',') === 'current,innerView'
  }).map(statement => statement.getText(source)).join('\n')
  interface Lifecycle { reconcile: () => Promise<void> }
  const context = {
    current,
    innerView,
    closing,
    document,
    preferenceDisposed: false,
    lifecycle: undefined as Lifecycle | undefined,
    shouldMonitorPreferencePerformance,
    appWindow: {
      isVisible: () => {
        calls.push('visible')
        const query = { visible: deferred<boolean>(), minimized: deferred<boolean>() }
        queries.push(query)
        return query.visible.promise
      },
      isMinimized: () => {
        calls.push('minimized')
        return queries[queries.length - 1].minimized.promise
      },
    },
    performanceStore: {
      start: async () => {
        calls.push('start')
      },
      stop: async () => {
        calls.push('stop')
      },
    },
    presetManager: { setListVisible: (value: boolean) => listVisibility.push(value) },
    reportDiagnostic: (_level: string, operation: string) => diagnostics.push(operation),
    cancelInteraction: () => {},
    useEventListener: (_target: unknown, event: string, listener: () => void) => domListeners.set(event, listener),
    useTauriListen: (event: string, listener: (event: { payload: boolean }) => void) => nativeListeners.set(event, listener),
    watch: (...args: Parameters<typeof Vue.watch>) => {
      const stop = Vue.watch(...args)
      watches.push(stop)
      return stop
    },
  }
  runInNewContext(ts.transpileModule(`${selected}\nglobalThis.lifecycle = { reconcile: reconcilePerformanceMonitoring };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  const flush = () => new Promise(resolve => setImmediate(resolve))
  return {
    current,
    innerView,
    closing,
    context,
    calls,
    listVisibility,
    diagnostics,
    queries,
    reconcile: context.lifecycle!.reconcile,
    nativeVisibility: (visible: boolean) => nativeListeners.get('preference-visibility-changed')!({ payload: visible }),
    documentVisibility: (hidden: boolean) => {
      document.hidden = hidden
      domListeners.get('visibilitychange')!()
    },
    resolve: async (index: number, visible = true, minimized = false) => {
      queries[index].visible.resolve(visible)
      queries[index].minimized.resolve(minimized)
      await flush()
    },
    dispose: () => watches.forEach(stop => stop()),
  }
}

describe('preference performance lifecycle', () => {
  for (const { pendingEvent, outcome } of ['resize', 'focus', 'close'].flatMap(pendingEvent => ['registered', 'registration failed', 'release failed'].map(outcome => ({ pendingEvent, outcome })))) {
    it(`retires a pending ${pendingEvent} listener after unmount when ${outcome}`, async () => {
      const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
      const source = ts.createSourceFile('preference-mount.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true)
      const names = new Set(['performanceLifecycleUnlisteners', 'preferenceDisposed'])
      const selected = source.statements.filter((statement) => {
        if (ts.isFunctionDeclaration(statement)) return statement.name?.text === 'retainPerformanceLifecycleListener' || statement.name?.text === 'releasePerformanceLifecycleListener'
        if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && names.has(declaration.name.text))
        if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
        return ts.isIdentifier(statement.expression.expression) && ['onMounted', 'onBeforeUnmount'].includes(statement.expression.expression.text)
      }).map(statement => statement.getText(source)).join('\n')
      const delayed = deferred<() => void>()
      const reached = deferred<void>()
      const subscribed: string[] = []
      const released: string[] = []
      const callbacks = new Map<string, (event: { payload?: boolean, preventDefault: () => void }) => void>()
      const work: string[] = []
      const diagnostics: string[] = []
      const closing = Vue.ref(false)
      const mouseReady = Vue.ref(true)
      let mount!: () => Promise<void>
      let unmount!: () => void
      const release = (event: string) => async () => {
        released.push(event)
        if (outcome === 'release failed') throw new Error('Native listener removal failed.')
      }
      const subscribe = (event: string, callback: (event: { payload?: boolean, preventDefault: () => void }) => void) => {
        subscribed.push(event)
        callbacks.set(event, callback)
        if (event === pendingEvent) {
          reached.resolve()
          return delayed.promise
        }
        return Promise.resolve(release(event))
      }
      runInNewContext(ts.transpileModule(selected, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText, {
        onMounted: (callback: () => Promise<void>) => {
          mount = callback
        },
        onBeforeUnmount: (callback: () => void) => {
          unmount = callback
        },
        generateColorVars: () => {},
        listenForMouseResponses: async () => {},
        refreshMouseSetting: () => work.push('mouse'),
        stopMouseSelectionListener: () => {},
        mouseResponseUnlisten: undefined,
        finishMouseRequest: () => {},
        cancelInteraction: () => work.push('cancel'),
        closing,
        mouseReady,
        performanceLifecycleGeneration: 0,
        presetManager: { setListVisible: () => {} },
        performanceStore: { stop: async () => {} },
        reconcilePerformanceMonitoring: async () => {
          work.push('performance')
        },
        reportDiagnostic: (_level: string, operation: string) => diagnostics.push(operation),
        appWindow: {
          onResized: (callback: (event: { payload?: boolean, preventDefault: () => void }) => void) => subscribe('resize', callback),
          onFocusChanged: (callback: (event: { payload?: boolean, preventDefault: () => void }) => void) => subscribe('focus', callback),
          onCloseRequested: (callback: (event: { payload?: boolean, preventDefault: () => void }) => void) => subscribe('close', callback),
        },
      })
      const mounting = mount()
      await reached.promise
      assert.equal(subscribed[subscribed.length - 1], pendingEvent)
      unmount()
      const retiredWork = [...work]
      // A queued callback can run before or after its late removal completes.
      for (const callback of callbacks.values()) callback({ payload: true, preventDefault: () => {} })
      if (outcome === 'registration failed') {
        delayed.reject(new Error('Native listener registration failed.'))
        await assert.rejects(mounting, /Native listener registration failed/)
      } else {
        delayed.resolve(release(pendingEvent))
        await mounting
      }
      for (const callback of callbacks.values()) callback({ payload: false, preventDefault: () => {} })
      assert.deepEqual(work, retiredWork, 'queued native events must not act for the retired owner')
      assert.equal(closing.value, false)
      assert.equal(mouseReady.value, true)
      const registered = outcome === 'registration failed' ? subscribed.filter(event => event !== pendingEvent) : subscribed
      assert.deepEqual([...released].sort(), [...registered].sort(), 'every completed registration must be released')
      assert.equal(subscribed[subscribed.length - 1], pendingEvent, 'a retired owner must not register subsequent listeners')
      assert.deepEqual(diagnostics, outcome === 'release failed' ? registered.map(() => 'preference.lifecycle_unsubscribe') : [])
    })
  }

  it('measures only while the visible performance tab is active', () => {
    assert.equal(shouldMonitorPreferencePerformance(activeState), true)
    assert.equal(shouldMonitorPreferencePerformance({ ...activeState, activeTab: 2 }), false)
    assert.equal(shouldMonitorPreferencePerformance({ ...activeState, visible: false }), false)
    assert.equal(shouldMonitorPreferencePerformance({ ...activeState, minimized: true }), false)
  })

  it('stops for close and restarts when the window is reopened', () => {
    assert.equal(shouldMonitorPreferencePerformance({ ...activeState, closing: true }), false)
    assert.equal(shouldMonitorPreferencePerformance({ ...activeState, closing: false }), true)
  })

  it('stops synchronously before IPC for tab exits, inner views, close, document hiding and native hiding', async (t) => {
    for (const reason of ['tab', 'innerView', 'close', 'document', 'native'] as const) {
      const h = windowLifecycleHarness()
      t.after(h.dispose)
      const obsolete = h.reconcile()
      if (reason === 'tab') {
        h.current.value = 0
      } else if (reason === 'innerView') {
        h.innerView.value = 'skin-library'
      } else if (reason === 'close') {
        h.closing.value = true
        void h.reconcile()
      } else if (reason === 'document') {
        h.documentVisibility(true)
      } else {
        h.nativeVisibility(false)
      }
      // A sync watch/native event invalidates a pending sampler prime even if
      // neither the previous nor the new native visibility query has settled.
      assert.deepEqual(h.calls, ['visible', 'minimized', 'stop', 'visible', 'minimized'], reason)
      await h.resolve(0)
      await obsolete
      assert.equal(h.calls.filter(call => call === 'start').length, 0, reason)
      assert.deepEqual(h.listVisibility, [], reason)
      await h.resolve(1)
      assert.equal(h.calls.filter(call => call === 'start').length, 0, reason)
      assert.equal(h.calls.filter(call => call === 'stop').length, 1, reason)
      assert.deepEqual(h.listVisibility, [reason === 'tab'], reason)
    }
  })

  it('allows a fresh native reopen without awaiting obsolete IPC and ignores its late replies', async (t) => {
    const h = windowLifecycleHarness()
    t.after(h.dispose)
    const obsolete = h.reconcile()
    h.closing.value = true
    h.nativeVisibility(false)
    h.nativeVisibility(true)
    assert.equal(h.closing.value, false)
    await h.resolve(2)
    assert.equal(h.calls.filter(call => call === 'start').length, 1)
    const settledCalls = [...h.calls]
    const settledList = [...h.listVisibility]
    await h.resolve(1, false, true)
    await h.resolve(0, false, true)
    await obsolete
    assert.deepEqual(h.calls, settledCalls)
    assert.deepEqual(h.listVisibility, settledList)
  })

  it('keeps native hide authoritative over a stale visible probe and retains preset-list visibility updates', async (t) => {
    const h = windowLifecycleHarness()
    t.after(h.dispose)
    h.nativeVisibility(false)
    await h.resolve(0, true)
    assert.equal(h.calls.filter(call => call === 'start').length, 0)
    h.current.value = 0
    await h.resolve(1, true)
    assert.equal(h.listVisibility[h.listVisibility.length - 1], false)
    h.nativeVisibility(true)
    await h.resolve(2, true)
    assert.equal(h.listVisibility[h.listVisibility.length - 1], true)
    h.documentVisibility(true)
    await h.resolve(3, true)
    assert.equal(h.listVisibility[h.listVisibility.length - 1], false)
    h.documentVisibility(false)
    await h.resolve(4, true)
    assert.equal(h.listVisibility[h.listVisibility.length - 1], true)
    assert.equal(h.calls.filter(call => call === 'start').length, 0)
  })

  it('does not restart from queries completed after unmount or report obsolete query failures', async (t) => {
    const h = windowLifecycleHarness()
    t.after(h.dispose)
    const obsolete = h.reconcile()
    h.current.value = 1
    h.queries[0].visible.reject(new Error('obsolete visibility query'))
    await h.resolve(0)
    await obsolete
    assert.deepEqual(h.diagnostics, [])
    h.context.preferenceDisposed = true
    await h.resolve(1)
    assert.equal(h.calls.filter(call => call === 'start').length, 0)
    assert.deepEqual(h.listVisibility, [])
  })
})
