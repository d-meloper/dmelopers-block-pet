/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import * as diagnosticsCore from './diagnosticsCore'
import { consoleOperation, createDiagnostic, createDiagnosticReporter, diagnosticCode, diagnosticLocation } from './diagnosticsCore'

describe('failure diagnostics', () => {
  it('preserves actionable codes and app coordinates without serializing user content', () => {
    const cause = Object.assign(new Error('Cannot read C:\\Users\\private-user\\skin.png?token=secret'), {
      code: 'INVALID_PNG',
      pngBase64: 'private image',
      nickname: 'private nickname',
      stack: 'Error: private\n at apply (http://localhost:1420/src/pages/main/index.vue?t=secret:44:8)',
    })
    const result = createDiagnostic('error', 'skin.apply', cause, 'main')
    assert.deepEqual(result, { level: 'error', message: {
      operation: 'skin.apply',
      code: 'INVALID_PNG',
      source: 'main',
      location: 'src/pages/main/index.vue:44:8',
    } })
    assert.doesNotMatch(JSON.stringify(result), /private|secret|localhost/)
    assert.equal(diagnosticCode({ code: 'recovery' }), 'recovery')
    assert.equal(diagnosticCode('window.destroy not allowed. User secret'), 'permission_denied.window.destroy')
    assert.equal(diagnosticCode('Command plugin:window|destroy not allowed by ACL'), 'permission_denied.window.destroy')
    assert.equal(diagnosticCode('Command plugin:window|private_user not allowed by ACL'), 'permission_denied')
    assert.equal(diagnosticCode(new Error('QUIESCE_FAILED')), 'QUIESCE_FAILED')
    assert.equal(diagnosticCode(new Error('QUIESCE_TIMEOUT')), 'QUIESCE_TIMEOUT')
    assert.equal(diagnosticCode(new Error('C:\\Users\\QUIESCE_FAILED\\private.bin')), 'unclassified_failure')
    assert.equal(diagnosticCode(new TypeError('private field')), 'TypeError')
    assert.equal(diagnosticCode(new Error('Cannot read C:\\Users\\SKIN_PRIVATE_USER_TOKEN\\skin.png')), 'unclassified_failure')
    assert.equal(diagnosticCode('Settings synchronization was not acknowledged.'), 'settings_acknowledgement_timeout')
  })

  it('retains exact deployed update, startup and save failure codes without accepting payload-shaped variants', () => {
    for (const code of [
      'UPDATE_SIGNATURE_INVALID',
      'UPDATE_HASH_INVALID',
      'UPDATE_NETWORK_FAILED',
      'UPDATE_INSTALL_FAILED',
      'AUTOSTART_OWNERSHIP_CONFLICT',
      'AUTOSTART_WRITE_FAILED',
      'SAVE_VERIFICATION_FAILED',
      'INVALID_CURRENT_STATE',
    ]) {
      assert.equal(diagnosticCode(code), code)
      assert.equal(diagnosticCode(new Error(code)), code)
      assert.equal(diagnosticCode({ code, message: 'private settings' }), code)
      assert.notEqual(diagnosticCode(`${code}: private settings`), code)
      assert.notEqual(diagnosticCode(`C:\\Users\\${code}\\private.bin`), code)
    }
    assert.equal(diagnosticCode('UPDATE_PRIVATE_USER_TOKEN'), 'unclassified_failure')
    assert.equal(diagnosticCode({ code: 'AUTOSTART_PRIVATE_USER_TOKEN' }), 'unclassified_failure')
  })

  it('accepts only known console operation text and safe application locations', () => {
    assert.equal(consoleOperation('warn', 'Failed to synchronize the broadcast scene.'), 'broadcast.synchronize')
    assert.equal(consoleOperation('warn', 'User private-name has private-data'), 'console.warn')
    assert.equal(diagnosticLocation({ stack: 'Error\n at C:\\Users\\private\\script.js:1:2' }), undefined)
    assert.equal(diagnosticLocation({ stack: 'Error\n at http://127.0.0.1/private-token/broadcast.js:1:2' }), undefined)
    assert.equal(diagnosticLocation({ stack: 'Error\n at http://tauri.localhost/assets/index-ABC.js:1:2' }), 'assets/index-ABC.js:1:2')
    assert.equal(createDiagnostic('error', 'http://private', {}, 'secret').message.operation, 'application.failure')
    const cyclic: { error?: unknown } = {}
    cyclic.error = { error: cyclic }
    assert.equal(diagnosticCode(cyclic), 'unclassified_failure')
    assert.equal(diagnosticCode({ get message() {
      throw new Error('private')
    } }), 'unreadable_error')
  })

  it('sends no normal activity and bounds repeated/flooded IPC without timer logs', async () => {
    let now = 0
    const sent: unknown[] = []
    const report = createDiagnosticReporter(async (level, message) => {
      sent.push({ level, message })
    }, () => now)
    assert.deepEqual(sent, [])
    for (let i = 0; i < 10000; i++) report('warn', { operation: 'viewport.measurement', code: 'timeout', source: 'main' })
    assert.equal(sent.length, 1)
    now = 5000
    report('warn', { operation: 'viewport.measurement', code: 'timeout', source: 'main' })
    assert.equal(sent.length, 2)
    for (let i = 0; i < 1000; i++) report('error', { operation: `feature.failure_${i}`, code: 'timeout', source: 'main' })
    assert.equal(sent.length, 62)
    now = 61000
    report('error', { operation: 'application.bootstrap', code: 'timeout', source: 'main' })
    assert.equal(sent.length, 63)
    const broken = createDiagnosticReporter(() => Promise.reject(new Error('disk unavailable')))
    assert.doesNotThrow(() => broken('error', { operation: 'application.bootstrap', code: 'timeout', source: 'main' }))
    await new Promise(resolve => setImmediate(resolve))
  })

  it('routes console and global failures from Preferences through existing log IPC only', async () => {
    const calls: { command: string, args: { level: number, message: string } }[] = []
    const handlers = new Map<string, (event: { error?: unknown, message?: string, reason?: unknown }) => void>()
    const logger = { warn() {}, error() {}, info() {}, log() {}, debug() {} }
    const exports: { installDiagnostics?: () => void, reportDiagnostic?: typeof import('./diagnostics').reportDiagnostic } = {}
    const source = ts.transpileModule(readFileSync(new URL('./diagnostics.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    runInNewContext(source, {
      exports,
      console: logger,
      Error,
      window: { addEventListener: (name: string, handler: typeof handlers extends Map<string, infer T> ? T : never) => handlers.set(name, handler) },
      location: { hash: '#/preference?tab=performance' },
      require: (id: string) => {
        if (id === './diagnosticsCore') return diagnosticsCore
        if (id === '@tauri-apps/api/core') {
          return { invoke: async (command: string, args: { level: number, message: string }) => {
            calls.push({ command, args })
          } }
        }
        throw new Error(`Unexpected module ${id}`)
      },
    })
    exports.installDiagnostics!()
    exports.installDiagnostics!()
    logger.info()
    logger.log()
    logger.debug()
    assert.equal(calls.length, 0)
    const warn = logger.warn as (...args: unknown[]) => void
    warn('Failed to load the fixed 3D pet model.', Object.assign(new Error('private skin'), { code: 'INVALID_PNG' }))
    const error = logger.error as (...args: unknown[]) => void
    error('Failed to apply visible-content fallback bounds.', new TypeError('private scene'))
    handlers.get('error')!({ error: new RangeError('private input') })
    handlers.get('unhandledrejection')!({ reason: new Error('window.hide not allowed. private user') })
    exports.reportDiagnostic!('warn', 'updates.check', 'UPDATE_SIGNATURE_INVALID')
    exports.reportDiagnostic!('error', 'autostart.apply', { code: 'AUTOSTART_WRITE_FAILED', message: 'private registry path' })
    error('The pet renderer failed unexpectedly.', new Error('private model'))
    warn('The scene viewport acknowledgement timed out.')
    await Promise.resolve()
    assert.equal(calls.length, 8)
    assert.deepEqual(calls.map(call => call.args.level), [4, 5, 5, 5, 4, 5, 5, 4])
    const records = calls.map(call => JSON.parse(call.args.message))
    assert.deepEqual(records.map(record => record.operation), ['renderer.model_load', 'viewport.fallback', 'application.uncaught', 'application.unhandled_rejection', 'updates.check', 'autostart.apply', 'renderer.runtime_failure', 'viewport.acknowledgement_timeout'])
    assert.equal(records[4].code, 'UPDATE_SIGNATURE_INVALID')
    assert.equal(records[5].code, 'AUTOSTART_WRITE_FAILED')
    assert.ok(records.every(record => record.source === 'preference'))
    assert.ok(calls.every(call => call.command === 'plugin:log|log' && Object.keys(call.args).length === 2))
    assert.doesNotMatch(JSON.stringify(calls), /private/)
  })
})
