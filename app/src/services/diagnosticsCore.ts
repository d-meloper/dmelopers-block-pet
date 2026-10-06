export type DiagnosticLevel = 'warn' | 'error'

export interface Diagnostic {
  operation: string
  code: string
  source: string
  location?: string
}

const ERROR_NAMES = new Set(['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'SecurityError', 'NotAllowedError', 'NotSupportedError', 'QuotaExceededError', 'InvalidStateError', 'NetworkError', 'TimeoutError', 'AbortError', 'PresetApplyUncertainError'])
const WINDOW_COMMANDS = ['destroy', 'hide', 'show', 'close', 'center', 'set_focus', 'set_size', 'set_position', 'set_theme', 'set_title', 'set_always_on_top', 'set_ignore_cursor_events', 'set_decorations', 'set_skip_taskbar', 'start_dragging', 'internal_toggle_maximize', 'is_visible', 'is_minimized', 'unminimize']

// Exact emitted codes only: a path/username can itself look like an error namespace.
const KNOWN_CODES = new Set([
  'LOG_DIRECTORY_FORBIDDEN',
  'LOG_DIRECTORY_UNAVAILABLE',
  'LOG_DIRECTORY_CREATE_FAILED',
  'AUTOSTART_APPROVAL_UNKNOWN',
  'AUTOSTART_BUSY',
  'AUTOSTART_IMAGE_PATH_TOO_LONG',
  'AUTOSTART_IMAGE_UNAVAILABLE',
  'AUTOSTART_OWNERSHIP_CONFLICT',
  'AUTOSTART_REGISTRATION_UNKNOWN',
  'AUTOSTART_STATE_UNKNOWN',
  'AUTOSTART_UNAVAILABLE',
  'AUTOSTART_WRITE_FAILED',
  'UPDATE_BUSY',
  'UPDATE_CACHE_UNAVAILABLE',
  'UPDATE_CANCELLED',
  'UPDATE_CHANGED',
  'UPDATE_CHECK_EXPIRED',
  'UPDATE_CHECK_FAILED',
  'UPDATE_CHECK_REQUIRED',
  'UPDATE_CONFIG_INVALID',
  'UPDATE_DOWNLOAD_REQUIRED',
  'UPDATE_HASH_INVALID',
  'UPDATE_IDENTITY_INVALID',
  'UPDATE_INSTALLED_APP_REQUIRED',
  'UPDATE_INSTALL_FAILED',
  'UPDATE_INSTALL_LOCATION_INVALID',
  'UPDATE_METADATA_INVALID',
  'UPDATE_NETWORK_FAILED',
  'UPDATE_PHASE_INVALID',
  'UPDATE_REQUEST_INVALID',
  'UPDATE_SIGNATURE_INVALID',
  'UPDATE_SIZE_INVALID',
  'UPDATE_TOO_LATE',
  'UPDATE_VERIFY_FAILED',
  'UPDATE_VERSION_INVALID',
  'UPDATE_WINDOW_INVALID',
  'DUPLICATE_PARTICIPANT',
  'INVALID_CURRENT_STATE',
  'INVALID_DATA',
  'INVALID_PARTICIPANT',
  'INVALID_WINDOW',
  'MISSING_CURRENT_STATE',
  'OPERATION_BUSY',
  'OPERATION_LOCKED',
  'QUIESCE_CANCELLED',
  'QUIESCE_STATE_CHANGED',
  'SAVE_VERIFICATION_FAILED',
  'STORES_NOT_READY',
  'UNSAFE_STORAGE_PATH',
  'UNSUPPORTED_STORAGE_LOCATION',
  'STORAGE_UNAVAILABLE',
  'INVALID_REQUEST',
  'INVALID_PNG',
  'INVALID_DIMENSIONS',
  'TOO_LARGE',
  'CATALOG_CORRUPT',
  'ENTRY_NOT_FOUND',
  'ENTRY_ALREADY_EXISTS',
  'IO_ERROR',
  'INVALID_RESPONSE',
  'INVALID_USERNAME',
  'PROFILE_NOT_FOUND',
  'NO_SKIN',
  'RATE_LIMITED',
  'TIMEOUT',
  'NETWORK',
  'UPSTREAM',
  'SERVICE_BLOCKED',
  'UNTRUSTED_TEXTURE_URL',
  'HASH_MISMATCH',
  'invalidSettings',
  'invalidFormat',
  'unsupportedVersion',
  'invalidSkin',
  'tooLarge',
  'invalidNickname',
  'recovery',
  'save',
  'export',
  'import',
  'library',
  'network',
  'timeout',
  'read',
  'PROCESS_BUSY',
  'PROCESS_CANCELLED',
  'PROCESS_FAILED',
  'PROCESS_TIMEOUT',
  'QUIESCE_FAILED',
  'QUIESCE_TIMEOUT',
  'STATE_UNKNOWN',
  'VIEWPORT_INTERACTION_CHANGED',
  'NATIVE_DRAG_FAILED',
  'NATIVE_OPERATION_FAILED',
  'PRESET_INVALID',
  'PROCESS_UNAVAILABLE',
  'QUIESCENCE_ACTIVE',
  'STARTUP_UNAVAILABLE',
  'STATE_CHANGED',
  'STATE_MISMATCH',
  'WINDOW_ACTIVATE_FAILED',
  'WINDOW_CREATE_FAILED',
  'WINDOW_HANDLE_UNAVAILABLE',
  'WINDOW_NOT_READY',
  'WINDOW_SETUP_FAILED',
  'WINDOW_UNAVAILABLE',
  'WINDOW_WAKE_FAILED',
])

export function diagnosticCode(error: unknown, depth = 0): string {
  try {
    const value = error && typeof error === 'object' ? error as { code?: unknown, name?: unknown, message?: unknown, error?: unknown } : undefined
    // Nested errors in existing renderer console calls are the only object payload read.
    if (depth < 3 && value?.error !== undefined && value.error !== error) return diagnosticCode(value.error, depth + 1)
    const message = typeof error === 'string' ? error : typeof value?.message === 'string' ? value.message : ''
    const code = typeof value?.code === 'string' ? value.code : message
    if (KNOWN_CODES.has(code)) return code
    if (/not allowed|explicitly denied|forbidden|permission denied|access is denied/i.test(message)) {
      const command = WINDOW_COMMANDS.find(command =>
        message.includes(`window.${command} not allowed`)
        || message.includes(`window.${command} explicitly denied`)
        || message.includes(`plugin:window|${command} not allowed`)
        || message.includes(`plugin:window|${command} explicitly denied`),
      )
      return command ? `permission_denied.window.${command}` : 'permission_denied'
    }
    if (/timed?\s*out|deadline/i.test(message)) return 'timeout'
    if (/synchronization was not acknowledged/i.test(message)) return 'settings_acknowledgement_timeout'
    if (/disk.*full|no space|quota/i.test(message)) return 'storage_full'
    if (/not found|does not exist|missing file/i.test(message)) return 'not_found'
    if (/failed to fetch|network|connection|websocket|fetch failed/i.test(message)) return 'network_failure'
    if (/webgl|context lost|shader|gpu/i.test(message)) return 'graphics_failure'
    if (/json|unexpected token|parse|malformed/i.test(message)) return 'invalid_data'
    if (typeof value?.name === 'string' && ERROR_NAMES.has(value.name)) return value.name
    return 'unclassified_failure'
  } catch {
    return 'unreadable_error'
  }
}

const CONSOLE_OPERATIONS = new Map<string, string>([
  ['IPC custom protocol failed, Tauri will now use the postMessage interface instead', 'ipc.protocol_fallback'],
  ['The scene viewport acknowledgement timed out.', 'viewport.acknowledgement_timeout'],
  ['Failed to send the scene viewport request.', 'viewport.request'],
  ['Failed to show the broadcast visibility prompt.', 'tray.broadcast_prompt'],
  ['Failed to apply the requested main viewport clamp.', 'viewport.clamp'],
  ['The pet renderer failed unexpectedly.', 'renderer.runtime_failure'],
  ['Failed to recover the pet renderer.', 'renderer.recover'],
  ['Failed to report pet recovery.', 'renderer.recovery_report'],
  ['Failed to acknowledge pet recovery.', 'renderer.recovery_acknowledge'],
  ['Failed to publish pet recovery.', 'renderer.recovery_publish'],
  ['Failed to resume pet recovery.', 'renderer.recovery_resume'],
  ['Failed to show the pet window.', 'window.pet_show'],
  ['Failed to hide the pet window.', 'window.pet_hide'],
  ['The visible-content fallback could not be applied; keeping the current native viewport.', 'viewport.fallback_preserve'],
  ['Failed to schedule content bounds.', 'viewport.schedule_bounds'],
  ['Failed to read the scene viewport acknowledgement state.', 'viewport.acknowledgement_read'],
  ['Failed to synchronize the resolved skin model.', 'skin.model_synchronize'],
  ['Failed to activate pet window memory management.', 'window.memory_activate'],
  ['Failed to apply the native mouse setting.', 'input.native_mouse'],
  ['Failed to acknowledge the antialiasing setting.', 'renderer.antialias_acknowledge'],
  ['Failed to load the fixed 3D pet model.', 'renderer.model_load'],
  ['Failed to render the visible-content measurement.', 'viewport.measurement_render'],
  ['Failed to restore the renderer after content measurement.', 'viewport.measurement_restore'],
  ['Failed to read the visible-content measurement.', 'viewport.measurement_read'],
  ['The active pet WebGL context was lost.', 'renderer.context_lost'],
  ['The pet renderer shader could not compile.', 'renderer.shader_compile'],
  ['Failed to decode the selected pet skin.', 'renderer.skin_decode'],
  ['Failed to read the selected pet skin.', 'renderer.skin_read'],
  ['Pet animation is disabled because required nodes are missing.', 'renderer.rig_nodes'],
  ['Pet animation is disabled because the mouse hand anchor is missing.', 'renderer.hand_anchor'],
  ['Dmeloper eyebrows are disabled because the generated eyebrow contract is missing.', 'renderer.eyebrow_contract'],
  ['Failed to dispose the replaced WebGL renderer.', 'renderer.dispose'],
  ['Failed to release the replaced WebGL context.', 'renderer.context_release'],
  ['Failed to initialize the fixed 3D pet renderer.', 'renderer.initialize'],
  ['Failed to update the fixed pet runtime.', 'renderer.update'],
  ['Failed to apply the fixed pet selection.', 'renderer.selection'],
  ['Failed to change antialiasing.', 'renderer.antialias'],
  ['Failed to show the requested window.', 'window.show'],
  ['Failed to apply a menu viewport setting.', 'viewport.menu_setting'],
  ['Failed to apply visible-content fallback bounds.', 'viewport.fallback'],
  ['Visible-content measurement failed unexpectedly.', 'viewport.measurement'],
  ['Failed to apply the delayed error viewport.', 'viewport.error_fallback'],
  ['Failed to publish the actual scene viewport.', 'viewport.publish'],
  ['Failed to change the scene viewport mode.', 'viewport.mode'],
  ['Failed to acknowledge the scene viewport.', 'viewport.acknowledge'],
  ['Failed to prepare the renderer error viewport.', 'viewport.error_prepare'],
  ['Failed to reset the main viewport geometry.', 'viewport.reset'],
  ['Failed to start dragging the pet window.', 'window.drag'],
  ['Failed to apply the preset; restoring the previous scene.', 'presets.apply'],
  ['The previous preset requires a retry.', 'presets.restore'],
  ['Failed to acknowledge the preset.', 'presets.acknowledge'],
  ['The preset application acknowledgement timed out.', 'presets.acknowledgement_timeout'],
  ['The preset application request could not be delivered.', 'presets.request'],
  ['The preset application acknowledgement was invalid.', 'presets.invalid_acknowledgement'],
  ['The bundled preset skin identity could not be verified.', 'presets.skin_identity'],
  ['Failed to suspend mouse input.', 'input.suspend'],
  ['Failed to resume mouse input.', 'input.resume'],
  ['Failed to subscribe to global input.', 'input.subscribe'],
  ['Failed to stop global input.', 'input.stop'],
  ['Failed to start global input.', 'input.start'],
  ['Failed to acknowledge the mouse setting.', 'input.mouse_acknowledge'],
  ['Failed to subscribe to mouse settings.', 'input.mouse_subscribe'],
  ['Failed to apply hover click-through.', 'window.hover_click_through'],
  ['Failed to resolve the pointer monitor.', 'window.pointer_monitor'],
  ['Failed to synchronize a global shortcut.', 'shortcuts.synchronize'],
  ['Failed to apply the preference theme.', 'theme.apply'],
  ['Failed to observe the system theme.', 'theme.observe'],
  ['Failed to focus the pet from the tray.', 'tray.focus'],
  ['Failed to update the tray menu.', 'tray.update'],
  ['Failed to notify a main viewport listener.', 'viewport.notify'],
  ['The main viewport scale factor did not stabilize.', 'viewport.scale_unstable'],
  ['Failed to subscribe to native window geometry.', 'window.geometry_subscribe'],
  ['Failed to read the current native window position.', 'window.position_read'],
  ['Failed to read the current native window size.', 'window.size_read'],
  ['Failed to restore the initial main viewport.', 'viewport.restore'],
  ['The scene viewport acknowledgement was rejected.', 'viewport.rejected'],
  ['Failed to subscribe to scene viewport state.', 'viewport.subscribe'],
  ['Failed to synchronize the broadcast scene.', 'broadcast.synchronize'],
  ['Failed to capture a valid broadcast scene.', 'broadcast.capture'],
  ['Failed to subscribe to broadcast status.', 'broadcast.subscribe'],
  ['Failed to query broadcast status.', 'broadcast.status'],
  ['Failed to release the editor lease.', 'state_safety.editor_release'],
  ['Failed to release the preparation lease.', 'state_safety.preparation_release'],
  ['Process editor lease cleanup is pending.', 'process.editor_release'],
  ['Failed to send preference changes.', 'settings.synchronize'],
])

export function consoleOperation(level: DiagnosticLevel, message: unknown): string {
  if (level === 'warn' && typeof message === 'string'
    && /^\[TAURI\] Couldn't find callback id \d+\. This might happen when the app is reloaded while Rust is running an asynchronous operation\.$/.test(message)) {
    return 'ipc.callback_missing'
  }
  return typeof message === 'string' ? CONSOLE_OPERATIONS.get(message) ?? `console.${level}` : `console.${level}`
}

export function diagnosticLocation(error: unknown): string | undefined {
  try {
    const stack = error && typeof error === 'object' && 'stack' in error ? error.stack : undefined
    if (typeof stack !== 'string') return undefined
    // Keep application source/bundle coordinates, dropping origins, queries and local paths.
    for (const line of stack.slice(0, 8192).split('\n').slice(1, 12)) {
      if (/diagnostics(?:Core)?\.ts|diagnostics\.js/.test(line)) continue
      const match = line.match(/\/(src\/[\w./-]+\.(?:ts|js|vue)|assets\/[\w.-]+\.js)(?:\?[^\s)]*)?:(\d+):(\d+)/)
      if (match && !match[1].includes('..')) return `${match[1]}:${match[2]}:${match[3]}`.slice(0, 180)
    }
  } catch { /* Diagnostics must never become another application failure. */ }
  return undefined
}

export function createDiagnostic(level: DiagnosticLevel, operation: string, error: unknown, source: string, caller?: unknown): { level: DiagnosticLevel, message: Diagnostic } {
  return {
    level,
    message: {
      operation: /^[a-z][a-z0-9_.-]{1,95}$/.test(operation) ? operation : 'application.failure',
      code: diagnosticCode(error),
      source: ['main', 'preference', 'bootstrap'].includes(source) ? source : 'bootstrap',
      location: diagnosticLocation(error) ?? diagnosticLocation(caller),
    },
  }
}

/** Bound IPC work as well as disk volume. Only failures enter this reporter. */
export function createDiagnosticReporter(send: (level: DiagnosticLevel, message: Diagnostic) => Promise<unknown>, now = () => Date.now()) {
  const recent = new Map<string, number>()
  let minute = now()
  let count = { warn: 0, error: 0 }
  return (level: DiagnosticLevel, message: Diagnostic): void => {
    if (level !== 'warn' && level !== 'error') return
    const time = now()
    if (time - minute >= 60_000 || time < minute) {
      minute = time
      count = { warn: 0, error: 0 }
    }
    const key = `${level}:${message.source}:${message.operation}:${message.code}:${message.location ?? ''}`
    if (time - (recent.get(key) ?? -Infinity) < 5000 || count[level] >= 60) return
    if (recent.size >= 128) recent.delete(recent.keys().next().value!)
    recent.set(key, time)
    count[level]++
    // Failed logging must not recurse through unhandledrejection or alter user work.
    try {
      void send(level, message).catch(() => {})
    } catch { /* synchronous transport failure */ }
  }
}
