use tauri::{AppHandle, WebviewWindow};

pub fn default(
    _app_handle: &AppHandle,
    _main_window: WebviewWindow,
    _preference_window: WebviewWindow,
) {
    #[cfg(debug_assertions)]
    _main_window.open_devtools();
}
