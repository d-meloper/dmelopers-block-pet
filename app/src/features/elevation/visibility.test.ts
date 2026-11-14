/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'

import { createPreferenceUpdateRecovery } from '@/composables/preferenceUpdateRecovery'
import { createPreferenceUpdateVisibility } from '@/composables/preferenceUpdateVisibility'
import { createPreferenceElevation } from '@/features/elevation/preferenceElevation'

import type { ElevatedRestartPreparation, ElevationStatus } from './types'

import { createPreferencePromptPriority } from './preferencePrompts'

function load<T>(relative: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const exports = {} as T
  const source = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(source, { exports, require: (name: string) => mocks[name], ...globals })
  return exports
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function harness() {
  const calls: string[] = []
  const mounts: (() => Promise<void>)[] = []
  const disposals: (() => void)[] = []
  let receive = (_visible: boolean) => {}
  let subscriptions = 0
  let releases = 0
  let failListen = false
  let read = async () => false
  let check = async () => ({ available: false, currentVersion: '1.0.0' })
  let prepare = async (): Promise<ElevatedRestartPreparation> => ({ outcome: 'cancelled' })
  let save = async () => {}
  let status = async (): Promise<ElevationStatus> => ({ supported: true, elevated: false })
  const focusCallbacks = new Set<() => void>()
  let inputStatusChanged = () => {}
  const general = Vue.reactive({ app: { alwaysRunAsAdministrator: false, administratorReminderDismissed: false, taskbarVisible: true } })
  const vue = {
    ...Vue,
    onMounted: (callback: () => Promise<void>) => mounts.push(callback),
    onBeforeUnmount: (callback: () => void) => disposals.push(callback),
    provide: () => {},
  }
  const elevation = load<typeof import('@/composables/usePreferenceElevation')>('../../composables/usePreferenceElevation.ts', {
    'vue': vue,
    '@tauri-apps/api/event': { listen: async (_event: string, receive: () => void) => {
      inputStatusChanged = receive
      return () => {
        inputStatusChanged = () => {}
      }
    } },
    '@/features/elevation/preferenceElevation': { createPreferenceElevation },
    '@/stores/general': { useGeneralStore: () => general },
    '@/plugins/process': { saveAppSettings: () => save(), restartAppAsAdministrator: async () => {
      calls.push('restart')
    } },
    '@/services/diagnostics': { reportDiagnostic: () => {} },
    '@/services/elevation': {
      disableElevatedInput: async () => {
        calls.push('disable')
        return status()
      },
      getElevationStatus: async () => {
        calls.push('status')
        return status()
      },
      prepareElevatedRestart: async () => {
        calls.push('prepare')
        return prepare()
      },
      cancelElevatedRestart: async () => {
        calls.push('cancel')
      },
    },
  }, { window: {
    addEventListener: (_event: string, callback: () => void) => focusCallbacks.add(callback),
    removeEventListener: (_event: string, callback: () => void) => focusCallbacks.delete(callback),
  } }).usePreferenceElevation()
  const updates = load<typeof import('@/composables/usePreferenceUpdates')>('../../composables/usePreferenceUpdates.ts', {
    'vue': vue,
    'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
    'ant-design-vue': { message: { error: () => {} } },
    '@tauri-apps/api/event': { listen: async (_name: string, accept: (event: { payload: boolean }) => void) => {
      subscriptions++
      if (failListen) throw new Error('listener unavailable')
      receive = visible => accept({ payload: visible })
      return () => {
        releases++
      }
    } },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({ isVisible: () => read() }) },
    '@/services/diagnostics': { reportDiagnostic: () => {} },
    '@/services/distribution': { getDistributionInfo: async () => ({ channel: 'github' }) },
    '@/services/inAppUpdates': {
      checkAppUpdate: async () => {
        calls.push('update')
        return check()
      },
      installAppUpdate: async () => {},
      cancelAppUpdate: async () => {},
    },
    '@/stores/general': { useGeneralStore: () => ({ app: { updateReminderSnooze: { version: '', hiddenUntil: 0 } } }) },
    './preferenceUpdateRecovery': { createPreferenceUpdateRecovery },
    './preferenceUpdateVisibility': { createPreferenceUpdateVisibility },
  }).providePreferenceUpdates(elevation.setVisible)
  const prompts = createPreferencePromptPriority({
    broadcastOpen: Vue.ref(false),
    broadcastActive: Vue.ref(false),
    updateVersion: updates.reminderVersion,
    updateBusy: updates.busy,
    updateHandoff: updates.handoffUnconfirmed,
    adminOpen: elevation.open,
    blockAdmin: elevation.setBlocked,
  })
  return {
    calls,
    general,
    status: (read: typeof status) => {
      status = read
    },
    save: (write: typeof save) => {
      save = write
    },
    updates,
    elevation,
    inputStatus: () => inputStatusChanged(),
    focus: () => focusCallbacks.forEach(callback => callback()),
    prompts,
    mount: () => Promise.all(mounts.map(callback => callback())),
    emit: (visible: boolean) => receive(visible),
    subscriptions: () => subscriptions,
    releases: () => releases,
    read: (value: typeof read) => {
      read = value
    },
    check: (value: typeof check) => {
      check = value
    },
    prepare: (value: typeof prepare) => {
      prepare = value
    },
    failListen: (value: boolean) => {
      failListen = value
    },
    dispose: () => {
      disposals.forEach(dispose => dispose())
      prompts.dispose()
    },
  }
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}

