//! Own the two low-level hooks on one thread. Only that thread changes hook
//! handles; a mouse configuration reply follows the completed Win32 operation.
//! rdev's process-global KEYBOARD_ONLY/exit_grab interfaces cannot provide this.
use super::{DeviceInputState, InputEpoch, capture_input_epoch, next_mouse_generation};
use rdev::{Button, EventType};
use std::{
    cell::RefCell,
    collections::VecDeque,
    ptr::null_mut,
    sync::{
        Arc, Mutex,
        mpsc::{self, Sender},
    },
    thread::{self, JoinHandle},
};
use windows_sys::Win32::{
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::{
        Input::KeyboardAndMouse::VK_PACKET,
        WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetMessageW, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, MSG,
            MSLLHOOKSTRUCT, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
            TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_KEYDOWN,
            WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL,
            WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
        },
    },
};

const WAKE: u32 = WM_APP + 47;

pub(super) enum InputMessage {
    Event(EventType, u64, InputEpoch),
    ResetMouse,
}

struct CallbackState {
    sender: Sender<InputMessage>,
    generation: u64,
    mouse_enabled: bool,
}

thread_local! {
    static CALLBACK: RefCell<Option<CallbackState>> = const { RefCell::new(None) };
}

fn keyboard_event(message: u32, data: &KBDLLHOOKSTRUCT) -> Option<EventType> {
    // Match the existing rdev virtual-key mapping, including its VK_PACKET rule.
    // Do not call ToUnicode or construct the input text.
    let code = if data.vkCode == u32::from(VK_PACKET) {
        data.scanCode
    } else {
        data.vkCode
    };
    let key = rdev::win_key_from_keycode(u32::from(code as u16));
    match message {
        WM_KEYDOWN | WM_SYSKEYDOWN => Some(EventType::KeyPress(key)),
        WM_KEYUP | WM_SYSKEYUP => Some(EventType::KeyRelease(key)),
        _ => None,
    }
}

fn mouse_event(message: u32, data: &MSLLHOOKSTRUCT) -> Option<EventType> {
    let raw_delta = i64::from((data.mouseData >> 16) as i16);
    let delta = raw_delta.signum() * (raw_delta.abs() / 120).max(1);
    match message {
        WM_LBUTTONDOWN => Some(EventType::ButtonPress(Button::Left)),
        WM_LBUTTONUP => Some(EventType::ButtonRelease(Button::Left)),
        WM_RBUTTONDOWN => Some(EventType::ButtonPress(Button::Right)),
        WM_RBUTTONUP => Some(EventType::ButtonRelease(Button::Right)),
        WM_MBUTTONDOWN => Some(EventType::ButtonPress(Button::Middle)),
        WM_MBUTTONUP => Some(EventType::ButtonRelease(Button::Middle)),
        WM_MOUSEMOVE => Some(EventType::MouseMove {
            x: f64::from(data.pt.x),
            y: f64::from(data.pt.y),
        }),
        // Preserve rdev's detent units, retaining sub-detent activity instead of
        // rounding it to zero. No physical wheel rotation is inferred from this.
        WM_MOUSEWHEEL => Some(EventType::Wheel {
            delta_x: 0,
            delta_y: delta,
        }),
        WM_MOUSEHWHEEL => Some(EventType::Wheel {
            delta_x: delta,
            delta_y: 0,
        }),
        _ => None,
    }
}

unsafe extern "system" fn keyboard_callback(code: i32, param: usize, data: isize) -> isize {
    if code == HC_ACTION as i32 && data != 0 {
        // Windows owns the structure for the duration of this callback.
        if let Some(event) =
            keyboard_event(param as u32, unsafe { &*(data as *const KBDLLHOOKSTRUCT) })
        {
            CALLBACK.with_borrow(|state| {
                if let Some(state) = state {
                    let _ = state.sender.send(InputMessage::Event(
                        event,
                        state.generation,
                        capture_input_epoch(),
                    ));
                }
            });
        }
    }
    // Keyboard input always passes through, including while mouse tracking is off.
    unsafe { CallNextHookEx(null_mut(), code, param, data) }
}

unsafe extern "system" fn mouse_callback(code: i32, param: usize, data: isize) -> isize {
    unsafe {
        process_mouse_callback(code, param, data, |code, param, data| {
            CallNextHookEx(null_mut(), code, param, data)
        })
    }
}

