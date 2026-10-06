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

import { fromSliderDisplayValue } from '@/components/default-snap-slider/displayValue'
import { DEFAULT_MODEL_SETTINGS } from '@/config/defaultSettings'
import presetRanges from '@/config/presetRanges.json'
import { applyPresetSnapshot, capturePresetSnapshot, clonePreset } from '@/features/presets/model'
import * as presetOperations from '@/features/presets/operations'
import * as stateSafety from '@/features/stateSafety/bridge'
import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'

const require = createRequire(import.meta.url)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 15; index++) await Vue.nextTick()
}

function harness(options: { render?: boolean, migration?: boolean, nickname?: boolean } = {}) {
  setActivePinia(createPinia())
  const store = useBlockStore()
  store.applySkinLibraryEntry({
    entryId: 'a'.repeat(64),
    source: 'local',
    dataUrl: 'data:image/png;base64,YQ==',
    skinModel: 'slim',
  })
  const decoding = deferred<Pick<NormalizedVoxelSkin, 'wideArmLayoutCompatible' | 'model' | 'suggestedEyebrowColor' | 'suggestedPalmColor' | 'data' | 'convertedFromLegacy'>>()
  const unmounts: Array<() => void> = []
  const dialogs: Array<{ title: string, onOk: () => void }> = []
  const migrated: unknown[] = []
  const visibility = new Map<Vue.VNode, boolean>()
  const scope = Vue.effectScope()
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const transformed = ts.transpileModule(compileScript(descriptor, { id: 'pet-skin-lifetime-test', inlineTemplate: options.render }).content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} as { default: { setup: (props: object, context: object) => unknown } } }
  // Exercise the actual skin watcher with a delayed decoder and real persisted state.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', 'fetch', transformed)((id: string) => {
    if (id === 'vue') {
      return { ...Vue, withDirectives: (node: Vue.VNode, bindings: Array<[unknown, boolean]>) => {
        for (const [directive, value] of bindings) {
          if (directive === Vue.vShow) visibility.set(node, value)
        }
        return node
      }, onMounted: () => {}, onBeforeUnmount: (callback: () => void) => unmounts.push(callback) }
    }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
    if (id === 'ant-design-vue') return { Button: {}, Flex: {}, Input: { Search: {} }, Modal: { confirm: (dialog: { title: string, onOk: () => void }) => dialogs.push(dialog) }, Segmented: {}, Select: { Option: {} }, Switch: {}, TabPane: {}, Tabs: {} }
    if (id === '@/features/presets/operations') return presetOperations
    if (id === '@/features/stateSafety/bridge') return stateSafety
    if (id === '@/stores/block') return { ...require(fileURLToPath(new URL('../../../../stores/block.ts', import.meta.url))), useBlockStore: () => store }
    if (id === '@/config/presetRanges.json') return { default: presetRanges }
    if (id === '@/services/dmeloperSkin') return { resolveDmeloperSkinUrl: async (url: string) => url, resolveDefaultDmeloperColors: async () => ({ palmColor: '#445566', eyebrowColor: '#778899' }) }
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
    visibility,
    flatten,
    migrate: () => (setupResult as { migrateStoredSkinToLibrary: () => Promise<void> }).migrateStoredSkinToLibrary(),
    sourceStatus: () => (setupResult as { minecraftSkinSourceStatus: Vue.ComputedRef<string> }).minecraftSkinSourceStatus.value,
    nodes: () => {
      visibility.clear()
      assert.equal(typeof setupResult, 'function')
      return flatten((setupResult as (context: object, cache: unknown[]) => Vue.VNode)({ $t: (key: string) => key }, []))
    },
    complete: () => decoding.resolve({ wideArmLayoutCompatible: false, model: 'slim', suggestedEyebrowColor: '#112233', suggestedPalmColor: '#445566', convertedFromLegacy: false, data: Uint8Array.from({ length: 64 * 64 * 4 }, (_, index) => [68, 85, 102, 255][index % 4]) }),
    failDecode: () => decoding.reject(new Error('Invalid saved skin')),
    unmount: () => {
      scope.stop()
      unmounts.splice(0).forEach(callback => callback())
    },
  }
}

