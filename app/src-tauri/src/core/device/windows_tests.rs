//! Synthetic SendInput targets an owned foreground window in a separate process.
//! Parsing fixtures below are separate from actual Win32 delivery evidence.
use super::*;
use rdev::Key;
use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::UI::{
    Input::KeyboardAndMouse::{
        INPUT, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEINPUT, SendInput,
    },
    WindowsAndMessaging::{
        AllowSetForegroundWindow, GetClientRect, GetForegroundWindow, GetSystemMetrics,
        HWND_TOPMOST, PM_REMOVE, SM_CXSCREEN, SM_CYSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SendMessageW, SetCursorPos, SetForegroundWindow, SetWindowPos, WS_POPUP, WS_VISIBLE,
        WindowFromPoint,
    },
};

fn received(events: &mpsc::Receiver<InputMessage>) -> Vec<CapturedInput> {
    events
        .try_iter()
        .filter_map(|message| match message {
            InputMessage::Event(event, generation, epoch) => Some((event, generation, epoch)),
            InputMessage::Pointer(slot) => slot.lock().unwrap().take(),
            InputMessage::ResetMouse => None,
        })
        .collect()
}

fn inspect_raw(listener: &HookListener) -> (usize, [usize; 4]) {
    let (reply, receive) = mpsc::channel();
    listener.send(Request::InspectRaw(reply)).unwrap();
    receive.recv_timeout(Duration::from_secs(2)).unwrap()
}

#[test]
fn raw_keyboard_parser_preserves_sides_breaks_and_packet_mapping() {
    for (vk, scan, flags, expected) in [
        (0x10, 0x2a, 0, Key::ShiftLeft),
        (0x10, 0x36, 0, Key::ShiftRight),
        (0x11, 0x1d, 0, Key::ControlLeft),
        (0x11, 0x1d, 2, Key::ControlRight),
        (0x12, 0x38, 0, Key::Alt),
        (0x12, 0x38, 2, Key::AltGr),
        (0xe7, 0x46, 0, Key::KeyF),
    ] {
        let data = RAWKEYBOARD {
            VKey: vk,
            MakeCode: scan,
            Flags: flags,
            Message: WM_KEYDOWN,
            ..Default::default()
        };
        assert_eq!(
            raw_keyboard_event(&data),
            Some(EventType::KeyPress(expected))
        );
        assert_eq!(
            raw_keyboard_event(&RAWKEYBOARD {
                Message: WM_SYSKEYUP,
                Flags: flags | 1,
                ..data
            }),
            Some(EventType::KeyRelease(expected))
        );
    }
    for data in [
        RAWKEYBOARD {
            VKey: 255,
            ..Default::default()
        },
        RAWKEYBOARD {
            VKey: 0x41,
            MakeCode: 0xff,
            ..Default::default()
        },
    ] {
        assert!(raw_keyboard_event(&data).is_none());
    }
}

#[test]
fn absolute_pointer_origin_is_motion_even_with_zero_coordinates() {
    let mut point = POINT::default();
    assert_ne!(unsafe { GetCursorPos(&mut point) }, 0);
    // Absolute (0, 0) is a valid position, unlike a zero relative delta.
    // Observe the current cursor without moving it or changing foreground.
    let mut events = Vec::new();
    for flags in [
        MOUSE_MOVE_ABSOLUTE,
        MOUSE_MOVE_ABSOLUTE | windows_sys::Win32::UI::Input::MOUSE_VIRTUAL_DESKTOP,
    ] {
        raw_mouse_events(
            &RAWMOUSE {
                usFlags: flags,
                ..Default::default()
            },
            |event| events.push(event),
        );
        assert!(matches!(events.as_slice(), [EventType::MouseMove { .. }]));
        events.clear();
    }
    raw_mouse_events(&RAWMOUSE::default(), |event| events.push(event));
    assert!(events.is_empty());
}

