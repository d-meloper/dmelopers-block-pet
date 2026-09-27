use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, async_runtime::spawn, command};

static UPDATE_RECOVERY_ACTIVE: AtomicBool = AtomicBool::new(false);
static MAIN_MEMORY_REQUEST: AtomicBool = AtomicBool::new(true);
static PREFERENCE_MEMORY_REQUEST: AtomicBool = AtomicBool::new(true);
pub fn hold_update_webviews(active: bool) {
    UPDATE_RECOVERY_ACTIVE.store(active, Ordering::SeqCst);
}
pub fn record_memory_request(label: &str, active: bool) {
    match label {
        "main" => MAIN_MEMORY_REQUEST.store(active, Ordering::SeqCst),
        "preference" => PREFERENCE_MEMORY_REQUEST.store(active, Ordering::SeqCst),
        _ => {}
    }
}
pub fn effective_memory_active(label: &str, requested: bool) -> bool {
    let current = match label {
        "main" => MAIN_MEMORY_REQUEST.load(Ordering::SeqCst),
        "preference" => PREFERENCE_MEMORY_REQUEST.load(Ordering::SeqCst),
        _ => requested,
    };
    current || (UPDATE_RECOVERY_ACTIVE.load(Ordering::SeqCst) && matches!(label, "main" | "preference"))
}

pub static MAIN_WINDOW_LABEL: &str = "main";
pub static PREFERENCE_WINDOW_LABEL: &str = "preference";

mod windows;

mod topmost;

mod drag;

mod drag_bounds;

pub use windows::*;

// The application's single diagnostic sink handles filtering and flood limits.
fn warn(operation: &'static str, code: &str) {
    log::warn!(target: "diagnostics", "operation={operation} code={code}");
}

pub fn set_webview_memory_active<R: Runtime>(
    window: &WebviewWindow<R>,
    active: bool,
) -> Result<(), String> {
    windows::set_windows_webview_memory_active(window, active)
}

#[command]
pub async fn drag_main_window<R: Runtime>(
    window: WebviewWindow<R>,
    keep_in_screen: bool,
) -> Result<(), String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("Only the main pet window can be dragged through this command.".into());
    }
    drag::run_main_window_drag(&window, keep_in_screen).await.inspect_err(|_| {
        warn("window.drag", "NATIVE_DRAG_FAILED");
    })
}

#[command]
pub async fn set_memory_active<R: Runtime>(
    window: WebviewWindow<R>,
    active: bool,
) -> Result<(), String> {
    set_webview_memory_active(&window, active)
}

pub fn show_main_window(app_handle: &AppHandle) {
    show_window_by_label(app_handle, MAIN_WINDOW_LABEL);
}

pub fn show_preference_window(app_handle: &AppHandle) {
    show_window_by_label(app_handle, PREFERENCE_WINDOW_LABEL);
}

fn show_window_by_label(app_handle: &AppHandle, label: &str) {
    let Some(window) = app_handle.get_webview_window(label) else {
        warn("window.show", "WINDOW_UNAVAILABLE");
        return;
    };

    let app_handle = app_handle.clone();

    spawn(async move {
        if show_window(app_handle, window, None).await.is_err() {
            warn("window.show", "NATIVE_OPERATION_FAILED");
        }
    });
}
