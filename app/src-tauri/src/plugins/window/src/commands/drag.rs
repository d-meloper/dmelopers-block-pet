use super::drag_bounds::{Monitor, Rect, clamp_drag_rect};
use tauri::{Runtime, WebviewWindow};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO,
        MonitorFromWindow,
    },
    UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, ReleaseCapture, VK_LBUTTON, VK_RBUTTON},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetCursorPos, GetSystemMetrics, HTCAPTION, IsWindowVisible, SM_SWAPBUTTON,
            SendMessageW, WM_MOVING, WM_NCLBUTTONDOWN,
        },
    },
};
use windows::core::BOOL;

const DRAG_CLAMP_SUBCLASS: usize = 1;

pub(super) async fn run_main_window_drag<R: Runtime>(
    window: &WebviewWindow<R>,
    keep_in_screen: bool,
) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || {
            let result = drag_until_released(HWND(hwnd as *mut _), keep_in_screen);
            let _ = sender.try_send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .await
        .ok_or("The pet window drag was interrupted.")?
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _dc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        // EnumDisplayMonitors calls synchronously; the vector outlives every callback.
        let monitors = unsafe { &mut *(data.0 as *mut Vec<Monitor>) };
        monitors.push(Monitor {
            id: monitor.0 as isize,
            bounds: Rect {
                x: info.rcMonitor.left,
                y: info.rcMonitor.top,
                width: info.rcMonitor.right - info.rcMonitor.left,
                height: info.rcMonitor.bottom - info.rcMonitor.top,
            },
            work_area: Rect {
                x: info.rcWork.left,
                y: info.rcWork.top,
                width: info.rcWork.right - info.rcWork.left,
                height: info.rcWork.bottom - info.rcWork.top,
            },
        });
    }
    BOOL(1)
}

unsafe extern "system" fn clamp_moving_window(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    active_monitor: usize,
) -> LRESULT {
    if message == WM_MOVING && active_monitor != 0 && lparam.0 != 0 {
        let mut monitors = Vec::<Monitor>::new();
        let enumerated = unsafe {
            EnumDisplayMonitors(
                None,
                None,
                Some(collect_monitor),
                LPARAM((&mut monitors as *mut Vec<Monitor>) as isize),
            )
        };
        let mut cursor = POINT {
            x: i32::MIN,
            y: i32::MIN,
        };
        let _ = unsafe { GetCursorPos(&mut cursor) };
        if enumerated.as_bool() && !monitors.is_empty() {
            // WM_MOVING supplies a writable proposal before Windows moves the window.
            let proposed = unsafe { &mut *(lparam.0 as *mut RECT) };
            let Some((clamped, selected_monitor)) = clamp_drag_rect(
                Rect {
                    x: proposed.left,
                    y: proposed.top,
                    width: proposed.right - proposed.left,
                    height: proposed.bottom - proposed.top,
                },
                (cursor.x, cursor.y),
                &monitors,
                active_monitor as isize,
            ) else {
                return unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            };
            if selected_monitor != active_monitor as isize {
                // Keep this target through gaps until the cursor enters another display.
                let _ = unsafe {
                    SetWindowSubclass(
                        hwnd,
                        Some(clamp_moving_window),
                        DRAG_CLAMP_SUBCLASS,
                        selected_monitor as usize,
                    )
                };
            }
            *proposed = RECT {
                left: clamped.x,
                top: clamped.y,
                right: clamped.x + clamped.width,
                bottom: clamped.y + clamped.height,
            };
            return LRESULT(1);
        }
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

fn drag_until_released(hwnd: HWND, keep_in_screen: bool) -> Result<(), String> {
    unsafe {
        // A quick click or a hide can finish while the frontend paints the overlay.
        let primary_button = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
            VK_RBUTTON
        } else {
            VK_LBUTTON
        };
        if !IsWindowVisible(hwnd).as_bool() || GetAsyncKeyState(i32::from(primary_button.0)) >= 0 {
            return Ok(());
        }
        let mut point = POINT::default();
        GetCursorPos(&mut point).map_err(|error| error.to_string())?;
        let position = u32::from(point.x as u16) | (u32::from(point.y as u16) << 16);
        let active_monitor = if keep_in_screen {
            MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST).0 as usize
        } else {
            0
        };
        if !SetWindowSubclass(
            hwnd,
            Some(clamp_moving_window),
            DRAG_CLAMP_SUBCLASS,
            active_monitor,
        )
        .as_bool()
        {
            return Err("Could not install pet drag bounds.".into());
        }
        let _ = ReleaseCapture();
        // Unlike Tauri's posted drag request, this returns after the Windows
        // move loop exits, including Escape cancellation and outside release.
        SendMessageW(
            hwnd,
            WM_NCLBUTTONDOWN,
            Some(WPARAM(HTCAPTION as usize)),
            Some(LPARAM(position as isize)),
        );
        // No borrowed state is stored in the subclass, even if the window was destroyed.
        let _ = RemoveWindowSubclass(hwnd, Some(clamp_moving_window), DRAG_CLAMP_SUBCLASS);
    }
    Ok(())
}
