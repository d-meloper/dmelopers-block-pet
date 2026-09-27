/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { ScreenColorAppearance } from '../../services/screenColor'
import type { Hsv } from './color'

import { createScreenColorAppearance } from '../../services/screenColor'
import * as color from './color'
import * as session from './session'

interface Picker {
  open: Vue.Ref<boolean>
  opening: Vue.Ref<boolean>
  hsv: Vue.Ref<Hsv>
  changeOpen: (open: boolean) => Promise<void>
  close: () => void
  pick: () => Promise<void>
  applyColor: (color: string) => void
  changeHsv: (hsv: Partial<Hsv>) => void
  moveKey: (event: KeyboardEvent) => void
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function harness() {
  const orders: boolean[] = []
  const cancellations: string[] = []
  const samples: string[] = []
  const appearances: Array<ScreenColorAppearance | undefined> = []
  const changes: string[] = []
  const errors: string[] = []
  const listeners = new Set<() => void>()
  const picking = Vue.ref(false)
  const operation = Vue.ref(false)
  const reset = Vue.ref(false)
  const sample = deferred<unknown>()
  const token = Vue.ref({ colorBgElevated: '#FFFFFF', colorBorder: '#D6E6DA', colorTextSecondary: 'rgba(0, 0, 0, 0.65)' })
  let pending = 0
  let marked = 0
  let holdOrder: ReturnType<typeof deferred<void>> | undefined
  let unmounts: Array<() => void> = []
  const { descriptor } = parse(readFileSync(new URL('./index.vue', import.meta.url), 'utf8'))
  const compiled = compileScript(descriptor, { id: 'color-picker-lifetime' })
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Picker } } }
  // Execute the component's actual async handlers; the OS boundary stays mocked.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', 'window', 'document', ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)((id: string) => {
    if (id === 'vue') return { ...Vue, onMounted: () => {}, onBeforeUnmount: (callback: () => void) => unmounts.push(callback) }
    if (id === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
    if (id === 'ant-design-vue') return { Button: {}, Popover: {}, message: { error: (text: string) => errors.push(text) }, theme: { useToken: () => ({ token }) } }
    if (id === './color') return color
    if (id === './session') return session
    if (id === '@/plugins/window') {
      return { setColorPickerOpen: async (value: boolean) => {
        orders.push(value)
        await holdOrder?.promise
      } }
    }
    if (id === '@/services/screenColor') {
      return {
        screenColorPicking: picking,
        createScreenColorAppearance,
        pickScreenColor: (id: string, _instruction: string, appearance?: ScreenColorAppearance) => {
          samples.push(id)
          appearances.push(appearance)
          return sample.promise
        },
        cancelScreenColorPick: async (id: string) => {
          cancellations.push(id)
        },
      }
    }
    if (id === '@/features/presets/editIntent') {
      return {
        markPresetUserEdit: () => marked++,
        onPresetSelectionChange: (callback: () => void) => {
          listeners.add(callback)
          return () => listeners.delete(callback)
        },
      }
    }
    if (id === '@/features/presets/operations') {
      return {
        presetOperationInProgress: operation,
        presetResetInProgress: reset,
        beginPresetNativeEdit: () => {
          pending++
          return () => pending--
        },
      }
    }
    throw new Error(`Unexpected import: ${id}`)
  }, module, module.exports, { removeEventListener: () => {} }, { removeEventListener: () => {} })
  return {
    orders,
    changes,
    errors,
    samples,
    appearances,
    token,
    cancellations,
    picking,
    sample,
    pending: () => pending,
    marked: () => marked,
    hold: () => {
      holdOrder = deferred<void>()
      return holdOrder
    },
    switchPreset: () => listeners.forEach(callback => callback()),
    mount: () => {
      unmounts = []
      const scope = Vue.effectScope()
      const props = Vue.reactive({ value: '#123456', label: 'Color', disabled: false })
      const picker = scope.run(() => module.exports.default.setup(props, { expose: () => {}, emit: (_event: string, value: string) => {
        changes.push(value)
        props.value = value
      } }))!
      const callbacks = unmounts
      return { picker, props, unmount: () => {
        callbacks.forEach(callback => callback())
        scope.stop()
      } }
    },
  }
}