function selectDetailTab(h: ReturnType<typeof harness>, tab: 'body' | 'arms' | 'eyebrows') {
  const tabs = h.nodes().find(node => typeof node.props?.['onUpdate:activeKey'] === 'function')!
  tabs.props!['onUpdate:activeKey'](tab)
}

function detailResetButton(h: ReturnType<typeof harness>) {
  return h.nodes().find(node => node.props?.onClick?.name === 'confirmPetDetailReset')!
}

describe('Pet detail reversed control directions', () => {
  for (const [field, title, defaultValue, min, max] of [
    ['petDeskOffset', 'pages.preference.environment.labels.deskDistance', 0, -0.4, 0.4],
    ['petRightArmSpreadDegrees', 'pages.preference.block.labels.petRightArmSpread', 0, -45, 45],
    ['depthPercent', 'pages.preference.block.labels.dmeloperEyebrowDepth', createDefaultPet3dPreset().dmeloperEyebrows.depthPercent, 0, 200],
  ] as const) {
    it(`reverses ${field} at the UI boundary while retaining old stored values and every other setting`, async () => {
      const h = harness({ render: true })
      try {
        h.complete()
        await flush()
        h.store.activePet3dPreset.petDeskOffset = 0.3
        h.store.activePet3dPreset.petRightArmSpreadDegrees = 20
        h.store.activePet3dPreset.petLeftArmSpreadDegrees = -12
        h.store.updateDmeloperEyebrows({ depthPercent: 75, heightOffsetPixels: 1 })
        const before = JSON.parse(JSON.stringify(h.store.$state))
        const control = () => {
          const row = h.nodes().find(node => node.props?.title === title)!
          return (row.children as { default: () => Vue.VNode[] }).default()[0]
        }
        const stored = field === 'depthPercent' ? before.customization3d.preset.dmeloperEyebrows[field] : before.customization3d.preset[field]
        assert.equal(control().props?.value, 0 - stored)
        assert.deepEqual(JSON.parse(JSON.stringify(h.store.$state)), before, 'rendering a restored value does not edit its stored scene meaning')
        assert.equal(control().props?.['default-value'], 0 - defaultValue)
        assert.equal(control().props?.min, 0 - max)
        assert.equal(control().props?.max, 0 - min)
        for (const [displayed, expected] of [[-1, max], [1, min], [0, defaultValue]]) {
          const slider = control()
          const props = slider.props!
          const edited = fromSliderDisplayValue(displayed, { min: props.min, max: props.max, defaultValue: props['default-value'] })
          props['onUpdate:value'](edited)
          if (field === 'depthPercent') before.customization3d.preset.dmeloperEyebrows[field] = expected
          else before.customization3d.preset[field] = expected
          assert.deepEqual(JSON.parse(JSON.stringify(h.store.$state)), before)
          assert.equal(control().props?.value, 0 - expected)
        }
      } finally {
        h.unmount()
        await flush()
      }
    })
  }
})

