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
import type { PresetExportMode } from '@/features/presets/transfer'
import type { PresetListEntry } from '@/features/presets/types'

import { isMinecraftUsername } from '@/services/minecraftSkin'
import { isValidSkinLibraryDisplayName } from '@/services/skinLibrary'

function entry(id: string, options: Partial<PresetListEntry> = {}): PresetListEntry {
  return {
    id,
    name: id,
    favorite: false,
    origin: 'user',
    snapshot: {
      preset: { mouseEnabled: true, autoViewportEnabled: true },
      appearance: { minecraftSkinUsername: '' },
    },
    ...options,
  } as PresetListEntry
}

function manager() {
  const calls: Array<{ action: string, args: unknown[] }> = []
  const result = vue.ref(true)
  const importResult = vue.ref<string | undefined>('last')
  const exportResult = vue.ref<'saved' | 'cancelled' | 'error'>('saved')
  const retryable = vue.ref(false)
  const entries = vue.ref([entry('other'), entry('first'), entry('last')])
  const busy = vue.ref(false)
  const cardPending = vue.ref<Record<string, 'saving' | 'thumbnail'>>({})
  const call = (action: string) => async (...args: unknown[]) => {
    calls.push({ action, args: action === 'activate' ? JSON.parse(JSON.stringify(args)) : args })
    return result.value
  }
  const importCall = (action: string) => async (...args: unknown[]) => {
    calls.push({ action, args })
    return result.value ? importResult.value : undefined
  }
  const value = {
    entries,
    busy,
    cardPending,
    ready: vue.ref(true),
    status: vue.ref('saved'),
    error: vue.ref<string>(),
    hasIndependentError: vue.computed(() => value.status.value === 'error'),
    createError: vue.ref<string>(),
    createName: vue.ref<string>(),
    createNeedsName: vue.ref(false),
    canRetryCreate: vue.ref(false),
    thumbnails: vue.ref({}),
    thumbnailErrors: vue.ref({}),
    transferError: vue.ref<string>(),
    importResults: vue.ref([]),
    importProgress: vue.ref(),
    importBatchStopped: vue.ref(false),
    isBatchImport: vue.computed(() => value.importResults.value.length > 1),
    transferPhase: vue.ref<string>(),
    canRetryImport: vue.computed(() => retryable.value),
    activate: call('activate'),
    create: call('create'),
    retryCreate: call('retryCreate'),
    duplicate: call('duplicate'),
    rename: call('rename'),
    remove: call('remove'),
    toggleFavorite: call('toggleFavorite'),
    move: call('move'),
    reorder: call('reorder'),
    retry: call('retry'),
    importPreset: importCall('import'),
    importPresets: async (...args: unknown[]) => {
      calls.push({ action: 'importBatch', args })
      return result.value && importResult.value ? [importResult.value] : []
    },
    retryImport: importCall('retryImport'),
    exportPreset: async (...args: unknown[]) => {
      calls.push({ action: 'export', args })
      return exportResult.value
    },
    getSuggestedName: () => 'New Preset',
  } as unknown as PresetManager
  return { value, entries, calls, result, importResult, exportResult, retryable, busy, cardPending }
}

function renderListState(manager: PresetManager, general = vue.reactive({ app: { applyPresetSkin: true } })) {
  const source = readFileSync(new URL('./index.vue', import.meta.url), 'utf8')
    .replace('</script>', '\ndefineExpose({ importSources, retryImport, openDeleteDialog, closeDeleteDialog, selectEntry, closeApplyDialog, applyEntry })\n</script>')
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
      if (name === '@/stores/general') return { useGeneralStore: () => general }
      if (name === 'vue') return { ...vue, onMounted: () => {}, onBeforeUnmount: () => {} }
      if (name === 'vue-i18n') return { useI18n: () => ({ t: translate, te: () => true }) }
      if (name === 'ant-design-vue') return { Button: 'button', Checkbox: 'checkbox', Dropdown: 'dropdown', Menu: { Item: 'menu-item' }, Modal: 'modal', Tag: 'tag', message: { success: () => {} } }
      return { default: 'name-dialog' }
    },
  })
  let controls: Pick<ListControls, 'importSources' | 'retryImport' | 'openDeleteDialog' | 'closeDeleteDialog' | 'selectEntry' | 'closeApplyDialog' | 'applyEntry'> | undefined
  const render = exports.default.setup({ manager }, {
    expose: (value: typeof controls) => {
      controls = value
    },
  })
  const flatten = (node: vue.VNode): vue.VNode[] => [node, ...Array.isArray(node.children)
    ? node.children.flatMap(child => vue.isVNode(child) ? flatten(child) : [])
    : []]
  return { controls: controls!, general, nodes: () => flatten(render({ $t: translate }, [])) }
}

function renderList(manager: PresetManager): vue.VNode[] {
  return renderListState(manager).nodes()
}

