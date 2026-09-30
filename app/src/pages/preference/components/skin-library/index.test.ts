/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { SkinLibraryCleanupResponse, SkinLibraryDeleteResponse, SkinLibraryEntry, SkinLibraryEntryContent } from '@/services/skinLibrary'

import * as skinIdentity from '@/config/skinIdentity'
import * as presetEditIntent from '@/features/presets/editIntent'
import { applyPresetSnapshot, capturePresetSnapshot, clonePreset, createPresetCollection } from '@/features/presets/model'
import * as presetOperations from '@/features/presets/operations'
import { preparePresetSkin } from '@/features/presets/skin'
import { installPresetSkinBrowser } from '@/features/presets/skin.test.utils'
import * as stateSafety from '@/features/stateSafety/bridge'
import * as dmeloperSkin from '@/services/dmeloperSkin'
import * as minecraftSkin from '@/services/minecraftSkin'
import * as skinLibrary from '@/services/skinLibrary'
import { useCatStore } from '@/stores/cat'
import * as skinLibraryImport from '@/utils/skinLibraryImport'
import * as skinLibrarySelection from '@/utils/skinLibrarySelection'
import * as skinThumbnail from '@/utils/skinThumbnail'
import * as voxelSkin from '@/utils/three3d/voxelSkin'

interface TestElement {
  type: string
  text: string
  props: Record<string, unknown>
  children: TestElement[]
  parent: TestElement | null
}

function element(type: string, text = ''): TestElement {
  return { type, text, props: {}, children: [], parent: null }
}

const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
const compiled = compileScript(descriptor, { id: 'skin-library-test', inlineTemplate: true })
const transformed = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
})
const locales = Object.fromEntries(['ko-KR', 'en-US'].map(locale => [
  locale,
  JSON.parse(readFileSync(new URL(`../../../../locales/${locale}.json`, import.meta.url), 'utf8')) as Record<string, unknown>,
]))

function stub(type: string) {
  return Vue.defineComponent({
    inheritAttrs: false,
    setup: (_, { attrs, slots }) => () => Vue.h(type, attrs, [slots.icon?.(), slots.default?.()]),
  })
}

function walk(node: TestElement): TestElement[] {
  return [node, ...node.children.flatMap(walk)]
}

function content(node: TestElement): string {
  return node.text + node.children.map(content).join('')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Vue.nextTick()
}

function entry(character: string): SkinLibraryEntry {
  return {
    id: character.repeat(64),
    source: 'local',
    displayName: `${character}.png`,
    originalFilename: `${character}.png`,
    model: 'wide',
    pngSha256: character.repeat(64),
    width: 64,
    height: 64,
    thumbnailPngBase64: 'iVBORw0KGgo=',
    addedAt: 0,
  }
}