#[test]
fn raw_mouse_parser_preserves_all_releases_and_signed_wheels() {
    let mut data = RAWMOUSE::default();
    data.Anonymous.Anonymous.usButtonFlags = 1 | 2 | 4 | 8 | 16 | 32;
    let mut events = Vec::new();
    raw_mouse_events(&data, |event| events.push(event));
    assert_eq!(
        events,
        vec![
            EventType::ButtonPress(Button::Left),
            EventType::ButtonRelease(Button::Left),
            EventType::ButtonPress(Button::Right),
            EventType::ButtonRelease(Button::Right),
            EventType::ButtonPress(Button::Middle),
            EventType::ButtonRelease(Button::Middle)
        ]
    );
    for delta in [-240_i16, -1, 1, 240] {
        data.Anonymous.Anonymous.usButtonFlags = 0x400 | 0x800;
        data.Anonymous.Anonymous.usButtonData = delta as u16;
        events.clear();
        raw_mouse_events(&data, |event| events.push(event));
        let expected = i64::from(delta.signum()) * (i64::from(delta).abs() / 120).max(1);
        assert_eq!(
            events,
            vec![
                EventType::Wheel {
                    delta_x: 0,
                    delta_y: expected
                },
                EventType::Wheel {
                    delta_x: expected,
                    delta_y: 0
                }
            ]
        );
    }
}

#[test]
fn source_pairing_retains_repeats_releases_and_does_not_revive_old_generations() {
    let (sender, events) = mpsc::channel();
    let mut state = CallbackState::new(sender, 7);
    state.mouse_enabled = true;
    for raw_first in [false, true] {
        for event in [
            EventType::KeyPress(Key::KeyA),
            EventType::KeyPress(Key::KeyA),
            EventType::KeyRelease(Key::KeyA),
            EventType::ButtonPress(Button::Left),
            EventType::ButtonRelease(Button::Left),
        ] {
            state.publish(event, 12, raw_first);
            state.publish(event, 12, !raw_first);
            assert_eq!(
                received(&events)
                    .iter()
                    .map(|input| input.0)
                    .collect::<Vec<_>>(),
                vec![event]
            );
        }
    }
    let release = EventType::ButtonRelease(Button::Left);
    state.publish(release, 20, false);
    state.generation = 8;
    state.publish(release, 20, true);
    let captured = received(&events);
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].1, 7);
    state.mouse_enabled = false;
    state.publish(release, 21, false);
    state.mouse_enabled = true;
    state.publish(release, 21, true);
    assert!(received(&events).is_empty());
}

#[test]
fn pointer_mailbox_is_bounded_and_cannot_cross_a_release_boundary() {
    let (sender, events) = mpsc::channel();
    let mut state = CallbackState::new(sender, 7);
    state.mouse_enabled = true;
    for time in 0..20_000 {
        state.publish(
            EventType::MouseMove {
                x: f64::from(time),
                y: 3.0,
            },
            time,
            true,
        );
    }
    let pending = events.try_recv().unwrap();
    assert!(events.try_recv().is_err(), "one pending motion wake");
    assert!(state.motion_pairs.len() <= 256);
    state.publish(EventType::ButtonRelease(Button::Left), 20_001, true);
    let mut sealed = match pending {
        InputMessage::Pointer(slot) => vec![slot.lock().unwrap().take().unwrap()],
        _ => unreachable!(),
    };
    sealed.extend(received(&events));
    assert_eq!(sealed.len(), 2);
    assert_eq!(
        sealed[0].0,
        EventType::MouseMove {
            x: 19_999.0,
            y: 3.0
        }
    );
    assert_eq!(sealed[1].0, EventType::ButtonRelease(Button::Left));
    state.mouse_enabled = false;
    state.publish(EventType::MouseMove { x: 4.0, y: 5.0 }, 20_002, true);
    assert_eq!(received(&events).len(), 1);
}

#[test]
fn delayed_pointer_wakes_preserve_press_move_release_move_order() {
    let (sender, events) = mpsc::channel();
    let mut state = CallbackState::new(sender, 7);
    state.mouse_enabled = true;
    let expected = [
        EventType::MouseMove { x: 1.0, y: 1.0 },
        EventType::ButtonPress(Button::Left),
        EventType::MouseMove { x: 2.0, y: 2.0 },
        EventType::ButtonRelease(Button::Left),
        EventType::MouseMove { x: 3.0, y: 3.0 },
    ];
    for (time, event) in expected.into_iter().enumerate() {
        state.publish(event, time as u32, true);
    }
    assert_eq!(
        received(&events)
            .iter()
            .map(|input| input.0)
            .collect::<Vec<_>>(),
        expected
    );
}

