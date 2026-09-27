/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { NormalizedVoxelSkin } from '@/utils/three3d/voxelSkin'

import { applyPresetSnapshot, capturePresetSnapshot, clonePreset } from '@/features/presets/model'
import { useCatStore } from '@/stores/cat'

const require = createRequire(import.meta.url)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

async function flush() {
  for (let index = 0; index < 15; index++) await Vue.nextTick()
}

function harness(options: { render?: boolean, migration?: boolean, nickname?: boolean } = {}) {
  setActivePinia(createPinia())
  const store = useCatStore()
  store.applySkinLibraryEntry({
    entryId: 'a'.repeat(64),
    source: 'local',
    dataUrl: 'data:image/png;base64,YQ==',
    skinModel: 'slim',
  })
  const decoding = deferred<Pick<NormalizedVoxelSkin, 'wideArmLayoutCompatible' | 'model' | 'suggestedEyebrowColor' | 'suggestedPalmColor' | 'data' | 'convertedFromLegacy'>>()
  const unmounts: Array<() => void> = []
  const dialogs: Array<{ onOk: () => void }> = []
  const migrated: unknown[] = []
  const scope = Vue.effectScope()
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const transformed = ts.transpileModule(compileScript(descriptor, { id: 'pet-skin-lifetime-test', inlineTemplate: options.render }).content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} as { default: { setup: (props: object, context: object) => unknown } } }
  // Exercise the actual skin watcher with a delayed decoder and real persisted state.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', 'fetch', transformed)((id: string) => {
    if (id === 'vue') return { ...Vue, withDirectives: (node: Vue.VNode) => node, onMounted: () => {}, onBeforeUnmount: (callback: () => void) => unmounts.push(callback) }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
    if (id === 'ant-design-vue') return { Button: {}, Flex: {}, Input: { Search: {} }, Modal: { confirm: (dialog: { onOk: () => void }) => dialogs.push(dialog) }, Segmented: {}, Select: { Option: {} }, Switch: {} }
    if (id === '@/stores/cat') return { ...require(fileURLToPath(new URL('../../../../stores/cat.ts', import.meta.url))), useCatStore: () => store }
    if (id === '@/services/dmeloperSkin') return { resolveDmeloperSkinUrl: async (url: string) => url, resolveDefaultDmeloperPalmColor: async () => '#445566' }
    if (id === '@/utils/three3d/voxelSkin') return { ...require(fileURLToPath(new URL('../../../../utils/three3d/voxelSkin.ts', import.meta.url))), decodeVoxelSkin: () => decoding.promise }
    if (options.nickname && id === '@/services/minecraftSkin') return { ...require(fileURLToPath(new URL('../../../../services/minecraftSkin.ts', import.meta.url))), fetchMinecraftSkin: async () => ({ canonicalName: 'Alex', model: 'slim', height: 64, pngBase64: 'iVBORw0KGgo=' }) }
    if ((options.migration || options.nickname) && id === '@/utils/skinThumbnail') return { createSkinFaceThumbnailPngBase64: async () => 'thumbnail' }
    if ((options.migration || options.nickname) && id === '@/services/skinLibrary') {
      return { storeSkinLibraryEntry: async (value: unknown) => {
        migrated.push(value)
        return { id: 'b'.repeat(64) }
      } }
    }
    if (id.startsWith('@/components/')) return { default: {} }
    if (id === '@/services/diagnostics') return { reportDiagnostic: () => {} }
    if (id.startsWith('@/')) return require(fileURLToPath(new URL(`../../../../${id.slice(2)}`, import.meta.url)))
    throw new Error(`Unexpected import: ${id}`)
  }, module, module.exports, async () => ({ ok: true, blob: async () => new Blob() }))
  const setupResult = scope.run(() => module.exports.default.setup({}, { expose: () => {}, emit: () => {} }))
  const flatten = (node: Vue.VNode): Vue.VNode[] => {
    const children = Array.isArray(node.children)
      ? node.children
      : typeof node.children === 'object' && typeof node.children?.default === 'function' ? node.children.default() : []
    return [node, ...children.flatMap((child: unknown) => Vue.isVNode(child) ? flatten(child) : [])]
  }
  return {
    store,
    applyNickname: async (name: string) => {
      const setup = setupResult as { minecraftSkinUsernameDraft: Vue.Ref<string>, applyMinecraftSkinNickname: () => Promise<void> }
      setup.minecraftSkinUsernameDraft.value = name
      await setup.applyMinecraftSkinNickname()
    },
    dialogs,
    migrated,
    migrate: () => (setupResult as { migrateStoredSkinToLibrary: () => Promise<void> }).migrateStoredSkinToLibrary(),
    sourceStatus: () => (setupResult as { minecraftSkinSourceStatus: Vue.ComputedRef<string> }).minecraftSkinSourceStatus.value,
    nodes: () => {
      assert.equal(typeof setupResult, 'function')
      return flatten((setupResult as (context: object, cache: unknown[]) => Vue.VNode)({ $t: (key: string) => key }, []))
    },
    complete: () => decoding.resolve({ wideArmLayoutCompatible: false, model: 'slim', suggestedEyebrowColor: '#112233', suggestedPalmColor: '#445566', convertedFromLegacy: false, data: Uint8Array.from({ length: 64 * 64 * 4 }, (_, index) => [68, 85, 102, 255][index % 4]) }),
    unmount: () => {
      scope.stop()
      unmounts.splice(0).forEach(callback => callback())
    },
  }
}

