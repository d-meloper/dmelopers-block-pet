/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'

const source = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content
const syntax = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
function functions(names: string[]) {
  return syntax.statements
    .filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
    .map(node => node.getText(syntax))
    .join('\n')
}
const teardown = functions(['detachRendererCanvas', 'destroyRendererResources'])

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

interface Canvas { className: string, remove: () => void }
type DelayStage = 'fallback' | 'model' | 'renderer'

function lifecycleHarness() {
  const attached: Canvas[] = []
  const retired = new Set<Canvas>()
  const shown: Canvas[][] = []
  const created: Canvas[] = []
  let delay: { stage: DelayStage, started: ReturnType<typeof deferred<void>>, complete: ReturnType<typeof deferred<void>> } | undefined
  const reach = async (stage: DelayStage) => {
    if (delay?.stage !== stage) return
    const current = delay
    delay = undefined
    current.started.resolve()
    await current.complete.promise
  }
  const makeCanvas = (): Canvas => {
    const canvas = {
      className: '',
      remove() {
        const index = attached.indexOf(canvas)
        if (index >= 0) attached.splice(index, 1)
        retired.add(canvas)
      },
    }
    created.push(canvas)
    return canvas
  }
  const context = {
    componentMounted: true,
    desktopPetVisible: { value: false },
    presetApplyInProgress: false,
    rendererLifecycleGeneration: 0,
    selectionRequestGeneration: 0,
    boundsMeasurementGeneration: 0,
    viewportGeometryGeneration: 0,
    visibilityGeneration: 0,
    rendererFrame: undefined,
    rendererInitialization: undefined,
    rendererReady: false,
    rendererLoading: { value: false },
    rendererError: { value: undefined },
    pendingSelection: undefined,
    appliedBoundsSignature: undefined,
    desiredBoundsSignature: undefined,
    desiredWindowScalePercent: undefined,
    currentContentRect: undefined,
    boundsRefreshPending: false,
    fullViewportRecoveryPending: false,
    viewportUpdatePending: false,
    viewportRevealPending: false,
    viewportResetPending: false,
    canvas: { value: undefined as Canvas | undefined },
    canvasHost: { value: { replaceChildren(canvas: Canvas) {
      attached.splice(0, attached.length, canvas)
    } } },
    document: { createElement: makeCanvas },
    loadingPaint: { cancel() {}, wait: async () => {} },
    editorsLocked: { value: false },
    selectionTaskQueue: { clear() {}, enqueue() {} },
    viewportUpdateScheduler: { clear() {} },
    requireRendererPresentation() {},
    suspendInput() {},
    clearViewportHologram() {},
    refreshAutomaticViewportMutationGuard() {},
    nextTick: async () => {},
    showWindow: async () => {
      assert.ok(attached.every(canvas => !retired.has(canvas)), 'native show never exposes a retired canvas')
      shown.push([...attached])
    },
    hideWindow: async () => {},
    setWindowMemoryActive: async () => {},
    reportWindowHideFailure: () => assert.fail('unexpected native hide failure'),
    reportWindowShowFailure: () => assert.fail('unexpected native show failure'),
    recordRuntimeFailure: (error: unknown) => assert.fail(String(error)),
    resolveDmeloperSkinUrl: async () => {
      await reach('fallback')
      return '/default.png'
    },
    resolvePetUrl: async () => {
      await reach('model')
      return '/pet.glb'
    },
    getCurrentSelection: () => ({ modelId: 'dmeloper', dmeloperSkinModel: 'wide' }),
    getResolvedDmeloperSkinUrl: () => '/default.png',
    confirmedMouseEnabled: () => false,
    blockStore: { model: { antialiasEnabled: false } },
    three3d: {
      setMouseEnabled() {},
      setViewportCrop() {},
      resizeOutput() {},
      init: async () => {
        await reach('renderer')
        return 'wide'
      },
      destroy() {
        assert.equal(context.canvas.value, undefined, 'detach must precede context disposal')
      },
    },
    synchronizeAntialias: async () => {},
    persistResolvedDmeloperSkinModel() {},
    applyPet3dPresetSelection: async () => {},
    createVisibleBoundsSelectionSignature: () => ({}),
    getFullContentRect: () => ({ x: 0, y: 0, width: 300, height: 200 }),
    measureContentBoundsWithRetries: async () => ({ outcome: 'ready', viewportReady: true }),
    revealPreparedRenderer: async () => {
      context.rendererLoading.value = false
      return true
    },
    resumeRendererInput: async () => {},
    processRuntimeFailure: async () => {},
    createBundledAssetError: (error: unknown) => error,
    innerWidth: 300,
    innerHeight: 200,
    console,
    setVisible: undefined as undefined | ((visible: boolean) => Promise<void>),
  }
  const selected = functions([
    'isCurrentSelectionRequest',
    'resetActiveRendererState',
    'detachRendererCanvas',
    'destroyRendererResources',
    'initializeRenderer',
    'ensureRendererInitialized',
    'synchronizeWindowVisibility',
    'prepareRendererChange',
  ])
  runInNewContext(ts.transpileModule(`${selected}\nglobalThis.setVisible = async visible => {
    desktopPetVisible.value = visible
    await synchronizeWindowVisibility()
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return {
    context,
    attached,
    retired,
    shown,
    created,
    show: () => context.setVisible!(true),
    hide: () => context.setVisible!(false),
    delay(stage: DelayStage) {
      const pending = { stage, started: deferred<void>(), complete: deferred<void>() }
      delay = pending
      return pending
    },
  }
}

describe('main canvas presentation lifetime', () => {
  it('detaches a retired canvas before losing its context and before a loading-only show', () => {
    const actions: string[] = []
    let attached = true
    const context = {
      loadingPaint: { cancel() {} },
      rendererFrame: { resolve() {} },
      rendererLoading: { value: true },
      rendererLifecycleGeneration: 1,
      selectionRequestGeneration: 1,
      boundsMeasurementGeneration: 1,
      viewportGeometryGeneration: 1,
      pendingSelection: {},
      selectionTaskQueue: { clear() {} },
      viewportUpdateScheduler: { clear() {} },
      resetActiveRendererState() {},
      canvas: { value: { remove() {
        attached = false
        actions.push('detach')
      } } as { remove: () => void } | undefined },
      three3d: { destroy() {
        assert.equal(attached, false)
        actions.push('release-context')
      } },
      destroy: undefined as (() => void) | undefined,
    }
    runInNewContext(ts.transpileModule(`${teardown}\nglobalThis.destroy = destroyRendererResources`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
    context.destroy!()
    assert.deepEqual(actions, ['detach', 'release-context'])
    assert.equal(context.canvas.value, undefined)
    // A loading-only native show cannot expose this discarded surface again.
    assert.equal(attached, false)
    context.destroy!()
    assert.deepEqual(actions, ['detach', 'release-context', 'release-context'])
  })

  for (const stage of ['fallback', 'model', 'renderer'] as const) {
    it(`keeps retired canvases detached across repeated hide/show with delayed ${stage} completion`, async () => {
      const h = lifecycleHarness()
      await h.show()
      const original = h.attached[0]
      await h.hide()
      assert.deepEqual(h.attached, [])
      assert.ok(h.retired.has(original))
      const delayed = h.delay(stage)
      const oldShow = h.show()
      await delayed.started.promise
      assert.equal(h.shown.at(-1)?.length, 0, 'loading-only show begins on an empty transparent host')
      const superseded = h.attached[0]
      await h.hide()
      await h.show()
      const current = h.attached[0]
      assert.ok(current && current !== original && current !== superseded)
      delayed.complete.resolve()
      await oldShow
      assert.deepEqual(h.attached, [current], 'late fallback/model/renderer completion cannot reattach its old canvas')
      assert.equal(h.context.rendererReady, true)
      assert.equal(h.context.rendererLoading.value, false)
      await h.hide()
      assert.ok(h.retired.has(current))
      assert.deepEqual(h.attached, [])
      await h.show()
      assert.notEqual(h.attached[0], current)
      assert.ok(h.shown.every(canvases => canvases.length === 0))
    })
  }
})
