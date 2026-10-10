use super::activation::without_activation;
use super::topmost::{TopmostChange, TopmostRequest, maintain_topmost, reconcile_window_order};
use super::{MAIN_WINDOW_LABEL, PREFERENCE_WINDOW_LABEL};
use std::sync::{Arc, OnceLock, mpsc, atomic::{AtomicBool, Ordering}};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, WindowEvent, command};
use tauri::menu::{ContextMenu, Menu};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    ICoreWebView2_19,
};
use windows::Win32::Foundation::{GetLastError, HWND, SetLastError, WIN32_ERROR};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_COLOR_DEFAULT};
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetForegroundWindow, GetWindowLongW, GetWindowThreadProcessId,
    HWND_NOTOPMOST, HWND_TOPMOST, IsIconic, IsWindow,
    IsWindowVisible, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowLongW, SetWindowPos, WS_EX_NOACTIVATE, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};
use windows::core::Interface;

static TOPMOST_REQUESTS: OnceLock<mpsc::Sender<TopmostRequest>> = OnceLock::new();
static PET_MENU_ACTIVE: AtomicBool = AtomicBool::new(false);

struct PetMenuOwner;
impl PetMenuOwner {
    fn acquire() -> Result<Self, String> {
        PET_MENU_ACTIVE.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "PET_MENU_ALREADY_ACTIVE".to_owned())?;
        Ok(Self)
    }
}
impl Drop for PetMenuOwner {
    fn drop(&mut self) {
        PET_MENU_ACTIVE.store(false, Ordering::SeqCst);
    }
}

fn read_extended_style(hwnd: HWND) -> Result<u32, String> {
    unsafe {
        SetLastError(WIN32_ERROR(0));
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if style == 0 && GetLastError() != WIN32_ERROR(0) {
            return Err("WINDOW_STYLE_READ_FAILED".into());
        }
        Ok(style as u32)
    }
}

fn write_extended_style(hwnd: HWND, style: u32) -> Result<(), String> {
    unsafe {
        SetLastError(WIN32_ERROR(0));
        if SetWindowLongW(hwnd, GWL_EXSTYLE, style as i32) == 0
            && GetLastError() != WIN32_ERROR(0)
        {
            return Err("WINDOW_STYLE_WRITE_FAILED".into());
        }
    }
    if read_extended_style(hwnd)? != style {
        return Err("WINDOW_STYLE_MISMATCH".into());
    }
    Ok(())
}

#[command]
pub async fn set_pet_cursor_events<R: Runtime>(
    window: WebviewWindow<R>,
    ignore: bool,
) -> Result<(), String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("Only the pet window can change its cursor events.".into());
    }
    let target = window.clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window.run_on_main_thread(move || {
        let result = (|| {
            let hwnd = target.hwnd().map_err(|_| "WINDOW_HANDLE_UNAVAILABLE".to_owned())?;
            // Wry dispatch and Tao's executor run inline on this UI thread. Keep
            // Tao's cursor flag in sync, but suppress its incidental SW_SHOW.
            without_activation(WS_EX_NOACTIVATE.0,
                || read_extended_style(hwnd),
                |style| write_extended_style(hwnd, style),
                || target.set_ignore_cursor_events(ignore).map_err(|error| error.to_string()))?;
            if (read_extended_style(hwnd)? & WS_EX_TRANSPARENT.0 != 0) != ignore {
                return Err("WINDOW_CURSOR_STATE_UNCONFIRMED".into());
            }
            Ok(())
        })();
        if result.is_err() {
            super::warn("window.cursor_events", "NATIVE_OPERATION_FAILED");
        }
        let _ = sender.try_send(result);
    }).map_err(|error| error.to_string())?;
    receiver.recv().await.ok_or("The cursor event change was interrupted.")?
}

async fn change_context_menu_priority<R: Runtime>(
    window: &WebviewWindow<R>,
    open: bool,
) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    let (completion, completed) = mpsc::channel();
    topmost_requests().send(TopmostRequest {
        hwnd,
        change: TopmostChange::ContextMenu(open),
        completion: Some(completion),
    }).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        completed.recv().map_err(|error| error.to_string())?
    }).await.map_err(|error| error.to_string())?
}

