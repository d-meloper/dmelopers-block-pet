/* eslint-disable test/no-import-node-test */
import type { WebGLRenderer } from 'three'

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { BoxGeometry, DirectionalLight, Group, Mesh, MeshStandardMaterial, Scene, Texture, WebGLRenderTarget } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import three3d, { Three3DRenderer } from '../three3d'
import {
  awaitAssetOperation,
  disposeRendererForReuse,
  restoreRendererCanvas,
} from './rendererLifecycle'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const cancelled = { name: 'PetModelLoadCancelledError' }
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function fakeRenderer() {
  const canvas = new EventTarget() as HTMLCanvasElement
  let lost = false
  const calls: string[] = []
  const renderer = {
    domElement: canvas,
    getContext: () => ({
      isContextLost: () => lost,
      getExtension: () => ({
        restoreContext: () => calls.push('restore'),
        loseContext: () => {
          lost = true
          calls.push('lose')
        },
      }),
    }),
    dispose: () => calls.push('dispose'),
  } as unknown as WebGLRenderer
  return {
    renderer,
    canvas,
    calls,
    lost: () => {
      const event = new Event('webglcontextlost', { cancelable: true })
      canvas.dispatchEvent(event)
      assert.equal(event.defaultPrevented, true)
    },
    restored: () => {
      lost = false
      canvas.dispatchEvent(new Event('webglcontextrestored'))
    },
  }
}

describe('canvas context retirement and reuse', () => {
  it('waits for both loss and restoration on immediate hide/show', async () => {
    const fake = fakeRenderer()
    disposeRendererForReuse(fake.renderer)
    let ready = false
    const operation = restoreRendererCanvas(fake.canvas, new AbortController().signal)
      .then(() => {
        ready = true
      })
    await flush()
    assert.deepEqual(fake.calls, ['dispose', 'lose'])
    assert.equal(ready, false)
    fake.lost()
    assert.deepEqual(fake.calls, ['dispose', 'lose'])
    await flush()
    assert.deepEqual(fake.calls, ['dispose', 'lose', 'restore'])
    await flush()
    assert.equal(ready, false)
    fake.restored()
    await operation
    await restoreRendererCanvas(fake.canvas, new AbortController().signal)
    assert.equal(fake.calls.filter(call => call === 'restore').length, 1)
  })

  it('cancels an old init without cancelling a newer waiter on the same canvas', async () => {
    const fake = fakeRenderer()
    disposeRendererForReuse(fake.renderer)
    const old = new AbortController()
    const first = assert.rejects(restoreRendererCanvas(fake.canvas, old.signal), cancelled)
    old.abort()
    const latest = restoreRendererCanvas(fake.canvas, new AbortController().signal)
    await flush()
    fake.lost()
    await flush()
    fake.restored()
    await Promise.all([first, latest])
    assert.equal(fake.calls.filter(call => call === 'restore').length, 1)
  })

  it('finishes raw GL readbacks before losing the context', async () => {
    const fake = fakeRenderer()
    const readback = deferred<void>()
    disposeRendererForReuse(fake.renderer, readback.promise)
    const ready = restoreRendererCanvas(fake.canvas, new AbortController().signal)
    await flush()
    assert.deepEqual(fake.calls, ['dispose'])
    readback.resolve()
    await flush()
    assert.deepEqual(fake.calls, ['dispose', 'lose'])
    fake.lost()
    await flush()
    fake.restored()
    await ready
  })

  it('reports restoration failure instead of constructing on a lost context', async () => {
    const fake = fakeRenderer()
    disposeRendererForReuse(fake.renderer, Promise.resolve(), 10)
    await assert.rejects(
      restoreRendererCanvas(fake.canvas, new AbortController().signal),
      /could not be restored/,
    )
  })

  it('does not require the optional lose-context extension', async () => {
    const fake = fakeRenderer()
    mock.method(fake.renderer, 'getContext', () => ({ getExtension: () => null }))
    disposeRendererForReuse(fake.renderer)
    await restoreRendererCanvas(fake.canvas, new AbortController().signal)
    assert.deepEqual(fake.calls, ['dispose'])
  })
})

