use super::{
    capture::Capture,
    hud::{Appearance, Hud},
};
use std::{
    ptr::{null, null_mut},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        HiDpi::*,
        Input::KeyboardAndMouse::{SetFocus, VK_ESCAPE},
        WindowsAndMessaging::*,
    },
};

struct State {
    image: Capture,
    frame: Capture,
    hud: Hud,
    point: Option<POINT>,
    hint: Option<RECT>,
    owner: HWND,
    cancelled: Arc<AtomicBool>,
    pressed: bool,
    result: Result<Option<String>, String>,
}

impl State {
    fn move_hint(&mut self, point: POINT) -> Result<bool, String> {
        if self
            .point
            .is_some_and(|old| old.x == point.x && old.y == point.y)
        {
            return Ok(false);
        }
        let color = self.image.colorref(point)?;
        let mut monitor = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let mut bounds = RECT {
            left: 0,
            top: 0,
            right: self.image.width,
            bottom: self.image.height,
        };
        unsafe {
            if GetMonitorInfoW(
                MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST),
                &mut monitor,
            ) != 0
            {
                bounds = RECT {
                    left: (monitor.rcMonitor.left - self.image.left).max(0),
                    top: (monitor.rcMonitor.top - self.image.top).max(0),
                    right: (monitor.rcMonitor.right - self.image.left).min(self.image.width),
                    bottom: (monitor.rcMonitor.bottom - self.image.top).min(self.image.height),
                };
            }
        }
        let hint = self.hud.bounds(
            POINT {
                x: point.x - self.image.left,
                y: point.y - self.image.top,
            },
            bounds,
        );
        if let Some(previous) = self.hint {
            self.frame.restore(&self.image, previous)?;
        }
        self.hud.draw(self.frame.dc, hint, color)?;
        self.point = Some(point);
        self.hint = Some(hint);
        Ok(true)
    }
}

unsafe extern "system" fn procedure(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        if message == WM_NCCREATE {
            let create = &*(lparam as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        }
        let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
        if state_ptr.is_null() {
            return DefWindowProcW(hwnd, message, wparam, lparam);
        }
        let state = &mut *state_ptr;
        match message {
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut paint);
                // Present a complete frame once; never erase the HUD on screen
                // and then redraw its background, swatch and text separately.
                let area = paint.rcPaint;
                let copied = area.right <= area.left
                    || area.bottom <= area.top
                    || BitBlt(
                        dc,
                        area.left,
                        area.top,
                        area.right - area.left,
                        area.bottom - area.top,
                        state.frame.dc,
                        area.left,
                        area.top,
                        SRCCOPY,
                    ) != 0;
                EndPaint(hwnd, &paint);
                if !copied {
                    state.result = Err("Could not display screen color preview.".into());
                    PostQuitMessage(0);
                }
                return 0;
            }
            WM_ERASEBKGND => return 1,
            WM_MOUSEMOVE => {
                let mut point = POINT::default();
                if GetCursorPos(&mut point) != 0 {
                    let previous = state.hint;
                    match state.move_hint(point) {
                        Ok(true) => {
                            // Windows merges these dirty rectangles. Unchanged
                            // desktop pixels never need to be repainted on move.
                            if let Some(rect) = previous {
                                InvalidateRect(hwnd, &rect, 0);
                            }
                            if let Some(rect) = state.hint {
                                InvalidateRect(hwnd, &rect, 0);
                            }
                        }
                        Ok(false) => {}
                        Err(error) => {
                            state.result = Err(error);
                            PostQuitMessage(0);
                        }
                    }
                }
                return 0;
            }
            WM_LBUTTONDOWN => {
                state.pressed = true;
                return 0;
            }
            WM_LBUTTONUP if state.pressed => {
                let mut point = POINT::default();
                state.result = if GetCursorPos(&mut point) != 0 {
                    state.image.color(point).map(Some)
                } else {
                    Err("Could not read the pointer position.".into())
                };
                PostQuitMessage(0);
                return 0;
            }
            WM_KEYDOWN if wparam == VK_ESCAPE as usize => {
                PostQuitMessage(0);
                return 0;
            }
            WM_RBUTTONUP | WM_CLOSE | WM_DESTROY | WM_DISPLAYCHANGE => {
                PostQuitMessage(0);
                return 0;
            }
            WM_SHOWWINDOW if wparam == 0 => {
                PostQuitMessage(0);
                return 0;
            }
            WM_ACTIVATE if wparam as u16 == WA_INACTIVE as u16 => {
                PostQuitMessage(0);
                return 0;
            }
            WM_TIMER => {
                if state.cancelled.load(Ordering::Relaxed) || IsWindowVisible(state.owner) == 0 {
                    PostQuitMessage(0);
                }
                return 0;
            }
            _ => {}
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }
}

