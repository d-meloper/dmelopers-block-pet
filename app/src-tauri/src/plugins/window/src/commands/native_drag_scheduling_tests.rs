use super::*;
use std::sync::atomic::AtomicUsize;
use windows::Win32::UI::{
    Shell::GetWindowSubclass,
    WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, HWND_MESSAGE, MSG, PM_REMOVE,
        PeekMessageW, WINDOW_EX_STYLE, WINDOW_STYLE,
    },
};

static TEST_LOCK: Mutex<()> = Mutex::new(());
static RUNS: AtomicUsize = AtomicUsize::new(0);

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
    fn dispatch_installed(&self) -> bool {
        let mut generation = 0;
        unsafe {
            GetWindowSubclass(
                self.0,
                Some(dispatch_queued_drag),
                DRAG_DISPATCH_SUBCLASS,
                Some(&mut generation),
            )
            .as_bool()
        }
    }
}
impl Drop for TestWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

fn simulated_run(_hwnd: HWND, keep_in_screen: bool) -> Result<(), String> {
    assert!(keep_in_screen);
    assert!(
        DragOwner::acquire().is_err(),
        "a running drag retains exclusive ownership"
    );
    RUNS.fetch_add(1, Ordering::SeqCst);
    Ok(())
}
fn failed_run(_hwnd: HWND, _keep_in_screen: bool) -> Result<(), String> {
    Err("native cancellation fixture".into())
}
fn request(
    run: fn(HWND, bool) -> Result<(), String>,
) -> (
    QueuedDrag,
    tauri::async_runtime::Receiver<Result<(), String>>,
) {
    let (completion, receiver) = tauri::async_runtime::channel(1);
    (
        QueuedDrag {
            hwnd: 0,
            generation: DRAG_GENERATION
                .fetch_add(1, Ordering::Relaxed)
                .wrapping_add(1),
            keep_in_screen: true,
            completion,
            run,
            _owner: DragOwner::acquire().unwrap(),
        },
        receiver,
    )
}

#[test]
fn native_drag_posted_dispatch_retains_completion_owner_and_rejects_repeated_start() {
    let _serial = TEST_LOCK.lock().unwrap();
    RUNS.store(0, Ordering::SeqCst);
    let window = TestWindow::new();
    let (queued, mut completion) = request(simulated_run);
    let generation = queued.generation;
    queue_drag(window.0, queued);
    assert!(
        completion.try_recv().is_err(),
        "posting is not native drag completion"
    );
    assert!(DragOwner::acquire().is_err());
    assert!(window.dispatch_installed());
    window.pump();
    assert_eq!(completion.try_recv().unwrap(), Ok(()));
    assert!(!window.dispatch_installed());
    unsafe {
        dispatch_queued_drag(
            window.0,
            drag_start_message(),
            WPARAM(generation),
            LPARAM(0),
            DRAG_DISPATCH_SUBCLASS,
            generation,
        );
    }
    assert_eq!(RUNS.load(Ordering::SeqCst), 1);
    assert!(DragOwner::acquire().is_ok());
}

#[test]
fn native_drag_destroy_before_start_releases_request_without_running_it() {
    let _serial = TEST_LOCK.lock().unwrap();
    RUNS.store(0, Ordering::SeqCst);
    let window = TestWindow::new();
    let (queued, mut completion) = request(simulated_run);
    queue_drag(window.0, queued);
    drop(window);
    assert!(completion.try_recv().unwrap().is_err());
    assert_eq!(RUNS.load(Ordering::SeqCst), 0);
    assert!(DragOwner::acquire().is_ok());
}

#[test]
fn native_drag_closed_receiver_and_invalid_window_release_request() {
    let _serial = TEST_LOCK.lock().unwrap();
    RUNS.store(0, Ordering::SeqCst);
    let window = TestWindow::new();
    let (queued, completion) = request(simulated_run);
    drop(completion);
    queue_drag(window.0, queued);
    assert!(!window.dispatch_installed());
    assert!(DragOwner::acquire().is_ok());
    let (queued, mut completion) = request(simulated_run);
    queue_drag(HWND::default(), queued);
    assert!(completion.try_recv().unwrap().is_err());
    assert_eq!(RUNS.load(Ordering::SeqCst), 0);
    assert!(DragOwner::acquire().is_ok());
}

#[test]
fn native_drag_failed_post_removes_dispatch_and_releases_completion_owner() {
    let _serial = TEST_LOCK.lock().unwrap();
    RUNS.store(0, Ordering::SeqCst);
    let window = TestWindow::new();
    let (queued, mut completion) = request(simulated_run);
    queue_drag_with_post(window.0, queued, |_, _, _| Err("post fixture".into()));
    assert_eq!(completion.try_recv().unwrap(), Err("post fixture".into()));
    assert!(!window.dispatch_installed());
    assert_eq!(RUNS.load(Ordering::SeqCst), 0);
    assert!(DragOwner::acquire().is_ok());
}

#[test]
fn native_drag_old_start_message_cannot_consume_a_new_request() {
    let _serial = TEST_LOCK.lock().unwrap();
    RUNS.store(0, Ordering::SeqCst);
    let window = TestWindow::new();
    let (queued, mut completion) = request(simulated_run);
    let generation = queued.generation;
    queue_drag(window.0, queued);
    unsafe {
        SendMessageW(
            window.0,
            drag_start_message(),
            Some(WPARAM(generation.wrapping_sub(1))),
            Some(LPARAM(0)),
        );
    }
    assert!(completion.try_recv().is_err());
    assert_eq!(RUNS.load(Ordering::SeqCst), 0);
    window.pump();
    assert_eq!(completion.try_recv().unwrap(), Ok(()));
    assert_eq!(RUNS.load(Ordering::SeqCst), 1);
}

#[test]
fn native_drag_hidden_quick_release_and_failure_leave_no_dispatch_or_owner() {
    let _serial = TEST_LOCK.lock().unwrap();
    let window = TestWindow::new();
    let (queued, mut completion) = request(drag_until_released);
    queue_drag(window.0, queued);
    window.pump();
    assert_eq!(completion.try_recv().unwrap(), Ok(()));
    assert!(!window.dispatch_installed());
    let (queued, mut completion) = request(failed_run);
    queue_drag(window.0, queued);
    window.pump();
    assert_eq!(
        completion.try_recv().unwrap(),
        Err("native cancellation fixture".into())
    );
    assert!(!window.dispatch_installed());
    assert!(DragOwner::acquire().is_ok());
}