#[test]
fn partial_consumption_and_out_of_order_raw_do_not_expire_future_pairs() {
    for base in [100_u32, u32::MAX - 1] {
        let (sender, events) = mpsc::channel();
        let mut state = CallbackState::new(sender, 7);
        state.mouse_enabled = true;
        for event in [
            EventType::KeyRelease(Key::KeyA),
            EventType::ButtonRelease(Button::Left),
            EventType::MouseMove { x: 1.0, y: 2.0 },
        ] {
            state.publish(event, base.wrapping_add(2), false);
            state.publish(EventType::KeyPress(Key::KeyB), base.wrapping_add(1), true);
            state.publish(event, base.wrapping_add(2), true);
            let captured = received(&events);
            assert_eq!(captured.iter().filter(|input| input.0 == event).count(), 1);
        }
    }
}

#[test]
fn out_of_order_motion_pairing_is_verified_after_each_mailbox_drain() {
    for base in [100_u32, u32::MAX - 1] {
        let (sender, events) = mpsc::channel();
        let mut state = CallbackState::new(sender, 7);
        let pointer = EventType::MouseMove { x: 1.0, y: 2.0 };
        state.publish(pointer, base.wrapping_add(2), false);
        assert_eq!(received(&events).len(), 1);
        state.publish(pointer, base.wrapping_add(1), true);
        assert_eq!(received(&events).len(), 1);
        state.publish(pointer, base.wrapping_add(2), true);
        assert!(received(&events).is_empty());
    }
}

#[test]
fn delayed_raw_mouse_is_excluded_after_a_generation_boundary_but_key_release_survives() {
    let (sender, events) = mpsc::channel();
    let mut state = CallbackState::new(sender, 9);
    state.mouse_enabled = true;
    let cutoff = unsafe { GetTickCount64() }.saturating_sub(100);
    state.mouse_since = Some(cutoff);
    state.publish(
        EventType::ButtonPress(Button::Left),
        cutoff.wrapping_sub(10) as u32,
        true,
    );
    state.publish(EventType::ButtonRelease(Button::Left), cutoff as u32, true);
    state.publish(
        EventType::MouseMove { x: 2.0, y: 2.0 },
        cutoff.wrapping_sub(1) as u32,
        true,
    );
    assert!(received(&events).is_empty());
    state.publish(
        EventType::KeyRelease(Key::KeyA),
        cutoff.wrapping_sub(10) as u32,
        true,
    );
    assert_eq!(received(&events).len(), 1);
    state.publish(
        EventType::ButtonRelease(Button::Left),
        cutoff.wrapping_add(1) as u32,
        true,
    );
    assert_eq!(received(&events).len(), 1);
}

fn register(devices: &[RAWINPUTDEVICE]) {
    assert_ne!(
        unsafe {
            windows_sys::Win32::UI::Input::RegisterRawInputDevices(
                devices.as_ptr(),
                devices.len() as u32,
                std::mem::size_of::<RAWINPUTDEVICE>() as u32,
            )
        },
        0
    );
}

#[test]
fn raw_receiver_restores_exact_prior_registration_and_preserves_newer_owner() {
    let mut prior = RawReceiver::start().unwrap();
    let original = RawReceiver::registration(prior.hwnd, RIDEV_INPUTSINK | 0x2000);
    register(&original);
    let original: Vec<_> = registered_devices()
        .unwrap()
        .into_iter()
        .filter(|device| device.usUsagePage == 1 && [2, 6].contains(&device.usUsage))
        .collect();
    let (sender, _events) = mpsc::channel();
    let (mut listener, _) = HookListener::start(true, sender).unwrap();
    let (hwnd, _) = inspect_raw(&listener);
    assert_ne!(hwnd, prior.hwnd as usize);
    listener.stop().unwrap();
    for device in &original {
        let current = registered_devices().unwrap();
        let restored = current
            .iter()
            .find(|now| now.usUsagePage == 1 && now.usUsage == device.usUsage)
            .unwrap();
        assert_eq!(restored.hwndTarget, device.hwndTarget);
        assert_eq!(restored.dwFlags, device.dwFlags);
    }
    let (sender, _events) = mpsc::channel();
    let (mut listener, _) = HookListener::start(true, sender).unwrap();
    // Only mouse ownership changes. Keyboard still restores independently.
    register(
        &original
            .iter()
            .filter(|device| device.usUsage == 2)
            .copied()
            .collect::<Vec<_>>(),
    );
    listener.stop().unwrap();
    for device in &original {
        assert!(
            registered_devices()
                .unwrap()
                .iter()
                .any(|now| now.usUsage == device.usUsage
                    && now.hwndTarget == device.hwndTarget
                    && now.dwFlags == device.dwFlags)
        );
    }
    let retired = prior.hwnd;
    prior.stop().unwrap();
    assert!(
        registered_devices()
            .unwrap()
            .iter()
            .all(|device| device.hwndTarget != retired)
    );
}