describe('cancelled asynchronous assets', () => {
  it('preserves a current asset error and the previous model', async () => {
    const state = three3d as unknown as { sceneRoot?: Group }
    const previousModel = new Group()
    state.sceneRoot = new Group().add(previousModel)
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }))
    const errorLog = mock.method(console, 'error', () => undefined)
    try {
      await assert.rejects(three3d.setPetModel('/missing.glb', 'dmeloper'), { name: 'PetAssetLoadError' })
      assert.equal(state.sceneRoot.children[0], previousModel)
      assert.equal(errorLog.mock.callCount(), 1)
    } finally {
      fetchMock.mock.restore()
      errorLog.mock.restore()
      three3d.destroy()
    }
  })

  it('rejects promptly and disposes a decoder result that arrives after cancellation', async () => {
    const decoder = deferred<{ dispose: () => void }>()
    const abort = new AbortController()
    const dispose = mock.fn()
    const done = assert.rejects(awaitAssetOperation(decoder.promise, abort.signal, value => value.dispose()), cancelled)
    abort.abort()
    await done
    decoder.resolve({ dispose })
    await flush()
    assert.equal(dispose.mock.callCount(), 1)
  })

  it('classifies a late decoder rejection as cancellation and preserves real failures', async () => {
    const decoder = deferred<void>()
    const abort = new AbortController()
    const done = assert.rejects(awaitAssetOperation(decoder.promise, abort.signal), cancelled)
    abort.abort()
    decoder.reject(new Error('old failure'))
    await done
    await assert.rejects(
      awaitAssetOperation(Promise.reject(new Error('current failure')), new AbortController().signal),
      /current failure/,
    )
  })

  it('aborts an actual model fetch on destroy and clears pending state', async () => {
    const state = three3d as unknown as { sceneRoot?: Group }
    state.sceneRoot = new Group()
    let signal: AbortSignal | undefined
    const fetchMock = mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
      signal = options.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('aborted network request')))
      })
    })
    try {
      const result = assert.rejects(three3d.setPetModel('/delayed.glb', 'dmeloper'), cancelled)
      assert.ok(three3d.getPendingPetAssetState())
      three3d.destroy()
      three3d.destroy()
      await result
      assert.equal(signal?.aborted, true)
      assert.equal(three3d.getPendingPetAssetState(), undefined)
      assert.equal(three3d.getLoadedPetAssetState(), undefined)
    } finally {
      fetchMock.mock.restore()
      three3d.destroy()
    }
  })

  it('disposes a parsed stale model without attaching it to the next scene', async () => {
    const state = three3d as unknown as { sceneRoot?: Group }
    state.sceneRoot = new Group()
    const geometry = new BoxGeometry()
    const material = new MeshStandardMaterial()
    const geometryDispose = mock.method(geometry, 'dispose')
    const materialDispose = mock.method(material, 'dispose')
    const model = new Group().add(new Mesh(geometry, material))
    const decoded = deferred<{ scene: Group }>()
    const parse = mock.method(GLTFLoader.prototype, 'parseAsync', () => decoded.promise)
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(new ArrayBuffer(1)))
    try {
      const operation = assert.rejects(three3d.setPetModel('/decoding.glb', 'dmeloper'), cancelled)
      await flush()
      assert.equal(parse.mock.callCount(), 1)
      three3d.destroy()
      const nextScene = new Group()
      state.sceneRoot = nextScene
      await operation
      decoded.resolve({ scene: model })
      await flush()
      assert.equal(nextScene.children.length, 0)
      assert.equal(geometryDispose.mock.callCount(), 1)
      assert.equal(materialDispose.mock.callCount(), 1)
    } finally {
      parse.mock.restore()
      fetchMock.mock.restore()
      three3d.destroy()
    }
  })

  it('releases the decoded model when its skin fetch is cancelled', async () => {
    const state = three3d as unknown as { sceneRoot?: Group }
    state.sceneRoot = new Group()
    const geometry = new BoxGeometry()
    const material = new MeshStandardMaterial()
    const dispose = mock.method(geometry, 'dispose')
    const model = new Group().add(new Mesh(geometry, material))
    const parse = mock.method(GLTFLoader.prototype, 'parseAsync', async () => ({ scene: model }))
    const started = deferred<AbortSignal>()
    const fetchMock = mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      if (url !== '/skin.png') return new Response(new ArrayBuffer(1))
      const signal = options.signal as AbortSignal
      started.resolve(signal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled skin fetch')))
      })
    })
    try {
      const operation = assert.rejects(three3d.setPetModel('/pet.glb', 'dmeloper', '/skin.png'), cancelled)
      const signal = await started.promise
      three3d.destroy()
      await operation
      assert.equal(signal.aborted, true)
      assert.equal(dispose.mock.callCount(), 1)
    } finally {
      parse.mock.restore()
      fetchMock.mock.restore()
      three3d.destroy()
    }
  })
})

