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

import * as sliderDisplay from '@/components/default-snap-slider/displayValue'
import { fromSliderDisplayValue } from '@/components/default-snap-slider/displayValue'
import { DEFAULT_MODEL_SETTINGS } from '@/config/defaultSettings'
import { DEFAULT_HEADBUTT_RECOIL_SETTINGS } from '@/config/headbuttRecoil'
import presetRanges from '@/config/presetRanges.json'
import { DEFAULT_TYPING_MOTION_SETTINGS } from '@/config/typingMotion'
import * as presetEditIntent from '@/features/presets/editIntent'
import { applyPresetSnapshot, capturePresetSnapshot, clonePreset } from '@/features/presets/model'
import * as presetOperations from '@/features/presets/operations'
import * as armControlOrder from '@/features/scene/armControlOrder'
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
  const language = Vue.ref<'ko-KR' | 'en-US'>()
  const catalogs = Object.fromEntries(['ko-KR', 'en-US'].map(locale => [locale, JSON.parse(readFileSync(new URL(`../../../../locales/${locale}.json`, import.meta.url), 'utf8'))]))
  const translate = (key: string) => language.value
    ? key.split('.').reduce((value, part) => value?.[part], catalogs[language.value]) ?? key
    : key
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
    if (id === 'vue-i18n') return { useI18n: () => ({ t: translate }) }
    if (id === 'ant-design-vue') return { Button: {}, Flex: {}, Input: { Search: {} }, Modal: { confirm: (dialog: { title: string, onOk: () => void }) => dialogs.push(dialog) }, Segmented: {}, Select: { Option: {} }, Switch: {}, TabPane: {}, Tabs: {} }
    if (id === '@/features/presets/operations') return presetOperations
    if (id === '@/features/presets/editIntent') return presetEditIntent
    if (id === '@/features/stateSafety/bridge') return stateSafety
    if (id === '@/features/scene/armControlOrder') return armControlOrder
    if (id === '@/components/default-snap-slider/displayValue') return sliderDisplay
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
    if (id === './headbutt-recoil-options.vue' || id === './typing-motion-options.vue') return { default: {} }
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
    setLanguage: (locale: 'ko-KR' | 'en-US') => language.value = locale,
    flatten,
    migrate: () => (setupResult as { migrateStoredSkinToLibrary: () => Promise<void> }).migrateStoredSkinToLibrary(),
    sourceStatus: () => (setupResult as { minecraftSkinSourceStatus: Vue.ComputedRef<string> }).minecraftSkinSourceStatus.value,
    nodes: () => {
      visibility.clear()
      assert.equal(typeof setupResult, 'function')
      return flatten((setupResult as (context: object, cache: unknown[]) => Vue.VNode)({ $t: translate }, []))
    },
    complete: () => decoding.resolve({ wideArmLayoutCompatible: false, model: 'slim', suggestedEyebrowColor: '#112233', suggestedPalmColor: '#445566', convertedFromLegacy: false, data: Uint8Array.from({ length: 64 * 64 * 4 }, (_, index) => [68, 85, 102, 255][index % 4]) }),
    failDecode: () => decoding.reject(new Error('Invalid saved skin')),
    unmount: () => {
      scope.stop()
      unmounts.splice(0).forEach(callback => callback())
    },
  }
}

