use std::cell::Cell;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::Gdi::ScreenToClient,
    UI::WindowsAndMessaging::{
        CallNextHookEx, GUI_INMENUMODE, GUI_POPUPMENUMODE, GUITHREADINFO, GetGUIThreadInfo,
        GetWindowThreadProcessId, HHOOK, MSG, MSGF_MENU, SetWindowsHookExW, UnhookWindowsHookEx,
        WH_MSGFILTER, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
    },
};

thread_local! {
    static MENU_OWNER: Cell<Option<(HWND, u32)>> = const { Cell::new(None) };
}

struct MenuMouseCoordinates(HHOOK);

impl Drop for MenuMouseCoordinates {
    fn drop(&mut self) {
        MENU_OWNER.set(None);
        if unsafe { UnhookWindowsHookEx(self.0) }.is_err() {
            super::warn("window.menu_input", "HOOK_REMOVAL_FAILED");
        }
    }
}

/// Bound to the posted popup's UI thread and native tracking lifetime.
pub(super) fn with_menu_mouse_coordinates(
    owner: HWND,
    popup: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if MENU_OWNER.get().is_some() {
        return Err("The pet menu input owner is already active.".into());
    }
    let thread_id = unsafe { GetWindowThreadProcessId(owner, None) };
    if thread_id == 0 {
        return Err("The pet menu input owner is unavailable.".into());
    }
    let hook = unsafe { SetWindowsHookExW(WH_MSGFILTER, Some(menu_mouse_filter), None, thread_id) }
        .map_err(|error| error.to_string())?;
    MENU_OWNER.set(Some((owner, thread_id)));
    let _guard = MenuMouseCoordinates(hook);
    popup()
}

fn normalize_mouse_coordinates(message: &mut MSG, owner: HWND) {
    if message.hwnd != owner
        || !matches!(
            message.message,
            WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK
        )
    {
        return;
    }
    let x = message.lParam.0 as i16 as i32;
    let y = (message.lParam.0 >> 16) as i16 as i32;
    if (x, y) == (message.pt.x, message.pt.y)
        || i16::try_from(message.pt.x).is_err()
        || i16::try_from(message.pt.y).is_err()
    {
        return;
    }
    let mut client: POINT = message.pt;
    if unsafe { ScreenToClient(owner, &mut client) }.as_bool() && (x, y) == (client.x, client.y) {
        // Actual failed popups delivered client coordinates here while normal
        // Win32 menu tracking received screen coordinates. MSG.pt remains valid.
        message.lParam = LPARAM(
            (u32::from(message.pt.x as u16) | (u32::from(message.pt.y as u16) << 16)) as isize,
        );
    }
}

unsafe extern "system" fn menu_mouse_filter(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let original = if code == MSGF_MENU as i32 && lparam.0 != 0 {
        Some(unsafe { *(lparam.0 as *const MSG) })
    } else {
        None
    };
    let result = unsafe { CallNextHookEx(None, code, wparam, lparam) };
    if result.0 != 0 || code != MSGF_MENU as i32 || lparam.0 == 0 {
        return result;
    }
    let message = unsafe { &mut *(lparam.0 as *mut MSG) };
    if original != Some(*message) {
        return result;
    }
    if let Some((owner, thread_id)) = MENU_OWNER.get() {
        let mut gui = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetGUIThreadInfo(thread_id, &mut gui) }.is_ok()
            && gui.hwndMenuOwner == owner
            && gui.hwndCapture == owner
            && gui.flags.contains(GUI_INMENUMODE | GUI_POPUPMENUMODE)
        {
            normalize_mouse_coordinates(message, owner);
        }
    }
    result
}

#[cfg(test)]
#[path = "native_menu_input_tests.rs"]
mod tests;