unsafe fn process_mouse_callback(
    code: i32,
    param: usize,
    data: isize,
    next_hook: impl FnOnce(i32, usize, isize) -> isize,
) -> isize {
    if code == HC_ACTION as i32 && data != 0 {
        // Windows owns the structure for the duration of this callback.
        let data = unsafe { &*(data as *const MSLLHOOKSTRUCT) };
        if let Some(event) = mouse_event(param as u32, data) {
            CALLBACK.with_borrow(|state| {
                let Some(state) = state.as_ref().filter(|state| state.mouse_enabled) else {
                    return;
                };
                let _ = state.sender.send(InputMessage::Event(
                    event,
                    state.generation,
                    capture_input_epoch(),
                ));
            });
        }
    }
    // Global monitoring never consumes a button press or release. The webview's
    // ignore-cursor setting owns click-through, including the context menu.
    next_hook(code, param, data)
}

enum Request {
    Configure(bool, Sender<Result<DeviceInputState, String>>),
    State(Sender<DeviceInputState>),
    Stop(Sender<Result<(), String>>),
    #[cfg(test)]
    Inspect(Sender<(usize, usize, DeviceInputState)>),
}

struct Hooks {
    keyboard: HHOOK,
    mouse: HHOOK,
    state: DeviceInputState,
}

fn change_mouse_hook<T: Copy + Default>(
    handle: &mut T,
    enabled: bool,
    install: impl FnOnce() -> Result<T, String>,
    remove: impl FnOnce(T) -> Result<(), String>,
) -> Result<(), String> {
    if enabled {
        *handle = install()?;
    } else {
        remove(*handle)?;
        *handle = T::default();
    }
    Ok(())
}

impl Hooks {
    fn start(mouse_enabled: bool, sender: Sender<InputMessage>) -> Result<Self, String> {
        let state = DeviceInputState {
            mouse_enabled: false,
            mouse_generation: next_mouse_generation(),
        };
        CALLBACK.set(Some(CallbackState {
            sender,
            generation: state.mouse_generation,
            mouse_enabled: false,
        }));
        let keyboard = unsafe {
            SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(keyboard_callback),
                GetModuleHandleW(null_mut()),
                0,
            )
        };
        if keyboard.is_null() {
            CALLBACK.set(None);
            let error = std::io::Error::last_os_error();
            crate::diagnostics::warn("input.keyboard_hook_start", &format!("WIN32_{}", error.raw_os_error().unwrap_or(0)));
            return Err(format!("Keyboard hook could not start: {error}"));
        }
        let mut hooks = Self {
            keyboard,
            mouse: null_mut(),
            state,
        };
        hooks.configure(mouse_enabled)?;
        Ok(hooks)
    }

    fn configure(&mut self, enabled: bool) -> Result<DeviceInputState, String> {
        if enabled == self.state.mouse_enabled {
            return Ok(self.state);
        }
        change_mouse_hook(
            &mut self.mouse,
            enabled,
            || {
                let mouse = unsafe {
                    SetWindowsHookExW(
                        WH_MOUSE_LL,
                        Some(mouse_callback),
                        GetModuleHandleW(null_mut()),
                        0,
                    )
                };
                if mouse.is_null() {
                    let error = std::io::Error::last_os_error();
                    crate::diagnostics::warn("input.mouse_hook_start", &format!("WIN32_{}", error.raw_os_error().unwrap_or(0)));
                    return Err(format!("Mouse hook could not start: {error}"));
                }
                Ok(mouse)
            },
            |mouse| {
                // This is executed on the callback thread, after any earlier callback
                // returned. Keep the handle and prior state if Win32 rejects removal.
                if unsafe { UnhookWindowsHookEx(mouse) } == 0 {
                    let error = std::io::Error::last_os_error();
                    crate::diagnostics::warn("input.mouse_hook_stop", &format!("WIN32_{}", error.raw_os_error().unwrap_or(0)));
                    return Err(format!("Mouse hook could not stop: {error}"));
                }
                Ok(())
            },
        )?;
        self.state = DeviceInputState {
            mouse_enabled: enabled,
            mouse_generation: next_mouse_generation(),
        };
        CALLBACK.with_borrow_mut(|callback| {
            if let Some(callback) = callback {
                callback.mouse_enabled = enabled;
                callback.generation = self.state.mouse_generation;
                let _ = callback.sender.send(InputMessage::ResetMouse);
            }
        });
        Ok(self.state)
    }

    fn stop(&mut self) -> Result<(), String> {
        self.configure(false)?;
        if !self.keyboard.is_null() {
            if unsafe { UnhookWindowsHookEx(self.keyboard) } == 0 {
                let error = std::io::Error::last_os_error();
                crate::diagnostics::warn("input.keyboard_hook_stop", &format!("WIN32_{}", error.raw_os_error().unwrap_or(0)));
                return Err(format!("Keyboard hook could not stop: {error}"));
            }
            self.keyboard = null_mut();
        }
        next_mouse_generation();
        CALLBACK.set(None);
        Ok(())
    }
}

