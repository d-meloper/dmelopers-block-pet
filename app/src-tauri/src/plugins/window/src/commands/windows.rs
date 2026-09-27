use super::topmost::{TopmostChange, TopmostRequest, maintain_topmost, reconcile_window_order};
use super::{MAIN_WINDOW_LABEL, PREFERENCE_WINDOW_LABEL};
use std::sync::{OnceLock, mpsc};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, WindowEvent, command};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    ICoreWebView2_19,
};
use windows::Win32::Foundation::{GetLastError, HWND, SetLastError, WIN32_ERROR};
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetForegroundWindow, GetWindowLongW, HWND_NOTOPMOST, HWND_TOPMOST, IsIconic,
    IsWindowVisible, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos, WS_EX_NOACTIVATE, WS_EX_TOPMOST,
};
use windows::core::Interface;

static TOPMOST_REQUESTS: OnceLock<mpsc::Sender<TopmostRequest>> = OnceLock::new();

fn read_topmost(hwnd: isize) -> Option<bool> {
    unsafe {
        // Zero is a valid style value; clear last-error to distinguish read failure.
        SetLastError(WIN32_ERROR(0));
        let style = GetWindowLongW(HWND(hwnd as *mut _), GWL_EXSTYLE);
        if style == 0 && GetLastError() != WIN32_ERROR(0) {
            return None;
        }
        Some(style as u32 & WS_EX_TOPMOST.0 != 0)
    }
}

fn preference_available(hwnd: isize) -> bool {
    let hwnd = HWND(hwnd as *mut _);
    unsafe {
        IsWindowVisible(hwnd).as_bool()
            && !IsIconic(hwnd).as_bool()
            && GetForegroundWindow() == hwnd
    }
}

fn write_topmost(hwnd: isize, topmost: bool) -> Result<(), String> {
    unsafe {
        SetWindowPos(
            HWND(hwnd as *mut _),
            Some(if topmost {
                HWND_TOPMOST
            } else {
                HWND_NOTOPMOST
            }),
            0,
            0,
            0,
            0,
            // Changing levels must neither focus nor reveal either window.
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|error| {
            super::warn("window.topmost_write", &format!("HRESULT_0x{:08X}", error.code().0 as u32));
            error.to_string()
        })?;
    }
    if read_topmost(hwnd) == Some(topmost) {
        Ok(())
    } else {
        super::warn("window.topmost_verify", "STATE_MISMATCH");
        Err("The native window level did not match the requested state.".into())
    }
}

fn topmost_requests() -> &'static mpsc::Sender<TopmostRequest> {
    TOPMOST_REQUESTS.get_or_init(|| {
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            maintain_topmost(receiver, |state| {
                reconcile_window_order(state, preference_available, read_topmost, write_topmost)
            })
        });
        sender
    })
}

fn update_main_topmost<R: Runtime>(window: &WebviewWindow<R>, change: TopmostChange) {
    let Ok(hwnd) = window.hwnd() else {
        super::warn("window.topmost_request", "WINDOW_HANDLE_UNAVAILABLE");
        return;
    };
    if topmost_requests().send(TopmostRequest {
        hwnd: hwnd.0 as isize,
        change,
        completion: None,
    }).is_err() {
        super::warn("window.topmost_request", "WORKER_QUEUE_UNAVAILABLE");
    }
}

fn preference_focus_change(label: &str, event: &WindowEvent) -> Option<bool> {
    if label != PREFERENCE_WINDOW_LABEL {
        return None;
    }
    match event {
        WindowEvent::Focused(focused) => Some(*focused),
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => Some(false),
        _ => None,
    }
}

pub fn handle_preference_focus<R: Runtime>(app: &AppHandle<R>, label: &str, event: &WindowEvent) {
    let Some(focused) = preference_focus_change(label, event) else {
        return;
    };
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        update_main_topmost(&main, TopmostChange::PreferenceFocused(focused));
    }
}

pub(crate) fn set_windows_webview_memory_active<R: Runtime>(
    window: &WebviewWindow<R>,
    active: bool,
) -> Result<(), String> {
    let label = window.label().to_owned();
    super::record_memory_request(&label, active);
    window
        .with_webview(move |webview| {
            // Resolve the current owner inside the scheduled native callback.
            // A queued hide must not suspend a newly acquired recovery lease.
            let level = if super::effective_memory_active(&label, active) {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            };
            let result = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|webview| webview.cast::<ICoreWebView2_19>())
                    .and_then(|webview| webview.SetMemoryUsageTargetLevel(level))
            };
            if let Err(error) = result {
                super::warn("window.webview_memory", &format!("HRESULT_0x{:08X}", error.code().0 as u32));
            }
        })
        .map_err(|error| {
            super::warn("window.webview_memory_dispatch", "WEBVIEW_UNAVAILABLE");
            error.to_string()
        })
}

