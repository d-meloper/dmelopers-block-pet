/* eslint-disable test/no-import-node-test */
import type { TestContext } from 'node:test'
import type { Color, WebGLRenderer } from 'three'

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { BoxGeometry, DirectionalLight, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Texture, WebGLRenderTarget } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import three3d, { Three3DRenderer } from '../three3d'
import {
  awaitAssetOperation,
  disposeRendererForReuse,
  restoreRendererCanvas,
} from './rendererLifecycle'
import { normalizeVoxelSkin } from './voxelSkin'

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

describe('pet-only loading presentation', () => {
  function fixture(t: TestContext) {
    const engine = new Three3DRenderer()
    const scene = new Scene()
    const root = new Group()
    const pet = new Group()
    pet.name = 'petGroup'
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial())
    mesh.name = 'pet'
    pet.add(mesh)
    const objects = ['desk', 'keyboard', 'mouse'].map((name, index) => {
      const object = new Mesh(new BoxGeometry(), new MeshStandardMaterial())
      object.name = name
      object.position.x = index + 2
      return object
    })
    root.add(pet, ...objects)
    scene.add(root)
    const camera = new PerspectiveCamera()
    camera.position.z = 10
    camera.updateMatrixWorld(true)
    let target: WebGLRenderTarget | null = null
    let failDraw = false
    const draws: Array<{ measured: boolean, objects: string[] }> = []
    const info = { render: { calls: 0 } }
    const renderer = {
      info,
      capabilities: { maxTextureSize: 2048 },
      autoClear: true,
      shadowMap: { autoUpdate: true, needsUpdate: false },
      getContext: () => ({ NO_ERROR: 0, isContextLost: () => false, getError: () => 0 }),
      getRenderTarget: () => target,
      setRenderTarget: (next: WebGLRenderTarget | null) => {
        target = next
      },
      getClearColor: (color: Color) => color.set(0),
      getClearAlpha: () => 0,
      setClearColor: () => {},
      setPixelRatio: () => {},
      setSize: () => {},
      clear: () => {},
      readRenderTargetPixelsAsync: async (_target: unknown, _x: number, _y: number, _w: number, _h: number, pixels: Uint8Array) => {
        pixels.fill(255)
      },
      render: (drawScene: Scene, drawCamera: PerspectiveCamera) => {
        if (failDraw) throw new Error('presentation draw failed')
        const names: string[] = []
        info.render.calls = 0
        drawScene.traverseVisible((object) => {
          if (!(object instanceof Mesh)) return
          const args = [renderer, drawScene, drawCamera, object.geometry, object.material, null] as unknown as Parameters<typeof object.onBeforeRender>
          object.onBeforeRender(...args)
          info.render.calls++
          object.onAfterRender(...args)
          names.push(object.name)
        })
        draws.push({ measured: !!target, objects: names })
      },
    } as unknown as WebGLRenderer
    const state = engine as unknown as { renderer?: WebGLRenderer, scene: Scene, sceneRoot: Group, camera: PerspectiveCamera, petModel: Group, renderFrame: (time: number) => void }
    Object.assign(state, { renderer, scene, sceneRoot: root, camera, petModel: pet })
    t.after(() => {
      state.renderer = undefined
      engine.destroy()
    })
    return { engine, pet, objects, draws, state, fail: (value: boolean) => {
      failDraw = value
    } }
  }

  it('keeps surrounding draws while hiding the pet immediately, during resize and on subsequent frames', (t) => {
    const h = fixture(t)
    const before = h.engine.getConservativeContentRect()
    h.engine.setPetPresentationVisible(false)
    h.engine.resizeOutput(200, 180)
    h.engine.renderStillFrame()
    const previousRequest = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = () => 1
    try {
      h.state.renderFrame(1000)
    } finally {
      // Retire the fake RAF before the fixture's resource cleanup.
      Object.assign(h.state, { frameId: undefined })
      globalThis.requestAnimationFrame = previousRequest
    }
    assert.equal(h.draws.length, 4)
    h.draws.forEach(draw => assert.deepEqual(draw.objects, ['desk', 'keyboard', 'mouse']))
    assert.equal(h.pet.visible, true, 'presentation masking must not alter the scene used for fitting')
    assert.deepEqual(h.engine.getConservativeContentRect(), before)
    h.engine.setPetPresentationVisible(true)
    assert.deepEqual(h.draws.at(-1)?.objects, ['pet', 'desk', 'keyboard', 'mouse'])
  })

  it('measures the complete returning pet and proves its healthy frame without releasing the loading mask', async (t) => {
    const h = fixture(t)
    h.engine.setPetPresentationVisible(false)
    const measured = await h.engine.measureVisibleContentRect()
    assert.equal(measured.status, 'success')
    assert.deepEqual(h.draws.at(-1), { measured: true, objects: ['pet', 'desk', 'keyboard', 'mouse'] })
    assert.equal(h.engine.renderHealthFrame(), true)
    h.engine.renderStillFrame()
    assert.deepEqual(h.draws.at(-1)?.objects, ['desk', 'keyboard', 'mouse'])
    assert.equal(h.pet.visible, true)
  })

  it('keeps successful alpha readback tight without adding a head-motion envelope', async (t) => {
    const h = fixture(t)
    const spine = new Group()
    spine.name = 'Spine02'
    const head = new Group()
    head.name = 'Head'
    head.position.y = 1
    spine.add(head)
    h.pet.add(spine)
    h.engine.setAutoViewportPadding(0)
    const rect = { x: 0, y: 0, width: 100, height: 80 }
    t.mock.method(h.engine, 'getConservativeContentRect', () => rect)
    assert.deepEqual(await h.engine.measureVisibleContentRect(), { status: 'success', rect })
  })

  it('restores scene visibility on draw failure and preserves an independently hidden pet', (t) => {
    const h = fixture(t)
    h.fail(true)
    assert.throws(() => h.engine.setPetPresentationVisible(false), /presentation draw failed/)
    assert.equal(h.pet.visible, true)
    h.fail(false)
    h.engine.renderStillFrame()
    assert.deepEqual(h.draws.at(-1)?.objects, ['desk', 'keyboard', 'mouse'])
    h.pet.visible = false
    h.engine.setPetPresentationVisible(true)
    assert.equal(h.pet.visible, false)
    assert.deepEqual(h.draws.at(-1)?.objects, ['desk', 'keyboard', 'mouse'])
  })

  it('keeps the current canvas and surroundings through a delayed skin-only replacement', async (t) => {
    const h = fixture(t)
    const skin = deferred<ReturnType<typeof normalizeVoxelSkin>>()
    // The fixture keeps GPU drawing deterministic; actual Wide/Slim skin rig
    // geometry is covered separately by voxelSkin and pet tests.
    Object.assign(h.engine, { voxelSkinModelController: { setModel() {}, dispose() {} } })
    const load = t.mock.method(h.engine as unknown as { loadSkin: () => Promise<ReturnType<typeof normalizeVoxelSkin>> }, 'loadSkin', () => skin.promise)
    const canvasRenderer = h.state.renderer
    h.engine.setPetPresentationVisible(false)
    const replacement = h.engine.setDmeloperSkin('/new-skin.png', 'wide')
    assert.equal(load.mock.callCount(), 1)
    for (let frame = 0; frame < 3; frame++) h.engine.renderStillFrame()
    assert.ok(h.draws.every(draw => draw.objects.join(',') === 'desk,keyboard,mouse'))
    skin.resolve(normalizeVoxelSkin({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(255) }, 'wide'))
    assert.equal(await replacement, 'wide')
    assert.equal(h.state.renderer, canvasRenderer)
    assert.equal(h.state.petModel, h.pet)
    assert.equal(h.engine.getPendingPetAssetState(), undefined)
    h.engine.renderStillFrame()
    assert.deepEqual(h.draws.at(-1)?.objects, ['desk', 'keyboard', 'mouse'])
    h.engine.setPetPresentationVisible(true)
    assert.deepEqual(h.draws.at(-1)?.objects, ['pet', 'desk', 'keyboard', 'mouse'])
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
    const petPointer = mock.fn()
    const petKey = mock.fn()
    const eyebrowKey = mock.fn()
    const eyebrowButton = mock.fn()
    const modes: boolean[] = []
    Object.assign(three3d, {
      mouse: { setMouseEnabled: (value: boolean) => modes.push(value), resetInput: mouseReset, setMouseButtonPressed: mouseButton, pulseWheelScroll: scroll, setMousePosition: mock.fn() },
      petAnimator: { setMouseEnabled: mock.fn(), setMousePosition: petPointer, setMouseButtonPressed: petButton, setKeyPressed: petKey, resetMouseInput: mock.fn(), resetInput: mock.fn(), dispose: mock.fn() },
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
      three3d.setMouseInputActive(false)
      three3d.handleSemanticInput({ kind: 'pointer_activity', x: 0.25, y: 0.75 })
      assert.deepEqual(petPointer.mock.calls.at(-1)?.arguments, [0.25, 0.75])
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
      assert.equal(mouseReset.mock.callCount(), 2)
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