#[test]
fn known_tao_target_recovers_hidden_devnotify_but_unknown_targets_do_not() {
    let known = OwnedWindow::named(DefWindowProcW, false, "Tao Thread Event Target\0");
    let devices = RawReceiver::registration(known.hwnd, RIDEV_INPUTSINK | RIDEV_DEVNOTIFY);
    register(&devices);
    let mut receiver = RawReceiver::start().unwrap();
    for old in receiver.previous.iter().flatten() {
        assert_eq!(old.hwndTarget, known.hwnd);
        assert_eq!(old.dwFlags, RIDEV_INPUTSINK | RIDEV_DEVNOTIFY);
    }
    receiver.stop().unwrap();
    for device in registered_devices().unwrap() {
        assert_eq!(device.hwndTarget, known.hwnd);
        assert_eq!(
            restorable_registration(device).dwFlags,
            RIDEV_INPUTSINK | RIDEV_DEVNOTIFY
        );
    }
    register(&RawReceiver::registration(null_mut(), RIDEV_REMOVE));
    let unknown = OwnedWindow::new(DefWindowProcW, false);
    let observed = RawReceiver::registration(unknown.hwnd, RIDEV_INPUTSINK);
    for device in observed {
        assert_eq!(restorable_registration(device).dwFlags, RIDEV_INPUTSINK);
    }
}

#[test]
fn retired_prior_window_and_invalid_raw_handles_leave_no_receiver_or_input() {
    let mut prior = RawReceiver::start().unwrap();
    let (sender, _events) = mpsc::channel();
    let (mut listener, _) = HookListener::start(true, sender).unwrap();
    let retired = inspect_raw(&listener).0 as HWND;
    assert_ne!(unsafe { DestroyWindow(prior.hwnd) }, 0);
    prior.hwnd = null_mut();
    // Isolate these invalid native handles from unrelated desktop input that
    // can arrive on the live listener's worker thread during this test.
    let (invalid_sender, invalid_events) = mpsc::channel();
    let mut invalid_state = CallbackState::new(invalid_sender, 7);
    invalid_state.mouse_enabled = true;
    let previous_callback = CALLBACK.replace(Some(invalid_state));
    unsafe {
        raw_window_proc(retired, WM_INPUT, 0, 0);
        raw_window_proc(retired, WM_INPUT, 0, 1);
    }
    CALLBACK.set(previous_callback);
    assert!(received(&invalid_events).is_empty());
    listener.stop().unwrap();
    assert_eq!(
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsWindow(retired) },
        0
    );
    assert!(
        registered_devices()
            .unwrap()
            .iter()
            .all(|device| device.hwndTarget != retired)
    );
    prior.stop().unwrap();
}

const SNAPSHOT: u32 = WM_APP + 1;
const TOGGLE: u32 = WM_APP + 2;
const FINISH: u32 = WM_APP + 3;

// Test-only DirectInput COM boundary. Typed bindings own interface references;
// preserve the reproduction's real foreground-exclusive acquisition.
use windows::{
    Win32::{
        Devices::HumanInterfaceDevice::{
            DIDATAFORMAT, DISCL_EXCLUSIVE, DISCL_FOREGROUND, DirectInput8Create, IDirectInput8W,
            IDirectInputDevice8W,
        },
        Foundation::{HINSTANCE, HWND as ComHwnd},
    },
    core::{GUID, IUnknown, Interface},
};