describe('Pet detail category resets', () => {
  for (const tab of ['body', 'arms', 'eyebrows'] as const) {
    it(`resets only ${tab}, matches its label and captures its scope before confirmation`, async () => {
      const h = harness({ render: true })
      try {
        h.complete()
        await flush()
        h.store.updateActivePet3dPreset({
          petHeadScalePercent: 175,
          petRotationDegrees: 35,
          petDeskOffset: -0.4,
          petRightArmBendPercent: 180,
          petRightArmSpreadDegrees: 12,
          petLeftArmBendPercent: 170,
          petLeftArmSpreadDegrees: -18,
          dmeloperPalmColor: '#123456',
          cameraZoomPercent: 150,
          keyboardScalePercent: 125,
          mouseEnabled: false,
        })
        h.store.updateDmeloperEyebrows({ color: '#654321', widthPixels: 3, depthPercent: 0, enabled: tab !== 'eyebrows' })
        h.store.model.eyebrowAnimationEnabled = false
        h.store.window.opacity = 45
        const before = JSON.parse(JSON.stringify(h.store.$state))
        selectDetailTab(h, tab)
        assert.deepEqual(JSON.parse(JSON.stringify(h.store.$state)), before, 'changing category is not a settings edit')
        const button = detailResetButton(h)
        const label = (button.children as { default: () => Vue.VNode[] }).default()[0].children
        assert.equal(label, `pages.preference.block.detailReset.${tab}`)
        button.props!.onClick()
        assert.equal(h.dialogs[0].title, `pages.preference.block.detailResetConfirm.${tab}`)
        assert.deepEqual(JSON.parse(JSON.stringify(h.store.$state)), before, 'opening confirmation cannot reset settings')
        selectDetailTab(h, tab === 'body' ? 'arms' : 'body')
        h.dialogs[0].onOk()
        const defaults = createDefaultPet3dPreset()
        if (tab === 'body') {
          Object.assign(before.customization3d.preset, {
            petHeadScalePercent: defaults.petHeadScalePercent,
            petRotationDegrees: defaults.petRotationDegrees,
            petDeskOffset: defaults.petDeskOffset,
          })
        } else if (tab === 'arms') {
          Object.assign(before.customization3d.preset, {
            petRightArmBendPercent: defaults.petRightArmBendPercent,
            petRightArmSpreadDegrees: defaults.petRightArmSpreadDegrees,
            petLeftArmBendPercent: defaults.petLeftArmBendPercent,
            petLeftArmSpreadDegrees: defaults.petLeftArmSpreadDegrees,
            dmeloperPalmColor: defaults.dmeloperPalmColor,
          })
        } else {
          before.customization3d.preset.dmeloperEyebrows = defaults.dmeloperEyebrows
          before.model.eyebrowAnimationEnabled = DEFAULT_MODEL_SETTINGS.eyebrowAnimationEnabled
        }
        assert.deepEqual(JSON.parse(JSON.stringify(h.store.$state)), before, 'all fields outside the confirmed category stay intact')
      } finally {
        h.unmount()
        await flush()
      }
    })

    it(`blocks ${tab} reset if saving starts before or after the confirmation opens`, async () => {
      const h = harness({ render: true })
      try {
        h.complete()
        await flush()
        h.store.activePet3dPreset.petHeadScalePercent = 170
        h.store.activePet3dPreset.petRightArmBendPercent = 180
        h.store.updateDmeloperEyebrows({ widthPixels: 3 })
        selectDetailTab(h, tab)
        const before = JSON.parse(JSON.stringify(h.store.$state))
        stateSafety.editorsLocked.value = true
        assert.equal(detailResetButton(h).props?.disabled, true)
        detailResetButton(h).props!.onClick()
        assert.equal(h.dialogs.length, 0)
        stateSafety.editorsLocked.value = false
        detailResetButton(h).props!.onClick()
        assert.equal(h.dialogs.length, 1)
        stateSafety.editorsLocked.value = true
        h.dialogs[0].onOk()
        assert.deepEqual(JSON.parse(JSON.stringify(h.store.$state)), before)
      } finally {
        stateSafety.editorsLocked.value = false
        h.unmount()
        await flush()
      }
    })
  }
})

