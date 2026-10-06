/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

import * as dataBridge from '@/features/stateSafety/bridge'
import { shortcutIdentity } from '@/utils/shortcutIdentity'

interface ShortcutEvent {
  shortcut: string
  state: 'Pressed' | 'Released'
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

async function flush() {
  for (let index = 0; index < 15; index++) await vue.nextTick()
}

function harness(initial: string) {
  const shortcut = vue.ref(initial)
  const active = new Map<string, (event: ShortcutEvent) => void>()
  const pending = new Map<string, ReturnType<typeof deferred>>()
  const unmounts: Array<() => unknown> = []
  const calls: ShortcutEvent[] = []
  const otherCalls: ShortcutEvent[] = []
  const errors: unknown[] = []
  const scope = vue.effectScope()
  const exports = {} as {
    useKeyPress: (value: vue.Ref<string>, callback: (event: ShortcutEvent) => void) => void
    beginShortcutRecording: (cancel: () => void) => (value?: string) => void
  }
  const source = readFileSync(new URL('./useKeyPress.ts', import.meta.url), 'utf8')
  // These two recorder outputs resolve to the same native modifier bitmask/key.
  const nativeKey = (key: string) => key === 'Shift+Control+A' ? 'Control+Shift+A' : key
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    console: { error: (...args: unknown[]) => errors.push(args) },
    require: (name: string) => {
      if (name === '@/features/stateSafety/bridge') return dataBridge
      if (name === '@/utils/shortcutIdentity') return { shortcutIdentity }
      if (name === 'vue') return { ...vue, onUnmounted: (callback: () => unknown) => unmounts.push(callback) }
      if (name === '@tauri-apps/plugin-global-shortcut') {
        return {
          isRegistered: async (key: string) => active.has(nativeKey(key)),
          register: async (key: string, callback: (event: ShortcutEvent) => void) => {
            await pending.get(key)?.promise
            if (active.has(nativeKey(key))) throw new Error('Shortcut is already registered.')
            active.set(nativeKey(key), callback)
          },
          unregister: async (key: string) => {
            active.delete(nativeKey(key))
          },
        }
      }
      throw new Error(`Unexpected import: ${name}`)
    },
  })
  let mounted = false
  return {
    shortcut,
    active,
    errors,
    calls,
    record: exports.beginShortcutRecording,
    otherCalls,
    hold: (key: string) => {
      const held = deferred()
      pending.set(key, held)
      return held.resolve
    },
    mount: () => {
      mounted = true
      scope.run(() => exports.useKeyPress(shortcut, event => calls.push(event)))
    },
    mountAnother: (value: string) => {
      scope.run(() => exports.useKeyPress(vue.ref(value), event => otherCalls.push(event)))
    },
    unmount: () => {
      if (!mounted) return
      mounted = false
      scope.stop()
      unmounts.forEach(callback => callback())
    },
    fire: (key: string, state: ShortcutEvent['state'] = 'Pressed') => active.get(nativeKey(key))?.({ shortcut: key, state }),
  }
}

describe('global shortcut registration ownership', () => {
  it('clears recorded-key suppression on release during an editor lock and accepts the first unlocked press', async () => {
    const h = harness('Control+KeyA')
    let endRecording: ((value?: string) => void) | undefined
    try {
      h.mount()
      await flush()
      endRecording = h.record(() => {})
      h.fire('Control+KeyA')
      endRecording('Control+KeyA')
      assert.equal(h.calls.length, 0)
      dataBridge.editorsLocked.value = true
      h.fire('Control+KeyA', 'Released')
      h.fire('Control+KeyA')
      assert.equal(h.calls.length, 0)
      h.fire('Control+KeyA', 'Released')
      dataBridge.editorsLocked.value = false
      h.fire('Control+KeyA')
      assert.equal(h.calls.length, 1)
    } finally {
      dataBridge.editorsLocked.value = false
      endRecording?.()
      h.unmount()
      await flush()
    }
  })

  it('does not steal a live binding recorded with the same modifiers in another order', async () => {
    const h = harness('Control+Shift+A')
    try {
      h.mount()
      await flush()
      h.mountAnother('Shift+Control+A')
      await flush()
      h.fire('Control+Shift+A')
      assert.equal(h.calls.length, 1)
      assert.equal(h.otherCalls.length, 0)
      assert.equal(h.active.size, 1)
      h.shortcut.value = ''
      await flush()
      assert.equal(h.active.size, 0)
    } finally {
      h.unmount()
      await flush()
    }
  })

  it('rebinds a shortcut retained by the native process after a development webview reload', async () => {
    const h = harness('Control+KeyA')
    let retiredCalls = 0
    h.active.set('Control+KeyA', () => retiredCalls++)
    try {
      h.mount()
      await flush()
      h.fire('Control+KeyA')
      assert.equal(h.calls.length, 1)
      assert.equal(retiredCalls, 0)
      assert.equal(h.errors.length, 0)
    } finally {
      h.unmount()
      await flush()
    }
  })

  it('restores a saved binding, invokes only presses, and clears the binding after an edit', async () => {
    const h = harness('Control+KeyA')
    try {
      h.mount()
      await flush()
      h.fire('Control+KeyA')
      h.fire('Control+KeyA', 'Released')
      assert.equal(h.calls.length, 1)
      h.shortcut.value = ''
      await flush()
      assert.equal(h.active.size, 0)
    } finally {
      h.unmount()
      await flush()
    }
  })

  it('does not leave an earlier binding active when a new shortcut is selected during registration', async () => {
    const h = harness('Control+KeyA')
    const release = h.hold('Control+KeyA')
    try {
      h.mount()
      await flush()
      h.shortcut.value = 'Control+KeyB'
      await flush()
      release()
      await flush()
      assert.deepEqual([...h.active.keys()], ['Control+KeyB'])
      h.fire('Control+KeyA')
      h.fire('Control+KeyB')
      assert.equal(h.calls.length, 1)
      assert.equal(h.calls[0].shortcut, 'Control+KeyB')
    } finally {
      release()
      h.unmount()
      await flush()
    }
  })

  it('releases a native registration that completes after its owner unmounts', async () => {
    const h = harness('Control+KeyA')
    const release = h.hold('Control+KeyA')
    h.mount()
    await flush()
    h.unmount()
    await flush()
    release()
    await flush()
    h.fire('Control+KeyA')
    assert.equal(h.active.size, 0)
    assert.equal(h.calls.length, 0)
  })
})
