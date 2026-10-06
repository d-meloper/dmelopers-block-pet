/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import type { createLoadingPaintBarrier } from './loadingPaint'

const source = ts.transpileModule(readFileSync(new URL('./loadingPaint.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function harness(hidden = false) {
  const exports = {} as { createLoadingPaintBarrier: typeof createLoadingPaintBarrier }
  const frames = new Map<number, () => void>()
  const timers = new Map<number, () => void>()
  let sequence = 0
  runInNewContext(source, {
    exports,
    document: { hidden },
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++sequence, callback)
      return sequence
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (callback: () => void, delay: number) => {
      assert.equal(delay, 150)
      timers.set(++sequence, callback)
      return sequence
    },
    clearTimeout: (id: number) => timers.delete(id),
  })
  const step = (callbacks: Map<number, () => void>) => {
    const [id, callback] = callbacks.entries().next().value!
    callbacks.delete(id)
    callback()
  }
  return { barrier: exports.createLoadingPaintBarrier(), frames, timers, frame: () => step(frames), timeout: () => step(timers) }
}

it('shares a pending wait and permits a paint between two RAF callbacks before asset work', async () => {
  const h = harness()
  const wait = h.barrier.wait()
  assert.equal(h.barrier.wait(), wait)
  let done = false
  void wait.then(() => {
    done = true
  })
  await Promise.resolve()
  assert.equal(done, false)
  h.frame()
  await Promise.resolve()
  assert.equal(done, false)
  h.frame()
  await wait
  assert.equal(done, true)
  assert.equal(h.frames.size + h.timers.size, 0)
})

for (const stage of ['before-frame', 'after-frame'] as const) {
  it(`releases cancellation ${stage} without leaking scheduled callbacks`, async () => {
    const h = harness()
    const wait = h.barrier.wait()
    if (stage === 'after-frame') h.frame()
    h.barrier.cancel()
    h.barrier.cancel()
    await wait
    assert.equal(h.frames.size + h.timers.size, 0)
    assert.notEqual(h.barrier.wait(), wait)
    h.barrier.cancel()
  })
}

it('bounds a wait when a minimized webview suspends animation frames', async () => {
  const h = harness()
  const wait = h.barrier.wait()
  h.timeout()
  await wait
  assert.equal(h.frames.size + h.timers.size, 0)
})

it('does not request frames for a hidden document', async () => {
  const h = harness(true)
  await h.barrier.wait()
  assert.equal(h.frames.size + h.timers.size, 0)
})