#[link(name = "dinput8", kind = "static")]
#[link(name = "dxguid", kind = "static")]
unsafe extern "system" {
    static c_dfDIKeyboard: DIDATAFORMAT;
    static c_dfDIMouse2: DIDATAFORMAT;
}
struct ExclusiveInput {
    devices: Vec<IDirectInputDevice8W>,
    _direct: IDirectInput8W,
}
impl ExclusiveInput {
    fn create(hwnd: HWND) -> Self {
        let mut direct: Option<IDirectInput8W> = None;
        unsafe {
            DirectInput8Create(
                HINSTANCE(GetModuleHandleW(null_mut())),
                0x800,
                &IDirectInput8W::IID,
                std::ptr::from_mut(&mut direct).cast(),
                None::<&IUnknown>,
            )
            .expect("DirectInput test interface creation");
        }
        let mut input = Self {
            devices: Vec::new(),
            _direct: direct.expect("DirectInput returned no test interface"),
        };
        for (index, guid) in [
            0x6f1d2b61_d5a0_11cf_bfc7_444553540000,
            0x6f1d2b60_d5a0_11cf_bfc7_444553540000,
        ]
        .into_iter()
        .enumerate()
        {
            let mut device = None;
            unsafe {
                input
                    ._direct
                    .CreateDevice(&GUID::from_u128(guid), &mut device, None::<&IUnknown>)
                    .expect("DirectInput test device creation");
            }
            input
                .devices
                .push(device.expect("DirectInput returned no test device"));
            let device = input.devices.last().unwrap();
            unsafe {
                let mut format = if index == 0 {
                    c_dfDIKeyboard
                } else {
                    c_dfDIMouse2
                };
                device
                    .SetDataFormat(&mut format)
                    .expect("DirectInput test data format");
                device
                    .SetCooperativeLevel(ComHwnd(hwnd), DISCL_EXCLUSIVE | DISCL_FOREGROUND)
                    .expect("DirectInput test exclusive foreground level");
            }
        }
        input
    }
    fn acquire(hwnd: HWND) -> Self {
        let input = Self::create(hwnd);
        for device in &input.devices {
            unsafe { device.Acquire() }.expect("DirectInput test exclusive acquire");
        }
        println!("typed DirectInput exclusive keyboard/mouse acquired");
        input
    }
}
#[test]
fn typed_directinput_creates_and_configures_owned_devices() {
    let owner = OwnedWindow::new(DefWindowProcW, true);
    let input = ExclusiveInput::create(owner.hwnd);
    assert_eq!(input.devices.len(), 2);
}
impl Drop for ExclusiveInput {
    fn drop(&mut self) {
        for device in &self.devices {
            let _ = unsafe { device.Unacquire() };
        }
        // Release devices before the parent interface, including partial setup.
        self.devices.clear();
    }
}
thread_local! {
    static FOREGROUND: RefCell<usize> = const { RefCell::new(0) };
    static FILTER: RefCell<bool> = const { RefCell::new(false) };
    static PROBE: RefCell<Option<(HookListener, mpsc::Receiver<InputMessage>)>> = const { RefCell::new(None) };
    static PHASES: RefCell<Vec<(usize, usize, [usize; 4], DeviceInputState, usize)>> = const { RefCell::new(Vec::new()) };
}

unsafe extern "system" fn filter(code: i32, w: usize, l: isize) -> isize {
    if code == HC_ACTION as i32
        && FILTER.with_borrow(|active| *active)
        && unsafe { GetForegroundWindow() } as usize == FOREGROUND.with_borrow(|hwnd| *hwnd)
    {
        return 1;
    }
    unsafe { CallNextHookEx(null_mut(), code, w, l) }
}

unsafe extern "system" fn probe_proc(hwnd: HWND, m: u32, w: usize, l: isize) -> isize {
    if m == SNAPSHOT {
        PROBE.with_borrow(|slot| {
            let (listener, events) = slot.as_ref().unwrap();
            let input = received(events);
            let keys = input
                .iter()
                .filter(|input| {
                    matches!(input.0, EventType::KeyPress(_) | EventType::KeyRelease(_))
                })
                .count();
            let buttons = input
                .iter()
                .filter(|input| {
                    matches!(
                        input.0,
                        EventType::ButtonPress(_) | EventType::ButtonRelease(_)
                    )
                })
                .count();
            let (_, sources) = inspect_raw(listener);
            let state = listener.state().unwrap();
            println!(
                "phase {w}: semantic={keys}/{buttons}, hook/raw={sources:?}, mouse={}",
                state.mouse_enabled
            );
            let pointers = input
                .iter()
                .filter(|input| matches!(input.0, EventType::MouseMove { .. }))
                .count();
            PHASES.with_borrow_mut(|phases| phases.push((keys, buttons, sources, state, pointers)));
        });
        return 0;
    }
    if m == TOGGLE {
        PROBE.with_borrow(|slot| {
            let listener = &slot.as_ref().unwrap().0;
            for enabled in if w == 0 {
                vec![false]
            } else {
                vec![true, false, true]
            } {
                listener.configure(enabled).unwrap();
            }
        });
        return 0;
    }
    unsafe { DefWindowProcW(hwnd, m, w, l) }
}