test('one accepted visibility stream drives both features, with no hidden-startup status check', async () => {
  const h = harness()
  assert.deepEqual(h.calls, [])
  await h.mount()
  assert.equal(h.subscriptions(), 1)
  assert.deepEqual(h.calls, [])
  const discovery = deferred<{ available: boolean, currentVersion: string }>()
  h.check(() => discovery.promise)
  h.emit(true)
  await settle()
  assert.deepEqual(h.calls.slice().sort(), ['status', 'update'])
  assert.equal(h.elevation.open.value, false)
  discovery.resolve({ available: false, currentVersion: '1.0.0' })
  await settle()
  assert.equal(h.elevation.open.value, true)
  h.emit(true)
  await settle()
  assert.equal(h.calls.filter(call => call === 'status').length, 1)
  h.emit(false)
  assert.equal(h.elevation.open.value, false)
  h.prompts.finishAdmin()
  h.emit(true)
  await settle()
  assert.equal(h.calls.filter(call => call === 'status').length, 2)
  assert.equal(h.subscriptions(), 1)
  h.dispose()
  h.emit(true)
  assert.equal(h.elevation.open.value, false)
  assert.equal(h.releases(), 1)
})

test('a newer pushed hide retires the initial visibility read for both observers', async () => {
  const h = harness()
  const reading = deferred<boolean>()
  h.read(() => reading.promise)
  const mounting = h.mount()
  await settle()
  h.emit(false)
  reading.resolve(true)
  await mounting
  assert.deepEqual(h.calls, [])
  assert.equal(h.elevation.open.value, false)
  h.dispose()
})

test('a failed visibility listener cannot offer elevation from the update fallback read', async () => {
  const h = harness()
  h.read(async () => true)
  h.failListen(true)
  await h.mount()
  assert.equal(h.subscriptions(), 1)
  assert.deepEqual(h.calls, ['update'])
  assert.equal(h.elevation.open.value, false)
  h.failListen(false)
  await h.updates.check(false)
  assert.equal(h.subscriptions(), 2)
  assert.equal(h.calls.filter(call => call === 'status').length, 1)
  assert.equal(h.elevation.open.value, true)
  h.dispose()
})

test('visibility read failure retires a pending UAC reply and never commits a late ready child', async () => {
  const h = harness()
  await h.mount()
  h.emit(true)
  await settle()
  const preparation = deferred<ElevatedRestartPreparation>()
  h.prepare(() => preparation.promise)
  const action = h.elevation.enable()
  h.read(async () => {
    throw new Error('unknown visibility')
  })
  await h.updates.check(false)
  assert.equal(h.elevation.open.value, false)
  preparation.resolve({ outcome: 'ready', ticket: 'a'.repeat(64) })
  await action
  assert.equal(h.calls.filter(call => call === 'cancel').length, 1)
  assert.equal(h.calls.includes('restart'), false)
  assert.equal(h.elevation.status.value, undefined)
  h.dispose()
})
test('after consent, failed preference persistence reconciles only the saved field and never activates input', async () => {
  const h = harness()
  await h.mount()
  h.emit(true)
  await settle()
  h.elevation.continueNormally()
  h.save(async () => {
    throw new Error('save unavailable')
  })
  h.prepare(async () => ({ outcome: 'ready', ticket: 'a'.repeat(64) }))
  h.status(async () => ({ supported: true, elevated: false, alwaysRunAsAdministrator: false, administratorReminderDismissed: false }))
  await h.elevation.requestEnable()
  await h.elevation.enable()
  assert.equal(h.general.app.alwaysRunAsAdministrator, false)
  assert.equal(h.general.app.taskbarVisible, true)
  assert.equal(h.calls.includes('prepare'), true)
  assert.equal(h.calls.includes('restart'), false)
  assert.equal(h.elevation.feedback.value, 'saveFailed')
  assert.equal(h.elevation.canManage.value, true)
  h.dispose()
})