async fn run_pet_menu<R: Runtime>(window: &WebviewWindow<R>, menu: Arc<Menu<R>>) -> Result<(), String> {
    let target = window.clone();
    let (completion, mut completed) = tauri::async_runtime::channel(1);
    window.run_on_main_thread(move || match target.hwnd() {
        Ok(hwnd) => super::menu::queue_menu(hwnd,
            move || menu.popup(target.as_ref().window()).map_err(|error| error.to_string()),
            completion),
        Err(error) => { let _ = completion.try_send(Err(error.to_string())); }
    }).map_err(|error| error.to_string())?;
    completed.recv().await.ok_or("The pet menu was interrupted.")?
}

#[command]
pub async fn popup_pet_menu<R: Runtime>(
    window: WebviewWindow<R>,
    rid: u32,
) -> Result<(), String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("Only the pet window can open its context menu.".into());
    }
    // Resolve only this caller's menu resource; no arbitrary HWND/menu payload.
    let menu = window.resources_table().get::<Menu<R>>(rid).map_err(|error| error.to_string())?;
    let owner = PetMenuOwner::acquire()?;
    // The native task owns cleanup even if navigation drops the IPC response.
    tauri::async_runtime::spawn(async move {
        let _owner = owner;
        let popup = match change_context_menu_priority(&window, true).await {
            Ok(()) => run_pet_menu(&window, menu).await,
            Err(error) => Err(error),
        };
        let restored = change_context_menu_priority(&window, false).await;
        if restored.is_err() {
            super::warn("window.context_menu_restore", "NATIVE_OPERATION_FAILED");
        }
        popup.and(restored)
    }).await.map_err(|error| error.to_string())?
}

fn window_process_id(hwnd: isize) -> Option<u32> {
    let hwnd = HWND(hwnd as *mut _);
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return None;
        }
        let mut process_id = 0;
        if GetWindowThreadProcessId(hwnd, Some(&mut process_id)) == 0 || process_id == 0 {
            None
        } else {
            Some(process_id)
        }
    }
}

fn owned_window(hwnd: isize) -> bool {
    window_process_id(hwnd) == Some(std::process::id())
}

fn window_retired(hwnd: isize) -> bool {
    match window_process_id(hwnd) {
        Some(process_id) => process_id != std::process::id(),
        // An unreadable live HWND still owes restoration. Only known retirement
        // or reuse by a foreign process can release that obligation without a write.
        None => unsafe { !IsWindow(Some(HWND(hwnd as *mut _))).as_bool() },
    }
}

