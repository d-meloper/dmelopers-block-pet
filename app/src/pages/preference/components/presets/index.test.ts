/* eslint-disable test/no-import-node-test */
import type { DragDropEvent } from '@tauri-apps/api/window'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { PresetManager } from '@/composables/usePresetManager'
import type { PresetEntry } from '@/features/presets/types'

import { isMinecraftUsername } from '@/services/minecraftSkin'
import { isValidSkinLibraryDisplayName } from '@/services/skinLibrary'

function entry(id: string, options: Partial<PresetEntry> = {}): PresetEntry {
  return {
    id,
    name: id,
    builtin: false,
    favorite: false,
    snapshot: {
      preset: { mouseEnabled: true, autoViewportEnabled: true },
      appearance: { minecraftSkinUsername: '' },
    },
    ...options,
  } as PresetEntry
}

function manager() {
  const calls: Array<{ action: string, args: unknown[] }> = []
  const result = vue.ref(true)
  const exportResult = vue.ref<'saved' | 'cancelled' | 'error'>('saved')
  const retryable = vue.ref(false)
  const entries = vue.ref([entry('default', { builtin: true }), entry('first'), entry('last')])
  const activeId = vue.ref('first')
  const busy = vue.ref(false)
  const cardPending = vue.ref<Record<string, 'saving' | 'thumbnail'>>({})
  const call = (action: string) => async (...args: unknown[]) => {
    calls.push({ action, args })
    return result.value
  }
  const value = {
    entries,
    activeId,
    busy,
    cardPending,
    ready: vue.ref(true),
    status: vue.ref('saved'),
    error: vue.ref<string>(),
    thumbnails: vue.ref({}),
    thumbnailErrors: vue.ref({}),
    transferError: vue.ref<string>(),
    transferPhase: vue.ref<string>(),
    canRetryImport: vue.computed(() => retryable.value),
    activate: call('activate'),
    create: call('create'),
    duplicate: call('duplicate'),
    rename: call('rename'),
    remove: call('remove'),
    toggleFavorite: call('toggleFavorite'),
    move: call('move'),
    reorder: call('reorder'),
    retry: call('retry'),
    importPreset: call('import'),
    retryImport: call('retryImport'),
    exportPreset: async (...args: unknown[]) => {
      calls.push({ action: 'export', args })
      return exportResult.value
    },
    getSuggestedName: () => 'New Preset',
  } as unknown as PresetManager
  return { value, calls, result, exportResult, retryable, activeId, busy, cardPending }
}

function renderListState(manager: PresetManager) {
  const source = readFileSync(new URL('./index.vue', import.meta.url), 'utf8')
    .replace('</script>', '\ndefineExpose({ importSources, retryImport })\n</script>')
  const { descriptor } = parse(source)
  const component = compileScript(descriptor, { id: 'preset-list-render-test', inlineTemplate: true })
  type Render = (context: { $t: (key: string) => string }, cache: unknown[]) => vue.VNode
  const exports = {} as { default: { setup: (props: object, context: object) => Render } }
  const translate = (key: string) => key
  runInNewContext(ts.transpileModule(component.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require: (name: string) => {
      if (name === '@/services/diagnostics') return { reportDiagnostic: () => {} }
      if (name === 'vue') return { ...vue, onMounted: () => {}, onBeforeUnmount: () => {} }
      if (name === 'vue-i18n') return { useI18n: () => ({ t: translate, te: () => true }) }
      if (name === 'ant-design-vue') return { Button: 'button', Dropdown: 'dropdown', Menu: { Item: 'menu-item' }, Modal: 'modal', Tag: 'tag', message: { success: () => {} } }
      return { default: 'name-dialog' }
    },
  })
  let controls: Pick<ListControls, 'importSources' | 'retryImport'> | undefined
  const render = exports.default.setup({ manager }, {
    expose: (value: typeof controls) => {
      controls = value
    },
  })
  const flatten = (node: vue.VNode): vue.VNode[] => [node, ...Array.isArray(node.children)
    ? node.children.flatMap(child => vue.isVNode(child) ? flatten(child) : [])
    : []]
  return { controls: controls!, nodes: () => flatten(render({ $t: translate }, [])) }
}

function renderList(manager: PresetManager): vue.VNode[] {
  return renderListState(manager).nodes()
}

interface UiTestRuntime {
  success?: string[]
  mounted?: Array<() => unknown>
  beforeUnmount?: Array<() => void>
  subscribe?: (handler: (event: { payload: DragDropEvent }) => void) => Promise<() => void>
  elementFromPoint?: (x: number, y: number) => Element | null
  overflowY?: (element: Element) => string
  requestAnimationFrame?: (callback: FrameRequestCallback) => number
  cancelAnimationFrame?: (id: number) => void
}

