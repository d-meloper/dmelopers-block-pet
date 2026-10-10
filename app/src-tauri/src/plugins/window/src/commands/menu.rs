use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicUsize, Ordering},
};
use tauri::async_runtime::Sender;
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{PostMessageW, RegisterWindowMessageW, WM_NCDESTROY},
        },
    },
    core::w,
};

static START_MESSAGE: OnceLock<u32> = OnceLock::new();
static NEXT_GENERATION: AtomicUsize = AtomicUsize::new(0);
static PENDING: Mutex<Option<PendingMenu>> = Mutex::new(None);
const DISPATCH_SUBCLASS: usize = 3;

struct PendingMenu {
    hwnd: isize,
    generation: usize,
    popup: Box<dyn FnOnce() -> Result<(), String> + Send>,
    completion: Sender<Result<(), String>>,
}

fn start_message() -> u32 {
    *START_MESSAGE
        .get_or_init(|| unsafe { RegisterWindowMessageW(w!("DMeloper.BlockPet.PetMenuStart.v1")) })
}

fn take_pending(hwnd: HWND, generation: usize) -> Option<PendingMenu> {
    PENDING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take_if(|request| request.hwnd == hwnd.0 as isize && request.generation == generation)
}

/// Install and post on the UI thread, then return from Tauri's Task handler.
/// Entering TrackPopupMenu inside that handler buffers further SDK UI tasks.
pub(super) fn queue_menu(
    hwnd: HWND,
    popup: impl FnOnce() -> Result<(), String> + Send + 'static,
    completion: Sender<Result<(), String>>,
) {
    queue_menu_with_post(
        hwnd,
        Box::new(popup),
        completion,
        |message, generation| unsafe {
            PostMessageW(Some(hwnd), message, WPARAM(generation), LPARAM(0))
                .map_err(|error| error.to_string())
        },
    );
}

fn queue_menu_with_post(
    hwnd: HWND,
    popup: Box<dyn FnOnce() -> Result<(), String> + Send>,
    completion: Sender<Result<(), String>>,
    post: impl FnOnce(u32, usize) -> Result<(), String>,
) {
    let message = start_message();
    if message == 0 || completion.is_closed() {
        let _ = completion.try_send(Err("Could not prepare the pet menu.".into()));
        return;
    }
    let generation = NEXT_GENERATION
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    {
        let mut pending = PENDING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.is_some() {
            let _ = completion.try_send(Err("The pet menu is already queued.".into()));
            return;
        }
        *pending = Some(PendingMenu {
            hwnd: hwnd.0 as isize,
            generation,
            popup,
            completion,
        });
    }
    unsafe {
        if !SetWindowSubclass(hwnd, Some(dispatch_menu), DISPATCH_SUBCLASS, generation).as_bool() {
            if let Some(request) = take_pending(hwnd, generation) {
                let _ = request
                    .completion
                    .try_send(Err("Could not install pet menu dispatch.".into()));
            }
            return;
        }
        if let Err(error) = post(message, generation) {
            let _ = RemoveWindowSubclass(hwnd, Some(dispatch_menu), DISPATCH_SUBCLASS);
            if let Some(request) = take_pending(hwnd, generation) {
                let _ = request.completion.try_send(Err(error));
            }
        }
    }
}

unsafe extern "system" fn dispatch_menu(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    generation: usize,
) -> LRESULT {
    if message == start_message() && wparam.0 == generation {
        if let Some(request) = take_pending(hwnd, generation) {
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(dispatch_menu), DISPATCH_SUBCLASS) };
            if !request.completion.is_closed() {
                // The SDK popup executes inline here, outside Tao's event callback.
                // Its result still acknowledges the end of native menu tracking.
                let result = super::menu_input::with_menu_mouse_coordinates(hwnd, request.popup);
                let _ = request.completion.try_send(result);
            }
        }
        return LRESULT(0);
    }
    if message == WM_NCDESTROY {
        let _ = unsafe { RemoveWindowSubclass(hwnd, Some(dispatch_menu), DISPATCH_SUBCLASS) };
        if let Some(request) = take_pending(hwnd, generation) {
            let _ = request
                .completion
                .try_send(Err("The pet menu was interrupted.".into()));
        }
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
#[path = "native_menu_dispatch_tests.rs"]
mod tests;
