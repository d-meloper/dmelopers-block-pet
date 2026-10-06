/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import defaults from '@/config/defaultSettings.json'
import { APP_DISPLAY_NAME } from '@/constants/branding'
import { isDesktopPetVisible } from '@/features/broadcast/visibility'

import type { DistributionChannel } from './distribution'

const secret = 'PRIVATE_USER_SKIN_PRESET_TOKEN'

function harness(channel: DistributionChannel = 'github') {
  const block = { model: { ...defaults.model }, window: { ...defaults.window }, customization3d: { name: secret, png: secret } }
  const general = { broadcast: { enabled: true, showOnDesktop: false, url: secret } }
  let released = 0
  let failGraphics = false
  let failDistribution = false
  let contextAvailable = true
  const gl = {
    RENDERER: 1,
    isContextLost: () => false,
    getParameter: () => {
      if (failGraphics) throw new Error(secret)
      return 'ANGLE (Example GPU)'
    },
    getExtension: (name: string) => name === 'WEBGL_debug_renderer_info'
      ? { UNMASKED_RENDERER_WEBGL: 2 }
      : { loseContext: () => {
          released++
        } },
  }
  const canvas = { width: 0, height: 0, getContext: () => contextAvailable ? gl : null }
  const modules: Record<string, object> = {
    '@tauri-apps/api/app': { getVersion: async () => '1.2.3', getTauriVersion: async () => '2.11.0' },
    '@tauri-apps/api/core': { invoke: async (command: string) => {
      assert.equal(command, 'support_system_info')
      return { windowsEdition: 'Professional', windowsRelease: '24H2', windowsBuild: '10.0.26100.1234', webview2Version: '142.0.1.2', unexpected: secret }
    } },
    '@tauri-apps/api/window': { availableMonitors: async () => [{ name: secret, size: { width: 3840, height: 2160 }, scaleFactor: 1.5 }] },
    '@tauri-apps/plugin-os': { arch: () => 'x86_64', platform: () => 'windows', version: () => '10.0.26100' },
    '@/constants/branding': { APP_DISPLAY_NAME },
    '@/features/broadcast/visibility': { isDesktopPetVisible },
    '@/stores/block': { useBlockStore: () => block },
    '@/stores/general': { useGeneralStore: () => general },
    './distribution': { getDistributionInfo: async () => {
      if (failDistribution) throw new Error(secret)
      return { channel, dataRoot: secret, localDataRoot: secret, updateUrl: secret }
    } },
  }
  const module = { exports: {} as typeof import('./environmentInfo') }
  runInNewContext(ts.transpileModule(readFileSync(new URL('./environmentInfo.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    require: (id: string) => {
      assert.ok(modules[id], `Unexpected module ${id}`)
      return modules[id]
    },
    navigator: { userAgent: `Chrome/142.0.0.0 ${secret}` },
    document: { createElement: () => canvas },
  })
  return {
    api: module.exports,
    block,
    general,
    canvas,
    released: () => released,
    fail: () => {
      failGraphics = failDistribution = true
    },
    withoutContext: () => {
      contextAvailable = false
    },
  }
}

it('copies core information for all channels without private data or settings mutations', async () => {
  for (const channel of ['github', 'store', 'test', 'development'] as const) {
    const h = harness(channel)
    const before = JSON.stringify({ block: h.block, general: h.general })
    const report = await h.api.collectEnvironmentInfo()
    assert.equal(report.distributionChannel, channel)
    assert.equal(report.appVersion, '1.2.3')
    assert.equal(report.platformVersion, '10.0.26100')
    assert.equal(report.system?.windowsBuild, '10.0.26100.1234')
    assert.equal(report.system?.windowsRelease, '24H2')
    assert.equal(report.system?.webview2Version, '142.0.1.2')
    assert.equal(report.displays?.[0].scaleFactor, 1.5)
    assert.equal(report.graphics?.renderer, 'ANGLE (Example GPU)')
    assert.equal(report.rendering?.maxFPS, defaults.model.maxFPS)
    assert.equal(report.visibility?.petVisible, true)
    assert.equal(report.visibility?.effectiveDesktopVisible, false)
    assert.equal(report.unavailable.length, 0)
    assert.ok(!JSON.stringify(report).includes(secret))
    assert.ok(JSON.stringify(report).length < 1500)
    assert.equal(JSON.stringify({ block: h.block, general: h.general }), before)
    assert.equal(h.released(), 1)
    assert.equal(h.canvas.width, 0)
  }
})

it('copies partial results without raw errors and releases a failed graphics probe', async () => {
  const h = harness()
  h.fail()
  const report = await h.api.collectEnvironmentInfo()
  assert.equal(report.appVersion, '1.2.3')
  assert.equal(report.distributionChannel, null)
  assert.equal(report.graphics, null)
  assert.deepEqual(Array.from(report.unavailable, entry => entry.section), ['distributionChannel', 'graphics'])
  assert.ok(!JSON.stringify(report).includes(secret))
  assert.equal(h.released(), 1)
})

it('reports a missing WebGL2 context and disabled shadows accurately', async () => {
  const h = harness()
  h.withoutContext()
  h.block.model.shadowsEnabled = false
  const report = await h.api.collectEnvironmentInfo()
  assert.equal(report.graphics?.contextAvailable, false)
  assert.equal(report.graphics?.renderer, null)
  assert.equal(report.rendering?.shadowQuality, 'off')
  assert.equal(h.released(), 0)
})

it('bounds hung reads and catches sync/async errors while retaining false and zero', async () => {
  const h = harness()
  let rejectLate!: (error: unknown) => void
  const result = await h.api.collectEnvironmentSources({
    hung: () => new Promise((_resolve, reject) => {
      rejectLate = reject
    }),
    syncError: () => {
      throw new Error(secret)
    },
    asyncError: async () => {
      throw new Error(secret)
    },
    disabled: () => false,
    zero: () => 0,
  }, 10)
  assert.equal(result.values.hung, null)
  assert.equal(result.values.disabled, false)
  assert.equal(result.values.zero, 0)
  assert.equal(result.unavailable.find(entry => entry.section === 'hung')?.reason, 'timeout')
  assert.equal(result.unavailable.length, 3)
  rejectLate(new Error(secret))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(!JSON.stringify(result).includes(secret))
})