describe('hidden renderer resource disposal', () => {
  it('releases shared scene resources, generated groups, shadows and readback targets once', async () => {
    const geometry = new BoxGeometry()
    const texture = new Texture()
    const material = new MeshStandardMaterial({ map: texture })
    const scene = new Scene().add(new Mesh(geometry, material), new Mesh(geometry, material))
    const light = new DirectionalLight()
    light.shadow.map = new WebGLRenderTarget(16, 16)
    const target = new WebGLRenderTarget(16, 16)
    const disposers = [geometry, material, texture, light.shadow, light.shadow.map, target]
      .map(value => mock.method(value, 'dispose'))
    const generated = mock.fn()
    const fake = fakeRenderer()
    const state = three3d as unknown as {
      scene?: Scene
      sceneRoot?: Group
      renderer?: WebGLRenderer
      directionalLight?: DirectionalLight
      generatedGroupDisposers: Array<() => void>
      contentMeasurementTargets: Set<WebGLRenderTarget>
    }
    state.scene = scene
    state.sceneRoot = new Group()
    state.renderer = fake.renderer
    state.directionalLight = light
    state.generatedGroupDisposers.push(generated)
    state.contentMeasurementTargets.add(target)
    three3d.destroy()
    three3d.destroy()
    await flush()
    assert.equal(generated.mock.callCount(), 1)
    disposers.forEach(dispose => assert.equal(dispose.mock.callCount(), 1))
    assert.deepEqual(fake.calls, ['dispose', 'lose'])
    assert.equal(state.renderer, undefined)
    assert.equal(scene.children.length, 0)
    const ready = restoreRendererCanvas(fake.canvas, new AbortController().signal)
    fake.lost()
    await flush()
    fake.restored()
    await ready
  })
})

