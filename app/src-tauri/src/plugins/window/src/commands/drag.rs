use super::drag_bounds::{Monitor, Rect, clamp_drag_rect};
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tauri::{Runtime, WebviewWindow};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST,
        MONITOR_DEFAULTTONULL, MONITORINFO, MonitorFromPoint, MonitorFromWindow,
    },
    UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, ReleaseCapture, VK_LBUTTON, VK_RBUTTON},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetCursorPos, GetSystemMetrics, HTCAPTION, IsWindowVisible, PostMessageW,
            RegisterWindowMessageW, SM_SWAPBUTTON, SendMessageW, WM_MOVING, WM_NCDESTROY,
            WM_NCLBUTTONDOWN,
        },
    },
};
use windows::core::{BOOL, w};

const DRAG_CLAMP_SUBCLASS: usize = 1;
const DRAG_DISPATCH_SUBCLASS: usize = 2;
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
static DRAG_GENERATION: AtomicUsize = AtomicUsize::new(0);
static DRAG_START_MESSAGE: OnceLock<u32> = OnceLock::new();
static QUEUED_DRAG: Mutex<Option<QueuedDrag>> = Mutex::new(None);

struct DragOwner;
impl DragOwner {
    fn acquire() -> Result<Self, String> {
        DRAG_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "The pet window already has an active drag.".to_owned())?;
        Ok(Self)
    }
}
impl Drop for DragOwner {
    fn drop(&mut self) {
        DRAG_ACTIVE.store(false, Ordering::SeqCst);
    }
}

struct QueuedDrag {
    hwnd: isize,
    generation: usize,
    keep_in_screen: bool,
    completion: tauri::async_runtime::Sender<Result<(), String>>,
    run: fn(HWND, bool) -> Result<(), String>,
    _owner: DragOwner,
}

fn drag_start_message() -> u32 {
    *DRAG_START_MESSAGE
        .get_or_init(|| unsafe { RegisterWindowMessageW(w!("DMeloper.BlockPet.DragStart.v1")) })
}

fn take_queued_drag(hwnd: HWND, generation: usize) -> Option<QueuedDrag> {
    QUEUED_DRAG
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take_if(|request| request.hwnd == hwnd.0 as isize && request.generation == generation)
}

fn queue_drag(hwnd: HWND, request: QueuedDrag) {
    queue_drag_with_post(hwnd, request, |hwnd, message, generation| unsafe {
        PostMessageW(Some(hwnd), message, WPARAM(generation), LPARAM(0))
            .map_err(|error| error.to_string())
    });
}

fn queue_drag_with_post(
    hwnd: HWND,
    mut request: QueuedDrag,
    post: impl FnOnce(HWND, u32, usize) -> Result<(), String>,
) {
    let message = drag_start_message();
    if message == 0 || request.completion.is_closed() {
        let _ = request
            .completion
            .try_send(Err("Could not prepare the pet drag.".into()));
        return;
    }
    request.hwnd = hwnd.0 as isize;
    let generation = request.generation;
    *QUEUED_DRAG
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(request);
    unsafe {
        if !SetWindowSubclass(
            hwnd,
            Some(dispatch_queued_drag),
            DRAG_DISPATCH_SUBCLASS,
            generation,
        )
        .as_bool()
        {
            if let Some(request) = take_queued_drag(hwnd, generation) {
                let _ = request
                    .completion
                    .try_send(Err("Could not install pet drag dispatch.".into()));
            }
            return;
        }
        if let Err(error) = post(hwnd, message, generation) {
            let _ = RemoveWindowSubclass(hwnd, Some(dispatch_queued_drag), DRAG_DISPATCH_SUBCLASS);
            if let Some(request) = take_queued_drag(hwnd, generation) {
                let _ = request.completion.try_send(Err(error));
            }
        }
    }
}

