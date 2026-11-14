//! Match the GUI event loop's physical coordinate space before worker HWNDs exist.
use crate::windows_process::wide;
use windows_sys::Win32::{
    Foundation::{ERROR_ACCESS_DENIED, FreeLibrary, GetLastError},
    System::LibraryLoader::{
        GetModuleHandleW, GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
    },
    UI::{
        HiDpi::{
            DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE,
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, PROCESS_DPI_AWARENESS,
            PROCESS_PER_MONITOR_DPI_AWARE,
        },
        WindowsAndMessaging::SetProcessDPIAware,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    PerMonitorV2,
    PerMonitorV1,
    LegacyPerMonitor,
    System,
}
#[derive(Clone, Copy)]
enum Attempt {
    Applied,
    AlreadyConfigured,
    Unavailable,
}

fn configure(mut attempt: impl FnMut(Mode) -> Attempt) {
    for mode in [
        Mode::PerMonitorV2,
        Mode::PerMonitorV1,
        Mode::LegacyPerMonitor,
        Mode::System,
    ] {
        match attempt(mode) {
            Attempt::Applied | Attempt::AlreadyConfigured => return,
            Attempt::Unavailable => {}
        }
    }
}

pub(super) fn initialize() {
    type ContextSetter = unsafe extern "system" fn(DPI_AWARENESS_CONTEXT) -> i32;
    type LegacySetter = unsafe extern "system" fn(PROCESS_DPI_AWARENESS) -> i32;
    // user32 is an existing executable import. Optional APIs stay dynamically
    // resolved, so an older supported Windows version can use the fallback.
    let user32 = unsafe { GetModuleHandleW(wide("user32.dll").as_ptr()) };
    let context_setter = if user32.is_null() {
        None
    } else {
        unsafe { GetProcAddress(user32, c"SetProcessDpiAwarenessContext".as_ptr().cast()) }.map(
            |value| unsafe {
                std::mem::transmute::<unsafe extern "system" fn() -> isize, ContextSetter>(value)
            },
        )
    };
    configure(|mode| match mode {
        Mode::PerMonitorV2 | Mode::PerMonitorV1 => {
            let Some(setter) = context_setter else {
                return Attempt::Unavailable;
            };
            let context = if mode == Mode::PerMonitorV2 {
                DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            } else {
                DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE
            };
            if unsafe { setter(context) } != 0 {
                Attempt::Applied
            } else if unsafe { GetLastError() } == ERROR_ACCESS_DENIED {
                Attempt::AlreadyConfigured
            } else {
                Attempt::Unavailable
            }
        }
        Mode::LegacyPerMonitor => {
            // Load only the OS directory, never a user-writable search location.
            let module = unsafe {
                LoadLibraryExW(
                    wide("shcore.dll").as_ptr(),
                    std::ptr::null_mut(),
                    LOAD_LIBRARY_SEARCH_SYSTEM32,
                )
            };
            if module.is_null() {
                return Attempt::Unavailable;
            }
            let result =
                unsafe { GetProcAddress(module, c"SetProcessDpiAwareness".as_ptr().cast()) }.map(
                    |value| unsafe {
                        std::mem::transmute::<unsafe extern "system" fn() -> isize, LegacySetter>(
                            value,
                        )(PROCESS_PER_MONITOR_DPI_AWARE)
                    },
                );
            unsafe { FreeLibrary(module) };
            match result {
                Some(0) => Attempt::Applied,
                Some(value) if value as u32 == 0x80070005 => Attempt::AlreadyConfigured,
                _ => Attempt::Unavailable,
            }
        }
        Mode::System => {
            if unsafe { SetProcessDPIAware() } != 0 {
                Attempt::Applied
            } else {
                Attempt::Unavailable
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_dpi_uses_the_first_supported_mode_and_preserves_existing_configuration() {
        let order = [
            Mode::PerMonitorV2,
            Mode::PerMonitorV1,
            Mode::LegacyPerMonitor,
            Mode::System,
        ];
        for stop in 0..order.len() {
            for already_configured in [false, true] {
                let mut seen = Vec::new();
                configure(|mode| {
                    seen.push(mode);
                    if mode != order[stop] {
                        Attempt::Unavailable
                    } else if already_configured {
                        Attempt::AlreadyConfigured
                    } else {
                        Attempt::Applied
                    }
                });
                assert_eq!(seen, order[..=stop]);
            }
        }
        let mut seen = Vec::new();
        configure(|mode| {
            seen.push(mode);
            Attempt::Unavailable
        });
        assert_eq!(seen, order);
    }
}
