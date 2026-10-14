//! Read-only foreground process lookup, without browser or page inspection.
use crate::windows_process::{Handle, creation_time, executable};
use windows_sys::Win32::{
    System::Threading::{GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    UI::WindowsAndMessaging::{
        EnumChildWindows, GA_ROOTOWNER, GetAncestor, GetClassNameW, GetForegroundWindow,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub hwnd: usize,
    pub pid: u32,
    pub created: u64,
}

pub struct Foreground {
    pub identity: Identity,
    pub path: String,
}
impl Foreground {
    pub fn own(&self) -> bool {
        self.identity.pid == unsafe { GetCurrentProcessId() }
    }
}

fn window_process(hwnd: usize) -> Option<Foreground> {
    if hwnd == 0 {
        return None;
    }
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd as _, &mut pid);
    }
    if pid == 0 {
        return None;
    }
    let process = Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
    if process.0.is_null() {
        return None;
    }
    Some(Foreground {
        identity: Identity {
            hwnd,
            pid,
            created: creation_time(process.0).ok()?,
        },
        path: executable(process.0).ok()?.to_str()?.to_owned(),
    })
}

pub fn foreground() -> Option<Foreground> {
    let hwnd = foreground_handle();
    if hwnd == 0 {
        return None;
    }
    let current = window_process(hwnd)?;
    if !current
        .path
        .to_ascii_lowercase()
        .ends_with("\\applicationframehost.exe")
    {
        return Some(current);
    }
    unsafe extern "system" fn app_child(
        hwnd: windows_sys::Win32::Foundation::HWND,
        parameter: isize,
    ) -> i32 {
        if unsafe { IsWindowVisible(hwnd) } == 0 {
            return 1;
        }
        let mut class = [0u16; 128];
        let length = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
        if length <= 0
            || String::from_utf16_lossy(&class[..length as usize]) != "Windows.UI.Core.CoreWindow"
        {
            return 1;
        }
        if let Some(window) = window_process(hwnd as usize) {
            let result = unsafe { &mut *(parameter as *mut Option<Foreground>) };
            *result = Some(window);
            return 0;
        }
        1
    }
    let mut child: Option<Foreground> = None;
    unsafe {
        EnumChildWindows(hwnd as _, Some(app_child), &mut child as *mut _ as isize);
    }
    if let Some(mut child) = child {
        child.identity.hwnd = hwnd;
        Some(child)
    } else {
        Some(current)
    }
}

fn foreground_handle() -> usize {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return 0;
    }
    let owner = unsafe { GetAncestor(hwnd, GA_ROOTOWNER) };
    let hwnd = if owner.is_null() { hwnd } else { owner };
    if unsafe { IsIconic(hwnd) } != 0 || unsafe { IsWindowVisible(hwnd) } == 0 {
        return 0;
    }
    hwnd as usize
}