describe('Pet tab asynchronous skin analysis', () => {
  it('still saves and links the migrated PNG while its Pet tab owns the operation', async () => {
    const h = harness({ migration: true })
    h.store.customization3d.skinLibraryMigrationCompleted = false
    try {
      const migration = h.migrate()
      h.complete()
      await migration
      assert.equal(h.migrated.length, 1)
      assert.equal(h.store.customization3d.activeSkinLibraryEntryId, 'b'.repeat(64))
      assert.equal(h.store.customization3d.skinLibraryMigrationCompleted, true)
    } finally {
      h.complete()
      h.unmount()
    }
  })

  it('does not recreate a migrated skin after leaving Pet and resetting the program during decode', async () => {
    const h = harness({ migration: true })
    h.store.customization3d.skinLibraryMigrationCompleted = false
    const migration = h.migrate()
    try {
      await flush()
      h.unmount()
      h.store.resetAllSettings()
      const reset = clonePreset(h.store.customization3d)
      h.complete()
      await migration
      assert.deepEqual(h.migrated, [], 'the departed Pet tab must not write an old PNG into the cleared library')
      assert.deepEqual(clonePreset(h.store.customization3d), reset)
    } finally {
      h.complete()
      h.unmount()
    }
  })

  it('identifies materialized built-in preset PNGs as the default while keeping user imports local', () => {
    const h = harness()
    try {
      assert.equal(h.sourceStatus(), 'pages.preference.cat.status.localSkin')
      h.store.customization3d.activeSkinLibraryEntryId = 'builtin:dmeloper'
      assert.equal(h.sourceStatus(), 'pages.preference.cat.status.defaultSkin')
      h.store.customization3d.activeSkinLibraryEntryId = 'a'.repeat(64)
      assert.equal(h.sourceStatus(), 'pages.preference.cat.status.localSkin')
      h.store.customization3d.minecraftSkinUsername = 'jeb_'
      assert.equal(h.sourceStatus(), 'pages.preference.cat.status.minecraftSkinApplied')
    } finally {
      h.complete()
      h.unmount()
    }
  })

  it('does not overwrite the newly selected preset after leaving the Pet tab during decode', async () => {
    const h = harness()
    try {
      await flush()
      h.unmount()
      const next = capturePresetSnapshot(h.store)
      next.appearance.dmeloperSkinDataUrl = 'data:image/png;base64,Yg=='
      next.appearance.activeSkinLibraryEntryId = 'b'.repeat(64)
      next.appearance.dmeloperSkinModel = 'wide'
      next.preset.dmeloperEyebrows.color = '#778899'
      next.preset.dmeloperPalmColor = '#AABBCC'
      applyPresetSnapshot(h.store, next)
      const expected = clonePreset(h.store.customization3d)
      h.complete()
      await flush()
      assert.deepEqual(clonePreset(h.store.customization3d), expected)
    } finally {
      h.complete()
      h.unmount()
    }
  })

  it('resolves arm compatibility without replacing preset appearance with sampled skin colors', async () => {
    const h = harness()
    try {
      await flush()
      h.store.setDmeloperSkinModel('wide')
      h.store.updateDmeloperEyebrows({ enabled: false, color: '#778899', widthPixels: 3 })
      h.store.updateDmeloperPalmColor('#AABBCC')
      const eyebrows = clonePreset(h.store.activePet3dPreset.dmeloperEyebrows)
      h.complete()
      await flush()
      assert.equal(h.store.customization3d.dmeloperSkinModel, 'slim')
      assert.deepEqual(clonePreset(h.store.activePet3dPreset.dmeloperEyebrows), eyebrows)
      assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#AABBCC')
    } finally {
      h.unmount()
    }
  })

  it('keeps a same-skin preset appearance when an earlier decode finishes in the mounted Pet tab', async () => {
    const h = harness()
    try {
      await flush()
      const next = capturePresetSnapshot(h.store)
      next.preset.dmeloperEyebrows = { ...next.preset.dmeloperEyebrows, color: '#778899', widthPixels: 4 }
      next.preset.dmeloperPalmColor = '#AABBCC'
      applyPresetSnapshot(h.store, next)
      h.complete()
      await flush()
      assert.deepEqual(capturePresetSnapshot(h.store), next)
    } finally {
      h.unmount()
    }
  })
})