fn pump(duration: Duration) {
    let until = Instant::now() + duration;
    while Instant::now() < until {
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) } != 0 {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
}

struct OwnedWindow {
    hwnd: HWND,
    class: Vec<u16>,
    previous: HWND,
    cursor: POINT,
    moved_cursor: Option<POINT>,
    hooks: [HHOOK; 2],
}
impl OwnedWindow {
    fn new(
        proc: unsafe extern "system" fn(HWND, u32, usize, isize) -> isize,
        visible: bool,
    ) -> Self {
        Self::named(
            proc,
            visible,
            &format!("BlockPetInputTest{}{}\0", std::process::id(), unsafe {
                GetCurrentThreadId()
            }),
        )
    }

    fn named(
        proc: unsafe extern "system" fn(HWND, u32, usize, isize) -> isize,
        visible: bool,
        name: &str,
    ) -> Self {
        let class: Vec<u16> = name.encode_utf16().collect();
        let previous = unsafe { GetForegroundWindow() };
        let mut cursor = POINT::default();
        unsafe {
            GetCursorPos(&mut cursor);
        }
        let instance = unsafe { GetModuleHandleW(null_mut()) };
        let wc = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            ..Default::default()
        };
        assert_ne!(unsafe { RegisterClassW(&wc) }, 0);
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                if visible { WS_POPUP | WS_VISIBLE } else { 0 },
                0,
                0,
                GetSystemMetrics(SM_CXSCREEN),
                GetSystemMetrics(SM_CYSCREEN),
                if visible { null_mut() } else { HWND_MESSAGE },
                null_mut(),
                instance,
                null_mut(),
            )
        };
        assert!(!hwnd.is_null());
        Self {
            hwnd,
            class,
            previous,
            cursor,
            moved_cursor: None,
            hooks: [null_mut(); 2],
        }
    }

    fn guard_pointer(&self) -> POINT {
        assert_eq!(
            unsafe { GetForegroundWindow() },
            self.hwnd,
            "owned foreground required"
        );
        let mut point = POINT::default();
        assert_ne!(unsafe { GetCursorPos(&mut point) }, 0);
        assert_eq!(
            unsafe { WindowFromPoint(point) },
            self.hwnd,
            "mouse input must hit the owned window"
        );
        let mut rect = windows_sys::Win32::Foundation::RECT::default();
        assert_ne!(unsafe { GetClientRect(self.hwnd, &mut rect) }, 0);
        let mut origin = POINT::default();
        assert_ne!(unsafe { ClientToScreen(self.hwnd, &mut origin) }, 0);
        assert!(
            point.x >= origin.x
                && point.x < origin.x + rect.right
                && point.y >= origin.y
                && point.y < origin.y + rect.bottom,
            "owned client bounds required"
        );
        point
    }

    fn position_pointer(&mut self) {
        assert_eq!(unsafe { GetForegroundWindow() }, self.hwnd);
        let mut rect = windows_sys::Win32::Foundation::RECT::default();
        assert_ne!(unsafe { GetClientRect(self.hwnd, &mut rect) }, 0);
        let point = [1, 2, 3]
            .into_iter()
            .flat_map(|x| [1, 2, 3].map(|y| (x, y)))
            .find_map(|(x, y)| {
                let mut point = POINT {
                    x: rect.right * x / 4,
                    y: rect.bottom * y / 4,
                };
                assert_ne!(unsafe { ClientToScreen(self.hwnd, &mut point) }, 0);
                (unsafe { WindowFromPoint(point) } == self.hwnd).then_some(point)
            })
            .expect("an unobstructed owned client point is required");
        assert_ne!(unsafe { SetCursorPos(point.x, point.y) }, 0);
        self.moved_cursor = Some(point);
        let observed = self.guard_pointer();
        assert_eq!((observed.x, observed.y), (point.x, point.y));
    }
    fn inject(&self, packet: bool, repeats: bool) {
        self.inject_at(packet, repeats, 0);
    }

    fn inject_at(&self, packet: bool, repeats: bool, time: u32) {
        // Check foreground ownership before every synthetic batch. This is not
        // hardware input, a game injection, or an installed-app test.
        assert_eq!(unsafe { GetForegroundWindow() }, self.hwnd);
        self.guard_pointer();
        let key = |up| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: if packet { 0 } else { 0x41 },
                    wScan: if packet { 0x46 } else { 0 },
                    dwFlags: if packet { KEYEVENTF_UNICODE } else { 0 }
                        | if up { KEYEVENTF_KEYUP } else { 0 },
                    time,
                    ..Default::default()
                },
            },
        };
        let mouse = |up| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                mi: MOUSEINPUT {
                    dwFlags: if up {
                        MOUSEEVENTF_LEFTUP
                    } else {
                        MOUSEEVENTF_LEFTDOWN
                    },
                    time,
                    ..Default::default()
                },
            },
        };
        let input = if packet {
            vec![key(false), key(true)]
        } else if repeats {
            vec![key(false), key(false), key(true)]
        } else {
            vec![key(false), key(true), mouse(false), mouse(true)]
        };
        assert_eq!(
            unsafe {
                SendInput(
                    input.len() as u32,
                    input.as_ptr(),
                    std::mem::size_of::<INPUT>() as i32,
                )
            },
            input.len() as u32
        );
    }
}
impl OwnedWindow {
    fn move_pointer(&mut self) {
        let before = self.guard_pointer();
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 1,
                    dy: 0,
                    dwFlags: MOUSEEVENTF_MOVE,
                    ..Default::default()
                },
            },
        };
        assert_eq!(
            unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) },
            1
        );
        pump(Duration::from_millis(30));
        let after = self.guard_pointer();
        assert!(after.x >= before.x && after.x <= before.x + 10 && after.y == before.y);
        self.moved_cursor = Some(after);
    }
}

