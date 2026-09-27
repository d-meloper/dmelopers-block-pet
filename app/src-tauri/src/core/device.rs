use rdev::{Button, EventType, Key};
use serde::Serialize;
use std::{
    collections::{HashSet, VecDeque},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use std::{
    sync::{Mutex, mpsc},
    thread::{self, JoinHandle},
};

mod windows;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, async_runtime, command};

const SEMANTIC_INPUT_EVENT: &str = "semantic-input";
const MAIN_WINDOW_LABEL: &str = "main";
const POINTER_INTERVAL: Duration = Duration::from_millis(16);
const TYPING_WINDOW: Duration = Duration::from_secs(1);
const TYPING_EVENTS_FOR_FULL_INTENSITY: f32 = 8.0;

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SemanticInputEvent {
    Typing {
        active: bool,
        intensity: f32,
        #[serde(skip_serializing_if = "Option::is_none")]
        contact: Option<KeyboardContact>,
    },
    PointerActivity {
        x: f64,
        y: f64,
    },
    MousePrimary {
        active: bool,
    },
    MouseSecondary {
        active: bool,
    },
    MouseMiddle {
        active: bool,
    },
    Scroll {
        delta_x: i64,
        delta_y: i64,
    },
    Drag {
        active: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct KeyboardContact {
    row: u8,
    column: u8,
    pressed: bool,
}

#[derive(Default)]
struct AggregateState {
    typing_events: VecDeque<Instant>,
    pressed_keys: HashSet<Key>,
    primary_pressed: bool,
    dragging: bool,
    last_pointer_emit: Option<Instant>,
}

impl AggregateState {
    fn reset_mouse(&mut self) {
        self.primary_pressed = false;
        self.dragging = false;
        self.last_pointer_emit = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInputState {
    mouse_enabled: bool,
    mouse_generation: u64,
}

static MOUSE_GENERATION: AtomicU64 = AtomicU64::new(0);

fn next_mouse_generation() -> u64 {
    MOUSE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

struct WindowsListener {
    hooks: windows::HookListener,
    processing: Option<JoinHandle<()>>,
}

impl WindowsListener {
    fn stop(&mut self) -> Result<(), String> {
        self.hooks.stop()?;
        if let Some(processing) = self.processing.take() {
            if processing.join().is_err() {
                crate::diagnostics::error("input.processing_thread", "THREAD_PANICKED");
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
struct Consumers {
    desktop: Option<bool>,
    broadcast: Option<bool>,
}

impl Consumers {
    fn active(self) -> bool {
        self.desktop.is_some() || self.broadcast.is_some()
    }
    fn mouse_enabled(self) -> bool {
        self.desktop == Some(true) || self.broadcast == Some(true)
    }
}

struct ListenerRegistry {
    listener: Option<WindowsListener>,
    consumers: Consumers,
}

static WINDOWS_LISTENER: Mutex<ListenerRegistry> = Mutex::new(ListenerRegistry {
    listener: None,
    consumers: Consumers {
        desktop: None,
        broadcast: None,
    },
});

// Consumer epochs are independent of physical hook generations: broadcasting
// can keep a hook alive while the desktop suspends and resumes its own input.
static DESKTOP_INPUT: AtomicU64 = AtomicU64::new(0);
static BROADCAST_INPUT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
pub(super) struct InputEpoch {
    desktop: u64,
    broadcast: u64,
}

fn capture_input_epoch() -> InputEpoch {
    InputEpoch {
        desktop: DESKTOP_INPUT.load(Ordering::SeqCst),
        broadcast: BROADCAST_INPUT.load(Ordering::SeqCst),
    }
}

fn consumer_demand(word: u64) -> Option<bool> {
    (word & 1 != 0).then_some(word & 2 != 0)
}

fn next_consumer_word(previous: u64, demand: Option<bool>) -> u64 {
    if consumer_demand(previous) == demand {
        return previous;
    }
    // Upper 32 bits identify the full consumer lifetime. Mouse-only toggles
    // advance the lower epoch without discarding queued keyboard releases.
    let lifetime = u64::from(consumer_demand(previous).is_some() != demand.is_some()) << 32;
    ((previous & !3) + 4 + lifetime) | demand.map_or(0, |mouse| 1 | (u64::from(mouse) << 1))
}

fn set_consumer_word(word: &AtomicU64, demand: Option<bool>) {
    word.store(
        next_consumer_word(word.load(Ordering::SeqCst), demand),
        Ordering::SeqCst,
    );
}

fn accepts_captured_input(event: &EventType, captured: u64, current: u64) -> bool {
    if matches!(event, EventType::KeyPress(_) | EventType::KeyRelease(_)) {
        captured >> 32 == current >> 32 && consumer_demand(current).is_some()
    } else {
        captured == current && consumer_demand(current) == Some(true)
    }
}

fn refresh_aggregate(state: &mut AggregateState, previous: &mut u64, current: u64) {
    if *previous >> 32 != current >> 32 {
        *state = AggregateState::default();
    } else if *previous != current {
        state.reset_mouse();
    }
    *previous = current;
}

fn desktop_state() -> DeviceInputState {
    let word = DESKTOP_INPUT.load(Ordering::SeqCst);
    DeviceInputState {
        mouse_enabled: consumer_demand(word) == Some(true),
        mouse_generation: word >> 2,
    }
}

#[command]
pub async fn start_device_listening<R: Runtime>(
    app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    mouse_enabled: Option<bool>,
) -> Result<DeviceInputState, String> {
    let result: Result<DeviceInputState, String> = async {
        if window.label() != MAIN_WINDOW_LABEL {
            return Err("Global input monitoring is only available to the main pet window.".into());
        }
        async_runtime::spawn_blocking(move || {
            let mut registry = WINDOWS_LISTENER
                .lock()
                .map_err(|_| "Input listener lock is unavailable.")?;
            let enabled = mouse_enabled.or(registry.consumers.desktop).unwrap_or(true);
            let consumers = Consumers {
                desktop: Some(enabled),
                ..registry.consumers
            };
            reconcile_listener(&mut registry, app_handle, consumers)?;
            Ok(desktop_state())
        })
        .await
        .map_err(|error| error.to_string())?
    }.await;
    if let Err(error) = &result {
        log_input_failure("input.start", error);
    }
    result
}

// Classify existing native errors without recording keys, pointer positions or raw messages.
fn log_input_failure(operation: &'static str, error: &str) {
    let code = if error.starts_with("Keyboard hook could not start") { "KEYBOARD_HOOK_START_FAILED" }
        else if error.starts_with("Keyboard hook could not stop") { "KEYBOARD_HOOK_STOP_FAILED" }
        else if error.starts_with("Mouse hook could not start") { "MOUSE_HOOK_START_FAILED" }
        else if error.starts_with("Mouse hook could not stop") { "MOUSE_HOOK_STOP_FAILED" }
        else if error.contains("lock") || error.contains("queue") { "INPUT_QUEUE_UNAVAILABLE" }
        else if error.contains("thread") { "INPUT_THREAD_UNAVAILABLE" }
        else if error.contains("only available") { "INVALID_WINDOW" }
        else if error.contains("not started") { "NOT_STARTED" }
        else { "INPUT_OPERATION_FAILED" };
    crate::diagnostics::warn(operation, code);
}

fn reconcile_listener<R: Runtime>(
    registry: &mut ListenerRegistry,
    app: AppHandle<R>,
    consumers: Consumers,
) -> Result<(), String> {
    if let Some(current) = registry
        .listener
        .as_mut()
        .filter(|current| current.hooks.is_finished())
    {
        crate::diagnostics::warn("input.recover_listener", "HOOK_THREAD_EXITED");
        current.stop()?;
        registry.listener = None;
    }
    if !consumers.active() {
        if let Some(current) = registry.listener.as_mut() {
            current.stop()?;
        }
        registry.listener = None;
    } else if let Some(current) = registry.listener.as_ref() {
        if current.hooks.state()?.mouse_enabled != consumers.mouse_enabled() {
            current.hooks.configure(consumers.mouse_enabled())?;
        }
    } else {
        registry.listener = Some(create_windows_listener(app, consumers.mouse_enabled())?);
    }
    set_consumer_word(&DESKTOP_INPUT, consumers.desktop);
    set_consumer_word(&BROADCAST_INPUT, consumers.broadcast);
    registry.consumers = consumers;
    Ok(())
}

fn create_windows_listener<R: Runtime>(
    app: AppHandle<R>,
    mouse_enabled: bool,
) -> Result<WindowsListener, String> {
    let (send, receive) = mpsc::channel();
    let (hooks, _) = windows::HookListener::start(mouse_enabled, send)?;
    let processing = thread::Builder::new()
        .name("pet-semantic-input".into())
        .spawn(move || {
            let mut desktop = AggregateState::default();
            let mut broadcast = AggregateState::default();
            let mut desktop_epoch = 0;
            let mut broadcast_epoch = 0;
            while let Ok(message) = receive.recv() {
                match message {
                    windows::InputMessage::ResetMouse => {
                        desktop.reset_mouse();
                        broadcast.reset_mouse();
                    }
                    windows::InputMessage::Event(event, generation, epoch) => {
                        if !is_current_input(
                            &event,
                            generation,
                            MOUSE_GENERATION.load(Ordering::SeqCst),
                        ) {
                            continue;
                        }
                        if accepts_captured_input(
                            &event,
                            epoch.desktop,
                            DESKTOP_INPUT.load(Ordering::SeqCst),
                        ) {
                            refresh_aggregate(&mut desktop, &mut desktop_epoch, epoch.desktop);
                            process_input_event(&mut desktop, &event, |event| {
                                emit_to_main(&app, event, epoch.desktop)
                            });
                        }
                        if accepts_captured_input(
                            &event,
                            epoch.broadcast,
                            BROADCAST_INPUT.load(Ordering::SeqCst),
                        ) {
                            refresh_aggregate(
                                &mut broadcast,
                                &mut broadcast_epoch,
                                epoch.broadcast,
                            );
                            process_input_event(&mut broadcast, &event, |event| {
                                emit_to_broadcast(&app, event, epoch.broadcast)
                            });
                        }
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(WindowsListener {
        hooks,
        processing: Some(processing),
    })
}

fn is_current_input(event: &EventType, generation: u64, current: u64) -> bool {
    matches!(event, EventType::KeyPress(_) | EventType::KeyRelease(_)) || generation == current
}

fn require_main_input_window(label: &str) -> Result<(), String> {
    if label == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err("Global input monitoring is only available to the main pet window.".into())
    }
}

/// Full lifecycle suspension is distinct from the user's saved mouse option.
/// Releasing the desktop lease never removes a ready browser source's lease.
#[command]
pub async fn set_device_input_active<R: Runtime>(
    window: WebviewWindow<R>,
    active: bool,
    mouse_enabled: bool,
) -> Result<DeviceInputState, String> {
    let result: Result<DeviceInputState, String> = async {
        require_main_input_window(window.label())?;
        async_runtime::spawn_blocking(move || {
            let mut registry = WINDOWS_LISTENER
                .lock()
                .map_err(|_| "Input listener lock is unavailable.")?;
            let consumers = Consumers {
                desktop: active.then_some(mouse_enabled),
                ..registry.consumers
            };
            reconcile_listener(&mut registry, window.app_handle().clone(), consumers)?;
            Ok(desktop_state())
        })
        .await
        .map_err(|error| error.to_string())?
    }.await;
    if let Err(error) = &result {
        log_input_failure("input.set_active", error);
    }
    result
}

#[command]
pub async fn set_device_mouse_enabled<R: Runtime>(
    window: WebviewWindow<R>,
    enabled: bool,
) -> Result<DeviceInputState, String> {
    let result: Result<DeviceInputState, String> = async {
        if window.label() != MAIN_WINDOW_LABEL {
            return Err("Global input monitoring is only available to the main pet window.".into());
        }
        async_runtime::spawn_blocking(move || {
            let mut registry = WINDOWS_LISTENER
                .lock()
                .map_err(|_| "Input listener lock is unavailable.")?;
            if registry.consumers.desktop.is_none() {
                return Err("Input listening has not started.".into());
            }
            let consumers = Consumers {
                desktop: Some(enabled),
                ..registry.consumers
            };
            reconcile_listener(&mut registry, window.app_handle().clone(), consumers)?;
            Ok(desktop_state())
        })
        .await
        .map_err(|error| error.to_string())?
    }.await;
    if let Err(error) = &result {
        log_input_failure("input.set_mouse_enabled", error);
    }
    result
}

pub(crate) fn set_broadcast_input<R: Runtime>(
    app: AppHandle<R>,
    demand: Option<bool>,
) -> Result<(), String> {
    let mut registry = WINDOWS_LISTENER
        .lock()
        .map_err(|_| "Input listener lock is unavailable.")?;
    let consumers = Consumers {
        broadcast: demand,
        ..registry.consumers
    };
    reconcile_listener(&mut registry, app, consumers)
}

pub fn stop_listening() -> Result<(), String> {
    let mut registry = WINDOWS_LISTENER
        .lock()
        .map_err(|_| "Input listener lock is unavailable.")?;
    if let Some(current) = registry.listener.as_mut() {
        current.stop()?;
    }
    registry.listener = None;
    registry.consumers = Consumers::default();
    set_consumer_word(&DESKTOP_INPUT, None);
    set_consumer_word(&BROADCAST_INPUT, None);
    Ok(())
}

#[command]
pub async fn stop_device_listening<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    let result: Result<(), String> = async {
        if window.label() != MAIN_WINDOW_LABEL {
            return Err("Global input monitoring is only available to the main pet window.".into());
        }
        async_runtime::spawn_blocking(move || {
            let mut registry = WINDOWS_LISTENER
                .lock()
                .map_err(|_| "Input listener lock is unavailable.")?;
            let consumers = Consumers {
                desktop: None,
                ..registry.consumers
            };
            reconcile_listener(&mut registry, window.app_handle().clone(), consumers)
        })
        .await
        .map_err(|error| error.to_string())?
    }.await;
    if let Err(error) = &result {
        log_input_failure("input.stop", error);
    }
    result
}

fn process_input_event(
    state: &mut AggregateState,
    event_type: &EventType,
    mut emit: impl FnMut(SemanticInputEvent),
) {
    match event_type {
        EventType::KeyPress(key) => {
            let now = Instant::now();
            state.pressed_keys.insert(*key);
            state.typing_events.push_back(now);
            prune_typing_events(&mut state.typing_events, now);
            emit(SemanticInputEvent::Typing {
                active: true,
                intensity: typing_intensity(&state.typing_events),
                contact: keyboard_contact(*key, true),
            });
        }
        EventType::KeyRelease(key) => {
            let now = Instant::now();
            state.pressed_keys.remove(key);
            prune_typing_events(&mut state.typing_events, now);
            emit(SemanticInputEvent::Typing {
                active: !state.pressed_keys.is_empty(),
                intensity: typing_intensity(&state.typing_events),
                contact: keyboard_contact(*key, false),
            });
        }
        EventType::ButtonPress(Button::Left) => {
            state.primary_pressed = true;
            emit(SemanticInputEvent::MousePrimary { active: true });
        }
        EventType::ButtonRelease(Button::Left) => {
            state.primary_pressed = false;
            if state.dragging {
                state.dragging = false;
                emit(SemanticInputEvent::Drag { active: false });
            }
            emit(SemanticInputEvent::MousePrimary { active: false });
        }
        EventType::ButtonPress(Button::Right) => {
            emit(SemanticInputEvent::MouseSecondary { active: true });
        }
        EventType::ButtonRelease(Button::Right) => {
            emit(SemanticInputEvent::MouseSecondary { active: false });
        }
        EventType::ButtonPress(Button::Middle) => {
            emit(SemanticInputEvent::MouseMiddle { active: true })
        }
        EventType::ButtonRelease(Button::Middle) => {
            emit(SemanticInputEvent::MouseMiddle { active: false })
        }
        EventType::MouseMove { x, y } => {
            if state.primary_pressed && !state.dragging {
                state.dragging = true;
                emit(SemanticInputEvent::Drag { active: true });
            }
            let now = Instant::now();
            if state
                .last_pointer_emit
                .is_some_and(|last| now.duration_since(last) < POINTER_INTERVAL)
            {
                return;
            }
            state.last_pointer_emit = Some(now);
            emit(SemanticInputEvent::PointerActivity { x: *x, y: *y });
        }
        EventType::Wheel { delta_x, delta_y } => emit(SemanticInputEvent::Scroll {
            delta_x: (*delta_x).clamp(-1200, 1200),
            delta_y: (*delta_y).clamp(-1200, 1200),
        }),
        _ => {}
    }
}

fn keyboard_contact(key: Key, pressed: bool) -> Option<KeyboardContact> {
    let (row, column) = match key {
        Key::Escape => (0, 0),
        Key::Num1 => (0, 1),
        Key::Num2 => (0, 2),
        Key::Num3 => (0, 3),
        Key::Num4 => (0, 4),
        Key::Num5 => (0, 5),
        Key::Num6 => (0, 6),
        Key::Num7 => (0, 7),
        Key::Num8 => (0, 8),
        Key::Num9 => (0, 9),
        Key::Num0 => (0, 10),
        Key::Minus => (0, 11),
        Key::Equal => (0, 12),
        Key::Backspace => (0, 13),
        Key::Delete => (0, 14),
        Key::Tab => (1, 0),
        Key::KeyQ => (1, 1),
        Key::KeyW => (1, 2),
        Key::KeyE => (1, 3),
        Key::KeyR => (1, 4),
        Key::KeyT => (1, 5),
        Key::KeyY => (1, 6),
        Key::KeyU => (1, 7),
        Key::KeyI => (1, 8),
        Key::KeyO => (1, 9),
        Key::KeyP => (1, 10),
        Key::LeftBracket => (1, 11),
        Key::RightBracket => (1, 12),
        Key::BackSlash | Key::IntlBackslash => (1, 13),
        Key::Home => (1, 14),
        Key::CapsLock => (2, 0),
        Key::KeyA => (2, 1),
        Key::KeyS => (2, 2),
        Key::KeyD => (2, 3),
        Key::KeyF => (2, 4),
        Key::KeyG => (2, 5),
        Key::KeyH => (2, 6),
        Key::KeyJ => (2, 7),
        Key::KeyK => (2, 8),
        Key::KeyL => (2, 9),
        Key::SemiColon => (2, 10),
        Key::Quote => (2, 11),
        Key::Return | Key::KpReturn => (2, 12),
        Key::PageUp => (2, 13),
        Key::ShiftLeft => (3, 0),
        Key::KeyZ => (3, 1),
        Key::KeyX => (3, 2),
        Key::KeyC => (3, 3),
        Key::KeyV => (3, 4),
        Key::KeyB => (3, 5),
        Key::KeyN => (3, 6),
        Key::KeyM => (3, 7),
        Key::Comma => (3, 8),
        Key::Dot => (3, 9),
        Key::Slash | Key::IntlRo => (3, 10),
        Key::ShiftRight => (3, 11),
        Key::UpArrow => (3, 12),
        Key::PageDown => (3, 13),
        Key::ControlLeft => (4, 0),
        Key::MetaLeft => (4, 1),
        Key::Alt => (4, 2),
        Key::Space => (4, 3),
        Key::Lang1 | Key::AltGr => (4, 4),
        Key::Function => (4, 5),
        Key::LeftArrow => (4, 6),
        Key::DownArrow => (4, 7),
        Key::RightArrow => (4, 8),
        _ => return None,
    };
    Some(KeyboardContact {
        row,
        column,
        pressed,
    })
}

fn emit_to_main<R: Runtime>(app: &AppHandle<R>, event: SemanticInputEvent, epoch: u64) {
    if !accepts_semantic_epoch(&event, epoch, DESKTOP_INPUT.load(Ordering::SeqCst)) {
        return;
    }
    let mouse_generation =
        (!matches!(event, SemanticInputEvent::Typing { .. })).then_some(epoch >> 2);
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        #[serde(flatten)]
        event: SemanticInputEvent,
        #[serde(skip_serializing_if = "Option::is_none")]
        mouse_generation: Option<u64>,
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if window.emit(
            SEMANTIC_INPUT_EVENT,
            Payload {
                event,
                mouse_generation,
            },
        ).is_err() {
            crate::diagnostics::warn("input.desktop_delivery", "EVENT_EMIT_FAILED");
        }
    }
}

fn normalized_pointer(x: f64, y: f64) -> Option<(f64, f64)> {
    use windows_sys::Win32::{
        Foundation::POINT,
        Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONULL, MONITORINFO, MonitorFromPoint},
    };
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let monitor = unsafe {
        MonitorFromPoint(
            POINT {
                x: x as i32,
                y: y as i32,
            },
            MONITOR_DEFAULTTONULL,
        )
    };
    if monitor.is_null() {
        return None;
    }
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return None;
    }
    let rect = info.rcMonitor;
    normalized_point_in_bounds(
        x,
        y,
        f64::from(rect.left),
        f64::from(rect.top),
        f64::from(rect.right - rect.left),
        f64::from(rect.bottom - rect.top),
    )
}

fn normalized_point_in_bounds(
    x: f64,
    y: f64,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
) -> Option<(f64, f64)> {
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some((
        ((x - left) / width).clamp(0.0, 1.0),
        ((y - top) / height).clamp(0.0, 1.0),
    ))
}

fn emit_to_broadcast<R: Runtime>(app: &AppHandle<R>, event: SemanticInputEvent, epoch: u64) {
    if !accepts_semantic_epoch(&event, epoch, BROADCAST_INPUT.load(Ordering::SeqCst)) {
        return;
    }
    let event = match event {
        SemanticInputEvent::PointerActivity { x, y } => {
            let Some((x, y)) = normalized_pointer(x, y) else {
                return;
            };
            SemanticInputEvent::PointerActivity { x, y }
        }
        event => event,
    };
    if let Some(state) = app.try_state::<crate::broadcast::BroadcastState>() {
        state.publish_input(event);
    }
}

fn accepts_semantic_epoch(event: &SemanticInputEvent, captured: u64, current: u64) -> bool {
    if matches!(event, SemanticInputEvent::Typing { .. }) {
        captured >> 32 == current >> 32 && consumer_demand(current).is_some()
    } else {
        captured == current && consumer_demand(current) == Some(true)
    }
}

fn prune_typing_events(events: &mut VecDeque<Instant>, now: Instant) {
    while events
        .front()
        .is_some_and(|timestamp| now.duration_since(*timestamp) > TYPING_WINDOW)
    {
        events.pop_front();
    }
}

fn typing_intensity(events: &VecDeque<Instant>) -> f32 {
    (events.len() as f32 / TYPING_EVENTS_FOR_FULL_INTENSITY).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_hooks_follow_the_union_and_each_consumer_keeps_its_own_acknowledgement() {
        require_main_input_window("main").unwrap();
        assert!(require_main_input_window("preference").is_err());
        assert!(require_main_input_window("broadcast").is_err());
        for desktop in [None, Some(false), Some(true)] {
            for broadcast in [None, Some(false), Some(true)] {
                let consumers = Consumers { desktop, broadcast };
                assert_eq!(consumers.active(), desktop.is_some() || broadcast.is_some());
                assert_eq!(
                    consumers.mouse_enabled(),
                    desktop == Some(true) || broadcast == Some(true)
                );
                let desktop_word = next_consumer_word(0, desktop);
                let broadcast_word = next_consumer_word(0, broadcast);
                assert_eq!(consumer_demand(desktop_word), desktop);
                assert_eq!(consumer_demand(broadcast_word), broadcast);
                // Updating one consumer never reuses the other's generation.
                assert_eq!(next_consumer_word(desktop_word, desktop), desktop_word);
                let mouse = EventType::ButtonPress(Button::Left);
                assert_eq!(
                    accepts_captured_input(&mouse, desktop_word, desktop_word),
                    desktop == Some(true)
                );
                assert_eq!(
                    accepts_captured_input(&mouse, broadcast_word, broadcast_word),
                    broadcast == Some(true)
                );
            }
        }
    }

    #[test]
    fn desktop_mouse_epochs_reject_queued_events_while_broadcast_keeps_the_hook_alive() {
        let on = next_consumer_word(0, Some(true));
        let off = next_consumer_word(on, Some(false));
        let resumed = next_consumer_word(off, Some(true));
        let mouse = EventType::ButtonRelease(Button::Left);
        let keyboard = EventType::KeyRelease(Key::KeyF);
        assert!(!accepts_captured_input(&mouse, on, resumed));
        assert!(!accepts_captured_input(&mouse, off, resumed));
        assert!(accepts_captured_input(&mouse, resumed, resumed));
        assert!(accepts_captured_input(&keyboard, on, off));
        assert!(accepts_captured_input(&keyboard, on, resumed));
        let stopped = next_consumer_word(resumed, None);
        let restarted = next_consumer_word(stopped, Some(true));
        assert!(!accepts_captured_input(&keyboard, resumed, restarted));
        assert!(!accepts_captured_input(&keyboard, stopped, stopped));
        assert!(on >> 2 < off >> 2 && off >> 2 < resumed >> 2 && resumed >> 2 < restarted >> 2);
    }

    #[test]
    fn mouse_toggle_preserves_keyboard_aggregation_and_restart_clears_every_contact() {
        let mut state = AggregateState::default();
        let mut epoch = next_consumer_word(0, Some(true));
        process_input_event(&mut state, &EventType::KeyPress(Key::KeyF), |_| {});
        process_input_event(&mut state, &EventType::KeyPress(Key::KeyJ), |_| {});
        process_input_event(&mut state, &EventType::ButtonPress(Button::Left), |_| {});
        let disabled = next_consumer_word(epoch, Some(false));
        refresh_aggregate(&mut state, &mut epoch, disabled);
        assert_eq!(state.pressed_keys.len(), 2);
        assert!(!state.primary_pressed);
        let mut events = Vec::new();
        process_input_event(&mut state, &EventType::KeyRelease(Key::KeyF), |event| {
            events.push(event)
        });
        assert!(matches!(
            events[0],
            SemanticInputEvent::Typing { active: true, .. }
        ));
        let restarted = next_consumer_word(next_consumer_word(epoch, None), Some(true));
        refresh_aggregate(&mut state, &mut epoch, restarted);
        assert!(state.pressed_keys.is_empty());
        assert!(state.typing_events.is_empty());
    }

    #[test]
    fn broadcast_pointer_normalizes_to_cursor_monitor_physical_bounds() {
        assert_eq!(
            normalized_point_in_bounds(-960.0, 540.0, -1920.0, 0.0, 1920.0, 1080.0),
            Some((0.5, 0.5))
        );
        assert_eq!(
            normalized_point_in_bounds(1920.0, -1440.0, 0.0, -1440.0, 3840.0, 2160.0),
            Some((0.5, 0.0))
        );
        assert_eq!(
            normalized_point_in_bounds(9000.0, -10.0, 0.0, 0.0, 1920.0, 1080.0),
            Some((1.0, 0.0))
        );
        assert_eq!(
            normalized_point_in_bounds(0.0, 0.0, 0.0, 0.0, 0.0, 1080.0),
            None
        );
    }

    #[test]
    fn typing_intensity_is_bounded() {
        let mut events = VecDeque::new();
        for _ in 0..20 {
            events.push_back(Instant::now());
        }
        assert_eq!(typing_intensity(&events), 1.0);
    }

    #[test]
    fn resetting_mouse_preserves_held_keyboard_input() {
        let mut state = AggregateState::default();
        state.pressed_keys.insert(Key::KeyF);
        state.typing_events.push_back(Instant::now());
        state.primary_pressed = true;
        state.dragging = true;
        state.last_pointer_emit = Some(Instant::now());
        state.reset_mouse();
        assert!(state.pressed_keys.contains(&Key::KeyF));
        assert_eq!(state.typing_events.len(), 1);
        assert!(!state.primary_pressed && !state.dragging);
        assert!(state.last_pointer_emit.is_none());
    }

    #[test]
    fn late_mouse_events_are_discarded_but_keyboard_releases_survive_a_toggle() {
        for event in [
            EventType::MouseMove { x: 1.0, y: 2.0 },
            EventType::ButtonPress(Button::Left),
            EventType::ButtonRelease(Button::Right),
            EventType::ButtonPress(Button::Middle),
            EventType::Wheel {
                delta_x: -1,
                delta_y: 1,
            },
        ] {
            assert!(is_current_input(&event, 1, 1));
            assert!(!is_current_input(&event, 1, 2));
            assert!(!is_current_input(&event, 1, 3));
        }
        assert!(is_current_input(&EventType::KeyRelease(Key::KeyF), 1, 2));
        assert!(is_current_input(&EventType::KeyPress(Key::KeyJ), 1, 3));
    }

    #[test]
    fn secondary_and_middle_press_and_release_have_the_semantic_contract_shape() {
        for active in [true, false] {
            for (event, kind) in [
                (
                    SemanticInputEvent::MouseSecondary { active },
                    "mouse_secondary",
                ),
                (SemanticInputEvent::MouseMiddle { active }, "mouse_middle"),
            ] {
                let payload = serde_json::to_value(event).unwrap();
                assert_eq!(
                    payload,
                    serde_json::json!({ "kind": kind, "active": active })
                );
            }
        }
    }

    #[test]
    fn semantic_payloads_never_include_key_identity() {
        let payload = serde_json::to_value(SemanticInputEvent::Typing {
            active: true,
            intensity: 0.5,
            contact: keyboard_contact(Key::KeyF, true),
        })
        .unwrap();
        assert_eq!(payload["kind"], "typing");
        assert!(payload.get("key").is_none());
        assert!(payload.get("code").is_none());
        assert_eq!(payload["contact"]["row"], 2);
        assert_eq!(payload["contact"]["column"], 4);
        assert_eq!(payload["contact"]["pressed"], true);

        let scroll = serde_json::to_value(SemanticInputEvent::Scroll {
            delta_x: 1,
            delta_y: -1,
        })
        .unwrap();
        assert_eq!(scroll["deltaX"], 1);
        assert_eq!(scroll["deltaY"], -1);
    }
}
