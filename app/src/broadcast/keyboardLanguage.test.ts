/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import { resolveKeyboardLanguage } from '@/config/keyboardLanguage'
import { createDefaultPresetSnapshot } from '@/features/presets/model'
import { applyPresetVisualSettings } from '@/features/presets/visualSettings'
import { createDefaultPet3dPreset } from '@/stores/block'

import type { createBroadcastView } from './view'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => resolve = done)
  return { promise, resolve }
}

for (const language of ['ko', 'ja'] as const) {
  it(`keeps OBS ${language} current across initial loading and measurement without asset reload`, async () => {
    const initialized = deferred()
    let measured = deferred()
    const languages: string[] = []
    let creates = 0
    let loads = 0
    let measurements = 0
    let destroyed = 0
    const bounds = { x: 0, y: 0, width: 300, height: 300 }
    function Renderer() {
      creates++
      const methods = {
        init: async () => {
          loads++
          await initialized.promise
        },
        setKeyboardLegendLanguage: (language: string) => languages.push(language),
        measureVisibleContentRect: async () => {
          measurements++
          await measured.promise
          return { status: 'success', rect: bounds }
        },
        destroy: () => destroyed++,
      }
      return new Proxy(methods, { get: (target, property) => Reflect.get(target, property) ?? (() => {}) })
    }
    const exports = {} as { createBroadcastView: typeof createBroadcastView }
    runInNewContext(ts.transpileModule(readFileSync(new URL('./view.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      exports,
      require: (id: string) => ({
        '@/utils/three3d': { Three3DRenderer: Renderer },
        '@/config/keyboardLanguage': { resolveKeyboardLanguage },
        '@/features/presets/visualSettings': { applyPresetVisualSettings },
        '@/features/broadcast/scene': { fitBroadcastOutput: () => ({ width: 300, height: 300 }) },
      })[id],
      document: { createElement: () => ({ style: {}, remove: () => {} }) },
      ResizeObserver: class {
        observe() {} disconnect() {}
      },
      performance: { now: () => 5000 },
      URL,
    })
    const view = exports.createBroadcastView({ clientWidth: 500, clientHeight: 500, append: () => {} } as unknown as HTMLElement, new URL('http://127.0.0.1/assets/'))
    const scene = {
      schemaVersion: 1 as const,
      modelId: 'dmeloper' as const,
      skinModel: 'wide' as const,
      ...createDefaultPresetSnapshot(),
      preset: createDefaultPet3dPreset(),
      performance: { maxFPS: 30, shadowsEnabled: true, shadowQuality: 'medium' as const, renderScalePercent: 100, idlePowerSavingEnabled: true, antialiasEnabled: true, pixelFilterEnabled: false },
    }
    scene.preset.keyboardLegendLanguage = 'system'
    view.keyboardLanguage('en')
    const applying = view.apply(scene, () => true)
    view.keyboardLanguage(language)
    initialized.resolve()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(languages.at(-1), language)
    assert.equal(measurements, 1)
    view.keyboardLanguage('en')
    measured.resolve()
    await applying
    assert.equal(languages.at(-1), 'en')
    const afterApply = languages.length
    view.keyboardLanguage(language)
    assert.equal(languages.at(-1), language)
    assert.equal(languages.length, afterApply + 1)
    const manual = structuredClone(scene)
    manual.preset.keyboardLegendLanguage = language
    measured = deferred()
    const manualApplying = view.apply(manual, () => true)
    await new Promise(resolve => setImmediate(resolve))
    const manualUpdates = languages.length
    view.keyboardLanguage('en')
    assert.equal(languages.length, manualUpdates, 'in-flight manual scene cannot be overwritten by a system update')
    measured.resolve()
    await manualApplying
    assert.equal(languages.at(-1), language)
    await view.apply(scene, () => true)
    assert.equal(languages.at(-1), 'en', 'returning to system uses its newest cached state')
    assert.equal(creates, 1)
    assert.equal(loads, 1)
    assert.equal(destroyed, 0)
    view.dispose()
  })
}