describe('Pet tab asynchronous skin analysis', () => {
  for (const outcome of ['success', 'failure', 'disposed', 'superseded'] as const) {
    it(`holds the save barrier through saved-skin analysis and releases after ${outcome}`, async () => {
      await flush()
      const pendingBefore = presetOperations.presetNativeEditPending.value
      const h = harness()
      try {
        h.store.setDmeloperSkinModel('wide')
        await flush()
        assert.equal(presetOperations.presetNativeEditPending.value, pendingBefore + 1)
        if (outcome === 'disposed') h.unmount()
        if (outcome === 'superseded') {
          h.store.setDmeloperSkinDataUrl('data:image/png;base64,Yg==')
          await flush()
          assert.equal(presetOperations.presetNativeEditPending.value, pendingBefore + 2)
        }
        stateSafety.editorsLocked.value = true
        if (outcome === 'failure') h.failDecode()
        else h.complete()
        await flush()
        assert.equal(presetOperations.presetNativeEditPending.value, pendingBefore)
        assert.equal(h.store.customization3d.dmeloperSkinModel, outcome === 'disposed' || outcome === 'failure' ? 'wide' : 'slim')
        const snapshot = capturePresetSnapshot(h.store)
        await h.applyNickname('')
        assert.deepEqual(capturePresetSnapshot(h.store), snapshot, 'a new callback cannot start an edit while saving')
      } finally {
        stateSafety.editorsLocked.value = false
        h.complete()
        h.unmount()
        await flush()
      }
    })
  }

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
      assert.equal(h.sourceStatus(), 'pages.preference.block.status.localSkin')
      h.store.customization3d.activeSkinLibraryEntryId = 'builtin:dmeloper'
      assert.equal(h.sourceStatus(), 'pages.preference.block.status.defaultSkin')
      h.store.customization3d.activeSkinLibraryEntryId = 'a'.repeat(64)
      assert.equal(h.sourceStatus(), 'pages.preference.block.status.localSkin')
      h.store.customization3d.minecraftSkinUsername = 'jeb_'
      assert.equal(h.sourceStatus(), 'pages.preference.block.status.minecraftSkinApplied')
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
        const picker = h.nodes().find(node => node.props?.label === `pages.preference.block.labels.${label}`)!
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

  it('hides subordinate controls, rejects stale edits and preserves values across OFF and ON', async () => {
    const h = harness({ render: true })
    try {
      h.complete()
      await flush()
      h.store.updateDmeloperEyebrows({ color: '#123456', heightOffsetPixels: 1, widthPixels: 3, depthPercent: 0 })
      h.store.model.eyebrowAnimationEnabled = false
      const before = clonePreset(h.store.activePet3dPreset.dmeloperEyebrows)
      selectDetailTab(h, 'eyebrows')
      const nodes = h.nodes()
      const animation = nodes.find(node => node.props?.['onUpdate:checked'] && node.props?.disabled === false)!
      const color = nodes.find(node => node.props?.label === 'pages.preference.block.labels.dmeloperEyebrowColor')!
      const depthRow = nodes.find(node => node.props?.title === 'pages.preference.block.labels.dmeloperEyebrowDepth')!
      const depth = (depthRow.children as { default: () => Vue.VNode[] }).default()[0]
      assert.deepEqual([...h.visibility.values()], [true])
      h.store.updateDmeloperEyebrows({ enabled: false })
      h.nodes()
      assert.deepEqual([...h.visibility.values()], [false])
      assert.equal([...h.visibility.keys()].flatMap(h.flatten).filter(node => node.props?.disabled).length, 9)
      animation.props!['onUpdate:checked'](true)
      color.props!['onUpdate:value']('#ffffff')
      depth.props!['onUpdate:value'](100)
      assert.deepEqual(clonePreset(h.store.activePet3dPreset.dmeloperEyebrows), { ...before, enabled: false })
      assert.equal(h.store.model.eyebrowAnimationEnabled, false)
      assert.equal(detailResetButton(h).props?.disabled, false, 'reset remains available while eyebrows are OFF')
      h.store.updateDmeloperEyebrows({ enabled: true })
      h.nodes()
      assert.deepEqual([...h.visibility.values()], [true])
      assert.deepEqual(clonePreset(h.store.activePet3dPreset.dmeloperEyebrows), before)
      assert.equal(h.store.model.eyebrowAnimationEnabled, false)
      stateSafety.editorsLocked.value = true
      animation.props!['onUpdate:checked'](true)
      color.props!['onUpdate:value']('#ffffff')
      depth.props!['onUpdate:value'](100)
      assert.deepEqual(clonePreset(h.store.activePet3dPreset.dmeloperEyebrows), before)
      assert.equal(h.store.model.eyebrowAnimationEnabled, false)
    } finally {
      stateSafety.editorsLocked.value = false
      h.complete()
      h.unmount()
    }
  })
})