pub(super) fn pick(
    owner: isize,
    cancelled: Arc<AtomicBool>,
    instruction: String,
    appearance: Appearance,
) -> Result<Option<String>, String> {
    unsafe {
        let previous_dpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if previous_dpi.is_null() {
            return Err("Could not prepare screen pixel coordinates.".into());
        }
        // This thread exits after selection, so the DPI context cannot leak to other work.
        let owner = owner as HWND;
        if cancelled.load(Ordering::Relaxed) || IsWindowVisible(owner) == 0 {
            return Ok(None);
        }
        let image = Capture::desktop()?;
        if cancelled.load(Ordering::Relaxed) || IsWindowVisible(owner) == 0 {
            return Ok(None);
        }
        let frame = image.duplicate()?;
        let hud = Hud::new(appearance, &instruction, GetDpiForWindow(owner))?;
        let mut state = Box::new(State {
            image,
            frame,
            hud,
            point: None,
            hint: None,
            owner,
            cancelled,
            pressed: false,
            result: Ok(None),
        });
        let mut point = POINT::default();
        if GetCursorPos(&mut point) == 0 {
            return Err("Could not read the pointer position.".into());
        }
        // Compose before showing the window, so its first paint is complete.
        state.move_hint(point)?;
        let instance = GetModuleHandleW(null());
        let class_name: Vec<u16> = format!("DMeloper.ScreenColorPicker.{}", std::process::id())
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let class = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            hCursor: LoadCursorW(null_mut(), IDC_CROSS),
            lpszClassName: class_name.as_ptr(),
            ..Default::default()
        };
        // Each session unregisters its class after destroying its only window.
        if RegisterClassW(&class) == 0 {
            return Err("Could not prepare screen color selection.".into());
        }
        let title: Vec<u16> = "DMeloper Screen Color — Click to select / Esc to cancel"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            state.image.left,
            state.image.top,
            state.image.width,
            state.image.height,
            owner,
            null_mut(),
            instance,
            (&mut *state as *mut State).cast(),
        );
        if hwnd.is_null() {
            UnregisterClassW(class_name.as_ptr(), instance);
            return Err("Could not open screen color selection.".into());
        }
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        SetFocus(hwnd);
        if SetTimer(hwnd, 1, 50, None) == 0 || GetForegroundWindow() != hwnd {
            DestroyWindow(hwnd);
            UnregisterClassW(class_name.as_ptr(), instance);
            return Err("Could not activate screen color selection.".into());
        }
        let mut message = MSG::default();
        loop {
            let status = GetMessageW(&mut message, null_mut(), 0, 0);
            if status <= 0 {
                if status < 0 {
                    state.result = Err("Screen color selection was interrupted.".into());
                }
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let restore_focus = GetForegroundWindow() == hwnd;
        KillTimer(hwnd, 1);
        DestroyWindow(hwnd);
        UnregisterClassW(class_name.as_ptr(), instance);
        if restore_focus && IsWindowVisible(owner) != 0 {
            SetForegroundWindow(owner);
        }
        if state.cancelled.load(Ordering::Relaxed) || IsWindowVisible(owner) == 0 {
            return Ok(None);
        }
        state.result.clone()
    }
}