describe('renderer input wiring', () => {
  it('updates all four arm settings without loading assets and invalidates bounds only when changed', () => {
    three3d.destroy()
    const armPose = mock.fn()
    const loadModel = mock.method(three3d, 'setPetModel')
    const loadSkin = mock.method(three3d, 'setDmeloperSkin')
    const state = three3d as unknown as { contentMeasurementGeneration: number }
    const defaults = { petRightArmBendPercent: 100, petRightArmSpreadDegrees: 0, petLeftArmBendPercent: 100, petLeftArmSpreadDegrees: 0 }
    three3d.setPetArmPoseSettings(defaults)
    Object.assign(three3d, { petAnimator: { setArmPoseSettings: armPose, dispose: mock.fn() } })
    const generation = state.contentMeasurementGeneration
    try {
      const updated = { ...defaults }
      for (const [index, key] of Object.keys(defaults).entries()) {
        updated[key as keyof typeof defaults] += 10
        three3d.setPetArmPoseSettings(updated)
        assert.equal(state.contentMeasurementGeneration, generation + index + 1)
      }
      three3d.setPetArmPoseSettings(updated)
      three3d.setPetArmPoseSettings({ ...updated, petRightArmSpreadDegrees: Number.NaN })
      assert.equal(state.contentMeasurementGeneration, generation + 4)
      three3d.setPetArmPoseSettings({ petRightArmBendPercent: 450, petRightArmSpreadDegrees: 90, petLeftArmBendPercent: -10, petLeftArmSpreadDegrees: -90 })
      assert.deepEqual(armPose.mock.calls.at(-1)!.arguments, [{ petRightArmBendPercent: 400, petRightArmSpreadDegrees: 45, petLeftArmBendPercent: 0, petLeftArmSpreadDegrees: -45 }])
      updated.petLeftArmBendPercent = 50
      assert.equal((armPose.mock.calls[3]!.arguments[0] as typeof defaults).petLeftArmBendPercent, 110, 'renderer copies caller settings')
      assert.equal(loadModel.mock.callCount(), 0)
      assert.equal(loadSkin.mock.callCount(), 0)
    } finally {
      three3d.destroy()
      three3d.setPetArmPoseSettings(defaults)
      loadModel.mock.restore()
      loadSkin.mock.restore()
    }
  })

  it('routes middle and small two-axis scroll, clears mouse only and retains typing on OFF', () => {
    three3d.destroy()
    const mouseButton = mock.fn()
    const scroll = mock.fn()
    const mouseReset = mock.fn()
    const petButton = mock.fn()
    const petKey = mock.fn()
    const eyebrowKey = mock.fn()
    const eyebrowButton = mock.fn()
    const modes: boolean[] = []
    Object.assign(three3d, {
      mouse: { setMouseEnabled: (value: boolean) => modes.push(value), resetInput: mouseReset, setMouseButtonPressed: mouseButton, pulseWheelScroll: scroll, setMousePosition: mock.fn() },
      petAnimator: { setMouseEnabled: mock.fn(), setMouseButtonPressed: petButton, setKeyPressed: petKey, dispose: mock.fn() },
      dmeloperEyebrowController: { setMouseEnabled: mock.fn(), resetMouseInput: mock.fn(), setKeyPressed: eyebrowKey, setMouseButtonPressed: eyebrowButton, dispose: mock.fn() },
      keyboard: { getContactTarget: () => undefined, setContactPressed: mock.fn() },
    })
    try {
      three3d.setMouseEnabled(true)
      three3d.setInputActive(true)
      three3d.setMouseInputActive(true)
      three3d.handleSemanticInput({ kind: 'mouse_middle', active: true })
      three3d.handleSemanticInput({ kind: 'scroll', deltaX: 0.01, deltaY: -0.02 })
      three3d.handleSemanticInput({ kind: 'mouse_middle', active: false })
      assert.deepEqual(mouseButton.mock.calls.map(call => call.arguments), [['Middle', true], ['Middle', false]])
      assert.equal(petButton.mock.callCount(), 2)
      assert.equal(eyebrowButton.mock.callCount(), 0)
      assert.deepEqual(scroll.mock.calls[0].arguments, [0.01, -0.02])
      three3d.setMouseEnabled(false)
      three3d.handleSemanticInput({ kind: 'mouse_primary', active: true })
      three3d.handleSemanticInput({ kind: 'scroll', deltaX: 1, deltaY: 2 })
      three3d.handleSemanticInput({ kind: 'typing', active: true, intensity: 1, contact: { row: 2, column: 3, pressed: true } })
      assert.equal(mouseButton.mock.callCount(), 2)
      assert.equal(scroll.mock.callCount(), 1)
      assert.equal(petKey.mock.callCount(), 1)
      assert.equal(eyebrowKey.mock.callCount(), 1)
      three3d.setInputActive(false)
      three3d.handleSemanticInput({ kind: 'typing', active: false, intensity: 0, contact: { row: 2, column: 3, pressed: false } })
      assert.deepEqual(petKey.mock.calls.map(call => call.arguments), [['2:3', true, undefined], ['2:3', false, undefined]])
      assert.deepEqual(eyebrowKey.mock.calls.map(call => call.arguments.slice(0, 2)), [['2:3', true], ['2:3', false]])
      assert.equal(mouseReset.mock.callCount(), 1)
      three3d.setMouseEnabled(true)
      three3d.setInputActive(true)
      three3d.handleSemanticInput({ kind: 'scroll', deltaX: 1, deltaY: 2 })
      assert.equal(scroll.mock.callCount(), 1)
      three3d.setMouseInputActive(true)
      three3d.handleSemanticInput({ kind: 'scroll', deltaX: 1, deltaY: 2 })
      assert.equal(scroll.mock.callCount(), 2)
      assert.deepEqual(modes, [true, false, true])
    } finally {
      three3d.destroy()
      three3d.setInputActive(true)
      three3d.setMouseInputActive(true)
      three3d.setMouseEnabled(true)
    }
  })
})

