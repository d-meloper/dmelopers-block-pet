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
import { useBlockStore } from '@/stores/block'
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

function warningClock() {
  let now = 0
  let sequence = 0
  const pending = new Map<number, { due: number, callback: () => void }>()
  return {
    pending,
    setTimeout: (callback: () => void, delay: number) => {
      pending.set(++sequence, { due: now + delay, callback })
      return sequence
    },
    clearTimeout: (id: number) => pending.delete(id),
    advance: (milliseconds: number) => {
      now += milliseconds
      for (const [id, timer] of pending) {
        if (timer.due <= now) {
          pending.delete(id)
          timer.callback()
        }
      }
    },
  }
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
  timers?: ReturnType<typeof warningClock>
  entries?: SkinLibraryEntry[]
  list?: () => Promise<SkinLibraryEntry[]>
  read?: (id: string) => Promise<SkinLibraryEntryContent>
  readLocal?: typeof skinLibrary.readLocalSkinFile
  fetch?: () => Promise<minecraftSkin.MinecraftSkinResponse>
  storeSkin?: (request: skinLibrary.SkinLibraryStoreRequest) => Promise<SkinLibraryEntry>
  rename?: (id: string, name: string) => Promise<SkinLibraryEntry>
  thumbnail?: () => Promise<string>
  defaultPalm?: () => Promise<string>
  defaultColors?: typeof dmeloperSkin.resolveDefaultDmeloperColors
  delete?: (ids: string[]) => Promise<SkinLibraryDeleteResponse>
  cleanup?: () => Promise<SkinLibraryCleanupResponse>
  manualConfirm?: boolean
  configureStore?: (store: ReturnType<typeof useBlockStore>) => void
} = {}) {
  setActivePinia(createPinia())
  const store = useBlockStore()
  options.configureStore?.(store)
  const locale = Vue.ref('ko-KR')
  const translate = (key: string, parameters: unknown = {}) => {
    const value = key.split('.').reduce<unknown>((current, part) =>
      (current as Record<string, unknown>)?.[part], locales[locale.value])
    assert.equal(typeof value, 'string', `Missing translation: ${key}`)
    const named = parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters as Record<string, unknown> : {}
    return (value as string).replace(/\{(\w+)\}/g, (placeholder, name: string) => name in named ? String(named[name]) : placeholder)
  }
  let catalog = options.entries ?? []
  const deletes: string[][] = []
  const confirmations: Array<{ title: string, onOk: () => unknown }> = []
  let cleanupCalls = 0
  const messages: string[] = []
  const diagnostics: Array<{ level: string, operation: string }> = []
  let remoteReads = 0
  const skinChanges: Array<{ phase: string, skin?: unknown }> = []
  let drop: ((event: { payload: { type: 'drop', paths: string[] } }) => void) | undefined
  const module = { exports: {} as { default: Vue.Component } }
  // Compile and mount the actual SFC. Only native I/O and visual framework
  // wrappers are stubbed, so card actions and store changes run production code.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', transformed.outputText)((id: string) => {
    if (id === '@/components/file-drop-surface/index.vue') return { default: stub('div') }
    if (id === '@/services/petSkinChange') {
      return { beginPetSkinChange: () => {
        skinChanges.push({ phase: 'prepare' })
        let finished = false
        return { ready: Promise.resolve(), finish: async (skin?: unknown) => {
          if (finished) return
          finished = true
          skinChanges.push({ phase: 'finish', skin })
        } }
      } }
    }
    if (id === '@/services/diagnostics') return { reportDiagnostic: (level: string, operation: string) => diagnostics.push({ level, operation }) }
    if (id === 'vue') return { ...Vue, vModelText: {} }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: translate }) }
    if (id === '@tauri-apps/api/window') {
      return { getCurrentWindow: () => ({ onDragDropEvent: async (callback: typeof drop) => {
        drop = callback
        return () => {
          drop = undefined
        }
      } }) }
    }
    if (id === 'ant-design-vue') {
      return {
        Button: stub('button'),
        Flex: stub('div'),
        Tag: stub('tag'),
        message: {
          error: (value: string) => messages.push(value),
          success: (value: string) => messages.push(value),
          warning: (value: string) => messages.push(value),
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
    if (id === '@/stores/block') return { useBlockStore: () => store }
    if (id === '@/services/dmeloperSkin') {
      return {
        ...dmeloperSkin,
        resolveDefaultDmeloperColors: options.defaultColors ?? (async () => ({
          palmColor: await (options.defaultPalm ?? (async () => '#445566'))(),
          eyebrowColor: '#778899',
        })),
        resolveDmeloperSkinThumbnailUrl: options.thumbnail ?? (async () => 'data:image/png;base64,default-preview'),
      }
    }
    if (id === '@/services/skinLibrary') {
      return {
        ...skinLibrary,
        storeSkinLibraryEntry: options.storeSkin ?? skinLibrary.storeSkinLibraryEntry,
        listSkinLibraryEntries: options.list ?? (async () => catalog),
        readSkinLibraryEntry: options.read ?? (async () => {
          throw new Error('Unexpected stored PNG read.')
        }),
        readLocalSkinFile: options.readLocal ?? skinLibrary.readLocalSkinFile,
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
          if (options.fetch) return options.fetch()
          throw new Error('Unexpected network call.')
        },
      }
    }
    if (id === '@/utils/skinLibraryImport') return skinLibraryImport
    if (id === '@/utils/skinLibrarySelection') return skinLibrarySelection
    if (id === '@/utils/skinThumbnail') return skinThumbnail
    if (id === '@/utils/three3d/voxelSkin') return voxelSkin
    throw new Error(`Unexpected library import: ${id}`)
  }, module, module.exports, options.timers?.setTimeout ?? setTimeout, options.timers?.clearTimeout ?? clearTimeout)

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
  const button = (key: string) => walk(root).find(node => node.type === 'button' && content(node).trim() === translate(key))!
  const click = async (node: TestElement) => {
    assert.ok(node, 'The requested control must be rendered.')
    assert.notEqual(node.props.disabled, true, 'The requested control must be enabled.')
    const result = (node.props.onClick as (event: { stopPropagation: () => void }) => unknown)({ stopPropagation: () => {} })
    await result
    await flush()
  }
  const waitImport = async () => {
    for (let attempts = 0; attempts < 30; attempts++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      await flush()
      if (!button('pages.preference.skinLibrary.buttons.importFile').props.disabled) return
    }
    assert.fail('The skin import did not settle.')
  }
  const importFiles = async (files: File[]) => {
    const input = walk(root).find(node => node.type === 'input' && node.props.type === 'file')!
    const target = { files, value: 'selected' }
    ;(input.props.onChange as (event: unknown) => void)({ currentTarget: target })
    assert.equal(target.value, '', 'the same failed file can be selected again')
    await waitImport()
  }
  return { app, root, cards, button, click, store, locale, deletes, confirmations, skinChanges, importFiles, waitImport, drop: (paths: string[]) => drop?.({ payload: { type: 'drop', paths } }), cleanupCalls: () => cleanupCalls, messages, diagnostics, remoteReads: () => remoteReads }
}