fn with_unfocused_presentation(
    was_focusable: bool,
    mut set_focusable: impl FnMut(bool) -> Result<(), String>,
    show: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if was_focusable {
        set_focusable(false)?;
    }
    let result = show();
    // Always restore interaction, including when showing or unminimizing failed.
    let restored = if was_focusable { set_focusable(true) } else { Ok(()) };
    result.and(restored)
}

fn present_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    window.show().map_err(|_| {
        super::warn("window.show", "NATIVE_OPERATION_FAILED");
        "WINDOW_SHOW_FAILED".to_owned()
    })?;
    window.unminimize().map_err(|_| {
        super::warn("window.unminimize", "NATIVE_OPERATION_FAILED");
        "WINDOW_RESTORE_FAILED".to_owned()
    })
}

#[command]
pub async fn show_window<R: Runtime>(
    _app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    focus: Option<bool>,
) -> Result<(), String> {
    let _ = set_windows_webview_memory_active(&window, true);
    if !focus.unwrap_or(true) && window.label() == MAIN_WINDOW_LABEL {
        let visible = window.is_visible().map_err(|_| "WINDOW_VISIBILITY_FAILED".to_owned())?;
        let minimized = window.is_minimized().map_err(|_| "WINDOW_MINIMIZED_STATE_FAILED".to_owned())?;
        if visible && !minimized {
            return Ok(());
        }
        // Tao's show itself uses SW_SHOW. Merely omitting set_focus still activates.
        // Normalize to hidden before changing focusability: a visible style change
        // can itself issue SW_SHOW before it installs WS_EX_NOACTIVATE.
        if visible {
            window.hide().map_err(|_| "WINDOW_HIDE_FAILED".to_owned())?;
        }
        let hwnd = window.hwnd().map_err(|_| "WINDOW_HANDLE_UNAVAILABLE".to_owned())?;
        let was_focusable = unsafe {
            SetLastError(WIN32_ERROR(0));
            let style = GetWindowLongW(HWND(hwnd.0 as *mut _), GWL_EXSTYLE);
            if style == 0 && GetLastError() != WIN32_ERROR(0) {
                return Err("WINDOW_FOCUSABILITY_FAILED".into());
            }
            style as u32 & WS_EX_NOACTIVATE.0 == 0
        };
        with_unfocused_presentation(was_focusable, |focusable| {
            window.set_focusable(focusable).map_err(|_| {
                super::warn("window.focusability", "NATIVE_OPERATION_FAILED");
                "WINDOW_FOCUSABILITY_FAILED".to_owned()
            })
        }, || present_window(&window))?;
    } else {
        present_window(&window)?;
    }
    if focus.unwrap_or(true) {
        window.set_focus().map_err(|_| {
            super::warn("window.focus", "NATIVE_OPERATION_FAILED");
            "WINDOW_FOCUS_FAILED".to_owned()
        })?;
    }
    if !window.is_visible().map_err(|_| {
        super::warn("window.visibility", "NATIVE_OPERATION_FAILED");
        "WINDOW_VISIBILITY_FAILED".to_owned()
    })? {
        super::warn("window.show", "STATE_MISMATCH");
        return Err("WINDOW_NOT_SHOWN".into());
    }
    if window.label() == PREFERENCE_WINDOW_LABEL {
        if window.emit("preference-visibility-changed", true).is_err() {
            super::warn("window.show_notify", "WINDOW_EVENT_FAILED");
        }
    }
    Ok(())
}

#[command]
pub async fn hide_window<R: Runtime>(_app_handle: AppHandle<R>, window: WebviewWindow<R>) -> Result<(), String> {
    window.hide().map_err(|_| {
        super::warn("window.hide", "NATIVE_OPERATION_FAILED");
        "WINDOW_HIDE_FAILED".to_owned()
    })?;
    if window.label() == PREFERENCE_WINDOW_LABEL {
        if let Some(main) = window.app_handle().get_webview_window(MAIN_WINDOW_LABEL) {
            update_main_topmost(&main, TopmostChange::PreferenceFocused(false));
        }
    }
    let _ = set_windows_webview_memory_active(&window, false);
    if window.is_visible().map_err(|_| {
        super::warn("window.visibility", "NATIVE_OPERATION_FAILED");
        "WINDOW_VISIBILITY_FAILED".to_owned()
    })? {
        super::warn("window.hide", "STATE_MISMATCH");
        return Err("WINDOW_NOT_HIDDEN".into());
    }
    if window.label() == PREFERENCE_WINDOW_LABEL {
        if window.emit("preference-visibility-changed", false).is_err() {
            super::warn("window.hide_notify", "WINDOW_EVENT_FAILED");
        }
    }
    Ok(())
}