describe('shared color picker component lifetime', () => {
  it('transfers ownership between options and ignores an older close or delayed open', async () => {
    const h = harness()
    const a = h.mount()
    const b = h.mount()
    try {
      const hold = h.hold()
      const first = a.picker.changeOpen(true)
      const second = b.picker.changeOpen(true)
      hold.resolve()
      await Promise.all([first, second])
      assert.equal(a.picker.open.value, false)
      assert.equal(b.picker.open.value, true)
      assert.deepEqual(h.orders, [true, false, true])
      a.unmount()
      assert.deepEqual(h.orders, [true, false, true])
      b.picker.close()
      assert.equal(h.orders.at(-1), false)
    } finally {
      a.unmount()
      b.unmount()
    }
  })

  it('does not open after disposal or let an old request finish a newer opening', async () => {
    const h = harness()
    const a = h.mount()
    const hold = h.hold()
    const first = a.picker.changeOpen(true)
    a.picker.close()
    const second = a.picker.changeOpen(true)
    a.unmount()
    hold.resolve()
    await Promise.all([first, second])
    assert.equal(a.picker.open.value, false)
    assert.equal(a.picker.opening.value, false)
    assert.deepEqual(h.orders, [true, false, true, false])
  })

  it('validates edits, preserves hue through black and makes keyboard changes without duplicate edits', async () => {
    const h = harness()
    const a = h.mount()
    try {
      await a.picker.changeOpen(true)
      for (const value of ['#123456', '#fff', 'red', '#12345678']) a.picker.applyColor(value)
      assert.equal(h.marked(), 0)
      a.picker.changeHsv({ h: 240, s: 100, v: 0 })
      await Vue.nextTick()
      a.picker.changeHsv({ v: 100 })
      await Vue.nextTick()
      assert.equal(a.props.value, '#0000FF')
      let prevented = false
      a.picker.moveKey({ key: 'ArrowDown', shiftKey: true, preventDefault: () => {
        prevented = true
      } } as KeyboardEvent)
      assert.equal(prevented, true)
      assert.equal(a.props.value, '#0000E6')
      a.props.disabled = true
      await Vue.nextTick()
      a.picker.applyColor('#FFFFFF')
      assert.equal(a.picker.open.value, false)
      assert.equal(a.props.value, '#0000E6')
    } finally {
      a.unmount()
    }
  })

  it('closes before sampling, preserves values on cancellation, and releases pending edits', async () => {
    for (const result of [null, '#ABCDEF']) {
      const h = harness()
      const a = h.mount()
      try {
        await a.picker.changeOpen(true)
        const selection = a.picker.pick()
        assert.equal(a.picker.open.value, false)
        assert.equal(h.pending(), 1)
        h.sample.resolve(result)
        await selection
        assert.equal(a.props.value, result ?? '#123456')
        assert.equal(h.orders.at(-1), false)
        assert.equal(h.pending(), 0)
        assert.equal(h.picking.value, false)
        assert.deepEqual(h.errors, [])
      } finally {
        a.unmount()
      }
    }
  })

  it('discards a screen result when the preset changes while window restoration is pending', async () => {
    const h = harness()
    const a = h.mount()
    try {
      const hold = h.hold()
      const selection = a.picker.pick()
      h.switchPreset()
      hold.resolve()
      h.sample.resolve('#ABCDEF')
      await selection
      assert.equal(h.cancellations.length, 1)
      assert.equal(a.props.value, '#123456')
      assert.equal(h.pending(), 0)
      assert.equal(h.marked(), 0)
    } finally {
      a.unmount()
    }
  })

  it('uses the current app theme when native sampling starts after window restoration', async () => {
    const h = harness()
    const a = h.mount()
    try {
      const hold = h.hold()
      const selection = a.picker.pick()
      assert.equal(h.appearances.length, 0)
      h.token.value = { colorBgElevated: '#19241B', colorBorder: '#35463A', colorTextSecondary: 'rgba(255, 255, 255, 0.65)' }
      hold.resolve()
      h.sample.resolve(null)
      await selection
      assert.deepEqual(h.appearances, [createScreenColorAppearance(h.token.value)])
      assert.equal(h.appearances[0]?.background, 0x1B2419)
      assert.equal(h.marked(), 0)
    } finally {
      a.unmount()
    }
  })
})