unsafe extern "system" fn dispatch_queued_drag(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    generation: usize,
) -> LRESULT {
    if message == drag_start_message() && wparam.0 == generation {
        if let Some(request) = take_queued_drag(hwnd, generation) {
            // The posted callback runs after Tauri's task returns. Tao can now
            // deliver events throughout the same native modal move loop.
            // Subclass data contains only a generation, never an owned pointer.
            let _ = unsafe {
                RemoveWindowSubclass(hwnd, Some(dispatch_queued_drag), DRAG_DISPATCH_SUBCLASS)
            };
            if !request.completion.is_closed() {
                let result = (request.run)(hwnd, request.keep_in_screen);
                let _ = request.completion.try_send(result);
            }
        }
        return LRESULT(0);
    }
    if message == WM_NCDESTROY {
        let _ = unsafe {
            RemoveWindowSubclass(hwnd, Some(dispatch_queued_drag), DRAG_DISPATCH_SUBCLASS)
        };
        if let Some(request) = take_queued_drag(hwnd, generation) {
            let _ = request
                .completion
                .try_send(Err("The pet window drag was interrupted.".into()));
        }
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

pub(super) async fn run_main_window_drag<R: Runtime>(
    window: &WebviewWindow<R>,
    keep_in_screen: bool,
) -> Result<(), String> {
    let owner = DragOwner::acquire()?;
    let target = window.clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || match target.hwnd() {
            Ok(hwnd) => queue_drag(
                HWND(hwnd.0 as *mut _),
                QueuedDrag {
                    hwnd: 0,
                    generation: DRAG_GENERATION
                        .fetch_add(1, Ordering::Relaxed)
                        .wrapping_add(1),
                    keep_in_screen,
                    completion: sender,
                    run: drag_until_released,
                    _owner: owner,
                },
            ),
            Err(error) => {
                let _ = sender.try_send(Err(error.to_string()));
            }
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .await
        .ok_or("The pet window drag was interrupted.")?
}

fn read_monitor(monitor: HMONITOR) -> Option<Monitor> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return None;
    }
    Some(Monitor {
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
    })
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _dc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    if let Some(monitor) = read_monitor(monitor) {
        // EnumDisplayMonitors calls synchronously; the vector outlives every callback.
        let monitors = unsafe { &mut *(data.0 as *mut Vec<Monitor>) };
        monitors.push(monitor);
    }
    BOOL(1)
}

fn clamp_drag_with_live_monitor(
    rect: Rect,
    cursor: (i32, i32),
    active_monitor: isize,
    cursor_monitor: isize,
    mut read: impl FnMut(isize) -> Option<Monitor>,
    enumerate: impl FnOnce() -> Option<Vec<Monitor>>,
) -> Option<(Rect, isize)> {
    // Resolve the cursor's monitor anew for each proposal, then read its live work
    // area. A gap retains the previous monitor; no topology/work-area cache is used.
    let target = if cursor_monitor == 0 {
        active_monitor
    } else {
        cursor_monitor
    };
    if let Some(monitor) = read(target) {
        // A topology change can invalidate the point lookup before the info read.
        if cursor_monitor == 0 || monitor.bounds.contains(cursor) {
            if let Some(clamped) =
                clamp_drag_rect(rect, cursor, std::slice::from_ref(&monitor), active_monitor)
            {
                return Some(clamped);
            }
        }
    }
    // Keep the existing full-enumeration recovery if a handle disappeared or a
    // monitor read/work area is invalid, including the first valid monitor fallback.
    let monitors = enumerate()?;
    clamp_drag_rect(rect, cursor, &monitors, active_monitor)
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
        let mut cursor = POINT {
            x: i32::MIN,
            y: i32::MIN,
        };
        let cursor_monitor = if unsafe { GetCursorPos(&mut cursor) }.is_ok() {
            unsafe { MonitorFromPoint(cursor, MONITOR_DEFAULTTONULL) }.0 as isize
        } else {
            0
        };
        // WM_MOVING supplies a writable proposal before Windows moves the window.
        let proposed = unsafe { &mut *(lparam.0 as *mut RECT) };
        if let Some((clamped, selected_monitor)) = clamp_drag_with_live_monitor(
            Rect {
                x: proposed.left,
                y: proposed.top,
                width: proposed.right - proposed.left,
                height: proposed.bottom - proposed.top,
            },
            (cursor.x, cursor.y),
            active_monitor as isize,
            cursor_monitor,
            |id| read_monitor(HMONITOR(id as *mut _)),
            || {
                let mut monitors = Vec::<Monitor>::new();
                let enumerated = unsafe {
                    EnumDisplayMonitors(
                        None,
                        None,
                        Some(collect_monitor),
                        LPARAM((&mut monitors as *mut Vec<Monitor>) as isize),
                    )
                };
                enumerated.as_bool().then_some(monitors)
            },
        ) {
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

#[cfg(test)]
#[path = "native_drag_scheduling_tests.rs"]
mod native_drag_scheduling_tests;

#[cfg(test)]
#[path = "native_drag_monitor_tests.rs"]
mod native_drag_monitor_tests;