test('consent, verified preference persistence and immediate activation preserve both window stores', async () => {
  const h = harness()
  await h.mount()
  h.emit(true)
  await settle()
  h.elevation.continueNormally()
  h.prepare(async () => ({ outcome: 'ready', ticket: 'a'.repeat(64) }))
  h.status(async () => ({
    supported: true,
    elevated: false,
    inputElevated: h.calls.includes('restart'),
    alwaysRunAsAdministrator: h.general.app.alwaysRunAsAdministrator,
    administratorReminderDismissed: h.general.app.administratorReminderDismissed,
  }))
  h.elevation.requestEnable()
  await h.elevation.enable()
  assert.equal(h.general.app.alwaysRunAsAdministrator, true)
  assert.equal(h.general.app.taskbarVisible, true)
  assert.equal(h.elevation.isActive.value, true)
  assert.equal(h.elevation.feedback.value, undefined)
  assert.equal(h.calls.filter(x => x === 'prepare').length, 1)
  assert.equal(h.calls.filter(x => x === 'restart').length, 1)
  h.dispose()
})

test('an unreadable bootstrap preference cannot be reported as a successful save or activate input', async () => {
  const h = harness()
  await h.mount()
  h.emit(true)
  await settle()
  h.elevation.continueNormally()
  h.prepare(async () => ({ outcome: 'ready', ticket: 'a'.repeat(64) }))
  h.status(async () => ({ supported: true, elevated: false, alwaysRunAsAdministrator: null }))
  await h.elevation.requestEnable()
  await h.elevation.enable()
  assert.equal(h.general.app.alwaysRunAsAdministrator, false)
  assert.equal(h.elevation.feedback.value, 'saveFailed')
  assert.equal(h.calls.includes('prepare'), true)
  h.dispose()
})

test('a failed checkbox save restores the saved field, keeps the dialog open and supports retry', async () => {
  const h = harness()
  await h.mount()
  h.emit(true)
  await settle()
  h.save(async () => {
    throw new Error('save unavailable')
  })
  h.status(async () => ({ supported: true, elevated: false, administratorReminderDismissed: false }))
  await h.elevation.setReminderDismissed(true)
  assert.equal(h.general.app.administratorReminderDismissed, false)
  assert.equal(h.general.app.alwaysRunAsAdministrator, false)
  assert.equal(h.general.app.taskbarVisible, true)
  assert.equal(h.elevation.open.value, true)
  assert.equal(h.elevation.feedback.value, 'saveFailed')
  h.save(async () => {})
  h.status(async () => ({ supported: true, elevated: false, administratorReminderDismissed: h.general.app.administratorReminderDismissed }))
  await h.elevation.setReminderDismissed(true)
  assert.equal(h.general.app.administratorReminderDismissed, true)
  assert.equal(h.elevation.open.value, true)
  assert.equal(h.elevation.feedback.value, undefined)
  assert.equal(h.calls.includes('prepare'), false)
  assert.equal(h.calls.includes('restart'), false)
  h.dispose()
})
test('worker liveness changes refresh the actual token separately without reopening consent or writing data', async () => {
  const h = harness()
  h.status(async () => ({ supported: true, elevated: false, inputElevated: true }))
  await h.mount()
  h.emit(true)
  await settle()
  assert.equal(h.elevation.status.value?.elevated, false)
  assert.equal(h.elevation.status.value?.inputElevated, true)
  assert.equal(h.elevation.open.value, false)
  h.status(async () => ({ supported: true, elevated: false, inputElevated: false }))
  h.inputStatus()
  await settle()
  assert.equal(h.elevation.status.value?.inputElevated, false)
  assert.equal(h.elevation.open.value, false)
  assert.equal(h.calls.includes('prepare'), false)
  assert.equal(h.calls.includes('restart'), false)
  h.dispose()
  const reads = h.calls.length
  h.inputStatus()
  h.focus()
  await settle()
  assert.equal(h.calls.length, reads)
})
