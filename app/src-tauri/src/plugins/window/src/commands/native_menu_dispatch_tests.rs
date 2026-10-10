use super::*;
use std::sync::{Arc, atomic::AtomicBool};
use windows::Win32::UI::{
    Shell::GetWindowSubclass,
    WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, HWND_MESSAGE, MSG, PM_REMOVE,
        PeekMessageW, WINDOW_EX_STYLE, WINDOW_STYLE,
    },
};

static SERIAL: Mutex<()> = Mutex::new(());

struct TestWindow(HWND);
impl TestWindow {
    fn new() -> Self {
        Self(unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                None,
                WINDOW_STYLE::default(),
                0,
                0,
                64,
                64,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
            .unwrap()
        })
    }
    fn pump(&self) {
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, Some(self.0), 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                DispatchMessageW(&message);
            }
        }
    }
    fn installed(&self) -> bool {
        unsafe { GetWindowSubclass(self.0, Some(dispatch_menu), DISPATCH_SUBCLASS, None).as_bool() }
    }
}
impl Drop for TestWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

#[test]
fn popup_completion_follows_native_return_and_duplicate_queue_preserves_the_first_owner() {
    let _serial = SERIAL.lock().unwrap();
    let window = TestWindow::new();
    let (completion, mut completed) = tauri::async_runtime::channel(1);
    let executed = Arc::new(AtomicBool::new(false));
    let ran = executed.clone();
    queue_menu(
        window.0,
        move || {
            ran.store(true, Ordering::SeqCst);
            Err("POPUP_FAILED".into())
        },
        completion,
    );
    assert!(window.installed());
    assert!(!executed.load(Ordering::SeqCst));
    assert!(
        completed.try_recv().is_err(),
        "posting must not acknowledge native menu completion"
    );
    let (second, mut rejected) = tauri::async_runtime::channel(1);
    queue_menu(window.0, || panic!("must preserve the first popup"), second);
    assert!(rejected.try_recv().unwrap().is_err());
    window.pump();
    assert!(executed.load(Ordering::SeqCst));
    assert_eq!(completed.try_recv(), Ok(Err("POPUP_FAILED".into())));
    assert!(!window.installed());
    assert!(PENDING.lock().unwrap().is_none());
}

#[test]
fn canceled_or_destroyed_owner_never_opens_a_late_popup() {
    let _serial = SERIAL.lock().unwrap();
    let window = TestWindow::new();
    let (completion, completed) = tauri::async_runtime::channel(1);
    queue_menu(
        window.0,
        || panic!("closed receiver cannot open a menu"),
        completion,
    );
    drop(completed);
    window.pump();
    assert!(!window.installed());
    assert!(PENDING.lock().unwrap().is_none());

    let retired = TestWindow::new();
    let (completion, mut completed) = tauri::async_runtime::channel(1);
    queue_menu(
        retired.0,
        || panic!("destroyed owner cannot open a menu"),
        completion,
    );
    drop(retired);
    assert_eq!(
        completed.try_recv(),
        Ok(Err("The pet menu was interrupted.".into()))
    );
    assert!(PENDING.lock().unwrap().is_none());
    let (completion, mut completed) = tauri::async_runtime::channel(1);
    queue_menu(window.0, || Ok(()), completion);
    window.pump();
    assert_eq!(
        completed.try_recv(),
        Ok(Ok(())),
        "retirement must permit the next menu"
    );
}

#[test]
fn failed_post_releases_the_popup_and_cannot_consume_a_new_generation() {
    let _serial = SERIAL.lock().unwrap();
    let window = TestWindow::new();
    let (completion, mut completed) = tauri::async_runtime::channel(1);
    let mut old = (0, 0);
    queue_menu_with_post(
        window.0,
        Box::new(|| panic!("failed post cannot open a menu")),
        completion,
        |message, generation| {
            old = (message, generation);
            Err("POST_FAILED".into())
        },
    );
    assert_eq!(completed.try_recv(), Ok(Err("POST_FAILED".into())));
    assert!(!window.installed());
    assert!(PENDING.lock().unwrap().is_none());
    let (completion, mut completed) = tauri::async_runtime::channel(1);
    queue_menu_with_post(
        window.0,
        Box::new(|| Ok(())),
        completion,
        |message, generation| unsafe {
            PostMessageW(Some(window.0), old.0, WPARAM(old.1), LPARAM(0)).unwrap();
            PostMessageW(Some(window.0), message, WPARAM(generation), LPARAM(0))
                .map_err(|error| error.to_string())
        },
    );
    window.pump();
    assert_eq!(completed.try_recv(), Ok(Ok(())));
    assert!(!window.installed());
    assert!(PENDING.lock().unwrap().is_none());
}
