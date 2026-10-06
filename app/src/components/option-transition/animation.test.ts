/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'

import { animateOptionTransition, cancelOptionTransition } from './animation'

it('animates height/opacity, reverses continuously and restores focus/style ownership', () => {
  const names = ['HTMLElement', 'document', 'getComputedStyle', 'matchMedia'] as const
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  let reduced = false
  let blurCount = 0
  const active = { blur: () => blurCount++ }
  class ElementFixture {
    style = { overflow: 'visible', boxSizing: '' }
    inert = false
    computed = { height: '100px', opacity: '1', paddingTop: '16px', paddingBottom: '16px', marginTop: '0px', marginBottom: '0px' }
    animations: Array<{ frames: Keyframe[], onfinish: (() => void) | null, cancel: () => void, cancelled: boolean }> = []
    contains = (element: unknown) => element === active
    animate(frames: Keyframe[]) {
      const animation = { frames, onfinish: null as (() => void) | null, cancelled: false, cancel: () => {
        animation.cancelled = true
      } }
      this.animations.push(animation)
      return animation
    }
  }
  Object.defineProperties(globalThis, {
    HTMLElement: { configurable: true, value: ElementFixture },
    document: { configurable: true, value: { activeElement: active } },
    getComputedStyle: { configurable: true, value: (element: ElementFixture) => element.computed },
    matchMedia: { configurable: true, value: () => ({ matches: reduced }) },
  })
  try {
    const element = new ElementFixture()
    const dom = element as unknown as Element
    let hidden = 0
    let shown = 0
    animateOptionTransition(dom, false, () => hidden++)
    assert.equal(element.inert, true)
    assert.equal(blurCount, 1)
    assert.equal(element.style.overflow, 'hidden')
    const leaving = element.animations[0]
    assert.equal(leaving.frames[0].height, '100px')
    assert.equal(leaving.frames[1].height, '0')
    element.computed = { ...element.computed, height: '40px', opacity: '0.4' }
    cancelOptionTransition(dom)
    assert.equal(leaving.cancelled, true)
    element.computed = { ...element.computed, height: '100px', opacity: '1' }
    animateOptionTransition(dom, true, () => shown++)
    const entering = element.animations[1]
    assert.equal(entering.frames[0].height, '40px')
    assert.equal(entering.frames[0].opacity, '0.4')
    assert.equal(entering.frames[1].height, '100px')
    assert.equal(element.inert, false)
    entering.onfinish!()
    assert.equal(hidden, 0)
    assert.equal(shown, 1)
    assert.equal(element.style.overflow, 'visible')
    assert.equal(element.style.boxSizing, '')
    reduced = true
    animateOptionTransition(dom, false, () => hidden++)
    assert.equal(hidden, 1)
    assert.equal(element.animations.length, 2)
    assert.equal(element.inert, false)
  } finally {
    for (const name of names) {
      const original = originals.get(name)
      if (original) Object.defineProperty(globalThis, name, original)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