impl Drop for OwnedWindow {
    fn drop(&mut self) {
        let restore = unsafe { GetForegroundWindow() } == self.hwnd;
        let mut point = POINT::default();
        let restore_cursor = restore
            && unsafe { GetCursorPos(&mut point) } != 0
            && self
                .moved_cursor
                .is_some_and(|last| (last.x, last.y) == (point.x, point.y))
            && unsafe { WindowFromPoint(point) } == self.hwnd;
        for hook in self.hooks {
            if !hook.is_null() {
                unsafe {
                    UnhookWindowsHookEx(hook);
                }
            }
        }
        if restore_cursor {
            unsafe {
                SetCursorPos(self.cursor.x, self.cursor.y);
            }
        }
        unsafe {
            DestroyWindow(self.hwnd);
            UnregisterClassW(self.class.as_ptr(), GetModuleHandleW(null_mut()));
        }
        if restore {
            unsafe {
                SetForegroundWindow(self.previous);
            }
        }
    }
}

#[test]
#[ignore = "child process helper, invoked only by the owned foreground regression"]
fn owned_foreground_child() {
    use std::io::Read;
    // Parent grants foreground permission to this exact process before startup.
    std::io::stdin().read_exact(&mut [0_u8]).unwrap();
    let parent: usize = std::env::var("BLOCK_PET_INPUT_PROBE_PARENT")
        .unwrap()
        .parse()
        .unwrap();
    let mut owned = OwnedWindow::new(DefWindowProcW, true);
    unsafe {
        assert_ne!(
            SetWindowPos(
                owned.hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
            ),
            0
        );
        assert_ne!(
            SetForegroundWindow(owned.hwnd),
            0,
            "owned foreground activation required"
        );
    }
    pump(Duration::from_millis(180));
    owned.position_pointer();
    let snapshot = |phase| {
        pump(Duration::from_millis(100));
        unsafe {
            SendMessageW(parent as HWND, SNAPSHOT, phase, 0);
        }
    };
    snapshot(0);
    for _ in 0..4 {
        owned.inject(false, false);
        pump(Duration::from_millis(30));
    }
    snapshot(1);
    let mut exclusive = Some(ExclusiveInput::acquire(owned.hwnd));
    pump(Duration::from_millis(80));
    FOREGROUND.set(owned.hwnd as usize);
    FILTER.set(true);
    owned.hooks = unsafe {
        [
            SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(filter),
                GetModuleHandleW(null_mut()),
                0,
            ),
            SetWindowsHookExW(WH_MOUSE_LL, Some(filter), GetModuleHandleW(null_mut()), 0),
        ]
    };
    assert!(owned.hooks.iter().all(|hook| !hook.is_null()));
    for _ in 0..4 {
        owned.inject(false, false);
        pump(Duration::from_millis(30));
    }
    snapshot(2);
    // Keep the filter hooks and listener registered. Relinquish foreground
    // DirectInput acquisition as a game does on leaving foreground, and clear
    // the foreground filter gate without restarting the background collector.
    drop(exclusive.take());
    FILTER.set(false);
    for _ in 0..4 {
        owned.inject(false, false);
        pump(Duration::from_millis(30));
    }
    snapshot(3);
    exclusive = Some(ExclusiveInput::acquire(owned.hwnd));
    FILTER.set(true);
    unsafe {
        SendMessageW(parent as HWND, TOGGLE, 0, 0);
    }
    pump(Duration::from_millis(30));
    owned.move_pointer();
    for _ in 0..4 {
        owned.inject(false, false);
        pump(Duration::from_millis(30));
    }
    snapshot(4);
    unsafe {
        SendMessageW(parent as HWND, TOGGLE, 1, 0);
    }
    pump(Duration::from_millis(30));
    for _ in 0..4 {
        owned.inject(false, false);
        pump(Duration::from_millis(30));
    }
    snapshot(5);
    drop(exclusive.take());
    FILTER.set(false);
    owned.inject(false, true);
    owned.inject(true, false);
    snapshot(6);
    exclusive = Some(ExclusiveInput::acquire(owned.hwnd));
    FILTER.set(true);
    unsafe {
        SendMessageW(parent as HWND, TOGGLE, 1, 0);
    }
    pump(Duration::from_millis(30));
    owned.inject_at(false, false, unsafe { GetTickCount() }.wrapping_sub(1000));
    snapshot(7);
    drop(exclusive.take());
    unsafe {
        SendMessageW(parent as HWND, FINISH, 0, 0);
    }
}