function mountLibrary(options: {
  entries?: SkinLibraryEntry[]
  list?: () => Promise<SkinLibraryEntry[]>
  read?: (id: string) => Promise<SkinLibraryEntryContent>
  rename?: (id: string, name: string) => Promise<SkinLibraryEntry>
  thumbnail?: () => Promise<string>
  defaultPalm?: () => Promise<string>
  delete?: (ids: string[]) => Promise<SkinLibraryDeleteResponse>
  cleanup?: () => Promise<SkinLibraryCleanupResponse>
  manualConfirm?: boolean
  configureStore?: (store: ReturnType<typeof useCatStore>) => void
} = {}) {
  setActivePinia(createPinia())
  const store = useCatStore()
  options.configureStore?.(store)
  const locale = Vue.ref('ko-KR')
  const translate = (key: string) => {
    const value = key.split('.').reduce<unknown>((current, part) =>
      (current as Record<string, unknown>)?.[part], locales[locale.value])
    assert.equal(typeof value, 'string', `Missing translation: ${key}`)
    return value as string
  }
  let catalog = options.entries ?? []
  const deletes: string[][] = []
  const confirmations: Array<{ title: string, onOk: () => unknown }> = []
  let cleanupCalls = 0
  const messages: string[] = []
  const diagnostics: Array<{ level: string, operation: string }> = []
  let remoteReads = 0
  const module = { exports: {} as { default: Vue.Component } }
  // Compile and mount the actual SFC. Only native I/O and visual framework
  // wrappers are stubbed, so card actions and store changes run production code.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', transformed.outputText)((id: string) => {
    if (id === '@/services/diagnostics') return { reportDiagnostic: (level: string, operation: string) => diagnostics.push({ level, operation }) }
    if (id === 'vue') return { ...Vue, vModelText: {} }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: translate }) }
    if (id === '@tauri-apps/api/window') {
      return { getCurrentWindow: () => ({ onDragDropEvent: async () => () => {} }) }
    }
    if (id === 'ant-design-vue') {
      return {
        Button: stub('button'),
        Flex: stub('div'),
        Tag: stub('tag'),
        message: {
          error: (value: string) => messages.push(value),
          success: (value: string) => messages.push(value),
        },
        Modal: { confirm: (value: { title: string, onOk: () => unknown }) => {
          confirmations.push(value)
          if (!options.manualConfirm) return value.onOk()
        } },
      }
    }
    if (id === '@/config/skinIdentity') return skinIdentity
    if (id === '@/features/presets/editIntent') return presetEditIntent
    if (id === '@/features/presets/operations') return presetOperations
    if (id === '@/features/stateSafety/bridge') return stateSafety
    if (id === '@/stores/cat') return { useCatStore: () => store }
    if (id === '@/services/dmeloperSkin') {
      return {
        ...dmeloperSkin,
        resolveDefaultDmeloperPalmColor: options.defaultPalm ?? (async () => '#445566'),
        resolveDmeloperSkinThumbnailUrl: options.thumbnail ?? (async () => 'data:image/png;base64,default-preview'),
      }
    }
    if (id === '@/services/skinLibrary') {
      return {
        ...skinLibrary,
        listSkinLibraryEntries: options.list ?? (async () => catalog),
        readSkinLibraryEntry: options.read ?? (async () => {
          throw new Error('Unexpected stored PNG read.')
        }),
        renameSkinLibraryEntry: options.rename ?? skinLibrary.renameSkinLibraryEntry,
        deleteSkinLibraryEntries: async (ids: string[]) => {
          deletes.push([...ids])
          assert.ok(ids.every(id => /^[0-9a-f]{64}$/.test(id)))
          const response = options.delete
            ? await options.delete(ids)
            : { deletedEntryIds: ids, cleanupPending: false }
          catalog = catalog.filter(value => !response.deletedEntryIds.includes(value.id))
          return response
        },
        cleanupSkinLibrary: async () => {
          cleanupCalls++
          return options.cleanup ? options.cleanup() : { cleanupPending: false }
        },
      }
    }
    if (id === '@/services/minecraftSkin') {
      return {
        ...minecraftSkin,
        fetchMinecraftSkin: async () => {
          remoteReads += 1
          throw new Error('Unexpected network call.')
        },
      }
    }
    if (id === '@/utils/skinLibraryImport') return skinLibraryImport
    if (id === '@/utils/skinLibrarySelection') return skinLibrarySelection
    if (id === '@/utils/skinThumbnail') return skinThumbnail
    if (id === '@/utils/three3d/voxelSkin') return voxelSkin
    throw new Error(`Unexpected library import: ${id}`)
  }, module, module.exports)

  const renderer = Vue.createRenderer<TestElement, TestElement>({
    createElement: element,
    createText: text => element('text', text),
    createComment: () => element('comment'),
    setText: (node, text) => {
      node.text = text
    },
    setElementText: (node, text) => {
      node.text = text
      node.children = []
    },
    patchProp: (node, key, _previous, next) => {
      node.props[key] = next
    },
    insert: (node, parent, anchor) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove: (node) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = null
    },
    parentNode: node => node.parent,
    nextSibling: (node) => {
      const siblings = node.parent?.children ?? []
      return siblings[siblings.indexOf(node) + 1] ?? null
    },
  })
  const root = element('root')
  const app = renderer.createApp(module.exports.default)
  app.config.globalProperties.$t = translate
  app.mount(root)
  const cards = () => walk(root).filter(node => node.props.role === 'option')
  const button = (key: string) => walk(root).find(node => node.type === 'button' && content(node) === translate(key))!
  const click = async (node: TestElement) => {
    assert.ok(node, 'The requested control must be rendered.')
    assert.notEqual(node.props.disabled, true, 'The requested control must be enabled.')
    const result = (node.props.onClick as (event: { stopPropagation: () => void }) => unknown)({ stopPropagation: () => {} })
    await result
    await flush()
  }
  return { app, root, cards, button, click, store, locale, deletes, confirmations, cleanupCalls: () => cleanupCalls, messages, diagnostics, remoteReads: () => remoteReads }
}