fn read_topmost(hwnd: isize) -> Option<bool> {
    if !owned_window(hwnd) {
        return None;
    }
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
    if !owned_window(hwnd) {
        return Err("WINDOW_OWNER_UNCONFIRMED".into());
    }
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
                reconcile_window_order(state, preference_available, window_retired,
                    read_topmost, write_topmost)?;
                if read_topmost(state.main_hwnd) != Some(state.main_topmost()) {
                    return Err("WINDOW_TOPMOST_STATE_UNCONFIRMED".into());
                }
                Ok(())
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

fn preference_caption_color(label: &str, dark: bool) -> Result<u32, String> {
    if label != PREFERENCE_WINDOW_LABEL {
        return Err("Only the preference window can set its caption color.".into());
    }
    Ok(if dark {
        0x00202020
    } else {
        DWMWA_COLOR_DEFAULT
    })
}

#[command]
pub async fn set_preference_caption_color<R: Runtime>(
    window: WebviewWindow<R>,
    dark: bool,
) -> Result<(), String> {
    let color = preference_caption_color(window.label(), dark)?;
    let hwnd = window
        .hwnd()
        .map_err(|_| "WINDOW_HANDLE_UNAVAILABLE".to_owned())?;
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            (&color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    }
    .map_err(|error| {
        super::warn(
            "window.preference_caption",
            &format!("HRESULT_0x{:08X}", error.code().0 as u32),
        );
        "CAPTION_COLOR_UNAVAILABLE".to_owned()
    })
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
    fn invalid_hwnd_cannot_be_read_reasserted_or_written() {
        assert!(!owned_window(0));
        assert!(window_retired(0));
        assert_eq!(read_topmost(0), None);
        assert_eq!(write_topmost(0, true), Err("WINDOW_OWNER_UNCONFIRMED".into()));
        assert_eq!(write_topmost(0, false), Err("WINDOW_OWNER_UNCONFIRMED".into()));
    }

    #[test]
    fn real_hidden_owned_window_stays_hidden_unfocused_and_at_the_same_bounds() {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, GetWindowRect, WS_POPUP};
        use windows::core::w;
        struct Fixture(HWND);
        impl Drop for Fixture {
            fn drop(&mut self) { unsafe { let _ = DestroyWindow(self.0); } }
        }
        unsafe {
            let foreground = GetForegroundWindow();
            let fixture = Fixture(CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOPMOST, w!("STATIC"), w!(""), WS_POPUP,
                10, 10, 8, 8, None, None, None, None).unwrap());
            let hwnd = fixture.0.0 as isize;
            assert!(owned_window(hwnd));
            assert!(!window_retired(hwnd));
            let mut before = RECT::default();
            GetWindowRect(fixture.0, &mut before).unwrap();
            assert_eq!(read_topmost(hwnd), Some(true));
            let mut state = super::super::topmost::WindowOrder::default();
            state.main_hwnd = hwnd;
            state.always_on_top = true;
            for _ in 0..100 {
                reconcile_window_order(&mut state, preference_available, window_retired,
                    read_topmost,
                    |_, _| panic!("a hidden already-topmost main must never repeat a write")).unwrap();
            }
            let mut after = RECT::default();
            GetWindowRect(fixture.0, &mut after).unwrap();
            assert_eq!(before, after);
            assert!(!IsWindowVisible(fixture.0).as_bool());
            assert_eq!(GetForegroundWindow(), foreground);
        }
    }

    #[test]
    fn real_foreign_desktop_hwnd_is_excluded_before_any_write() {
        use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;
        let desktop = unsafe { GetDesktopWindow() };
        assert!(unsafe { IsWindow(Some(desktop)).as_bool() });
        let hwnd = desktop.0 as isize;
        assert_ne!(window_process_id(hwnd), Some(std::process::id()));
        assert!(!owned_window(hwnd));
        assert!(window_retired(hwnd));
        assert_eq!(read_topmost(hwnd), None);
        assert_eq!(write_topmost(hwnd, true), Err("WINDOW_OWNER_UNCONFIRMED".into()));
    }

    #[test]
    fn menu_task_keeps_ownership_after_its_response_is_dropped() {
        let owner = PetMenuOwner::acquire().unwrap();
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        let (finished, completed) = mpsc::channel();
        let task = tauri::async_runtime::spawn(async move {
            let owner = owner;
            receiver.recv().await.unwrap();
            drop(owner);
            finished.send(()).unwrap();
        });
        drop(task); // Navigation can discard the response without ending the popup.
        assert!(PetMenuOwner::acquire().is_err());
        sender.try_send(()).unwrap();
        completed.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        let next = PetMenuOwner::acquire().unwrap();
        drop(next);
    }

    #[test]
    fn caption_color_is_preference_only_and_light_restores_the_native_default() {
        assert_eq!(
            preference_caption_color(PREFERENCE_WINDOW_LABEL, true).unwrap(),
            0x00202020
        );
        assert_eq!(
            preference_caption_color(PREFERENCE_WINDOW_LABEL, false).unwrap(),
            DWMWA_COLOR_DEFAULT
        );
        assert!(preference_caption_color(MAIN_WINDOW_LABEL, true).is_err());
        assert!(preference_caption_color("remote", false).is_err());
    }

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