describe('Pet eyebrow automatic color action', () => {
  it('requires explicit application and edits only eyebrow color using the current head top', async () => {
    const h = harness({ render: true })
    const button = () => h.nodes().find(node => node.props?.onClick?.name === 'setDmeloperEyebrowColorAutomatically')!
    try {
      h.store.updateDmeloperEyebrows({ color: '#AABBCC', widthPixels: 3 })
      const before = capturePresetSnapshot(h.store)
      assert.equal(button().props?.['aria-label'], 'pages.preference.block.labels.setDmeloperEyebrowColorAutomatically')
      assert.equal(button().props?.disabled, true)
      button().props!.onClick()
      assert.deepEqual(capturePresetSnapshot(h.store), before)
      h.complete()
      await flush()
      assert.equal(button().props?.disabled, false)
      assert.deepEqual(capturePresetSnapshot(h.store), before)
      button().props!.onClick()
      // Fixture top pixels are #445566; the older front suggestion is #112233.
      const expected = clonePreset(before)
      expected.preset.dmeloperEyebrows.color = '#445566'
      assert.deepEqual(capturePresetSnapshot(h.store), expected)
      h.store.setDmeloperSkinDataUrl('data:image/png;base64,Yg==')
      const changedSkin = capturePresetSnapshot(h.store)
      assert.equal(button().props?.disabled, true)
      button().props!.onClick()
      assert.deepEqual(capturePresetSnapshot(h.store), changedSkin)
    } finally {
      h.complete()
      h.unmount()
      await flush()
    }
  })

  it('rejects the action when eyebrows are OFF or the save lock is held', async () => {
    const h = harness({ render: true })
    const button = () => h.nodes().find(node => node.props?.onClick?.name === 'setDmeloperEyebrowColorAutomatically')!
    try {
      h.complete()
      await flush()
      for (const gate of ['off', 'save'] as const) {
        h.store.updateDmeloperEyebrows({ enabled: gate !== 'off', color: '#AABBCC' })
        stateSafety.editorsLocked.value = gate === 'save'
        const before = capturePresetSnapshot(h.store)
        assert.equal(button().props?.disabled, true)
        button().props!.onClick()
        assert.deepEqual(capturePresetSnapshot(h.store), before)
        stateSafety.editorsLocked.value = false
      }
      assert.equal(button().props?.disabled, false)
    } finally {
      stateSafety.editorsLocked.value = false
      h.unmount()
      await flush()
    }
  })

  it('keeps the current color after a skin analysis failure', async () => {
    const h = harness({ render: true })
    try {
      h.store.updateDmeloperEyebrows({ color: '#AABBCC' })
      h.failDecode()
      await flush()
      const button = h.nodes().find(node => node.props?.onClick?.name === 'setDmeloperEyebrowColorAutomatically')!
      assert.equal(button.props?.disabled, true)
      const before = capturePresetSnapshot(h.store)
      button.props!.onClick()
      assert.deepEqual(capturePresetSnapshot(h.store), before)
    } finally {
      h.unmount()
      await flush()
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

  it('applies sampled palm and head-top eyebrow colors for Java and default selections while retaining other eyebrow settings', async () => {
    const h = harness({ nickname: true })
    try {
      h.store.updateDmeloperEyebrows({ color: '#AABBCC', enabled: false, widthPixels: 3 })
      const eyebrows = clonePreset(h.store.activePet3dPreset.dmeloperEyebrows)
      const applying = h.applyNickname('Alex')
      h.complete()
      await applying
      assert.equal(h.store.customization3d.minecraftSkinUsername, 'Alex')
      assert.equal(capturePresetSnapshot(h.store).preset.dmeloperPalmColor, '#445566')
      assert.deepEqual(h.store.activePet3dPreset.dmeloperEyebrows, { ...eyebrows, color: '#445566' })
      h.store.updateDmeloperPalmColor('#123456')
      await h.applyNickname('')
      assert.equal(h.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
      assert.equal(h.store.activePet3dPreset.dmeloperPalmColor, '#445566')
      assert.deepEqual(h.store.activePet3dPreset.dmeloperEyebrows, { ...eyebrows, color: '#778899' })
    } finally {
      h.complete()
      h.unmount()
    }
  })
})