interface UiTestRuntime {
  general?: { app: { applyPresetSkin: boolean } }
  success?: string[]
  mounted?: Array<() => unknown>
  beforeUnmount?: Array<() => void>
  subscribe?: (handler: (event: { payload: DragDropEvent }) => void) => Promise<() => void>
  elementFromPoint?: (x: number, y: number) => Element | null
  overflowY?: (element: Element) => string
  rowGap?: string
  innerHeight?: number
  resizeListeners?: Set<() => void>
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
    window: {
      innerHeight: runtime.innerHeight ?? 400,
      addEventListener: (_event: string, callback: () => void) => runtime.resizeListeners?.add(callback),
      removeEventListener: (_event: string, callback: () => void) => runtime.resizeListeners?.delete(callback),
    },
    getComputedStyle: (element: Element) => ({ overflowY: runtime.overflowY?.(element) ?? 'visible', rowGap: runtime.rowGap ?? '12px' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => runtime.requestAnimationFrame?.(callback) ?? 1,
    cancelAnimationFrame: (id: number) => runtime.cancelAnimationFrame?.(id),
    require: (name: string) => {
      if (name === '@/services/diagnostics') return { reportDiagnostic: () => {} }
      if (name === '@/stores/general') return { useGeneralStore: () => runtime.general ?? vue.reactive({ app: { applyPresetSkin: true } }) }
      if (name === 'vue') {
        return {
          ...vue,
          onMounted: (callback: () => unknown) => runtime.mounted?.push(callback),
          onBeforeUnmount: (callback: () => void) => runtime.beforeUnmount?.push(callback),
        }
      }
      if (name === 'vue-i18n') {
        return { useI18n: () => ({
          t: (key: string) => key,
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
  selectEntry: (entry: PresetListEntry) => void
  applyingId: vue.Ref<string | undefined>
  applying: vue.Ref<boolean>
  applyError: vue.Ref<string | undefined>
  closeApplyDialog: () => void
  applyEntry: () => Promise<void>
  openNewDialog: () => void
  openRenameDialog: (entry: PresetListEntry) => void
  duplicateEntry: (entry: PresetListEntry) => Promise<void>
  openExportDialog: (entry: PresetListEntry) => void
  exportingId: vue.Ref<string | undefined>
  importSources: (sources: Array<File | string>) => Promise<void>
  onFileInputChange: (event: Event) => Promise<void>
  retryImport: () => Promise<void>
  importErrorText: vue.ComputedRef<string | undefined>
  onNativeFileDrop: (payload: DragDropEvent) => void
  fileDropActive: vue.Ref<boolean>
  fileDropRegion: vue.Ref<{ top: string, left: string, width: string, height: string } | undefined>
  listenForPresetFileDrops: () => Promise<void>
  toggleFavorite: (entry: PresetListEntry) => Promise<void>
  onEntryMenu: (key: string | number, entry: PresetListEntry) => void
  openDeleteDialog: (entry: PresetListEntry) => void
  closeDeleteDialog: () => void
  deleteEntry: () => Promise<void>
  onMoveKeydown: (event: KeyboardEvent, entry: PresetListEntry) => Promise<void>
  startPointerDrag: (event: PointerEvent, entry: PresetListEntry) => void
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
  errorText: vue.ComputedRef<string | undefined>
}

function listControls(value: PresetManager, runtime: UiTestRuntime = {}) {
  return loadSetup<ListControls>('./index.vue', { manager: value }, `
    selectEntry, applyingId, applying, applyError, closeApplyDialog, applyEntry,
    openNewDialog, openRenameDialog, duplicateEntry, toggleFavorite, onEntryMenu, openDeleteDialog, closeDeleteDialog, deleteEntry,
    onMoveKeydown, startPointerDrag, movePointerDrag, finishPointerDrag, cancelPointerDrag, nameDialogOpen,
    draggedId, dropTarget, dropAtGroupEnd, presetList,
    deletingId, deleteError, errorText,
    openExportDialog, exportingId, importSources, onFileInputChange, retryImport, importErrorText,
    onNativeFileDrop, fileDropActive, fileDropRegion, listenForPresetFileDrops,
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
  it('groups favorites, users and immutable bundled scenes with only apply on bundled cards', async () => {
    const { value, entries, calls } = manager()
    entries.value = [
      entry('favorite', { favorite: true }),
      entry('user'),
      entry('builtin:preset:default', { origin: 'builtin', name: '기본' }),
    ]
    const nodes = renderList(value)
    assert.deepEqual(nodes.filter(node => node.type === 'section').map(node => node.props?.['aria-label']), [
      'pages.preference.presets.title',
      'pages.preference.presets.labels.favorites',
      'pages.preference.presets.labels.userList',
      'pages.preference.presets.labels.builtinList',
    ])
    assert.deepEqual(nodes.filter(node => node.props?.['data-preset-id']).map(node => node.props?.['data-preset-id']), ['favorite', 'user', 'builtin:preset:default'])
    const builtin = entries.value[2]
    const card = nodes.find(node => node.props?.['data-preset-id'] === builtin.id)!
    assert.equal((card.children as vue.VNode[]).some(node => node.props?.class === 'preset-action preset-drag-handle'), false)
    assert.equal((card.children as vue.VNode[]).some(node => node.props?.class === 'preset-actions'), false)
    const control = listControls(value)
    await control.duplicateEntry(builtin)
    control.openRenameDialog(builtin)
    control.openDeleteDialog(builtin)
    control.openExportDialog(builtin)
    await control.toggleFavorite(builtin)
    for (const action of ['duplicate', 'rename', 'delete', 'export']) control.onEntryMenu(action, builtin)
    assert.deepEqual(calls, [])
    assert.equal(control.nameDialogOpen.value, false)
    assert.equal(control.deletingId.value, undefined)
    assert.equal(control.exportingId.value, undefined)
    control.selectEntry(builtin)
    await control.applyEntry()
    await control.duplicateEntry(builtin)
    assert.deepEqual(calls, [{ action: 'activate', args: [builtin.id, { applySkin: true }] }])
    entries.value = [builtin]
    const headings = renderList(value).filter(node => node.type === 'section').map(node => node.props?.['aria-label'])
    assert.deepEqual(headings, ['pages.preference.presets.title', 'pages.preference.presets.labels.builtinList'])
  })

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
      assert.equal(control.applyingId.value, 'last')
      await control.applyEntry()
      await control.duplicateEntry(value.entries.value[2])
      assert.deepEqual(calls, [
        { action: 'activate', args: ['last', { applySkin: true }] },
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
    assert.equal(pendingNodes.find(node => node.props?.['data-preset-id'] === 'other')?.props?.['aria-busy'], false)
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

  it('duplicates any menu card without applying it or asking for a name', async () => {
    const { value, calls, busy } = manager()
    const control = listControls(value)
    control.onEntryMenu('duplicate', value.entries.value[2])
    await vue.nextTick()
    await control.duplicateEntry(value.entries.value[0])
    assert.deepEqual(calls, [
      { action: 'duplicate', args: ['last'] },
      { action: 'duplicate', args: ['other'] },
    ])
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

  it('shows ordinary save recovery alongside an older create error, but hides a duplicate for the same failure', () => {
    const { value } = manager()
    const independent = vue.ref(false)
    value.hasIndependentError = vue.computed(() => independent.value)
    value.canRetryCreate = vue.computed(() => true)
    const control = listControls(value)
    value.status.value = 'error'
    value.error.value = 'pages.preference.presets.errors.save'
    value.createError.value = 'pages.preference.presets.errors.create'
    assert.equal(control.errorText.value, undefined)
    independent.value = true
    assert.equal(control.errorText.value, 'pages.preference.presets.errors.save')
    const notices = renderList(value).filter(node => node.props?.role === 'alert')
    assert.equal(notices.length, 2, 'the retained create retry must not hide the independent save retry')
    independent.value = false
    value.status.value = 'saved'
    assert.equal(control.errorText.value, undefined)
    assert.equal(renderList(value).filter(node => node.props?.role === 'alert').length, 1)
    assert.equal(value.createError.value, 'pages.preference.presets.errors.create')
  })

  it('requires confirmation for every row click and repeated application of the same preset', async () => {
    const { value, calls, busy } = manager()
    const control = listControls(value)
    const target = value.entries.value[1]
    control.openRenameDialog(target)
    control.openDeleteDialog(target)
    assert.deepEqual(calls, [])
    assert.equal(control.deletingId.value, undefined)
    control.nameDialogOpen.value = false
    control.selectEntry(target)
    assert.equal(control.applyingId.value, 'first')
    assert.deepEqual(calls, [])
    control.closeApplyDialog()
    assert.equal(control.applyingId.value, undefined)
    control.selectEntry(target)
    await control.applyEntry()
    assert.deepEqual(calls, [{ action: 'activate', args: ['first', { applySkin: true }] }])
    control.selectEntry(target)
    assert.equal(control.applyingId.value, 'first')
    await control.applyEntry()
    assert.deepEqual(calls, [
      { action: 'activate', args: ['first', { applySkin: true }] },
      { action: 'activate', args: ['first', { applySkin: true }] },
    ])
    busy.value = true
    control.selectEntry(value.entries.value[2])
    assert.equal(calls.length, 2)
  })

  it('renders the shared warning modal and routes its Cancel and Apply buttons', async () => {
    const { value, calls } = manager()
    const view = renderListState(value)
    const card = view.nodes().find(node => node.props?.['data-preset-id'] === 'first')!
    card.props!.onClick()
    const modal = () => view.nodes().find(node => node.props?.title === 'pages.preference.presets.dialog.applyTitle')!
    assert.equal(modal().props?.open, true)
    assert.equal(modal().props?.['mask-closable'], false)
    assert.equal(modal().props?.['cancel-text'], 'pages.preference.presets.buttons.cancel')
    assert.equal(modal().props?.['ok-text'], 'pages.preference.presets.buttons.apply')
    assert.equal(modal().props?.keyboard, true)
    assert.ok(view.nodes().some(node => node.children === 'pages.preference.presets.dialog.applyWarning' && node.props?.class === 'text-primary-7'))
    assert.equal(view.nodes().find(node => node.props?.class === 'preset-new-button')?.props?.disabled, true)
    assert.equal(view.nodes().find(node => node.props?.class === 'preset-import-button')?.props?.disabled, true)
    assert.deepEqual(calls, [])
    modal().props!.onCancel()
    assert.equal(modal().props?.open, false)
    card.props!.onClick()
    const pending = modal().props!.onOk()
    assert.equal(modal().props?.closable, false)
    assert.equal(modal().props?.keyboard, false)
    assert.equal(modal().props?.['cancel-button-props'].disabled, true)
    assert.equal(modal().props?.['confirm-loading'], true)
    assert.equal(view.nodes().find(node => node.type === 'checkbox')!.props?.disabled, true)
    modal().props!.onCancel()
    assert.equal(modal().props?.open, true)
    await pending
    assert.equal(modal().props?.open, false)
    assert.deepEqual(calls, [{ action: 'activate', args: ['first', { applySkin: true }] }])
    const ko = JSON.parse(readFileSync(new URL('../../../../locales/ko-KR.json', import.meta.url), 'utf8')).pages.preference.presets
    const en = JSON.parse(readFileSync(new URL('../../../../locales/en-US.json', import.meta.url), 'utf8')).pages.preference.presets
    assert.equal(ko.dialog.applyTitle, '"{name}" 프리셋을 적용하시겠습니까?')
    assert.equal(ko.dialog.applyWarning, '주의: 현재 설정된 펫, 물체, 장면 설정이 모두 이 프리셋으로 덮어씌워집니다. 현재 설정을 보존하려면 \'+새 프리셋\' 버튼을 클릭해 현재 상태를 프리셋으로 저장해주세요.')
    assert.equal(ko.buttons.cancel, '취소')
    assert.equal(ko.buttons.apply, '적용하기')
    assert.equal(en.buttons.cancel, 'Cancel')
    assert.equal(en.buttons.apply, 'Apply')
  })

  it('remembers the skin checkbox after Cancel and remount, and passes it through imported confirmation', async () => {
    const { value, calls } = manager()
    const view = renderListState(value)
    const checkbox = () => view.nodes().find(node => node.type === 'checkbox')!
    view.controls.selectEntry(value.entries.value[1])
    assert.equal(checkbox().props?.checked, true)
    assert.equal(checkbox().props?.disabled, false)
    const info = view.nodes().find(node => node.props?.text === 'pages.preference.presets.dialog.applySkinHint')!
    assert.equal(info.props?.label, 'pages.preference.presets.dialog.applySkin')
    checkbox().props!['onUpdate:checked'](false)
    view.controls.closeApplyDialog()
    assert.deepEqual(calls, [])
    const reopened = renderListState(value, view.general)
    await reopened.controls.importSources(['preset.petpreset'])
    const savedChoice = reopened.nodes().find(node => node.type === 'checkbox')!
    assert.equal(savedChoice.props?.checked, false)
    await reopened.controls.applyEntry()
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      { action: 'import', args: ['preset.petpreset'] },
      { action: 'activate', args: ['last', { applySkin: false }] },
    ])
    const ko = JSON.parse(readFileSync(new URL('../../../../locales/ko-KR.json', import.meta.url), 'utf8')).pages.preference.presets.dialog
    assert.equal(ko.applySkin, '이 펫 스킨으로 변경하기')
    assert.equal(ko.applySkinHint, '이 옵션을 끄면 현재 적용된 스킨을 유지한 상태로 프리셋을 적용합니다.')
  })

  it('blocks overlapping actions and closing during apply, then keeps failures open for recovery and retry', async () => {
    const { value, calls } = manager()
    let finish: ((accepted: boolean) => void) | undefined
    value.activate = async (id, options) => {
      calls.push({ action: 'activate', args: JSON.parse(JSON.stringify([id, options])) })
      return await new Promise<boolean>((resolve) => {
        finish = resolve
      })
    }
    const control = listControls(value)
    control.selectEntry(value.entries.value[1])
    const pending = control.applyEntry()
    await control.applyEntry()
    control.closeApplyDialog()
    control.selectEntry(value.entries.value[2])
    control.openNewDialog()
    control.openRenameDialog(value.entries.value[0])
    control.openDeleteDialog(value.entries.value[0])
    control.openExportDialog(value.entries.value[0])
    await control.duplicateEntry(value.entries.value[0])
    await control.toggleFavorite(value.entries.value[0])
    control.onNativeFileDrop({ type: 'drop', paths: ['scene.petpreset'], position: { x: 0, y: 0 } } as DragDropEvent)
    assert.equal(control.applyingId.value, 'first')
    assert.equal(control.applying.value, true)
    assert.equal(control.nameDialogOpen.value, false)
    assert.equal(control.deletingId.value, undefined)
    assert.equal(control.exportingId.value, undefined)
    assert.deepEqual(calls, [{ action: 'activate', args: ['first', { applySkin: true }] }])
    value.error.value = 'pages.preference.presets.errors.apply'
    value.ready.value = false
    finish!(false)
    await pending
    assert.equal(control.applying.value, false)
    assert.equal(control.applyingId.value, 'first')
    assert.equal(control.applyError.value, 'pages.preference.presets.errors.apply')
    await control.applyEntry()
    assert.equal(calls.length, 1)
    control.closeApplyDialog()
    assert.equal(control.applyingId.value, undefined)
    value.ready.value = true
    control.selectEntry(value.entries.value[1])
    const retry = control.applyEntry()
    finish!(true)
    await retry
    assert.equal(calls.length, 2)
    assert.equal(control.applyingId.value, undefined)
    assert.equal(control.applyError.value, undefined)
  })

  it('discards the pending confirmation if its target disappears or the tab unmounts', async () => {
    const { value, entries, calls } = manager()
    const beforeUnmount: Array<() => void> = []
    const control = listControls(value, { beforeUnmount })
    control.selectEntry(entries.value[1])
    entries.value.splice(1, 1)
    await vue.nextTick()
    assert.equal(control.applyingId.value, undefined)
    await control.applyEntry()
    control.selectEntry(entries.value[0])
    beforeUnmount[0]()
    assert.equal(control.applyingId.value, undefined)
    control.selectEntry(entries.value[0])
    await control.applyEntry()
    assert.deepEqual(calls, [])
  })

  it('allows every user item to be managed and retries failed deletion without applying another preset', async () => {
    const { value, calls, result } = manager()
    const control = listControls(value)
    control.openRenameDialog(value.entries.value[0])
    assert.equal(control.nameDialogOpen.value, true)
    control.nameDialogOpen.value = false
    control.openDeleteDialog(value.entries.value[0])
    assert.equal(control.deletingId.value, 'other')
    control.closeDeleteDialog()
    control.openDeleteDialog(value.entries.value[1])
    result.value = false
    value.error.value = 'pages.preference.presets.errors.manage'
    await control.deleteEntry()
    assert.equal(control.deletingId.value, 'first')
    assert.equal(control.deleteError.value, 'pages.preference.presets.errors.manage')
    result.value = true
    await control.deleteEntry()
    assert.equal(control.deletingId.value, undefined)
    assert.deepEqual(calls, [
      { action: 'remove', args: ['first'] },
      { action: 'remove', args: ['first'] },
    ])
  })

  it('uses the same current-state preservation notice for every deletion', () => {
    const { value } = manager()
    const view = renderListState(value)
    for (const entry of value.entries.value) {
      view.controls.openDeleteDialog(entry)
      assert.ok(view.nodes().some(node => node.children === 'pages.preference.presets.dialog.deleteHint'))
      assert.equal(view.nodes().some(node => node.children === 'pages.preference.presets.dialog.deleteActiveHint'), false)
      view.controls.closeDeleteDialog()
    }
  })

  it('renders saved snapshots as actions without applied or selected state', () => {
    const { value } = manager()
    value.entries.value[1].favorite = true
    const nodes = renderList(value)
    const cards = nodes.filter(node => node.props?.['data-preset-id'])
    assert.equal(cards.length, 3)
    for (const card of cards) {
      assert.equal(String(card.props?.class).includes('preset-card-active'), false)
    }
    const actions = nodes.filter(node => node.props?.class === 'preset-select')
    assert.equal(actions.length, 3)
    assert.ok(actions.every(node => !Object.prototype.hasOwnProperty.call(node.props, 'aria-pressed')))
    assert.equal(nodes.some(node => node.children === 'pages.preference.presets.status.active'), false)
    const favorite = nodes.find(node => node.props?.['aria-pressed'] === true)!
    assert.ok(String(favorite.props?.class).includes('preset-favorite-active'))
    assert.ok((favorite.children as vue.VNode[]).some(node => String(node.props?.class).includes('i-solar:star-bold')))
    const ordinary = nodes.find(node => node.props?.['aria-pressed'] === false)!
    assert.ok((ordinary.children as vue.VNode[]).some(node => String(node.props?.class).includes('i-lucide:star')))
    value.entries.value[1].favorite = false
    assert.equal(renderList(value).some(node => node.props?.['aria-pressed'] === true), false)
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
    const { value, calls } = manager()
    const { control, surface } = pointerControls(value)
    const target = value.entries.value[2]
    control.startPointerDrag(surface.event(0, 0, { button: 2 }).event, target)
    control.startPointerDrag(surface.event(0, 0, { isPrimary: false }).event, target)
    assert.deepEqual(surface.captures, [])
    control.startPointerDrag(surface.event().event, target)
    surface.hitCard('other')
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
  it('keeps invalid and bundled duplicate names in the new dialog without capturing a request', async () => {
    const { value, entries, calls } = manager()
    entries.value.push(entry('builtin:preset:default', { name: '기본', origin: 'builtin' }))
    const events: string[] = []
    const control = loadSetup<NameControls>('./name-dialog.vue', { manager: value, mode: 'new', open: false }, 'name, nameError, submit', events)
    for (const name of ['   ', 'a'.repeat(256), 'bad\u0001name', '기본']) {
      control.name.value = name
      await control.submit()
      assert.equal(control.nameError.value, `pages.preference.presets.errors.${name === '기본' ? 'duplicateName' : 'invalidName'}`)
    }
    assert.deepEqual(events, [])
    assert.deepEqual(calls, [])
    control.name.value = '유효한 이름'
    await control.submit()
    assert.deepEqual(events, ['close'])
    assert.deepEqual(calls, [{ action: 'create', args: ['유효한 이름'] }])
  })
  it('keeps local name validation and trimmed Unicode names for rename', async () => {
    const { value, calls } = manager()
    const events: string[] = []
    const control = loadSetup<NameControls>('./name-dialog.vue', { manager: value, mode: 'rename', open: false, entry: value.entries.value[1] }, 'name, nameError, submit', events)
    for (const name of [' ', '\t', 'a\u0000b', '😶'.repeat(256), 'other']) {
      control.name.value = name
      await control.submit()
      assert.ok(control.nameError.value)
    }
    assert.deepEqual(calls, [])
    control.name.value = '  가상사용자 安★  '
    await control.submit()
    assert.deepEqual(calls, [{ action: 'rename', args: ['first', '가상사용자 安★'] }])
    assert.deepEqual(events, ['close'])
  })

  it('allows the former app-default names and creates from an empty catalog', async () => {
    for (const name of ['App Defaults', '앱 기본값']) {
      const { value, entries, calls } = manager()
      entries.value = []
      const control = loadSetup<NameControls>('./name-dialog.vue', { manager: value, mode: 'new', open: false }, 'name, nameError, submit')
      control.name.value = name
      await control.submit()
      assert.equal(control.nameError.value, undefined)
      assert.deepEqual(calls, [{ action: 'create', args: [name] }])
    }
  })

  it('closes new creation immediately, before pending work succeeds or fails', async () => {
    const { value } = manager()
    let resolve!: (accepted: boolean) => void
    value.create = () => new Promise<boolean>((done) => {
      resolve = done
    })
    const events: string[] = []
    const control = loadSetup<NameControls>('./name-dialog.vue', { manager: value, mode: 'new', open: false }, 'name, nameError, submit', events)
    control.name.value = 'New Scene'
    const creating = control.submit()
    assert.deepEqual(events, ['close'])
    resolve(false)
    await creating
    assert.equal(control.nameError.value, undefined)
  })

  it('keeps duplicate new names open and routes accepted retained-request retries separately', async () => {
    const { value, calls } = manager()
    const events: string[] = []
    const props = { manager: value, mode: 'new', open: false, retryCreation: false }
    const control = loadSetup<NameControls>('./name-dialog.vue', props, 'name, nameError, submit', events)
    control.name.value = 'first'
    await control.submit()
    assert.equal(control.nameError.value, 'pages.preference.presets.errors.duplicateName')
    assert.deepEqual(events, [])
    assert.deepEqual(calls, [])
    props.retryCreation = true
    control.name.value = 'Corrected name'
    await control.submit()
    assert.deepEqual(events, ['close'])
    assert.deepEqual(calls, [{ action: 'retryCreate', args: ['Corrected name'] }])
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
  it('retains batch file results after a tab remount and never applies a partially retried batch', async () => {
    const { value, retryable, calls } = manager()
    value.importResults.value = [
      { key: 'a', file: 'one.petpreset', status: 'saved', presetId: 'last' },
      { key: 'b', file: 'bad.petpreset', status: 'failed', error: 'Invalid file' },
      { key: 'c', file: 'remaining.petpreset', status: 'pending' },
    ]
    value.importBatchStopped.value = true
    retryable.value = true
    const beforeUnmount: Array<() => void> = []
    listControls(value, { beforeUnmount })
    beforeUnmount.forEach(callback => callback())
    const control = listControls(value)
    const nodes = renderList(value)
    assert.ok(nodes.some(node => node.children === 'pages.preference.presets.transfer.batch.summary'))
    assert.ok(nodes.some(node => typeof node.children === 'string' && node.children.includes('bad.petpreset')))
    assert.ok(nodes.some(node => node.children === 'pages.preference.presets.transfer.batch.stopped'))
    await control.retryImport()
    assert.deepEqual(calls, [{ action: 'retryImport', args: [] }])
    assert.equal(control.applyingId.value, undefined)
    assert.equal(value.importResults.value.length, 3)
  })
  it('renders file errors without an unavailable retry action and keeps progress separate from application', async () => {
    const { value, calls, result, busy } = manager()
    const view = renderListState(value)
    result.value = false
    value.transferError.value = 'This preset format is invalid.'
    await view.controls.importSources(['C:\\invalid.petpreset'])
    let nodes = view.nodes()
    assert.ok(nodes.some(node => node.children === 'This preset format is invalid.'))
    assert.equal(nodes.some(node => node.props?.onClick === view.controls.retryImport), false)
    busy.value = true
    for (const phase of ['reading', 'skin', 'applying', 'saving'] as const) {
      value.transferPhase.value = phase
      nodes = view.nodes()
      assert.ok(nodes.some(node => node.props?.role === 'status' && node.props?.['aria-live'] === 'polite'))
      assert.ok(nodes.some(node => typeof node.children === 'string' && node.children.includes(`pages.preference.presets.transfer.phases.${phase}`)))
    }
    assert.deepEqual(calls, [{ action: 'import', args: ['C:\\invalid.petpreset'] }])
  })

  it('renders a multiple .petpreset picker and keeps the import and export controls separate from preset application', () => {
    const { value, calls } = manager()
    const nodes = renderList(value)
    const input = nodes.find(node => node.type === 'input' && node.props?.type === 'file')!
    assert.equal(input.props?.accept, '.petpreset')
    assert.notEqual(input.props?.multiple, undefined)
    const control = listControls(value)
    control.onEntryMenu('export', value.entries.value[0])
    assert.equal(control.exportingId.value, 'other')
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

  it('imports multiple file drops without applying them and accepts one Unicode native path', async () => {
    const { value, calls } = manager()
    const control = listControls(value)
    await control.importSources(['C:\\skins\\a.petpreset', 'C:\\skins\\b.petpreset'])
    assert.equal(control.importErrorText.value, undefined)
    assert.equal(control.applyingId.value, undefined)
    assert.deepEqual(calls, [{ action: 'importBatch', args: [['C:\\skins\\a.petpreset', 'C:\\skins\\b.petpreset']] }])
    calls.splice(0)
    const path = 'C:\\사용자 😶安★\\나의 프리셋.petpreset'
    control.onNativeFileDrop({ type: 'drop', paths: [path], position: { x: 12, y: 34 } } as DragDropEvent)
    await vue.nextTick()
    assert.deepEqual(calls, [{ action: 'import', args: [path] }])
    assert.equal(control.importErrorText.value, undefined)
  })

  it('shows the empty hint without cards and keeps both creation and import available', () => {
    const { value, entries, calls } = manager()
    entries.value = []
    const nodes = renderList(value)
    assert.ok(nodes.some(node => node.children === 'pages.preference.presets.hints.empty'))
    assert.equal(nodes.some(node => node.props?.['data-preset-id']), false)
    assert.equal(nodes.find(node => node.props?.class === 'preset-new-button')?.props?.disabled, false)
    assert.equal(nodes.find(node => node.props?.class === 'preset-import-button')?.props?.disabled, false)
    assert.deepEqual(calls, [])
    const ko = JSON.parse(readFileSync(new URL('../../../../locales/ko-KR.json', import.meta.url), 'utf8')).pages.preference.presets
    assert.equal(ko.hints.empty, '아직 프리셋이 없습니다. 새 프리셋을 만들어 현재 스킨과 설정을 저장해보세요')
    assert.equal(ko.dialog.newHint, '현재 적용된 스킨과 설정을 새 프리셋으로 저장합니다.')
  })

  it('uses the empty-list anchor for a fixed two-row file-drop region and imports into an empty catalog', async () => {
    const { value, entries, calls } = manager()
    entries.value = []
    const scroller = {
      parentElement: null,
      scrollTop: 300,
      getBoundingClientRect: () => ({ bottom: 1000 }),
    }
    let width = 630
    const anchor = {
      parentElement: scroller,
      querySelector: () => null,
      getBoundingClientRect: () => ({ top: 145 - scroller.scrollTop, left: 163, width }),
    }
    const control = listControls(value, {
      innerHeight: 1000,
      overflowY: element => element === scroller as unknown as HTMLElement ? 'auto' : 'visible',
    })
    control.presetList.value = {
      querySelector: (selector: string) => selector === '.preset-grid' ? anchor : null,
    } as unknown as HTMLElement
    control.onNativeFileDrop({ type: 'enter', paths: ['scene.petpreset'], position: { x: 0, y: 0 } } as DragDropEvent)
    assert.deepEqual({ ...control.fileDropRegion.value }, { top: '145px', left: '163px', width: '630px', height: '542.75px' })
    scroller.scrollTop = 450
    control.onNativeFileDrop({ type: 'over', position: { x: 0, y: 0 } } as DragDropEvent)
    assert.equal(control.fileDropRegion.value?.top, '145px')
    width = 420
    control.onNativeFileDrop({ type: 'over', position: { x: 0, y: 0 } } as DragDropEvent)
    assert.equal(control.fileDropRegion.value?.height, '411.5px')
    control.onNativeFileDrop({ type: 'drop', paths: ['scene.petpreset'], position: { x: 0, y: 0 } } as DragDropEvent)
    await vue.nextTick()
    assert.equal(control.fileDropActive.value, false)
    assert.deepEqual(calls, [{ action: 'import', args: ['scene.petpreset'] }])
  })

  it('reserves two card rows below the heading, regardless of card count and scroll position', () => {
    const { value } = manager()
    const scroller = {
      parentElement: null,
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 1000,
      getBoundingClientRect: () => ({ bottom: 1000 }),
    }
    const card = { getBoundingClientRect: () => ({ height: 265 }) }
    const grid = {
      parentElement: scroller,
      querySelector: () => card,
      getBoundingClientRect: () => ({
        top: 145 - scroller.scrollTop,
        left: 163,
        width: 630,
        height: Math.ceil(value.entries.value.length / 2) * 277 - 12,
      }),
    }
    const control = listControls(value, {
      innerHeight: 1000,
      overflowY: element => element === scroller as unknown as HTMLElement ? 'auto' : 'visible',
    })
    control.presetList.value = { querySelector: () => grid } as unknown as HTMLElement
    const enter = { type: 'enter', paths: ['scene.petpreset'], position: { x: 0, y: 0 } } as DragDropEvent
    const expected = { top: '145px', left: '163px', width: '630px', height: '542px' }
    value.entries.value.splice(0, value.entries.value.length, entry('other'))
    control.onNativeFileDrop(enter)
    assert.deepEqual({ ...control.fileDropRegion.value }, expected)
    value.entries.value.splice(0, value.entries.value.length, ...Array.from({ length: 7 }, (_, index) => entry(String(index))))
    scroller.scrollHeight = 1600
    scroller.scrollTop = 450
    control.onNativeFileDrop({ type: 'over', position: { x: 20, y: 20 } } as DragDropEvent)
    assert.deepEqual({ ...control.fileDropRegion.value }, expected)
    control.onNativeFileDrop({ type: 'leave' })
    assert.equal(control.fileDropActive.value, false)
    control.onNativeFileDrop(enter)
    assert.deepEqual({ ...control.fileDropRegion.value }, expected)
  })

  it('fits the two-row region to the visible viewport and updates on window resize', () => {
    const { value } = manager()
    const mounted: Array<() => unknown> = []
    const beforeUnmount: Array<() => void> = []
    const resizeListeners = new Set<() => void>()
    let bottom = 700
    let cardHeight = 265
    let width = 630
    const scroller = {
      parentElement: null,
      scrollTop: 200,
      getBoundingClientRect: () => ({ bottom }),
    }
    const grid = {
      parentElement: scroller,
      querySelector: () => ({ getBoundingClientRect: () => ({ height: cardHeight }) }),
      getBoundingClientRect: () => ({ top: 145 - scroller.scrollTop, left: 163, width }),
    }
    const control = listControls(value, {
      mounted,
      beforeUnmount,
      resizeListeners,
      innerHeight: 680,
      overflowY: element => element === scroller as unknown as HTMLElement ? 'auto' : 'visible',
      subscribe: async () => () => {},
    })
    control.presetList.value = { querySelector: () => grid } as unknown as HTMLElement
    mounted[0]()
    control.onNativeFileDrop({ type: 'enter', paths: ['scene.petpreset'], position: { x: 0, y: 0 } } as DragDropEvent)
    assert.equal(control.fileDropRegion.value?.height, '535px')
    bottom = 500
    cardHeight = 200
    width = 420
    resizeListeners.forEach(listener => listener())
    assert.deepEqual({ ...control.fileDropRegion.value }, { top: '145px', left: '163px', width: '420px', height: '355px' })
    bottom = 800
    resizeListeners.forEach(listener => listener())
    assert.equal(control.fileDropRegion.value?.height, '412px')
    beforeUnmount[0]()
    assert.equal(resizeListeners.size, 0)
    assert.equal(control.fileDropActive.value, false)
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
    assert.equal(control.applyingId.value, undefined)
    assert.deepEqual(success, [])
    result.value = true
    await control.retryImport()
    assert.deepEqual(calls.map(call => call.action), ['import', 'retryImport'])
    assert.deepEqual(success, ['pages.preference.presets.transfer.success.import'])
    assert.equal(control.applyingId.value, 'last')
    success.length = 0
    control.closeApplyDialog()
    let finish: ((value: string | undefined) => void) | undefined
    value.importPreset = () => new Promise((resolve) => {
      finish = resolve
    })
    const pending = control.importSources(['C:\\another.petpreset'])
    assert.deepEqual(success, [])
    finish!('other')
    await pending
    assert.deepEqual(success, ['pages.preference.presets.transfer.success.import'])
    assert.equal(control.applyingId.value, 'other')
  })

  it('keeps the imported entry without applying it on confirmation cancellation', async () => {
    const { value, calls, entries } = manager()
    value.importPreset = async (source) => {
      calls.push({ action: 'import', args: [source] })
      entries.value.push(entry('imported'))
      return 'imported'
    }
    const control = listControls(value)
    await control.importSources(['scene.petpreset'])
    assert.equal(control.applyingId.value, 'imported')
    assert.deepEqual(calls, [{ action: 'import', args: ['scene.petpreset'] }])
    control.closeApplyDialog()
    assert.equal(control.applyingId.value, undefined)
    assert.equal(entries.value.at(-1)?.id, 'imported')
    control.selectEntry(entries.value.at(-1)!)
    await control.applyEntry()
    assert.deepEqual(calls.at(-1), { action: 'activate', args: ['imported', { applySkin: true }] })
  })

  it('opens imported confirmation during thumbnail work but waits until the target and manager are ready to apply', async () => {
    const { value, calls, cardPending } = manager()
    cardPending.value = { last: 'thumbnail' }
    const view = renderListState(value)
    await view.controls.importSources(['scene.petpreset'])
    const modal = () => view.nodes().find(node => node.props?.title === 'pages.preference.presets.dialog.applyTitle')!
    assert.equal(modal().props?.open, true)
    assert.equal(modal().props?.['ok-button-props'].disabled, true)
    await modal().props!.onOk()
    assert.equal(calls.length, 1)
    cardPending.value = {}
    value.ready.value = false
    assert.equal(modal().props?.['ok-button-props'].disabled, true)
    value.ready.value = true
    assert.equal(modal().props?.['ok-button-props'].disabled, false)
    await modal().props!.onOk()
    assert.deepEqual(calls.at(-1), { action: 'activate', args: ['last', { applySkin: true }] })
  })

  it('does not open confirmation or report success for an import completing after unmount', async () => {
    const { value } = manager()
    let finish: ((id: string | undefined) => void) | undefined
    value.importPreset = () => new Promise((resolve) => {
      finish = resolve
    })
    const success: string[] = []
    const beforeUnmount: Array<() => void> = []
    const control = listControls(value, { success, beforeUnmount })
    const pending = control.importSources(['scene.petpreset'])
    beforeUnmount[0]()
    finish!('last')
    await pending
    assert.deepEqual(success, [])
    assert.equal(control.applyingId.value, undefined)
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
  mode: vue.Ref<PresetExportMode>
  username: vue.ComputedRef<string | undefined>
  operationError: vue.Ref<string | undefined>
  submit: () => Promise<void>
  close: () => void
}

function exportControls(value: PresetManager, target: PresetListEntry, events: string[], success: string[] = []) {
  return loadSetup<ExportControls>('./export-dialog.vue', { manager: value, entry: target, open: true }, 'mode, username, operationError, submit, close', events, { success })
}

describe('preset export dialog', () => {
  it('defaults to the saved linked username and exports the chosen card without applying it', async () => {
    const { value, calls } = manager()
    const target = value.entries.value[2]
    target.snapshot.appearance.minecraftSkinUsername = 'Linked_Name'
    const events: string[] = []
    const success: string[] = []
    const control = exportControls(value, target, events, success)
    assert.equal(control.mode.value, 'nickname')
    assert.equal(control.username.value, 'Linked_Name')
    await control.submit()
    assert.deepEqual(calls, [{ action: 'export', args: ['last', 'nickname'] }])
    assert.deepEqual(events, ['close'])
    assert.deepEqual(success, ['pages.preference.presets.transfer.success.export'])
  })

  it('uses image mode and rejects nickname mode without a valid saved username', async () => {
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
      assert.deepEqual(calls, [{ action: 'export', args: ['other', 'image'] }])
    }
  })

  it('exports without sharing the skin with or without a linked username', async () => {
    for (const username of ['', 'Linked_Name']) {
      const { value, calls } = manager()
      const target = value.entries.value[0]
      target.snapshot.appearance.minecraftSkinUsername = username
      const events: string[] = []
      const control = exportControls(value, target, events)
      control.mode.value = 'default'
      await control.submit()
      assert.deepEqual(calls, [{ action: 'export', args: ['other', 'default'] }])
      assert.deepEqual(events, ['close'])
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