describe('Pet tab eyebrow control availability', () => {
  it('routes the two shared color controls to their existing preset appearance fields', () => {
    const h = harness({ render: true })
    try {
      for (const [label, value] of [['dmeloperPalmColor', '#112233'], ['dmeloperEyebrowColor', '#445566']]) {
        const picker = h.nodes().find(node => node.props?.label === `pages.preference.cat.labels.${label}`)!
        picker.props!['onUpdate:value'](value)
      }
      const preset = capturePresetSnapshot(h.store).preset
      assert.equal(preset.dmeloperPalmColor, '#112233')
      assert.equal(preset.dmeloperEyebrows.color, '#445566')
    } finally {
      h.complete()
      h.unmount()
    }
  })

  it('disables every subordinate control and reset while preserving settings across OFF and ON', () => {
    const h = harness({ render: true })
    const eyebrowNodes = () => {
      const section = h.nodes().find(node => node.props?.title === 'pages.preference.cat.labels.dmeloperEyebrowSettings')!
      const children = (section.children as { default: () => Vue.VNode[] }).default()
      const flatten = (node: Vue.VNode): Vue.VNode[] => {
        const slots = node.children as { default?: () => Vue.VNode[] } | null
        const nested = Array.isArray(node.children) ? node.children : typeof slots?.default === 'function' ? slots.default() : []
        return [node, ...nested.flatMap(child => Vue.isVNode(child) ? flatten(child) : [])]
      }
      return children.flatMap(flatten)
    }
    try {
      h.store.updateDmeloperEyebrows({ color: '#123456', heightOffsetPixels: 1, widthPixels: 3, depthPercent: 0 })
      h.store.model.eyebrowAnimationEnabled = false
      const before = clonePreset(h.store.activePet3dPreset.dmeloperEyebrows)
      const reset = () => eyebrowNodes().find(node => typeof node.props?.onClick === 'function')!
      reset().props!.onClick()
      assert.equal(h.dialogs.length, 1)
      h.store.updateDmeloperEyebrows({ enabled: false })
      const disabled = eyebrowNodes().filter(node => node.props?.disabled)
      assert.equal(disabled.length, 9)
      const depthRow = eyebrowNodes().find(node => node.props?.title === 'pages.preference.cat.labels.dmeloperEyebrowDepth')!
      const depth = (depthRow.children as { default: () => Vue.VNode[] }).default()[0]
      assert.equal(depth.props?.disabled, true)
      assert.equal(depth.props?.value, 0)
      reset().props!.onClick()
      assert.equal(h.dialogs.length, 1)
      h.dialogs[0].onOk()
      assert.deepEqual(clonePreset(h.store.activePet3dPreset.dmeloperEyebrows), { ...before, enabled: false })
      assert.equal(h.store.model.eyebrowAnimationEnabled, false)
      h.store.updateDmeloperEyebrows({ enabled: true })
      assert.equal(eyebrowNodes().filter(node => node.props?.disabled).length, 0)
      assert.deepEqual(clonePreset(h.store.activePet3dPreset.dmeloperEyebrows), before)
      assert.equal(h.store.model.eyebrowAnimationEnabled, false)
    } finally {
      h.complete()
      h.unmount()
    }
  })
})

describe('Pet palm automatic color actions', () => {
  it('samples the current skin on automatic reset and immediately updates the preset', async () => {
    const h = harness({ render: true })
    const button = () => h.nodes().find(node => node.props?.onClick?.name === 'resetDmeloperPalmColor')!
    try {
      h.store.updateDmeloperPalmColor('#AABBCC')
      assert.equal(button().props!.disabled, true)
      h.complete()
      await flush()
      assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#AABBCC')
      assert.equal(button().props!.disabled, false)
      button().props!.onClick()
      assert.equal(capturePresetSnapshot(h.store).preset.dmeloperPalmColor, '#445566')
      h.store.setDmeloperSkinDataUrl('data:image/png;base64,Yg==')
      assert.equal(button().props!.disabled, true)
      button().props!.onClick()
      assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#445566')
    } finally {
      h.complete()
      h.unmount()
    }
  })

  it('applies a Java nickname with its sampled palm while preserving eyebrows', async () => {
    const h = harness({ nickname: true })
    try {
      h.store.updateDmeloperEyebrows({ color: '#AABBCC' })
      const applying = h.applyNickname('Alex')
      h.complete()
      await applying
      assert.equal(h.store.customization3d.minecraftSkinUsername, 'Alex')
      assert.equal(capturePresetSnapshot(h.store).preset.dmeloperPalmColor, '#445566')
      assert.equal(h.store.activePet3dPreset.dmeloperEyebrows.color, '#AABBCC')
      h.store.updateDmeloperPalmColor('#123456')
      await h.applyNickname('')
      assert.equal(h.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
      assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#445566')
    } finally {
      h.complete()
      h.unmount()
    }
  })
})