it('keeps the library title and blank header area outside native window dragging', async () => {
  const h = mountLibrary()
  try {
    await flush()
    assert.equal(walk(h.root).some(node => node.props['data-tauri-drag-region'] !== undefined), false)
    assert.equal(h.button('pages.preference.skinLibrary.buttons.back').props.disabled, false)
    assert.ok(walk(h.root).some(node => node.type === 'h1'), 'the actual library header must be mounted')
  } finally {
    h.app.unmount()
  }
})

describe('local PNG import failure reasons', () => {
  const file = (browser: ReturnType<typeof installPresetSkinBrowser>, width = 64, height = 64, name = 'skin.png') => {
    const bytes = Uint8Array.from(atob(browser.dataUrl.split(',')[1]), character => character.charCodeAt(0))
    const header = new DataView(bytes.buffer)
    header.setUint32(16, width)
    header.setUint32(20, height)
    return new File([bytes], name, { type: 'image/png' })
  }
  const alerts = (control: ReturnType<typeof mountLibrary>) => walk(control.root).filter(node => node.props.role === 'alert').map(content)
  const stored = async (request: skinLibrary.SkinLibraryStoreRequest) => {
    assert.equal('importIndex' in request, false, 'batch positions must never enter native storage')
    return { ...entry('a'), displayName: request.displayName, originalFilename: request.originalFilename }
  }

  it('expires repeated picker/drop warnings at 3000 ms and cancels timers on success and disposal', async () => {
    const browser = installPresetSkinBrowser()
    const timers = warningClock()
    const control = mountLibrary({ timers, storeSkin: stored })
    try {
      await flush()
      control.drop(['C:/invalid.jpg'])
      await control.waitImport()
      const stale = [...timers.pending.values()][0].callback
      assert.equal(alerts(control).length, 1)
      assert.equal(control.button('pages.preference.skinLibrary.buttons.retry'), undefined)
      timers.advance(2000)
      await control.importFiles([file(browser, 64, 64, 'invalid.jpg')])
      stale()
      await flush()
      assert.equal(alerts(control).length, 1)
      assert.equal(timers.pending.size, 1)
      timers.advance(2999)
      await flush()
      assert.equal(alerts(control).length, 1)
      timers.advance(1)
      await flush()
      assert.deepEqual(alerts(control), [])
      assert.equal(timers.pending.size, 0)

      await control.importFiles([file(browser, 64, 64, 'invalid.jpg')])
      await control.importFiles([file(browser, 64, 64, 'valid.png')])
      assert.deepEqual(alerts(control), [])
      assert.equal(timers.pending.size, 0)
      await control.importFiles([file(browser, 64, 64, 'invalid.jpg')])
      const disposed = [...timers.pending.values()][0].callback
      control.app.unmount()
      disposed()
      assert.equal(timers.pending.size, 0)
    } finally {
      control.app.unmount()
      browser.restore()
    }
  })

  it('shows proven picker size/format causes and keeps its last reason reactive across language changes', async () => {
    const browser = installPresetSkinBrowser()
    const control = mountLibrary()
    try {
      await flush()
      const cases: Array<[File, string]> = [
        [file(browser, 128, 128), '64×64 또는 64×32'],
        [file(browser, 64, 64, 'photo.jpg'), 'PNG 파일만'],
        [new File(['not PNG data'], 'photo.png'), '올바른 PNG'],
        [new File([new Uint8Array(skinLibrary.MAX_SKIN_LIBRARY_PNG_BYTES + 1)], 'large.png'), '용량'],
      ]
      for (const [input, expected] of cases) {
        await control.importFiles([input])
        assert.equal(alerts(control).length, 1)
        assert.ok(alerts(control)[0].includes(expected))
        assert.equal(presetOperations.presetNativeEditPending.value, 0)
      }
      await control.importFiles([file(browser, 64, 128)])
      assert.deepEqual(alerts(control), ['64×64 또는 64×32 픽셀의 PNG만 불러올 수 있습니다.'])
      control.locale.value = 'en-US'
      await flush()
      assert.deepEqual(alerts(control), ['Only 64×64 or 64×32 pixel PNGs can be loaded.'])
    } finally {
      control.app.unmount()
      browser.restore()
    }
  })

  for (const [error, expected] of [
    [new skinLibrary.SkinLibraryError('INVALID_DIMENSIONS'), '64×64 또는 64×32'],
    [new skinLibrary.SkinLibraryError('INVALID_PNG'), '올바른 PNG'],
    [new skinLibrary.SkinLibraryError('TOO_LARGE'), '용량'],
    [new skinLibrary.SkinLibraryError('STORAGE_UNAVAILABLE'), '보관함'],
    [new skinLibrary.SkinLibraryError('IO_ERROR'), '알 수 없는 이유'],
    [new Error('Private file path or arbitrary decoder message'), '알 수 없는 이유'],
  ] as const) {
    it(`uses only confirmed native codes for dropped images: ${String(error)}`, async () => {
      const control = mountLibrary({ readLocal: async () => {
        throw error
      } })
      try {
        await flush()
        control.drop(['C:/skin.png'])
        await control.waitImport()
        assert.equal(alerts(control).length, 1)
        assert.ok(alerts(control)[0].includes(expected))
        assert.equal(alerts(control)[0].includes('Private file path'), false)
      } finally {
        control.app.unmount()
      }
    })
  }

  it('identifies a non-PNG drop without sending its path to the native reader', async () => {
    const control = mountLibrary({ readLocal: async () => assert.fail('non-PNG drop reached native I/O') })
    try {
      await flush()
      control.drop(['C:/photo.jpg'])
      await control.waitImport()
      assert.ok(alerts(control)[0].includes('PNG 파일만'))
    } finally {
      control.app.unmount()
    }
  })

  it('keeps only the last failed input in batch order across read/decode stages and partial success', async () => {
    const browser = installPresetSkinBrowser()
    const control = mountLibrary({ storeSkin: stored })
    try {
      await flush()
      const invalidDimensions = file(browser, 128, 128)
      const invalidFormat = file(browser, 64, 64, 'photo.jpg')
      const good = file(browser, 64, 64, 'good.png')
      for (const [inputs, expected] of [
        [[invalidDimensions, invalidFormat, good], 'PNG 파일만'],
        [[invalidFormat, invalidDimensions, good], '64×64 또는 64×32'],
      ] as const) {
        await control.importFiles([...inputs])
        assert.equal(alerts(control).length, 1)
        assert.ok(alerts(control)[0].includes(expected))
        assert.ok(control.messages.at(-1)!.includes('스킨 1개를 가져오고 2개'))
        assert.equal(control.store.customization3d.activeSkinLibraryEntryId, entry('a').id)
      }
      for (const height of [64, 32]) {
        await control.importFiles([file(browser, 64, height, 'valid.png')])
        assert.deepEqual(alerts(control), [], 'a successful new attempt clears the previous reason')
      }
    } finally {
      control.app.unmount()
      browser.restore()
    }
  })

  it('does not publish a delayed failed import after its preset owner is superseded', async () => {
    const oldRead = deferred<skinLibrary.LocalSkinFileResponse>()
    const control = mountLibrary({ readLocal: path => path.endsWith('old.png') ? oldRead.promise : Promise.reject(new skinLibrary.SkinLibraryError('INVALID_PNG')) })
    try {
      await flush()
      control.drop(['C:/old.png'])
      await flush()
      presetEditIntent.invalidatePresetSelection()
      control.drop(['C:/new.png'])
      await control.waitImport()
      const current = alerts(control)
      oldRead.reject(new skinLibrary.SkinLibraryError('INVALID_DIMENSIONS'))
      await flush()
      assert.deepEqual(alerts(control), current)
      assert.ok(current[0].includes('올바른 PNG'))
      assert.equal(presetOperations.presetNativeEditPending.value, 0)
    } finally {
      oldRead.reject(new Error('cleanup'))
      await flush()
      control.app.unmount()
    }
  })
})

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

  it('ends multi-selection and samples both default-skin colors', async () => {
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
      assert.equal(control.store.customization3d.preset.dmeloperEyebrows.color, '#778899')
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
          store.presetCollection = { ...createPresetCollection(), activeId: 'saved', entries: [{ id: 'saved', name: 'Saved', favorite: false, snapshot: capturePresetSnapshot(store) }] }
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
        assert.deepEqual(control.store.customization3d.preset, { ...appearance, dmeloperPalmColor: '#445566', dmeloperEyebrows: { ...appearance.dmeloperEyebrows, color: '#778899' } })
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
    assert.equal(control.store.activePet3dPreset.dmeloperEyebrows.color, '#778899')
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
    defaultColors: dmeloperSkin.resolveDefaultDmeloperColors,
    read: async () => ({ ...a, pngBase64: browser.dataUrl.split(',')[1] }),
  })
  try {
    await flush()
    await control.click(control.cards()[1])
    for (let attempt = 0; attempt < 100 && control.store.customization3d.activeSkinLibraryEntryId !== a.id; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(control.store.customization3d.activeSkinLibraryEntryId, a.id)
    assert.equal(capturePresetSnapshot(control.store).preset.dmeloperPalmColor, '#445566')
    assert.equal(capturePresetSnapshot(control.store).preset.dmeloperEyebrows.color, '#445566')
    control.store.updateDmeloperPalmColor('#ABCDEF')
    control.store.updateDmeloperEyebrows({ color: '#AABBCC' })
    const decodedBeforeDefault = browser.decoded()
    await control.click(control.cards()[0])
    assert.equal(control.store.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
    assert.equal(capturePresetSnapshot(control.store).preset.dmeloperPalmColor, '#445566')
    assert.equal(capturePresetSnapshot(control.store).preset.dmeloperEyebrows.color, '#445566')
    assert.equal(browser.decoded(), decodedBeforeDefault + 1, 'one default decode must supply both colors')
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
  const active = (store: ReturnType<typeof useBlockStore>, skin: SkinLibraryEntry, png = 'old') => {
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

it('begins pet loading before a cold Java nickname request and ends it on lookup failure', async () => {
  const request = deferred<minecraftSkin.MinecraftSkinResponse>()
  const java = { ...entry('a'), source: 'java' as const, canonicalNickname: 'Steve' }
  const control = mountLibrary({ entries: [java], fetch: () => request.promise })
  try {
    await flush()
    await control.click(control.cards()[1])
    assert.equal(control.remoteReads(), 1)
    assert.deepEqual(control.skinChanges, [{ phase: 'prepare' }], 'the pet must know preparation is pending before Block changes')
    assert.equal(control.store.customization3d.dmeloperSkinDataUrl, undefined)
    request.reject(new minecraftSkin.MinecraftSkinError({ code: 'NETWORK', retryable: true }))
    await flush()
    assert.deepEqual(control.skinChanges, [{ phase: 'prepare' }, { phase: 'finish', skin: undefined }])
  } finally {
    request.reject(new Error('cleanup'))
    await flush()
    control.app.unmount()
  }
})

for (const cancel of ['disposed', 'superseded'] as const) {
  it(`ends pet loading immediately when a Java selection is ${cancel}`, async () => {
    const request = deferred<minecraftSkin.MinecraftSkinResponse>()
    const java = { ...entry('a'), source: 'java' as const, canonicalNickname: 'Steve' }
    const control = mountLibrary({ entries: [java], fetch: () => request.promise })
    try {
      await flush()
      await control.click(control.cards()[1])
      assert.deepEqual(control.skinChanges, [{ phase: 'prepare' }])
      if (cancel === 'disposed') control.app.unmount()
      else presetEditIntent.invalidatePresetSelection()
      await flush()
      assert.deepEqual(control.skinChanges, [{ phase: 'prepare' }, { phase: 'finish', skin: undefined }])
      request.reject(new minecraftSkin.MinecraftSkinError({ code: 'NETWORK', retryable: true }))
      await flush()
      assert.equal(control.skinChanges.length, 2, 'late preparation must not end another request')
      assert.equal(control.store.customization3d.dmeloperSkinDataUrl, undefined)
    } finally {
      request.reject(new Error('cleanup'))
      await flush()
      if (cancel !== 'disposed') control.app.unmount()
    }
  })
}

it('hands a successfully prepared Java PNG to the pet with its resolved model and palm color', async () => {
  const browser = installPresetSkinBrowser()
  const java = { ...entry('a'), source: 'java' as const, canonicalNickname: 'Steve' }
  const request = deferred<minecraftSkin.MinecraftSkinResponse>()
  const control = mountLibrary({
    entries: [java],
    fetch: () => request.promise,
    storeSkin: async skin => ({ ...java, model: skin.model, thumbnailPngBase64: skin.thumbnailPngBase64 }),
  })
  try {
    await flush()
    await control.click(control.cards()[1])
    assert.deepEqual(control.skinChanges, [{ phase: 'prepare' }])
    request.resolve({
      canonicalName: 'Steve',
      uuid: 'a'.repeat(32),
      model: 'wide',
      textureKey: 'b'.repeat(64),
      pngBase64: browser.dataUrl.split(',')[1],
      sha256: 'c'.repeat(64),
      width: 64,
      height: 64,
      cacheHit: false,
    })
    for (let attempt = 0; attempt < 100 && control.skinChanges.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(control.skinChanges, [{ phase: 'prepare' }, { phase: 'finish', skin: {
      dataUrl: browser.dataUrl,
      model: control.store.customization3d.dmeloperSkinModel,
      palmColor: '#445566',
    } }])
    assert.equal(control.store.customization3d.activeSkinLibraryEntryId, java.id)
    assert.deepEqual(control.diagnostics, [])
  } finally {
    request.reject(new Error('cleanup'))
    await flush()
    control.app.unmount()
    browser.restore()
  }
})

it('cancels pending Java preparation immediately when the current skin is selected again', async () => {
  const java = { ...entry('a'), source: 'java' as const, canonicalNickname: 'Steve' }
  const active = entry('b')
  const request = deferred<minecraftSkin.MinecraftSkinResponse>()
  const control = mountLibrary({
    entries: [java, active],
    fetch: () => request.promise,
    configureStore: (store) => {
      store.applySkinLibraryEntry({ entryId: active.id, source: 'local', dataUrl: 'data:image/png;base64,current', skinModel: 'wide' })
    },
  })
  try {
    await flush()
    await control.click(control.cards()[1])
    assert.deepEqual(control.skinChanges, [{ phase: 'prepare' }])
    await control.click(control.cards()[2])
    assert.deepEqual(control.skinChanges, [{ phase: 'prepare' }, { phase: 'finish', skin: undefined }])
    request.reject(new minecraftSkin.MinecraftSkinError({ code: 'NETWORK', retryable: true }))
    await flush()
    assert.equal(control.store.customization3d.activeSkinLibraryEntryId, active.id)
    assert.equal(control.skinChanges.length, 2)
  } finally {
    request.reject(new Error('cleanup'))
    await flush()
    control.app.unmount()
  }
})