#[test]
fn actual_win32_raw_sink_survives_foreground_consumption_without_duplicates() {
    let owner = OwnedWindow::new(probe_proc, false);
    let (sender, events) = mpsc::channel();
    let (listener, initial) = HookListener::start(true, sender).unwrap();
    PROBE.set(Some((listener, events)));
    PHASES.set(Vec::new());
    let child_test = format!(
        "{}::owned_foreground_child",
        module_path!().split_once("::").unwrap().1
    );
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &child_test, "--ignored", "--nocapture"])
        .env(
            "BLOCK_PET_INPUT_PROBE_PARENT",
            (owner.hwnd as usize).to_string(),
        )
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let granted = unsafe { AllowSetForegroundWindow(child.id()) };
    if granted == 0 {
        let _ = child.kill();
        let mut listener = PROBE.take().unwrap().0;
        listener.stop().unwrap();
        panic!("controlled desktop foreground permission required");
    }
    use std::io::Write;
    child.stdin.take().unwrap().write_all(&[1]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        pump(Duration::from_millis(5));
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            child.kill().unwrap();
            panic!("owned child timed out");
        }
    };
    let mut listener = PROBE.take().unwrap().0;
    let retired = inspect_raw(&listener).0 as HWND;
    assert!(!listener.is_finished());
    listener.stop().unwrap();
    assert!(status.success());
    PHASES.with_borrow(|phases| {
        assert_eq!(phases.len(), 8);
        for phase in [1, 2, 3, 5] {
            assert_eq!((phases[phase].0, phases[phase].1), (8, 8), "phase {phase}");
        }
        assert_eq!(
            phases[1].2,
            [8, 8, 8, 8],
            "both APIs really delivered, one semantic copy"
        );
        assert_eq!(
            phases[2].2,
            [0, 0, 8, 8],
            "later foreground hook consumed only hook delivery"
        );
        assert_eq!(
            phases[3].2,
            [8, 8, 8, 8],
            "same hooks resumed after gate changed"
        );
        assert_eq!(phases[3].3, initial, "no restart or new mouse generation");
        assert_eq!((phases[4].0, phases[4].1), (8, 0));
        assert!(
            phases[4].4 > 0,
            "raw pointer survives mouse OFF with consuming hooks"
        );
        assert_eq!(
            (phases[6].0, phases[6].1),
            (5, 0),
            "two presses + release and Unicode packet pair"
        );
        assert_eq!(
            phases[7].2,
            [0, 0, 2, 2],
            "backdated synthetic input really reaches Raw Input"
        );
        assert_eq!(
            (phases[7].0, phases[7].1),
            (2, 0),
            "old mouse messages cannot enter the new generation; keys survive mouse-only toggle"
        );
    });
    assert!(
        registered_devices()
            .unwrap()
            .iter()
            .all(|device| device.hwndTarget != retired)
    );
}