describe('active renderer failure ownership', () => {
  it('stops a failing frame loop, reports once, and never treats a health-only frame as animation success', async () => {
    const engine = new Three3DRenderer()
    const frames = mock.fn(() => 1)
    const cancellations = mock.fn()
    const previousRequest = globalThis.requestAnimationFrame
    const previousCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = frames
    globalThis.cancelAnimationFrame = cancellations
    const failures: unknown[] = []
    let firstFrames = 0
    const state = engine as unknown as {
      renderer?: { render: () => void }
      scene?: Scene
      camera?: object
      petModel?: Group
      petAnimator?: { update: () => void }
      runtimeFailure?: (error: unknown) => void
      firstFrameRendered?: () => void
      renderFrame: (time: number) => void
      runtimeFaulted: boolean
    }
    state.renderer = { render: () => {} }
    state.scene = new Scene()
    state.camera = {}
    state.petModel = new Group()
    state.runtimeFailure = error => failures.push(error)
    state.firstFrameRendered = () => {
      firstFrames++
    }
    state.petAnimator = { update: () => {
      throw new Error('animation failed')
    } }
    try {
      state.renderFrame(1000)
      await Promise.resolve()
      state.renderFrame(1100)
      await Promise.resolve()
      assert.equal(failures.length, 1)
      assert.equal(frames.mock.callCount(), 0)
      assert.equal(firstFrames, 0)
      assert.equal(engine.renderHealthFrame(), false)
    } finally {
      state.renderer = undefined
      state.scene = undefined
      state.camera = undefined
      state.petModel = undefined
      state.petAnimator = undefined
      engine.destroy()
      globalThis.requestAnimationFrame = previousRequest
      globalThis.cancelAnimationFrame = previousCancel
    }
  })

  it('acknowledges only an actual loaded-model animation frame and suppresses fault delivery after destroy', async () => {
    const engine = new Three3DRenderer()
    const previousRequest = globalThis.requestAnimationFrame
    const previousCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = () => 1
    globalThis.cancelAnimationFrame = () => {}
    const state = engine as unknown as {
      renderer?: { render: () => void }
      scene?: Scene
      camera?: object
      petModel?: Group
      runtimeFailure?: (error: unknown) => void
      firstFrameRendered?: () => void
      renderFrame: (time: number) => void
      failRuntime: (error: unknown) => void
    }
    let firstFrames = 0
    let failures = 0
    state.renderer = { render: () => {} }
    state.scene = new Scene()
    state.camera = {}
    state.runtimeFailure = () => {
      failures++
    }
    state.firstFrameRendered = () => {
      firstFrames++
    }
    try {
      state.renderFrame(1000)
      assert.equal(firstFrames, 0, 'background draws do not acknowledge the model')
      state.petModel = new Group()
      state.renderFrame(2000)
      state.renderFrame(3000)
      assert.equal(firstFrames, 1)
      state.failRuntime(new Error('context lost'))
      state.renderer = undefined
      state.scene = undefined
      state.camera = undefined
      state.petModel = undefined
      engine.destroy()
      await Promise.resolve()
      assert.equal(failures, 0, 'an obsolete renderer cannot report into its replacement')
    } finally {
      state.renderer = undefined
      state.scene = undefined
      state.camera = undefined
      state.petModel = undefined
      engine.destroy()
      globalThis.requestAnimationFrame = previousRequest
      globalThis.cancelAnimationFrame = previousCancel
    }
  })
})

it('preserves the non-desktop frame loop policy when no recovery owner is installed', () => {
  const engine = new Three3DRenderer()
  const previousRequest = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  const scheduled = mock.fn(() => 1)
  globalThis.requestAnimationFrame = scheduled
  globalThis.cancelAnimationFrame = () => {}
  const state = engine as unknown as {
    renderer?: { render: () => void }
    scene?: Scene
    camera?: object
    renderFrame: (time: number) => void
    runtimeFaulted: boolean
  }
  state.renderer = { render: () => {
    throw new Error('broadcast frame failed')
  } }
  state.scene = new Scene()
  state.camera = {}
  try {
    assert.throws(() => state.renderFrame(1000), /broadcast frame failed/)
    assert.equal(scheduled.mock.callCount(), 1)
    assert.equal(state.runtimeFaulted, false)
    state.renderer.render = () => {}
    state.renderFrame(2000)
    assert.equal(scheduled.mock.callCount(), 2, 'a non-desktop owner keeps its existing recovery policy')
  } finally {
    state.renderer = undefined
    state.scene = undefined
    state.camera = undefined
    engine.destroy()
    globalThis.requestAnimationFrame = previousRequest
    globalThis.cancelAnimationFrame = previousCancel
  }
})

it('classifies skin-only read and invalid-image failures as known asset failures', async () => {
  const engine = new Three3DRenderer()
  const state = engine as unknown as { petModel?: Group, sceneRoot?: Group }
  const warning = mock.method(console, 'warn', () => {})
  try {
    for (const response of [new Response(null, { status: 404 }), new Response('invalid image', { headers: { 'Content-Type': 'image/jpeg' } })]) {
      const model = new Group()
      state.petModel = model
      state.sceneRoot = new Group()
      const fetchMock = mock.method(globalThis, 'fetch', async () => response)
      try {
        await assert.rejects(engine.setDmeloperSkin('/broken-skin.png'), { name: 'PetAssetLoadError' })
        assert.equal(state.petModel, model, 'keep the previously loaded model')
        assert.equal(engine.getPendingPetAssetState(), undefined)
      } finally {
        fetchMock.mock.restore()
        state.petModel = undefined
        engine.destroy()
      }
    }
  } finally {
    warning.mock.restore()
    engine.destroy()
  }
})