impl Drop for Hooks {
    fn drop(&mut self) {
        let _ = self.stop();
        next_mouse_generation();
        CALLBACK.set(None);
    }
}

type RequestQueue = Arc<Mutex<Option<VecDeque<Request>>>>;

struct CloseQueue(RequestQueue);

impl Drop for CloseQueue {
    fn drop(&mut self) {
        // Drop queued replies on every exit, including startup failure or panic,
        // so callers receive an error instead of waiting on an abandoned request.
        if let Ok(mut queue) = self.0.lock() {
            *queue = None;
        }
    }
}

pub(super) struct HookListener {
    requests: RequestQueue,
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl HookListener {
    pub(super) fn start(
        enabled: bool,
        input: Sender<InputMessage>,
    ) -> Result<(Self, DeviceInputState), String> {
        let requests = Arc::new(Mutex::new(Some(VecDeque::new())));
        let receive = Arc::clone(&requests);
        let (ready, started) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("pet-input-hooks".into())
            .spawn(move || {
                let _close_queue = CloseQueue(Arc::clone(&receive));
                let mut message: MSG = unsafe { std::mem::zeroed() };
                // A thread-message queue must exist before exposing the thread ID.
                unsafe {
                    PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
                }
                let mut hooks = match Hooks::start(enabled, input) {
                    Ok(hooks) => hooks,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                if ready
                    .send(Ok((unsafe { GetCurrentThreadId() }, hooks.state)))
                    .is_err()
                {
                    return;
                }
                loop {
                    let result = unsafe { GetMessageW(&mut message, null_mut(), 0, 0) };
                    if result <= 0 {
                        if result < 0 {
                            let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                            crate::diagnostics::error("input.message_loop", &format!("WIN32_{code}"));
                        }
                        break;
                    }
                    if message.message == WAKE {
                        if process_requests(&receive, &mut hooks) {
                            break;
                        }
                    } else {
                        unsafe {
                            TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        match started.recv() {
            Ok(Ok((thread_id, state))) => Ok((
                Self {
                    requests,
                    thread_id,
                    thread: Some(thread),
                },
                state,
            )),
            result => {
                let _ = thread.join();
                Err(match result {
                    Ok(Err(error)) => error,
                    _ => "Input hook thread exited before startup.".into(),
                })
            }
        }
    }

    fn send(&self, request: Request) -> Result<(), String> {
        if self.is_finished() {
            return Err("Input hook thread is unavailable.".into());
        }
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "Input request queue is unavailable.".to_string())?;
        let requests = requests
            .as_mut()
            .ok_or_else(|| "Input hook thread is unavailable.".to_string())?;
        // Hold the queue lock across posting and insertion. A failed post cannot
        // leave a latent configuration to be applied by a later request.
        if unsafe { PostThreadMessageW(self.thread_id, WAKE, 0, 0) } == 0 {
            let error = std::io::Error::last_os_error();
            crate::diagnostics::warn("input.post_request", &format!("WIN32_{}", error.raw_os_error().unwrap_or(0)));
            return Err(format!("Input hook request could not be posted: {error}"));
        }
        requests.push_back(request);
        Ok(())
    }

    pub(super) fn state(&self) -> Result<DeviceInputState, String> {
        let (reply, receive) = mpsc::channel();
        self.send(Request::State(reply))?;
        receive
            .recv()
            .map_err(|_| "Input hook thread exited during state query.".to_string())
    }

    pub(super) fn configure(&self, enabled: bool) -> Result<DeviceInputState, String> {
        let (reply, receive) = mpsc::channel();
        self.send(Request::Configure(enabled, reply))?;
        receive
            .recv()
            .map_err(|_| "Input hook thread exited during configuration.".to_string())?
    }

    pub(super) fn stop(&mut self) -> Result<(), String> {
        if self
            .thread
            .as_ref()
            .is_none_or(|thread| thread.is_finished())
        {
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
            return Ok(());
        }
        let (reply, receive) = mpsc::channel();
        self.send(Request::Stop(reply))?;
        receive
            .recv()
            .map_err(|_| "Input hook thread exited during shutdown.".to_string())??;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        Ok(())
    }

    pub(super) fn is_finished(&self) -> bool {
        self.thread
            .as_ref()
            .is_none_or(|thread| thread.is_finished())
    }
}

impl Drop for HookListener {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn process_requests(receive: &Mutex<Option<VecDeque<Request>>>, hooks: &mut Hooks) -> bool {
    loop {
        let request = receive
            .lock()
            .ok()
            .and_then(|mut queue| queue.as_mut().and_then(VecDeque::pop_front));
        let Some(request) = request else {
            return false;
        };
        match request {
            Request::Configure(enabled, reply) => {
                let _ = reply.send(hooks.configure(enabled));
            }
            Request::State(reply) => {
                let _ = reply.send(hooks.state);
            }
            Request::Stop(reply) => {
                let result = hooks.stop();
                let stopped = result.is_ok();
                let _ = reply.send(result);
                if stopped {
                    return true;
                }
            }
            #[cfg(test)]
            Request::Inspect(reply) => {
                let _ = reply.send((hooks.keyboard as usize, hooks.mouse as usize, hooks.state));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouse_callbacks_forward_both_click_buttons_without_consuming_them() {
        let (sender, events) = mpsc::channel();
        CALLBACK.set(Some(CallbackState {
            sender,
            generation: 7,
            mouse_enabled: true,
        }));
        let data: MSLLHOOKSTRUCT = unsafe { std::mem::zeroed() };
        let pointer = &data as *const MSLLHOOKSTRUCT as isize;
        for (message, expected) in [
            (WM_RBUTTONDOWN, EventType::ButtonPress(Button::Right)),
            (WM_RBUTTONUP, EventType::ButtonRelease(Button::Right)),
            (WM_LBUTTONDOWN, EventType::ButtonPress(Button::Left)),
            (WM_LBUTTONUP, EventType::ButtonRelease(Button::Left)),
        ] {
            let mut forwarded = false;
            let result = unsafe {
                process_mouse_callback(
                    HC_ACTION as i32,
                    message as usize,
                    pointer,
                    |code, param, data| {
                        forwarded = true;
                        assert_eq!(code, HC_ACTION as i32);
                        assert_eq!(param, message as usize);
                        assert_eq!(data, pointer);
                        43
                    },
                )
            };
            assert!(forwarded);
            assert_eq!(result, 43);
            match events.try_recv().unwrap() {
                InputMessage::Event(event, generation, _) => {
                    assert_eq!(event, expected);
                    assert_eq!(generation, 7);
                }
                InputMessage::ResetMouse => panic!("button input must remain an animation event"),
            }
            assert!(events.try_recv().is_err());
        }
        CALLBACK.with_borrow_mut(|state| state.as_mut().unwrap().mouse_enabled = false);
        for message in [WM_RBUTTONDOWN, WM_RBUTTONUP] {
            let result = unsafe {
                process_mouse_callback(HC_ACTION as i32, message as usize, pointer, |_, _, _| 43)
            };
            assert_eq!(result, 43);
            assert!(events.try_recv().is_err());
        }
        CALLBACK.set(None);
    }

    #[test]
    fn failed_hook_operations_preserve_the_previous_handle() {
        let mut handle = 0_u32;
        assert!(
            change_mouse_hook(
                &mut handle,
                true,
                || Err("install failed".into()),
                |_| Ok(())
            )
            .is_err()
        );
        assert_eq!(handle, 0);
        change_mouse_hook(&mut handle, true, || Ok(7), |_| Ok(())).unwrap();
        assert!(
            change_mouse_hook(
                &mut handle,
                false,
                || Ok(0),
                |_| Err("remove failed".into())
            )
            .is_err()
        );
        assert_eq!(handle, 7);
        change_mouse_hook(&mut handle, false, || Ok(0), |_| Ok(())).unwrap();
        assert_eq!(handle, 0);
    }

    #[test]
    fn closing_the_queue_releases_pending_and_cancelled_requests() {
        let (reply, receive) = mpsc::channel();
        let queue = Arc::new(Mutex::new(Some(VecDeque::from([Request::Configure(
            false, reply,
        )]))));
        drop(CloseQueue(Arc::clone(&queue)));
        assert!(receive.recv().is_err());
        assert!(queue.lock().unwrap().is_none());
    }

    #[test]
    fn middle_and_high_resolution_wheel_mapping_preserves_direction() {
        let mut data: MSLLHOOKSTRUCT = unsafe { std::mem::zeroed() };
        assert_eq!(
            mouse_event(WM_MBUTTONDOWN, &data),
            Some(EventType::ButtonPress(Button::Middle))
        );
        assert_eq!(
            mouse_event(WM_MBUTTONUP, &data),
            Some(EventType::ButtonRelease(Button::Middle))
        );
        for delta in [1_i16, -1, 120, -120, 240, -240] {
            data.mouseData = u32::from(delta as u16) << 16;
            let expected = i64::from(delta.signum()) * (i64::from(delta).abs() / 120).max(1);
            assert_eq!(
                mouse_event(WM_MOUSEWHEEL, &data),
                Some(EventType::Wheel {
                    delta_x: 0,
                    delta_y: expected
                })
            );
            assert_eq!(
                mouse_event(WM_MOUSEHWHEEL, &data),
                Some(EventType::Wheel {
                    delta_x: expected,
                    delta_y: 0
                })
            );
        }
    }

    #[test]
    fn keyboard_mapping_matches_rdev_without_text_conversion() {
        for code in [0x41, 0x46, 0xA0, 0xA1, 0x0D, 0x20, 0xE7] {
            let data = KBDLLHOOKSTRUCT {
                vkCode: code,
                scanCode: 0x46,
                ..unsafe { std::mem::zeroed() }
            };
            let key = rdev::win_key_from_keycode(if code == 0xE7 { 0x46 } else { code });
            assert_eq!(
                keyboard_event(WM_KEYDOWN, &data),
                Some(EventType::KeyPress(key))
            );
            assert_eq!(
                keyboard_event(WM_SYSKEYUP, &data),
                Some(EventType::KeyRelease(key))
            );
        }
    }

    #[test]
    fn actual_windows_hooks_toggle_mouse_without_replacing_keyboard() {
        let (input, _events) = mpsc::channel();
        let (mut listener, initial) =
            HookListener::start(false, input).expect("install actual Windows keyboard hook");
        let inspect = |listener: &HookListener| {
            let (reply, receive) = mpsc::channel();
            listener.send(Request::Inspect(reply)).unwrap();
            receive.recv().unwrap()
        };
        let (keyboard, mouse, _) = inspect(&listener);
        assert_ne!(keyboard, 0);
        assert_eq!(mouse, 0);
        assert_eq!(listener.state().unwrap(), initial);
        let mut previous = initial;
        for enabled in [true, false, true, true, false, false, true, false] {
            let current = listener.configure(enabled).unwrap();
            let (current_keyboard, mouse, observed) = inspect(&listener);
            assert_eq!(current_keyboard, keyboard);
            assert_eq!(mouse != 0, enabled);
            assert_eq!(observed, current);
            if enabled != previous.mouse_enabled {
                assert!(current.mouse_generation > previous.mouse_generation);
            } else {
                assert_eq!(current, previous);
            }
            previous = current;
        }
        // A caller dropping its reply does not let that queued request outlive a
        // later ordered shutdown or resurrect collection on the next start.
        let (reply, cancelled) = mpsc::channel();
        listener.send(Request::Configure(true, reply)).unwrap();
        drop(cancelled);
        listener.stop().unwrap();
        assert!(listener.is_finished());
        assert!(listener.configure(true).is_err());
        listener.stop().unwrap();
        let (input, _events) = mpsc::channel();
        let (mut restarted, state) = HookListener::start(true, input).unwrap();
        assert!(state.mouse_generation > previous.mouse_generation);
        restarted.stop().unwrap();
    }
}