#[command]
pub async fn set_color_picker_open<R: Runtime>(
    window: WebviewWindow<R>,
    open: bool,
) -> Result<(), String> {
    let result: Result<(), String> = async {
        if window.label() != PREFERENCE_WINDOW_LABEL {
            return Err("Only the preference window can open a color picker.".into());
        }
        let preference_hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        if open && !preference_available(preference_hwnd) {
            return Err("The color picker requires a visible, focused preference window.".into());
        }
        let main = window
            .app_handle()
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or("The pet window is unavailable.")?;
        let hwnd = main.hwnd().map_err(|error| error.to_string())?.0 as isize;
        let (completion, completed) = mpsc::channel();
        topmost_requests()
            .send(TopmostRequest {
                hwnd,
                change: TopmostChange::ColorPicker(open.then_some(preference_hwnd)),
                completion: Some(completion),
            })
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            completed.recv().map_err(|error| error.to_string())?
        })
        .await
        .map_err(|error| error.to_string())?
    }.await;
    if let Err(error) = &result {
        // Losing focus during a queued popup request is an ordinary cancellation.
        if error != "The color picker requires a visible, focused preference window." {
            super::warn("window.color_picker_order", "NATIVE_OPERATION_FAILED");
        }
    }
    result
}

#[command]
pub async fn set_always_on_top<R: Runtime>(
    _app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    always_on_top: bool,
) {
    if window.label() == MAIN_WINDOW_LABEL {
        update_main_topmost(&window, TopmostChange::AlwaysOnTop(always_on_top));
    } else {
        if window.set_always_on_top(always_on_top).is_err() {
            super::warn("window.topmost", "NATIVE_OPERATION_FAILED");
        }
    }
}

#[command]
pub async fn set_taskbar_visibility<R: Runtime>(window: WebviewWindow<R>, visible: bool) {
    if window.set_skip_taskbar(!visible).is_err() {
        super::warn("window.taskbar", "NATIVE_OPERATION_FAILED");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfocused_presentation_restores_focusability_on_success_and_failure() {
        use std::cell::RefCell;
        for failed in [false, true] {
            let changes = RefCell::new(Vec::new());
            let result = with_unfocused_presentation(true, |value| {
                changes.borrow_mut().push(value);
                Ok(())
            }, || {
                assert_eq!(*changes.borrow(), [false]);
                if failed { Err("SHOW_FAILED".into()) } else { Ok(()) }
            });
            assert_eq!(*changes.borrow(), [false, true]);
            assert_eq!(result.is_err(), failed);
        }
        let result = with_unfocused_presentation(false, |_| panic!("preserve original nonfocusability"), || Ok(()));
        assert!(result.is_ok());
        assert!(with_unfocused_presentation(true, |value| {
            if value { Err("RESTORE_FAILED".into()) } else { Ok(()) }
        }, || Ok(())).is_err());
    }

    #[test]
    fn only_preference_focus_and_end_events_change_the_temporary_reason() {
        assert_eq!(
            preference_focus_change(PREFERENCE_WINDOW_LABEL, &WindowEvent::Focused(true)),
            Some(true)
        );
        assert_eq!(
            preference_focus_change(PREFERENCE_WINDOW_LABEL, &WindowEvent::Focused(false)),
            Some(false)
        );
        assert_eq!(
            preference_focus_change(PREFERENCE_WINDOW_LABEL, &WindowEvent::Destroyed),
            Some(false)
        );
        assert_eq!(
            preference_focus_change(MAIN_WINDOW_LABEL, &WindowEvent::Focused(true)),
            None
        );
        assert_eq!(
            preference_focus_change(MAIN_WINDOW_LABEL, &WindowEvent::Focused(false)),
            None
        );
        assert_eq!(
            preference_focus_change(
                PREFERENCE_WINDOW_LABEL,
                &WindowEvent::Resized(tauri::PhysicalSize::new(800, 720))
            ),
            None
        );
    }
}
