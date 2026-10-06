/* eslint-disable test/no-import-node-test */
import type { WebGLRenderer } from 'three'

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { DirectionalLight, PerspectiveCamera, Scene, WebGLRenderTarget } from 'three'

import type { RenderCadence } from './renderCadence'

import three3d from '../three3d'

describe('performance options in the renderer', () => {
  it('reduces actual update/draw calls together and wakes through the input and setting paths', () => {
    const state = three3d as unknown as {
      renderer?: WebGLRenderer
      scene?: Scene
      camera?: PerspectiveCamera
      keyboard?: unknown
      mouse?: unknown
      petAnimator?: unknown
      dmeloperEyebrowController?: unknown
      renderCadence: RenderCadence
      renderFrame: (timestamp: number) => void
    }
    const raf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
    const cancelRaf = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame')
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 })
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} })
    let now = 0
    const clock = mock.method(performance, 'now', () => now)
    const counts = { draw: 0, keyboard: 0, mouse: 0, pet: 0, eyebrows: 0 }
    try {
      three3d.destroy()
      three3d.setInputActive(true)
      three3d.setMouseEnabled(true)
      three3d.setMouseInputActive(true)
      three3d.setMaxFPS(60)
      state.scene = new Scene()
      state.camera = new PerspectiveCamera()
      state.renderer = { render: () => counts.draw++ } as unknown as WebGLRenderer
      state.keyboard = { update: () => counts.keyboard++ }
      state.mouse = { update: () => counts.mouse++, setMousePosition: () => {}, resetInput: () => {} }
      state.petAnimator = { update: () => counts.pet++, setMousePosition: () => {}, setMouseEnabled: () => {}, resetMouseInput: () => {}, resetInput: () => {} }
      state.dmeloperEyebrowController = { update: () => counts.eyebrows++, resetMouseInput: () => {} }
      const run = (start: number, seconds: number) => {
        for (let i = 0; i < 60 * seconds; i++) {
          now = start + i * 1000 / 60
          state.renderFrame(now)
        }
      }
      run(0, 4)
      assert.deepEqual(counts, { draw: 240, keyboard: 240, mouse: 240, pet: 240, eyebrows: 240 })
      now = 4000
      three3d.setIdlePowerSavingEnabled(true)
      run(9000, 4)
      assert.deepEqual(counts, { draw: 300, keyboard: 300, mouse: 300, pet: 300, eyebrows: 300 })
      now = 13000
      three3d.handleSemanticInput({ kind: 'pointer_activity', x: 0.4, y: 0.6 })
      state.renderFrame(13001)
      assert.equal(counts.draw, 301)
      assert.equal(state.renderCadence.getFrameLimit(18000, 60), 15)
      now = 18001
      three3d.setCameraPan(0.2, 0)
      assert.equal(state.renderCadence.getFrameLimit(18002, 60), 60)
      now = 24000
      three3d.setInputActive(false)
      three3d.handleSemanticInput({ kind: 'typing', active: true, intensity: 1 })
      assert.equal(state.renderCadence.getFrameLimit(29000, 60), 15)
      three3d.setIdlePowerSavingEnabled(false)
      for (const [index, fps] of [15, 14].entries()) {
        const before = { ...counts }
        now = 30000 + index * 4000
        three3d.setMaxFPS(fps)
        run(now, 4)
        for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
          assert.equal(counts[key] - before[key], 60, `${key}: ${fps} FPS uses the 15 FPS minimum`)
        }
      }
    } finally {
      state.renderer = undefined
      state.keyboard = undefined
      state.mouse = undefined
      state.petAnimator = undefined
      state.dmeloperEyebrowController = undefined
      three3d.destroy()
      three3d.setIdlePowerSavingEnabled(false)
      three3d.setCameraPan(0, 0)
      clock.mock.restore()
      if (raf) Object.defineProperty(globalThis, 'requestAnimationFrame', raf)
      else Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
      if (cancelRaf) Object.defineProperty(globalThis, 'cancelAnimationFrame', cancelRaf)
      else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame')
    }
  })

  it('disposes replaced shadow maps, avoids duplicate allocation, and keeps disabled quality changes', () => {
    const state = three3d as unknown as {
      renderer?: WebGLRenderer
      directionalLight?: DirectionalLight
    }
    const light = new DirectionalLight()
    const oldMap = new WebGLRenderTarget(256, 256)
    const dispose = mock.method(oldMap, 'dispose')
    const shadowMap = { enabled: true }
    three3d.setShadowQuality('low')
    state.directionalLight = light
    light.shadow.mapSize.set(256, 256)
    light.shadow.map = oldMap
    state.renderer = {
      shadowMap,
      getDrawingBufferSize: (target: { set: (x: number, y: number) => void }) => {
        target.set(800, 600)
        return target
      },
    } as unknown as WebGLRenderer
    try {
      three3d.setShadowQuality('medium')
      assert.equal(dispose.mock.callCount(), 1)
      assert.equal(light.shadow.map, null)
      assert.equal(light.shadow.mapSize.x, 512)
      assert.equal(light.shadow.needsUpdate, true)
      three3d.setShadowQuality('medium')
      assert.equal(dispose.mock.callCount(), 1)
      three3d.setShadowQuality('high')
      assert.equal(light.shadow.mapSize.x, 2048)
      assert.equal(light.shadow.radius, 8)
      Object.assign(state.renderer!, { capabilities: { maxTextureSize: 1024 } })
      three3d.setShadowQuality('medium')
      assert.equal(light.shadow.radius, 1)
      three3d.setShadowQuality('high')
      assert.equal(light.shadow.mapSize.x, 1024)
      assert.equal(light.shadow.radius, 4)
      three3d.setShadowsEnabled(false)
      three3d.setShadowQuality('low')
      assert.equal(shadowMap.enabled, false)
      assert.equal(light.shadow.mapSize.x, 256)
      three3d.setShadowsEnabled(true)
      assert.equal(light.shadow.mapSize.x, 256)
      three3d.setShadowQuality('medium')
      assert.equal(light.shadow.mapSize.x, 512)
    } finally {
      state.renderer = undefined
      three3d.destroy()
      three3d.setShadowQuality('medium')
    }
  })
})