function loadSetup<T>(filename: string, props: object, exposed: string, emitted: string[] = [], runtime: UiTestRuntime = {}): T {
  const { descriptor } = parse(readFileSync(new URL(filename, import.meta.url), 'utf8'))
  // Exercise the real templates as well as their event handlers.
  compileScript(descriptor, { id: filename, inlineTemplate: true })
  const source = `${descriptor.scriptSetup!.content}\nglobalThis.controls = { ${exposed} }`
  const context = {
    exports: {},
    defineProps: () => props,
    defineEmits: () => (event: string) => emitted.push(event),
    controls: undefined as T | undefined,
    document: { elementFromPoint: (x: number, y: number) => runtime.elementFromPoint?.(x, y) ?? null },
    window: { innerHeight: 400 },
    getComputedStyle: (element: Element) => ({ overflowY: runtime.overflowY?.(element) ?? 'visible' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => runtime.requestAnimationFrame?.(callback) ?? 1,
    cancelAnimationFrame: (id: number) => runtime.cancelAnimationFrame?.(id),
    require: (name: string) => {
      if (name === '@/services/diagnostics') return { reportDiagnostic: () => {} }
      if (name === 'vue') {
        return {
          ...vue,
          onMounted: (callback: () => unknown) => runtime.mounted?.push(callback),
          onBeforeUnmount: (callback: () => void) => runtime.beforeUnmount?.push(callback),
        }
      }
      if (name === 'vue-i18n') {
        return { useI18n: () => ({
          t: (key: string) => key === 'pages.preference.presets.builtinName' ? 'App Defaults' : key,
          te: () => true,
        }) }
      }
      if (name === '@/services/skinLibrary') return { isValidSkinLibraryDisplayName }
      if (name === '@/services/minecraftSkin') return { isMinecraftUsername }
      if (name === 'ant-design-vue') return { message: { success: (text: string) => runtime.success?.push(text) } }
      if (name === '@tauri-apps/api/window') return { getCurrentWindow: () => ({ onDragDropEvent: runtime.subscribe }) }
      return {}
    },
  }
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  return context.controls!
}

interface ListControls {
  selectEntry: (entry: PresetEntry) => void
  openNewDialog: () => void
  openRenameDialog: (entry: PresetEntry) => void
  duplicateEntry: (entry: PresetEntry) => Promise<void>
  openExportDialog: (entry: PresetEntry) => void
  exportingId: vue.Ref<string | undefined>
  importSources: (sources: Array<File | string>) => Promise<void>
  onFileInputChange: (event: Event) => Promise<void>
  retryImport: () => Promise<void>
  importErrorText: vue.ComputedRef<string | undefined>
  onNativeFileDrop: (payload: DragDropEvent) => void
  fileDropActive: vue.Ref<boolean>
  listenForPresetFileDrops: () => Promise<void>
  toggleFavorite: (entry: PresetEntry) => Promise<void>
  onEntryMenu: (key: string | number, entry: PresetEntry) => void
  openDeleteDialog: (entry: PresetEntry) => void
  deleteEntry: () => Promise<void>
  onMoveKeydown: (event: KeyboardEvent, entry: PresetEntry) => Promise<void>
  startPointerDrag: (event: PointerEvent, entry: PresetEntry) => void
  movePointerDrag: (event: PointerEvent) => void
  finishPointerDrag: (event: PointerEvent) => Promise<void>
  cancelPointerDrag: (event: PointerEvent) => void
  draggedId: vue.Ref<string | undefined>
  dropTarget: vue.Ref<{ id: string, after: boolean } | undefined>
  dropAtGroupEnd: vue.Ref<boolean>
  presetList: vue.Ref<HTMLElement | undefined>
  nameDialogOpen: vue.Ref<boolean>
  deletingId: vue.Ref<string | undefined>
  deleteError: vue.Ref<string | undefined>
  replacementEntry: vue.ComputedRef<PresetEntry | undefined>
  errorText: vue.ComputedRef<string | undefined>
}

function listControls(value: PresetManager, runtime: UiTestRuntime = {}) {
  return loadSetup<ListControls>('./index.vue', { manager: value }, `
    selectEntry, openNewDialog, openRenameDialog, duplicateEntry, toggleFavorite, onEntryMenu, openDeleteDialog, deleteEntry,
    onMoveKeydown, startPointerDrag, movePointerDrag, finishPointerDrag, cancelPointerDrag, nameDialogOpen,
    draggedId, dropTarget, dropAtGroupEnd, presetList,
    deletingId, deleteError, replacementEntry, errorText,
    openExportDialog, exportingId, importSources, onFileInputChange, retryImport, importErrorText,
    onNativeFileDrop, fileDropActive, listenForPresetFileDrops,
  `, [], runtime)
}

function pointerSurface() {
  const members = new Set<object>()
  let hit: Element | null = null
  let captured: number | undefined
  const captures: number[] = []
  const releases: number[] = []
  const frames = new Map<number, FrameRequestCallback>()
  let frameSequence = 0
  const scroller = {
    parentElement: null,
    scrollHeight: 1000,
    clientHeight: 180,
    scrollTop: 100,
    getBoundingClientRect: () => ({ left: 0, right: 300, top: 20, bottom: 200 }),
  } as unknown as HTMLElement
  const handle = {
    parentElement: null as HTMLElement | null,
    setPointerCapture: (id: number) => {
      captured = id
      captures.push(id)
    },
    hasPointerCapture: (id: number) => captured === id,
    releasePointerCapture: (id: number) => {
      captured = undefined
      releases.push(id)
    },
  }
  const root = { contains: (node: object) => members.has(node) } as unknown as HTMLElement
  const runtime: UiTestRuntime = {
    elementFromPoint: () => hit,
    overflowY: element => element === scroller ? 'auto' : 'visible',
    requestAnimationFrame: (callback) => {
      frames.set(++frameSequence, callback)
      return frameSequence
    },
    cancelAnimationFrame: id => frames.delete(id),
  }
  const hitNode = (dataset: Record<string, string>, inside = true) => {
    const node = {
      dataset,
      getBoundingClientRect: () => ({ left: 0, width: 100 }),
      closest: (selector: string) => (selector === '[data-preset-id]' && dataset.presetId)
        || (selector === '[data-preset-group-end]' && dataset.presetGroupEnd)
        ? node
        : null,
    } as unknown as HTMLElement
    if (inside) members.add(node)
    hit = node
  }
  return {
    runtime,
    root,
    handle,
    captures,
    releases,
    frames,
    scroller,
    hitCard: (id: string, inside = true) => hitNode({ presetId: id }, inside),
    hitGroupEnd: (favorite: boolean) => hitNode({ presetGroupEnd: String(favorite) }),
    miss: () => {
      hit = null
    },
    stepFrame: () => {
      const [id, callback] = frames.entries().next().value!
      frames.delete(id)
      callback(0)
    },
    event: (x = 0, y = 0, options: Partial<PointerEvent> = {}) => {
      let prevented = false
      return {
        get prevented() {
          return prevented
        },
        event: {
          pointerId: 1,
          button: 0,
          buttons: 1,
          isPrimary: true,
          currentTarget: handle,
          clientX: x,
          clientY: y,
          preventDefault: () => {
            prevented = true
          },
          ...options,
        } as unknown as PointerEvent,
      }
    },
  }
}

function pointerControls(value: PresetManager, surface = pointerSurface(), runtime: UiTestRuntime = {}) {
  const control = listControls(value, { ...surface.runtime, ...runtime })
  control.presetList.value = surface.root
  return { control, surface }
}

describe('preset list interactions', () => {
  for (const pending of ['saving', 'thumbnail'] as const) {
    it(`blocks only the ${pending} card across pointer, menu, keyboard, and drag actions`, async () => {
      const { value, calls, cardPending } = manager()
      const { control, surface } = pointerControls(value)
      const target = value.entries.value[1]
      cardPending.value = { first: pending }
      control.selectEntry(target)
      await control.toggleFavorite(target)
      for (const action of ['duplicate', 'rename', 'delete']) control.onEntryMenu(action, target)
      await control.onMoveKeydown({ altKey: true, key: 'ArrowDown', preventDefault: () => {}, stopPropagation: () => {} } as unknown as KeyboardEvent, target)
      const drag = surface.event()
      control.startPointerDrag(drag.event, target)
      assert.equal(drag.prevented, true)
      assert.equal(control.nameDialogOpen.value, false)
      assert.equal(control.deletingId.value, undefined)
      assert.deepEqual(calls, [])
      control.selectEntry(value.entries.value[2])
      await control.duplicateEntry(value.entries.value[2])
      assert.deepEqual(calls, [
        { action: 'activate', args: ['last'] },
        { action: 'duplicate', args: ['last'] },
      ])
    })
  }

  it('rejects drops when their source or target becomes pending after drag start', async () => {
    const { value, calls, cardPending } = manager()
    const { control, surface } = pointerControls(value)
    for (const pendingId of ['first', 'last']) {
      cardPending.value = {}
      control.startPointerDrag(surface.event().event, value.entries.value[1])
      surface.hitCard('last')
      control.movePointerDrag(surface.event(20).event)
      cardPending.value = { [pendingId]: 'saving' }
      await control.finishPointerDrag(surface.event(20).event)
      assert.equal(control.draggedId.value, undefined)
      assert.deepEqual(calls, [])
    }
    cardPending.value = {}
    control.startPointerDrag(surface.event().event, value.entries.value[1])
    control.movePointerDrag(surface.event(20).event)
    await control.finishPointerDrag(surface.event(20).event)
    assert.deepEqual(calls, [{ action: 'reorder', args: ['first', 'last'] }])
  })

  it('renders busy overlays per card and replaces an errored cached preview with an unlocked fallback', () => {
    const { value, cardPending } = manager()
    cardPending.value = { first: 'saving', last: 'thumbnail' }
    const pendingNodes = renderList(value)
    assert.equal(pendingNodes.find(node => node.props?.['data-preset-id'] === 'first')?.props?.['aria-busy'], true)
    assert.equal(pendingNodes.find(node => node.props?.['data-preset-id'] === 'default')?.props?.['aria-busy'], false)
    assert.equal(pendingNodes.filter(node => node.props?.class === 'preset-card-loading').length, 2)
    assert.ok(pendingNodes.some(node => node.children === 'pages.preference.presets.status.saving'))
    assert.ok(pendingNodes.some(node => node.children === 'pages.preference.presets.status.thumbnail'))
    value.thumbnails.value = { first: 'cached-preview' }
    value.thumbnailErrors.value = { first: true }
    cardPending.value = {}
    const failedNodes = renderList(value)
    assert.equal(failedNodes.filter(node => node.props?.class === 'preset-card-loading').length, 0)
    assert.equal(failedNodes.some(node => node.type === 'img' && node.props?.src === 'cached-preview'), false)
    assert.ok(failedNodes.some(node => typeof node.props?.class === 'string' && node.props.class.includes('i-lucide:image-off')))
    const card = failedNodes.find(node => node.props?.['data-preset-id'] === 'first')!
    assert.equal(card.props?.['aria-busy'], false)
    assert.equal((card.children as vue.VNode[]).find(node => node.props?.class === 'preset-select')?.props?.disabled, false)
  })

  it('duplicates the selected menu card including app defaults without applying it or asking for a name', async () => {
    const { value, calls, activeId, busy } = manager()
    const control = listControls(value)
    control.onEntryMenu('duplicate', value.entries.value[2])
    await vue.nextTick()
    await control.duplicateEntry(value.entries.value[0])
    assert.deepEqual(calls, [
      { action: 'duplicate', args: ['last'] },
      { action: 'duplicate', args: ['default'] },
    ])
    assert.equal(activeId.value, 'first')
    assert.equal(control.nameDialogOpen.value, false)
    assert.equal(control.deletingId.value, undefined)
    busy.value = true
    await control.duplicateEntry(value.entries.value[1])
    assert.equal(calls.length, 2)
  })

  it('provides error text only while recovery is needed', () => {
    const { value } = manager()
    const control = listControls(value)
    assert.equal(control.errorText.value, undefined)
    value.status.value = 'saving'
    assert.equal(control.errorText.value, undefined)
    value.status.value = 'error'
    assert.equal(control.errorText.value, 'pages.preference.presets.errors.save')
    value.error.value = 'pages.preference.presets.errors.apply'
    assert.equal(control.errorText.value, 'pages.preference.presets.errors.apply')
    value.status.value = 'saved'
    assert.equal(control.errorText.value, undefined)
  })

  it('applies through the row while management actions do not apply it', () => {
    const { value, calls, busy } = manager()
    const control = listControls(value)
    const target = value.entries.value[1]
    control.openRenameDialog(target)
    control.openDeleteDialog(target)
    assert.deepEqual(calls, [])
    control.selectEntry(target)
    assert.deepEqual(calls, [{ action: 'activate', args: ['first'] }])
    busy.value = true
    control.selectEntry(value.entries.value[2])
    assert.equal(calls.length, 1)
  })

  it('protects the built-in item and presents the same next-or-previous deletion target', async () => {
    const { value, calls, result, activeId } = manager()
    const control = listControls(value)
    control.openRenameDialog(value.entries.value[0])
    control.openDeleteDialog(value.entries.value[0])
    assert.equal(control.nameDialogOpen.value, false)
    assert.equal(control.deletingId.value, undefined)
    control.openDeleteDialog(value.entries.value[1])
    assert.equal(control.replacementEntry.value?.id, 'last')
    result.value = false
    value.error.value = 'pages.preference.presets.errors.apply'
    await control.deleteEntry()
    assert.equal(control.deletingId.value, 'first')
    assert.equal(control.deleteError.value, 'pages.preference.presets.errors.apply')
    result.value = true
    await control.deleteEntry()
    assert.equal(control.deletingId.value, undefined)
    assert.equal(calls.length, 2)
    activeId.value = 'last'
    control.openDeleteDialog(value.entries.value[2])
    assert.equal(control.replacementEntry.value?.id, 'first')
    control.openDeleteDialog(value.entries.value[1])
    assert.equal(control.replacementEntry.value, undefined)
  })

  it('moves from the keyboard without also applying a preset', async () => {
    const { value, calls, busy } = manager()
    const control = listControls(value)
    let prevented = 0
    let stopped = 0
    const event = {
      altKey: true,
      key: 'ArrowDown',
      preventDefault: () => {
        prevented++
      },
      stopPropagation: () => {
        stopped++
      },
    } as unknown as KeyboardEvent
    await control.onMoveKeydown(event, value.entries.value[1])
    assert.deepEqual(calls, [{ action: 'move', args: ['first', 1] }])
    assert.equal(prevented, 1)
    assert.equal(stopped, 1)
    await control.onMoveKeydown({ ...event, altKey: false } as KeyboardEvent, value.entries.value[1])
    busy.value = true
    await control.onMoveKeydown(event, value.entries.value[1])
    assert.equal(calls.length, 1)
  })

  it('accepts before/after drops only within the dragged preset’s group', async () => {
    const { value, calls } = manager()
    value.entries.value.unshift(entry('favorite', { favorite: true }))
    const { control, surface } = pointerControls(value)
    const source = value.entries.value[2]
    const assertTarget = (id: string, after: boolean) => {
      assert.equal(control.dropTarget.value?.id, id)
      assert.equal(control.dropTarget.value?.after, after)
    }
    control.startPointerDrag(surface.event().event, source)
    surface.hitCard('favorite')
    control.movePointerDrag(surface.event(80).event)
    assert.equal(control.dropTarget.value, undefined)
    await control.finishPointerDrag(surface.event(80).event)
    assert.deepEqual(calls, [])
    control.startPointerDrag(surface.event().event, source)
    surface.hitCard('last')
    control.movePointerDrag(surface.event(80).event)
    assertTarget('last', true)
    await control.finishPointerDrag(surface.event(80).event)
    assert.deepEqual(calls, [{ action: 'reorder', args: ['first', undefined] }])
    control.startPointerDrag(surface.event().event, value.entries.value[3])
    surface.hitCard('first')
    control.movePointerDrag(surface.event(20).event)
    assertTarget('first', false)
    await control.finishPointerDrag(surface.event(20).event)
    assert.deepEqual(calls[1], { action: 'reorder', args: ['last', 'first'] })
    assert.deepEqual(surface.captures, [1, 1, 1])
    assert.deepEqual(surface.releases, [1, 1, 1])
    assert.equal(control.draggedId.value, undefined)
    assert.equal(control.dropTarget.value, undefined)
  })

  it('requires a primary pointer and movement threshold, and never selects a card from its handle click', async () => {
    const { value, calls, activeId } = manager()
    const { control, surface } = pointerControls(value)
    const target = value.entries.value[2]
    control.startPointerDrag(surface.event(0, 0, { button: 2 }).event, target)
    control.startPointerDrag(surface.event(0, 0, { isPrimary: false }).event, target)
    assert.deepEqual(surface.captures, [])
    control.startPointerDrag(surface.event().event, target)
    surface.hitCard('default')
    control.movePointerDrag(surface.event(3, 4).event)
    await control.finishPointerDrag(surface.event(3, 4).event)
    assert.deepEqual(calls, [])
    assert.equal(control.draggedId.value, undefined)
    const handle = renderList(value).find(node => node.props?.class === 'preset-action preset-drag-handle')!
    assert.equal(handle.props?.draggable, undefined)
    assert.equal(handle.props?.onDragstart, undefined)
    for (const event of ['onPointerdown', 'onPointermove', 'onPointerup', 'onPointercancel', 'onLostpointercapture']) assert.equal(typeof handle.props?.[event], 'function')
    let stopped = false
    handle.props!.onClick({ stopPropagation: () => {
      stopped = true
    } })
    assert.equal(stopped, true)
    assert.equal(activeId.value, 'first')
    assert.deepEqual(calls, [])
  })

  it('uses the current release position and ignores self, unrelated elements, and the other group end', async () => {
    const { value, calls } = manager()
    const { control, surface } = pointerControls(value)
    for (const invalidTarget of [() => surface.hitCard('first'), () => surface.hitCard('last', false), () => surface.hitGroupEnd(true), () => surface.miss()]) {
      control.startPointerDrag(surface.event().event, value.entries.value[1])
      surface.hitCard('last')
      control.movePointerDrag(surface.event(80).event)
      invalidTarget()
      await control.finishPointerDrag(surface.event(80).event)
      assert.deepEqual(calls, [])
    }
    control.startPointerDrag(surface.event().event, value.entries.value[1])
    surface.hitCard('last')
    control.movePointerDrag(surface.event(20).event)
    surface.hitGroupEnd(false)
    await control.finishPointerDrag(surface.event(20).event)
    assert.deepEqual(calls, [{ action: 'reorder', args: ['first', undefined] }])
    assert.equal(control.dropAtGroupEnd.value, false)
  })

  it('cleans up cancellation, lost capture, unmount, and work starting during a pointer gesture', async () => {
    const { value, calls, busy } = manager()
    const beforeUnmount: Array<() => void> = []
    const { control, surface } = pointerControls(value, pointerSurface(), { beforeUnmount })
    for (const cancel of [() => control.cancelPointerDrag(surface.event().event), () => control.cancelPointerDrag(surface.event(0, 0, { type: 'lostpointercapture' }).event), () => {
      busy.value = true
    }]) {
      control.startPointerDrag(surface.event().event, value.entries.value[1])
      surface.hitCard('last')
      control.movePointerDrag(surface.event(80).event)
      control.cancelPointerDrag(surface.event(0, 0, { pointerId: 2 }).event)
      assert.equal(control.draggedId.value, 'first')
      cancel()
      await vue.nextTick()
      assert.equal(control.draggedId.value, undefined)
      assert.equal(control.dropTarget.value, undefined)
      await control.finishPointerDrag(surface.event(80).event)
      assert.deepEqual(calls, [])
      busy.value = false
    }
    control.startPointerDrag(surface.event().event, value.entries.value[1])
    beforeUnmount[0]()
    assert.equal(control.draggedId.value, undefined)
    assert.deepEqual(surface.releases, [1, 1, 1, 1])
  })

  it('scrolls the containing panel near an edge, updates the drop target, and stops after release', async () => {
    const { value, calls } = manager()
    const { control, surface } = pointerControls(value)
    surface.handle.parentElement = surface.scroller
    control.startPointerDrag(surface.event(20, 100).event, value.entries.value[1])
    surface.hitCard('last')
    control.movePointerDrag(surface.event(20, 195).event)
    assert.equal(surface.frames.size, 1)
    surface.hitGroupEnd(false)
    surface.stepFrame()
    assert.equal(surface.scroller.scrollTop, 112)
    assert.equal(control.dropAtGroupEnd.value, true)
    assert.equal(surface.frames.size, 1)
    await control.finishPointerDrag(surface.event(20, 195).event)
    assert.equal(surface.frames.size, 0)
    assert.deepEqual(calls, [{ action: 'reorder', args: ['first', undefined] }])
    control.startPointerDrag(surface.event(20, 100).event, value.entries.value[1])
    control.movePointerDrag(surface.event(20, 25).event)
    surface.stepFrame()
    assert.equal(surface.scroller.scrollTop, 100)
    control.cancelPointerDrag(surface.event().event)
    assert.equal(surface.frames.size, 0)
  })
})

interface NameControls {
  name: vue.Ref<string>
  nameError: vue.ComputedRef<string | undefined>
  submit: () => Promise<void>
}

describe('preset naming dialogs', () => {
  it('validates trimmed Unicode names and rejects existing names before creating', async () => {
    const { value, calls } = manager()
    const events: string[] = []
    const control = loadSetup<NameControls>('./name-dialog.vue', { manager: value, mode: 'new', open: false }, 'name, nameError, submit', events)
    for (const name of [' ', '\t', 'a\u0000b', '😶'.repeat(256), 'first', 'App Defaults']) {
      control.name.value = name
      await control.submit()
      assert.ok(control.nameError.value)
    }
    assert.deepEqual(calls, [])
    control.name.value = '  가상사용자 安★  '
    await control.submit()
    assert.deepEqual(calls, [{ action: 'create', args: ['가상사용자 安★'] }])
    assert.deepEqual(events, ['close'])
  })

  it('keeps a failed new-preset dialog open and retries creation', async () => {
    const { value, calls, result } = manager()
    result.value = false
    value.error.value = 'pages.preference.presets.errors.save'
    const events: string[] = []
    const control = loadSetup<NameControls>('./name-dialog.vue', { manager: value, mode: 'new', open: false }, 'name, nameError, submit', events)
    control.name.value = 'New Scene'
    await control.submit()
    assert.equal(control.nameError.value, 'pages.preference.presets.errors.save')
    assert.deepEqual(events, [])
    result.value = true
    await control.submit()
    assert.deepEqual(calls.map(call => call.action), ['create', 'create'])
    assert.deepEqual(events, ['close'])
  })

  it('allows a name to remain unchanged during rename and prevents overlapping submissions', async () => {
    const { value, calls } = manager()
    const target = value.entries.value[1]
    const control = loadSetup<NameControls>('./name-dialog.vue', { manager: value, mode: 'rename', open: false, entry: target }, 'name, nameError, submit')
    control.name.value = 'first'
    const request = control.submit()
    await control.submit()
    await request
    assert.deepEqual(calls, [{ action: 'rename', args: ['first', 'first'] }])
  })
})

describe('preset file import controls', () => {
  it('renders file errors without an unavailable retry action and keeps progress separate from selection', async () => {
    const { value, calls, result, activeId, busy } = manager()
    const view = renderListState(value)
    await view.controls.importSources(['C:\\a.petpreset', 'C:\\b.petpreset'])
    let nodes = view.nodes()
    assert.ok(nodes.some(node => node.props?.role === 'alert'))
    assert.ok(nodes.some(node => node.children === 'pages.preference.presets.transfer.errors.multipleFiles'))
    assert.equal(nodes.some(node => node.props?.onClick === view.controls.retryImport), false)
    assert.deepEqual(calls, [])
    result.value = false
    value.transferError.value = 'This preset format is invalid.'
    await view.controls.importSources(['C:\\invalid.petpreset'])
    nodes = view.nodes()
    assert.ok(nodes.some(node => node.children === 'This preset format is invalid.'))
    assert.equal(nodes.some(node => node.props?.onClick === view.controls.retryImport), false)
    busy.value = true
    for (const phase of ['reading', 'skin', 'applying', 'saving'] as const) {
      value.transferPhase.value = phase
      nodes = view.nodes()
      assert.ok(nodes.some(node => node.props?.role === 'status' && node.props?.['aria-live'] === 'polite'))
      assert.ok(nodes.some(node => typeof node.children === 'string' && node.children.includes(`pages.preference.presets.transfer.phases.${phase}`)))
    }
    assert.equal(activeId.value, 'first')
    assert.deepEqual(calls, [{ action: 'import', args: ['C:\\invalid.petpreset'] }])
  })

  it('renders a single .petpreset picker and keeps the import and export controls separate from card selection', () => {
    const { value, calls, activeId } = manager()
    const nodes = renderList(value)
    const input = nodes.find(node => node.type === 'input' && node.props?.type === 'file')!
    assert.equal(input.props?.accept, '.petpreset')
    assert.equal(Boolean(input.props?.multiple), false)
    const control = listControls(value)
    control.onEntryMenu('export', value.entries.value[0])
    assert.equal(control.exportingId.value, 'default')
    assert.equal(activeId.value, 'first')
    assert.deepEqual(calls, [])
  })

  it('treats picker cancellation as a no-op and resets the input so the same file can be selected again', async () => {
    const { value, calls } = manager()
    const success: string[] = []
    const control = listControls(value, { success })
    const input = { files: [], value: '' }
    await control.onFileInputChange({ target: input } as unknown as Event)
    assert.deepEqual(calls, [])
    assert.deepEqual(success, [])
    const file = { name: '가상사용자 安★.petpreset' } as File
    const selectedInput = { files: [file], value: 'selected-file' }
    await control.onFileInputChange({ target: selectedInput } as unknown as Event)
    assert.equal(selectedInput.value, '')
    assert.deepEqual(calls, [{ action: 'import', args: [file] }])
    assert.deepEqual(success, ['pages.preference.presets.transfer.success.import'])
  })

  it('rejects multiple file drops before importing and accepts one Unicode native path', async () => {
    const { value, calls } = manager()
    const control = listControls(value)
    await control.importSources(['C:\\skins\\a.petpreset', 'C:\\skins\\b.petpreset'])
    assert.equal(control.importErrorText.value, 'pages.preference.presets.transfer.errors.multipleFiles')
    assert.deepEqual(calls, [])
    const path = 'C:\\사용자 😶安★\\나의 프리셋.petpreset'
    control.onNativeFileDrop({ type: 'drop', paths: [path], position: { x: 12, y: 34 } } as DragDropEvent)
    await vue.nextTick()
    assert.deepEqual(calls, [{ action: 'import', args: [path] }])
    assert.equal(control.importErrorText.value, undefined)
  })

  it('distinguishes native file drops from internal card sorting and blocks transfers during busy work or dialogs', async () => {
    const { value, calls, busy } = manager()
    const { control, surface } = pointerControls(value)
    const payload = { type: 'drop', paths: ['C:\\scene.petpreset'], position: { x: 12, y: 34 } } as DragDropEvent
    control.startPointerDrag(surface.event().event, value.entries.value[1])
    control.onNativeFileDrop(payload)
    assert.deepEqual(calls, [])
    surface.hitCard('last')
    control.movePointerDrag(surface.event(20).event)
    await control.finishPointerDrag(surface.event(20).event)
    assert.deepEqual(calls, [{ action: 'reorder', args: ['first', 'last'] }])
    busy.value = true
    control.onNativeFileDrop(payload)
    busy.value = false
    control.openExportDialog(value.entries.value[0])
    control.onNativeFileDrop(payload)
    assert.equal(calls.length, 1)
    assert.equal(control.fileDropActive.value, false)
  })

  it('shows import errors with retry and reports success only after the manager acknowledges completion', async () => {
    const { value, calls, result, retryable } = manager()
    const success: string[] = []
    const control = listControls(value, { success })
    result.value = false
    value.transferError.value = 'Could not fetch the skin.'
    retryable.value = true
    await control.importSources(['C:\\scene.petpreset'])
    assert.equal(control.importErrorText.value, 'Could not fetch the skin.')
    assert.deepEqual(success, [])
    result.value = true
    await control.retryImport()
    assert.deepEqual(calls.map(call => call.action), ['import', 'retryImport'])
    assert.deepEqual(success, ['pages.preference.presets.transfer.success.import'])
    success.length = 0
    let finish: ((value: boolean) => void) | undefined
    value.importPreset = () => new Promise((resolve) => {
      finish = resolve
    })
    const pending = control.importSources(['C:\\another.petpreset'])
    assert.deepEqual(success, [])
    finish!(true)
    await pending
    assert.deepEqual(success, ['pages.preference.presets.transfer.success.import'])
  })

  it('unsubscribes when the tab unmounts, including a subscription that resolves after unmount', async () => {
    const { value, calls } = manager()
    const beforeUnmount: Array<() => void> = []
    let listener: ((event: { payload: DragDropEvent }) => void) | undefined
    let resolveSubscription: ((unlisten: () => void) => void) | undefined
    let unlistened = 0
    const control = listControls(value, {
      beforeUnmount,
      subscribe: (handler) => {
        listener = handler
        return new Promise((resolve) => {
          resolveSubscription = resolve
        })
      },
    })
    const pending = control.listenForPresetFileDrops()
    beforeUnmount[0]()
    resolveSubscription!(() => {
      unlistened++
    })
    await pending
    assert.equal(unlistened, 1)
    listener!({ payload: { type: 'drop', paths: ['C:\\late.petpreset'], position: { x: 0, y: 0 } } as DragDropEvent })
    assert.deepEqual(calls, [])
    assert.equal(control.fileDropActive.value, false)
  })
})

interface ExportControls {
  mode: vue.Ref<'image' | 'nickname'>
  username: vue.ComputedRef<string | undefined>
  operationError: vue.Ref<string | undefined>
  submit: () => Promise<void>
  close: () => void
}

function exportControls(value: PresetManager, target: PresetEntry, events: string[], success: string[] = []) {
  return loadSetup<ExportControls>('./export-dialog.vue', { manager: value, entry: target, open: true }, 'mode, username, operationError, submit, close', events, { success })
}

describe('preset export dialog', () => {
  it('defaults to the saved linked username and exports the chosen card without applying it', async () => {
    const { value, calls, activeId } = manager()
    const target = value.entries.value[2]
    target.snapshot.appearance.minecraftSkinUsername = 'Linked_Name'
    const events: string[] = []
    const success: string[] = []
    const control = exportControls(value, target, events, success)
    assert.equal(control.mode.value, 'nickname')
    assert.equal(control.username.value, 'Linked_Name')
    await control.submit()
    assert.deepEqual(calls, [{ action: 'export', args: ['last', 'nickname'] }])
    assert.equal(activeId.value, 'first')
    assert.deepEqual(events, ['close'])
    assert.deepEqual(success, ['pages.preference.presets.transfer.success.export'])
  })

  it('uses image mode for app defaults and rejects nickname mode without a valid saved username', async () => {
    for (const username of ['', 'two words', 'ab']) {
      const { value, calls } = manager()
      const target = value.entries.value[0]
      target.snapshot.appearance.minecraftSkinUsername = username
      const control = exportControls(value, target, [])
      assert.equal(control.mode.value, 'image')
      assert.equal(control.username.value, undefined)
      control.mode.value = 'nickname'
      await control.submit()
      assert.deepEqual(calls, [])
      control.mode.value = 'image'
      await control.submit()
      assert.deepEqual(calls, [{ action: 'export', args: ['default', 'image'] }])
    }
  })

  it('keeps the dialog open on file-save cancellation without an error or success notice', async () => {
    const { value, exportResult } = manager()
    exportResult.value = 'cancelled'
    const events: string[] = []
    const success: string[] = []
    const control = exportControls(value, value.entries.value[0], events, success)
    await control.submit()
    assert.deepEqual(events, [])
    assert.deepEqual(success, [])
    assert.equal(control.operationError.value, undefined)
    control.close()
    assert.deepEqual(events, ['close'])
  })

  it('keeps save errors in the dialog and allows a retry without overlapping submissions', async () => {
    const { value, calls, exportResult } = manager()
    exportResult.value = 'error'
    value.transferError.value = 'Destination is unavailable.'
    const events: string[] = []
    const control = exportControls(value, value.entries.value[0], events)
    const pending = control.submit()
    await control.submit()
    await pending
    assert.equal(calls.length, 1)
    assert.equal(control.operationError.value, 'Destination is unavailable.')
    assert.deepEqual(events, [])
    exportResult.value = 'saved'
    await control.submit()
    assert.equal(calls.length, 2)
    assert.equal(control.operationError.value, undefined)
    assert.deepEqual(events, ['close'])
  })
})