function selectDetailTab(h: ReturnType<typeof harness>, tab: 'body' | 'arms' | 'eyebrows' | 'motion') {
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
  for (const tab of ['body', 'arms', 'eyebrows', 'motion'] as const) {
    it(`resets only ${tab}, matches its label and captures its scope before confirmation`, async () => {
      const h = harness({ render: true })
      try {
        h.complete()
        await flush()
        h.store.updateActivePet3dPreset({
          petAnimationMode: 'headbutt',
          petHeadbuttMaxRadiusOffset: 0.8,
          petTypingMaxRadiusOffset: -0.8,
          petHeadbuttRecoilEnabled: false,
          petHeadbuttRecoilStrengthPercent: 5,
          petHeadbuttRecoilWobblePercent: 80,
          petTypingHandLiftPercent: 250,
          petTypingBodyMotionPercent: 200,
          petTypingReturnSpeedPercent: 350,
          petShoulderTorsoConnected: true,
          petRightArmDisabled: true,
          petLeftArmDisabled: true,
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
            petShoulderTorsoConnected: defaults.petShoulderTorsoConnected,
          })
        } else if (tab === 'arms') {
          Object.assign(before.customization3d.preset, {
            petRightArmDisabled: defaults.petRightArmDisabled,
            petLeftArmDisabled: defaults.petLeftArmDisabled,
            petRightArmBendPercent: defaults.petRightArmBendPercent,
            petRightArmSpreadDegrees: defaults.petRightArmSpreadDegrees,
            petLeftArmBendPercent: defaults.petLeftArmBendPercent,
            petLeftArmSpreadDegrees: defaults.petLeftArmSpreadDegrees,
            dmeloperPalmColor: defaults.dmeloperPalmColor,
          })
        } else if (tab === 'motion') {
          Object.assign(before.customization3d.preset, {
            petAnimationMode: defaults.petAnimationMode,
            petHeadbuttMaxRadiusOffset: defaults.petHeadbuttMaxRadiusOffset,
            ...DEFAULT_HEADBUTT_RECOIL_SETTINGS,
            ...DEFAULT_TYPING_MOTION_SETTINGS,
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
      const eyebrowGroup = () => [...h.visibility.keys()].find(node => h.flatten(node).some(child => child.props?.title === 'pages.preference.block.labels.dmeloperEyebrowDepth'))!
      assert.equal(h.visibility.get(eyebrowGroup()), true)
      h.store.updateDmeloperEyebrows({ enabled: false })
      h.nodes()
      assert.equal(h.visibility.get(eyebrowGroup()), false)
      assert.equal(h.flatten(eyebrowGroup()).filter(node => node.props?.disabled).length, 9)
      animation.props!['onUpdate:checked'](true)
      color.props!['onUpdate:value']('#ffffff')
      depth.props!['onUpdate:value'](100)
      assert.deepEqual(clonePreset(h.store.activePet3dPreset.dmeloperEyebrows), { ...before, enabled: false })
      assert.equal(h.store.model.eyebrowAnimationEnabled, false)
      assert.equal(detailResetButton(h).props?.disabled, false, 'reset remains available while eyebrows are OFF')
      h.store.updateDmeloperEyebrows({ enabled: true })
      h.nodes()
      assert.equal(h.visibility.get(eyebrowGroup()), true)
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

describe('Pet arm visibility and committed rotation order', () => {
  it('orders both control rows only after rotation commit and persists isolated switches with reset/save guards', async () => {
    const h = harness({ render: true })
    try {
      h.complete()
      await flush()
      const switches = () => h.nodes().filter(node => typeof node.props?.['onUpdate:checked'] === 'function'
        && ['pages.preference.block.labels.petRightArmVisible', 'pages.preference.block.labels.petLeftArmVisible'].includes(node.props?.['aria-label']))
      const order = () => switches().map(node => node.props!['aria-label'])
      const expected = (left: boolean) => (left ? ['Left', 'Right'] : ['Right', 'Left']).map(side => `pages.preference.block.labels.pet${side}ArmVisible`)
      const details = () => {
        const nodes = h.nodes()
        return switches().map((toggle) => {
          const group = nodes.find(node => node.key === (toggle.props!['aria-label'].includes('Right') ? 'right' : 'left'))!
          const detail = h.flatten(group).find(node => h.visibility.has(node))!
          assert.equal(h.flatten(group).filter(node => typeof node.props?.['onUpdate:checked'] === 'function').length, 1, 'each arm owns its switch and details in one box')
          return h.visibility.get(detail)
        })
      }
      const rightSliders = () => {
        const rows = h.nodes().filter(node => ['pages.preference.block.labels.petRightArmBend', 'pages.preference.block.labels.petRightArmSpread'].includes(node.props?.title))
        return rows.map(node => (node.children as { default: () => Vue.VNode[] }).default()[0])
      }
      assert.deepEqual(order(), expected(false))
      assert.deepEqual(switches().map(node => node.props!.checked), [true, true])
      for (const [rotation, leftFirst] of [[0.3, true], [0.8, true], [0.29, false], [0.81, false], [-0.2, true], [-0.7, true], [-0.19, false], [-0.71, false]] as const) {
        const before = order()
        h.store.activePet3dPreset.sceneRotationOffsetDegrees = rotation * 360
        await flush()
        assert.deepEqual(order(), before, 'dragging keeps the layout unchanged')
        armControlOrder.commitArmControlOrderRotation(rotation * 360)
        assert.deepEqual(order(), expected(leftFirst))
        const bendOrder = h.nodes().filter(node => ['pages.preference.block.labels.petLeftArmBend', 'pages.preference.block.labels.petRightArmBend'].includes(node.props?.title)).map(node => node.props!.title)
        assert.deepEqual(bendOrder, (leftFirst ? ['Left', 'Right'] : ['Right', 'Left']).map(side => `pages.preference.block.labels.pet${side}ArmBend`))
      }
      const before = clonePreset(h.store.$state)
      switches()[0].props!['onUpdate:checked'](false)
      before.customization3d.preset.petRightArmDisabled = true
      assert.deepEqual(clonePreset(h.store.$state), before)
      assert.deepEqual(details(), [false, true])
      for (const slider of rightSliders()) {
        assert.equal(slider.props!.disabled, true)
        slider.props!['onUpdate:value'](25)
      }
      assert.deepEqual(clonePreset(h.store.$state), before, 'hidden sliders preserve saved values and reject late input')
      switches()[1].props!['onUpdate:checked'](false)
      assert.deepEqual(details(), [false, false])
      switches()[0].props!['onUpdate:checked'](true)
      assert.deepEqual(details(), [true, false])
      switches()[1].props!['onUpdate:checked'](true)
      assert.deepEqual(details(), [true, true])
      stateSafety.editorsLocked.value = true
      for (const slider of rightSliders()) slider.props!['onUpdate:value'](25)
      stateSafety.editorsLocked.value = false
      switches()[0].props!['onUpdate:checked'](false)
      assert.deepEqual(clonePreset(h.store.$state), before, 'reenabling controls and locked input retain each arm setting')
      const snapshot = capturePresetSnapshot(h.store)
      assert.equal(snapshot.preset.petRightArmDisabled, true)
      stateSafety.editorsLocked.value = true
      switches()[1].props!['onUpdate:checked'](false)
      assert.equal(h.store.activePet3dPreset.petLeftArmDisabled, false)
      stateSafety.editorsLocked.value = false
      snapshot.preset.sceneRotationOffsetDegrees = 180
      applyPresetSnapshot(h.store, snapshot)
      await flush()
      assert.deepEqual(order(), expected(true), 'preset restore updates order without a drag')
      assert.equal(h.store.activePet3dPreset.petRightArmDisabled, true)
      assert.deepEqual(details(), [true, false], 'restored rotation keeps the remaining controls under their switch')
      assert.deepEqual(switches().map(node => node.props!.checked), [true, false], 'stored Disabled flags remain inverse to positive switches')
    } finally {
      stateSafety.editorsLocked.value = false
      h.unmount()
      await flush()
    }
  })
})

describe('Pet animation segmented selection', () => {
  it('binds both modes to the selected preset, retains hidden values and rejects late mode/save-locked updates', async () => {
    const h = harness({ render: true })
    try {
      h.complete()
      await flush()
      const panel = (recoil: boolean) => h.nodes().find(node => node.props?.['onUpdate:settings']?.name === (recoil ? 'updateHeadbuttRecoilSettings' : 'updateTypingMotionSettings'))!
      const selectMode = (value: string) => h.nodes().find(node => node.props?.options?.some((option: { value: string }) => option.value === 'headbutt'))!.props!['onUpdate:value'](value)
      const before = clonePreset(h.store.$state)
      const typing = { ...DEFAULT_TYPING_MOTION_SETTINGS, petTypingHandLiftPercent: 250 }
      const recoil = { ...DEFAULT_HEADBUTT_RECOIL_SETTINGS, petHeadbuttRecoilStrengthPercent: 5, petHeadbuttRecoilWobblePercent: 80 }
      const staleRecoil = panel(true)
      const radius = () => h.nodes().find(node => node.props?.['onUpdate:value']?.name === 'updateHeadbuttMaxRadiusOffset')!
      assert.equal(radius().props!.min, -1)
      assert.equal(radius().props!.max, 1)
      assert.equal(radius().props!['display-step'], 0.1)
      radius().props!['onUpdate:value'](0.8)
      staleRecoil.props!['onUpdate:settings'](recoil)
      assert.deepEqual(clonePreset(h.store.$state), before, 'hidden mode events cannot edit the active preset')
      await flush()
      assert.equal(presetEditIntent.isPresetUserEdit(), false)
      panel(false).props!['onUpdate:settings'](typing)
      assert.equal(presetEditIntent.isPresetUserEdit(), true)
      assert.equal(capturePresetSnapshot(h.store).preset.petTypingHandLiftPercent, 250)
      selectMode('headbutt')
      radius().props!['onUpdate:value'](-0.6)
      assert.equal(capturePresetSnapshot(h.store).preset.petHeadbuttMaxRadiusOffset, -0.6)
      const retainedTyping = panel(false)
      staleRecoil.props!['onUpdate:settings'](recoil)
      assert.equal(capturePresetSnapshot(h.store).preset.petHeadbuttRecoilStrengthPercent, 5)
      assert.equal(panel(false).props!.settings.petTypingHandLiftPercent, 250)
      const active = clonePreset(h.store.$state)
      retainedTyping.props!['onUpdate:settings']({ ...typing, petTypingHandLiftPercent: 0 })
      assert.deepEqual(clonePreset(h.store.$state), active)
      stateSafety.editorsLocked.value = true
      radius().props!['onUpdate:value'](1)
      panel(true).props!['onUpdate:settings']({ ...recoil, petHeadbuttRecoilStrengthPercent: 200 })
      assert.deepEqual(clonePreset(h.store.$state), active)
      assert.equal(panel(true).props!.disabled, true)
      stateSafety.editorsLocked.value = false
      const restored = capturePresetSnapshot(h.store)
      Object.assign(restored.preset, {
        petAnimationMode: 'default',
        petTypingHandLiftPercent: 125,
        petHeadbuttRecoilStrengthPercent: 50,
      })
      applyPresetSnapshot(h.store, restored)
      await flush()
      assert.equal(panel(false).props!.settings, h.store.activePet3dPreset)
      assert.equal(panel(true).props!.settings, h.store.activePet3dPreset)
      assert.equal(panel(false).props!.settings.petTypingHandLiftPercent, 125)
      assert.equal(panel(true).props!.settings.petHeadbuttRecoilStrengthPercent, 50)
      assert.equal(panel(true).props!.settings.petHeadbuttRecoilWobblePercent, 80, 'loading another preset retains its hidden wobble value')
    } finally {
      stateSafety.editorsLocked.value = false
      h.unmount()
      await flush()
    }
  })

  it('belongs to Motion after Eyebrows and changes only its preset-owned field with user intent', async () => {
    const h = harness({ render: true })
    try {
      h.complete()
      await flush()
      const section = h.nodes().find(node => node.props?.title === 'pages.preference.block.labels.petBehaviorSettings')!
      const children = (section.children as { default: () => Vue.VNode[] }).default()
      const tabs = children.find(node => typeof node.props?.['onUpdate:activeKey'] === 'function')!
      const categories = (tabs.children as { default: () => Vue.VNode[] }).default()
      assert.deepEqual(categories.map(node => node.key), ['body', 'arms', 'eyebrows', 'motion'])
      assert.ok(h.flatten(categories[3]).some(node => node.props?.title === 'pages.preference.block.labels.petAnimationMode'))
      const control = () => h.nodes().find(node => node.props?.options?.[0]?.value === 'default')!
      const before = clonePreset(h.store.$state)
      assert.equal(control().props?.value, 'default')
      assert.equal(presetEditIntent.isPresetUserEdit(), false, 'rendering and initialization do not mark an edit')
      control().props!['onUpdate:value']('headbutt')
      assert.equal(presetEditIntent.isPresetUserEdit(), true)
      before.customization3d.preset.petAnimationMode = 'headbutt'
      assert.deepEqual(clonePreset(h.store.$state), before)
      await flush()
      assert.equal(presetEditIntent.isPresetUserEdit(), false)
      stateSafety.editorsLocked.value = true
      assert.equal(control().props?.disabled, true)
      control().props!['onUpdate:value']('default')
      assert.deepEqual(clonePreset(h.store.$state), before)
      assert.equal(presetEditIntent.isPresetUserEdit(), false, 'blocked edits cannot mark user intent')
      stateSafety.editorsLocked.value = false
      control().props!['onUpdate:value']('unsupported')
      assert.deepEqual(clonePreset(h.store.$state), before)
      const saved = capturePresetSnapshot(h.store)
      saved.preset.petAnimationMode = 'default'
      applyPresetSnapshot(h.store, saved)
      assert.equal(control().props?.value, 'default')
      assert.equal(presetEditIntent.isPresetUserEdit(), false, 'preset restoration is not a user edit')
    } finally {
      stateSafety.editorsLocked.value = false
      h.unmount()
      await flush()
    }
  })

  it('reactively renders the approved Korean and English row and choices', async () => {
    const h = harness({ render: true })
    try {
      h.complete()
      await flush()
      for (const [locale, title, labels] of [
        ['ko-KR', '타이핑 모션', ['기본', '박치기']],
        ['en-US', 'Typing Motion', ['Default', 'Headbutt']],
      ] as const) {
        h.setLanguage(locale)
        const row = h.nodes().find(node => node.props?.title === title)!
        assert.ok(row)
        const control = (row.children as { default: () => Vue.VNode[] }).default()[0]
        assert.deepEqual(control.props?.options, [{ value: 'default', label: labels[0] }, { value: 'headbutt', label: labels[1] }])
      }
    } finally {
      h.unmount()
      await flush()
    }
  })
})