describe('built-in skin library card', () => {
  for (const outcome of ['failure', 'disposed', 'superseded'] as const) {
    it(`releases its pending save lease after a ${outcome} default selection`, async () => {
      await flush()
      const before = presetOperations.presetNativeEditPending.value
      const sample = deferred<string>()
      const control = mountLibrary({ defaultPalm: () => sample.promise })
      await flush()
      const selecting = control.click(control.cards()[0])
      try {
        assert.equal(presetOperations.presetNativeEditPending.value, before + 1)
        if (outcome === 'disposed') control.app.unmount()
        if (outcome === 'superseded') presetEditIntent.invalidatePresetSelection()
        const previous = capturePresetSnapshot(control.store)
        if (outcome === 'failure') sample.reject(new Error('Default skin unavailable'))
        else sample.resolve('#123456')
        await selecting
        assert.equal(presetOperations.presetNativeEditPending.value, before)
        assert.deepEqual(capturePresetSnapshot(control.store), previous)
        if (outcome !== 'disposed') {
          stateSafety.editorsLocked.value = true
          await control.click(control.cards()[0])
          assert.equal(presetOperations.presetNativeEditPending.value, before)
          assert.deepEqual(capturePresetSnapshot(control.store), previous)
        }
      } finally {
        stateSafety.editorsLocked.value = false
        sample.resolve('#123456')
        await selecting
        if (outcome !== 'disposed') control.app.unmount()
      }
    })
  }

  for (const key of ['Enter', 'Escape']) {
    it(`does not submit or cancel a name while IME handles ${key}`, async () => {
      const previousInput = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement')
      Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: class {} })
      const a = entry('a')
      const renames: string[] = []
      const control = mountLibrary({ entries: [a], rename: async (_id, name) => {
        renames.push(name)
        return { ...a, displayName: name }
      } })
      try {
        await flush()
        await control.click(walk(control.cards()[1]).find(node => node.type === 'button' && node.props.title === a.displayName)!)
        const input = walk(control.cards()[1]).find(node => node.type === 'input')!
        assert.ok(input)
        ;(input.props['onUpdate:modelValue'] as (value: string) => void)('사용자')
        let prevented = false
        ;(input.props.onKeydown as (event: object) => void)({
          key,
          isComposing: true,
          stopPropagation: () => {},
          preventDefault: () => {
            prevented = true
          },
        })
        await flush()
        assert.deepEqual(renames, [])
        assert.equal(prevented, false)
        assert.ok(walk(control.cards()[1]).some(node => node.type === 'input'), 'composition must keep the editor open')
        ;(input.props['onUpdate:modelValue'] as (value: string) => void)('사용자 이름')
        ;(input.props.onKeydown as (event: object) => void)({ key, isComposing: false, stopPropagation: () => {}, preventDefault: () => {} })
        await flush()
        assert.deepEqual(renames, key === 'Enter' ? ['사용자 이름'] : [])
        assert.equal(walk(control.cards()[1]).some(node => node.type === 'input'), false)
      } finally {
        control.app.unmount()
        if (previousInput) Object.defineProperty(globalThis, 'HTMLInputElement', previousInput)
        else Reflect.deleteProperty(globalThis, 'HTMLInputElement')
      }
    })
  }

  for (const key of ['Enter', ' ']) {
    it(`toggles a focused checkbox with ${JSON.stringify(key)} without activating its card`, async () => {
      const a = entry('a')
      const b = entry('b')
      let reads = 0
      const control = mountLibrary({
        entries: [a, b],
        read: async () => {
          reads++
          throw new Error('Checkbox must not apply a skin.')
        },
        configureStore: (store) => {
          store.applySkinLibraryEntry({ entryId: a.id, source: 'local', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', skinModel: 'wide' })
        },
      })
      try {
        await flush()
        const checkbox = walk(control.cards()[2]).find(node => node.props.role === 'checkbox')!
        let stopped = false
        let prevented = false
        const event = {
          key,
          stopPropagation: () => {
            stopped = true
          },
          preventDefault: () => {
            prevented = true
          },
        }
        for (let node: TestElement | null = checkbox; node; node = node.parent) {
          (node.props.onKeydown as ((keyboardEvent: typeof event) => void) | undefined)?.(event)
          if (stopped) break
        }
        // Native buttons generate their click only when keydown has not been cancelled.
        if (!prevented) await control.click(checkbox)
        await flush()
        assert.equal(reads, 0)
        assert.equal(control.store.customization3d.activeSkinLibraryEntryId, a.id)
        assert.equal(walk(control.root).find(node => node.props.role === 'listbox')?.props['aria-multiselectable'], true)
        assert.equal(checkbox.props['aria-checked'], true)
      } finally {
        control.app.unmount()
      }
    })
  }

  it('stays first and read-only through catalog loading, failure, retry, and language changes', async () => {
    const firstLoad = deferred<SkinLibraryEntry[]>()
    let loads = 0
    const control = mountLibrary({ list: () => ++loads === 1 ? firstLoad.promise : Promise.resolve([entry('a')]) })
    try {
      assert.equal(control.cards().length, 1)
      assert.equal(control.cards()[0].props['aria-label'], '디멜로퍼(기본값)')
      assert.equal(control.cards()[0].props['aria-selected'], true)
      assert.equal(walk(control.cards()[0]).filter(node => node.type === 'button' || node.type === 'input').length, 0)
      assert.equal(control.button('pages.preference.skinLibrary.buttons.delete').props.disabled, true)
      firstLoad.reject(new Error('Catalog unavailable'))
      await flush()
      assert.deepEqual(control.diagnostics, [{ level: 'error', operation: 'skin_library.load' }])
      assert.equal(control.cards().length, 1)
      assert.equal(walk(control.root).filter(node => node.props.role === 'alert').length, 1)
      await control.click(control.cards()[0])
      assert.equal(control.remoteReads(), 0)
      await control.click(control.button('pages.preference.skinLibrary.buttons.retry'))
      assert.deepEqual(control.cards().map(node => node.props['data-skin-id']), ['builtin:dmeloper', 'a'.repeat(64)])
      assert.equal(walk(control.root).filter(node => node.props.role === 'alert').length, 0)
      assert.equal(walk(control.cards()[0]).find(node => node.type === 'img')?.props.src, 'data:image/png;base64,default-preview')
      control.locale.value = 'en-US'
      await flush()
      assert.equal(control.cards()[0].props['aria-label'], 'dmeloper (Default)')
    } finally {
      control.app.unmount()
    }
  })

  it('ends multi-selection and samples default-skin palms while preserving eyebrows', async () => {
    const a = entry('a')
    const b = entry('b')
    const control = mountLibrary({
      entries: [a, b],
      configureStore: (store) => {
        store.updateDmeloperEyebrows({ color: '#123456' })
        store.updateDmeloperPalmColor('#ABCDEF')
        assert.equal(store.applySkinLibraryEntry({ entryId: a.id, source: 'local', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', skinModel: 'slim' }), true)
        store.updateDmeloperPalmColor('#334455')
      },
    })
    try {
      await flush()
      await control.click(walk(control.cards()[2]).find(node => node.props.role === 'checkbox')!)
      assert.equal(walk(control.root).find(node => node.props.role === 'listbox')?.props['aria-multiselectable'], true)
      await control.click(control.cards()[0])
      assert.equal(walk(control.root).find(node => node.props.role === 'listbox')?.props['aria-multiselectable'], false)
      assert.equal(control.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
      assert.equal(control.store.customization3d.dmeloperSkinDataUrl, undefined)
      assert.equal(control.store.customization3d.dmeloperSkinModel, 'wide')
      assert.equal(control.store.customization3d.preset.dmeloperEyebrows.color, '#123456')
      assert.equal(control.store.customization3d.preset.dmeloperPalmColor, '#445566')
      assert.equal('dmeloperPalmManualColors' in control.store.customization3d, false)
      assert.equal(control.button('pages.preference.skinLibrary.buttons.delete').props.disabled, true)
      assert.deepEqual(control.deletes, [])
    } finally {
      control.app.unmount()
    }
  })

  it('selects and deletes only user entries, leaving the default after delete-all and reset', async () => {
    const a = entry('a')
    const b = entry('b')
    const control = mountLibrary({
      entries: [a, b],
      configureStore: store => assert.equal(store.applySkinLibraryEntry({ entryId: a.id, source: 'local', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', skinModel: 'wide' }), true),
    })
    try {
      await flush()
      await control.click(walk(control.cards()[1]).find(node => node.props.role === 'checkbox')!)
      await control.click(control.button('pages.preference.skinLibrary.buttons.selectAll'))
      await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
      assert.deepEqual(control.deletes, [[a.id, b.id]])
      assert.equal(control.cards().length, 1)
      assert.equal(control.cards()[0].props['aria-selected'], true)
      control.store.resetAllSettings()
      await flush()
      assert.equal(control.cards().length, 1)
      assert.equal(control.cards()[0].props['aria-label'], '디멜로퍼(기본값)')
    } finally {
      control.app.unmount()
    }
  })

  for (const deleteAll of [false, true]) {
    it(`returns to the default after ${deleteAll ? 'bulk' : 'single'} active-skin deletion with presets initialized`, async () => {
      const a = entry('a')
      const b = entry('b')
      const control = mountLibrary({
        entries: [a, b],
        configureStore: (store) => {
          store.applySkinLibraryEntry({ entryId: a.id, source: 'java', canonicalNickname: 'jeb_', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', skinModel: 'slim' })
          store.updateDmeloperPalmColor('#334455')
          store.presetCollection = createPresetCollection(capturePresetSnapshot(store))
        },
      })
      try {
        await flush()
        const appearance = clonePreset(control.store.customization3d.preset)
        const savedPresets = clonePreset(control.store.presetCollection)
        const currentSkin = control.store.customization3d.dmeloperSkinDataUrl
        control.store.handleSkinLibraryEntriesDeleted([b.id])
        assert.equal(control.store.customization3d.dmeloperSkinDataUrl, currentSkin)
        assert.equal(control.store.customization3d.activeSkinLibraryEntryId, a.id)
        if (deleteAll) {
          await control.click(walk(control.cards()[1]).find(node => node.props.role === 'checkbox')!)
          await control.click(control.button('pages.preference.skinLibrary.buttons.selectAll'))
        }
        await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
        assert.deepEqual(control.deletes, [deleteAll ? [a.id, b.id] : [a.id]])
        assert.equal(control.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
        assert.equal(control.store.customization3d.dmeloperSkinDataUrl, undefined)
        assert.equal(control.store.customization3d.minecraftSkinUsername, undefined)
        assert.equal(control.store.customization3d.dmeloperSkinModel, 'wide')
        assert.equal(control.cards()[0].props['aria-selected'], true)
        assert.equal(walk(control.cards()[0]).filter(node => node.type === 'tag').length, 1)
        assert.deepEqual(control.store.customization3d.preset, { ...appearance, dmeloperPalmColor: '#445566' })
        assert.deepEqual(control.store.presetCollection, savedPresets)
        assert.deepEqual(control.messages, [])
      } finally {
        control.app.unmount()
      }
    })
  }

  it('cancels a pending user-skin application when the default is selected', async () => {
    const pending = deferred<SkinLibraryEntryContent>()
    const a = entry('a')
    const control = mountLibrary({ entries: [a], read: () => pending.promise })
    try {
      await flush()
      await control.click(control.cards()[1])
      await control.click(control.cards()[0])
      pending.resolve({ ...a, pngBase64: 'invalid stale skin must never decode' })
      await flush()
      assert.equal(control.store.customization3d.dmeloperSkinDataUrl, undefined)
      assert.equal(control.cards()[0].props['aria-selected'], true)
      assert.deepEqual(control.messages, [])
    } finally {
      control.app.unmount()
    }
  })

  it('retries a failed preview independently of the user catalog and cancels completions on unmount', async () => {
    let previews = 0
    const catalog = deferred<SkinLibraryEntry[]>()
    const control = mountLibrary({
      list: () => catalog.promise,
      thumbnail: async () => {
        if (++previews === 1) throw new Error('Bundled preview temporarily unavailable')
        return 'data:image/png;base64,recovered-preview'
      },
    })
    await flush()
    await control.click(control.button('pages.preference.skinLibrary.buttons.retry'))
    assert.equal(walk(control.cards()[0]).find(node => node.type === 'img')?.props.src, 'data:image/png;base64,recovered-preview')
    control.app.unmount()
    catalog.resolve([entry('a')])
    await flush()
    assert.equal(control.root.children.length, 0)
    assert.deepEqual(control.messages, [])
  })

  it('rejects the built-in identity before rename or deletion can reach native storage', async () => {
    const nativeInvoke = async <T>() => {
      assert.fail('A built-in card must never reach native storage mutation.')
      return undefined as T
    }
    await assert.rejects(skinLibrary.deleteSkinLibraryEntries([dmeloperSkin.BUILTIN_DMELOPER_SKIN.id], nativeInvoke), /INVALID_REQUEST/)
    await assert.rejects(skinLibrary.renameSkinLibraryEntry(dmeloperSkin.BUILTIN_DMELOPER_SKIN.id, 'changed', nativeInvoke), /INVALID_REQUEST/)
  })
})

it('keeps the default current after actual preset PNG preparation, persistence and library reopening', async () => {
  const browser = installPresetSkinBrowser()
  const control = mountLibrary()
  let reopened: ReturnType<typeof mountLibrary> | undefined
  try {
    await flush()
    control.store.updateDmeloperEyebrows({ color: '#123456' })
    control.store.updateDmeloperPalmColor('#abcdef')
    await control.click(control.cards()[0])
    const assertCurrent = (view: ReturnType<typeof mountLibrary>) => {
      assert.equal(view.cards()[0].props['aria-selected'], true)
      assert.equal(walk(view.cards()[0]).filter(node => node.type === 'tag').length, 1)
      assert.equal(view.button('pages.preference.skinLibrary.buttons.delete').props.disabled, true)
    }
    assertCurrent(control)
    const prepared = await preparePresetSkin(capturePresetSnapshot(control.store))
    assert.equal(prepared.appearance.dmeloperSkinDataUrl, browser.dataUrl)
    assert.ok(browser.decoded() > 0, 'the production PNG preparation/decoder must run')
    applyPresetSnapshot(control.store, prepared)
    control.store.init()
    await flush()
    assertCurrent(control)
    assert.equal(control.store.activePet3dPreset.dmeloperEyebrows.color, '#123456')
    assert.equal(control.store.activePet3dPreset.dmeloperPalmColor, '#445566')
    const saved = clonePreset(control.store.$state)
    control.app.unmount()
    reopened = mountLibrary({ configureStore: (store) => {
      store.$patch(state => Object.assign(state, saved))
      store.init()
    } })
    await flush()
    assertCurrent(reopened)
    await reopened.click(reopened.cards()[0])
    applyPresetSnapshot(reopened.store, await preparePresetSkin(capturePresetSnapshot(reopened.store)))
    await flush()
    assertCurrent(reopened)
    assert.deepEqual(reopened.deletes, [])
  } finally {
    if (reopened) reopened.app.unmount()
    else control.app.unmount()
    browser.restore()
  }
})

it('samples a selected local PNG and the bundled default directly into the preset', async () => {
  const browser = installPresetSkinBrowser()
  const a = entry('a')
  const control = mountLibrary({
    entries: [a],
    defaultPalm: dmeloperSkin.resolveDefaultDmeloperPalmColor,
    read: async () => ({ ...a, pngBase64: browser.dataUrl.split(',')[1] }),
  })
  try {
    await flush()
    await control.click(control.cards()[1])
    for (let attempt = 0; attempt < 100 && control.store.customization3d.activeSkinLibraryEntryId !== a.id; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(control.store.customization3d.activeSkinLibraryEntryId, a.id)
    assert.equal(capturePresetSnapshot(control.store).preset.dmeloperPalmColor, '#445566')
    control.store.updateDmeloperPalmColor('#ABCDEF')
    await control.click(control.cards()[0])
    assert.equal(control.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.equal(capturePresetSnapshot(control.store).preset.dmeloperPalmColor, '#445566')
    assert.deepEqual(control.messages, [])
  } finally {
    control.app.unmount()
    browser.restore()
  }
})

it('discards a delayed default-skin sample after another card is selected', async () => {
  const pending = deferred<string>()
  const a = entry('a')
  const control = mountLibrary({ entries: [a], defaultPalm: () => pending.promise, configureStore: (store) => {
    store.applySkinLibraryEntry({ entryId: a.id, source: 'local', dataUrl: 'data:image/png;base64,YQ==', skinModel: 'wide' })
    store.updateDmeloperPalmColor('#ABCDEF')
  } })
  try {
    await flush()
    const applying = control.click(control.cards()[0])
    await flush()
    await control.click(control.cards()[1])
    pending.resolve('#445566')
    await applying
    assert.equal(control.store.customization3d.activeSkinLibraryEntryId, a.id)
    assert.equal(control.store.activePet3dPreset.dmeloperPalmColor, '#ABCDEF')
  } finally {
    pending.resolve('#445566')
    control.app.unmount()
  }
})

describe('skin deletion confirmation, ownership and cleanup', () => {
  const active = (store: ReturnType<typeof useCatStore>, skin: SkinLibraryEntry, png = 'old') => {
    store.applySkinLibraryEntry({ entryId: skin.id, source: 'local', dataUrl: `data:image/png;base64,${png}`, skinModel: 'slim', palmColor: '#334455' })
  }

  it('requires confirmation for one skin and does nothing when the dialog is dismissed', async () => {
    const a = entry('a')
    const control = mountLibrary({ entries: [a], manualConfirm: true, configureStore: store => active(store, a) })
    try {
      await flush()
      await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
      assert.equal(control.confirmations.length, 1)
      assert.equal(control.confirmations[0].title, '이 스킨을 삭제하시겠습니까?')
      assert.deepEqual(control.deletes, [])
      assert.equal(control.store.customization3d.activeSkinLibraryEntryId, a.id)
      // Dismissing a confirmation never invokes its onOk callback.
      await flush()
      assert.deepEqual(control.deletes, [])
      await control.confirmations[0].onOk()
      assert.deepEqual(control.deletes, [[a.id]])
      assert.equal(control.store.customization3d.preset.dmeloperPalmColor, '#445566')
    } finally {
      control.app.unmount()
    }
  })

  it('deletes the confirmed ID snapshot even if checkbox selection later changes', async () => {
    const a = entry('a')
    const b = entry('b')
    const control = mountLibrary({ entries: [a, b], manualConfirm: true, configureStore: store => active(store, a) })
    try {
      await flush()
      await control.click(walk(control.cards()[2]).find(node => node.props.role === 'checkbox')!)
      await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
      await control.click(walk(control.cards()[2]).find(node => node.props.role === 'checkbox')!)
      await control.confirmations[0].onOk()
      assert.deepEqual(control.deletes, [[a.id, b.id]])
      assert.equal(control.cards().length, 1)
    } finally {
      control.app.unmount()
    }
  })

  it('preserves the active skin and its custom appearance when deleting only another skin', async () => {
    const a = entry('a')
    const b = entry('b')
    const control = mountLibrary({
      entries: [a, b],
      defaultPalm: async () => {
        throw new Error('An inactive deletion must not sample the default')
      },
      configureStore: store => active(store, a),
    })
    try {
      await flush()
      const previous = capturePresetSnapshot(control.store)
      await control.click(walk(control.cards()[2]).find(node => node.props.role === 'checkbox')!)
      await control.click(walk(control.cards()[1]).find(node => node.props.role === 'checkbox')!)
      await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
      assert.deepEqual(control.deletes, [[b.id]])
      assert.deepEqual(capturePresetSnapshot(control.store), previous)
      assert.deepEqual(control.messages, [])
    } finally {
      control.app.unmount()
    }
  })

  it('aborts before native deletion when preparing the default palms fails', async () => {
    const a = entry('a')
    const control = mountLibrary({ entries: [a], defaultPalm: async () => {
      throw new Error('Missing bundled PNG')
    }, configureStore: store => active(store, a) })
    try {
      await flush()
      const previous = capturePresetSnapshot(control.store)
      await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
      assert.deepEqual(control.deletes, [])
      assert.deepEqual(capturePresetSnapshot(control.store), previous)
      assert.equal(control.messages.length, 1)
      assert.equal(control.button('pages.preference.skinLibrary.buttons.delete').props.disabled, false)
    } finally {
      control.app.unmount()
    }
  })

  it('discards a confirmation or pending fallback when its preset is no longer current', async () => {
    for (const pendingSample of [false, true]) {
      const a = entry('a')
      const sample = deferred<string>()
      const control = mountLibrary({ entries: [a], manualConfirm: true, defaultPalm: () => sample.promise, configureStore: store => active(store, a) })
      try {
        await flush()
        await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
        const operation = pendingSample ? control.confirmations[0].onOk() : undefined
        presetEditIntent.invalidatePresetSelection()
        active(control.store, a, 'new-preset')
        sample.resolve('#445566')
        if (pendingSample) await operation
        else await control.confirmations[0].onOk()
        await flush()
        assert.deepEqual(control.deletes, [])
        assert.equal(control.store.customization3d.dmeloperSkinDataUrl, 'data:image/png;base64,new-preset')
      } finally {
        sample.resolve('#445566')
        control.app.unmount()
      }
    }
  })

  it('ignores committed deletion replies after preset replacement or unmount', async () => {
    for (const unmount of [false, true]) {
      const a = entry('a')
      const reply = deferred<SkinLibraryDeleteResponse>()
      const control = mountLibrary({ entries: [a], delete: () => reply.promise, configureStore: store => active(store, a) })
      try {
        await flush()
        await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
        assert.deepEqual(control.deletes, [[a.id]])
        if (unmount) control.app.unmount()
        else presetEditIntent.invalidatePresetSelection()
        active(control.store, a, 'new-preset')
        const previous = capturePresetSnapshot(control.store)
        reply.resolve({ deletedEntryIds: [a.id], cleanupPending: false })
        await flush()
        assert.deepEqual(capturePresetSnapshot(control.store), previous)
        if (!unmount) {
          assert.equal(control.cards().length, 1)
          assert.equal(control.cleanupCalls(), 2)
        }
        assert.deepEqual(control.messages, [])
      } finally {
        reply.resolve({ deletedEntryIds: [a.id], cleanupPending: false })
        if (!unmount) control.app.unmount()
      }
    }
  })

  it('does not let an older deletion completion unlock a newer operation', async () => {
    const a = entry('a')
    const replies = [deferred<SkinLibraryDeleteResponse>(), deferred<SkinLibraryDeleteResponse>()]
    let index = 0
    const control = mountLibrary({ entries: [a], delete: () => replies[index++].promise, configureStore: store => active(store, a) })
    try {
      await flush()
      await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
      presetEditIntent.invalidatePresetSelection()
      active(control.store, a, 'new-preset')
      await flush()
      await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
      assert.equal(index, 2)
      replies[0].resolve({ deletedEntryIds: [a.id], cleanupPending: false })
      await flush()
      assert.equal(control.button('pages.preference.skinLibrary.buttons.delete').props.disabled, true)
      assert.equal(control.store.customization3d.dmeloperSkinDataUrl, 'data:image/png;base64,new-preset')
      replies[1].resolve({ deletedEntryIds: [a.id], cleanupPending: false })
      await flush()
      assert.equal(control.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    } finally {
      for (const reply of replies) reply.resolve({ deletedEntryIds: [a.id], cleanupPending: false })
      control.app.unmount()
    }
  })

  it('keeps a committed deletion visible while failed local-file cleanup can be retried', async () => {
    const a = entry('a')
    const control = mountLibrary({ entries: [a], delete: async ids => ({ deletedEntryIds: ids, cleanupPending: true }), configureStore: store => active(store, a) })
    try {
      await flush()
      assert.equal(control.cleanupCalls(), 1)
      await control.click(control.button('pages.preference.skinLibrary.buttons.delete'))
      assert.equal(control.cards().length, 1)
      assert.equal(control.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
      assert.equal(walk(control.root).filter(node => node.props.role === 'alert').length, 1)
      await control.click(control.button('pages.preference.skinLibrary.buttons.retryCleanup'))
      assert.equal(control.cleanupCalls(), 2)
      assert.equal(walk(control.root).filter(node => node.props.role === 'alert').length, 0)
      assert.deepEqual(control.messages, [])
    } finally {
      control.app.unmount()
    }
  })

  it('checks old orphan cleanup on opening and retains a retry after IPC failure', async () => {
    let attempt = 0
    const control = mountLibrary({ cleanup: async () => {
      if (++attempt === 1) throw new Error('Locked local file')
      return { cleanupPending: false }
    } })
    try {
      await flush()
      assert.equal(control.cleanupCalls(), 1)
      assert.equal(walk(control.root).filter(node => node.props.role === 'alert').length, 1)
      await control.click(control.button('pages.preference.skinLibrary.buttons.retryCleanup'))
      assert.equal(attempt, 2)
      assert.equal(walk(control.root).filter(node => node.props.role === 'alert').length, 0)
    } finally {
      control.app.unmount()
    }
  })
})
