mod capture;
mod hud;
mod overlay;

pub use hud::Appearance;

use std::collections::VecDeque;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{WebviewWindow, command};

struct Session {
    id: String,
    cancelled: Arc<AtomicBool>,
}
#[derive(Default)]
struct Sessions {
    active: Option<Session>,
    cancelled: VecDeque<String>,
}
impl Sessions {
    fn start(&mut self, id: String) -> Result<Option<Arc<AtomicBool>>, String> {
        if let Some(index) = self.cancelled.iter().position(|old| old == &id) {
            self.cancelled.remove(index);
            return Ok(None);
        }
        if self.active.is_some() {
            return Err("Screen color selection is already active.".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        self.active = Some(Session {
            id,
            cancelled: cancelled.clone(),
        });
        Ok(Some(cancelled))
    }

    fn cancel(&mut self, id: String) {
        if let Some(session) = self.active.as_ref().filter(|s| s.id == id) {
            session.cancelled.store(true, Ordering::Relaxed);
        } else if !self.cancelled.contains(&id) {
            self.cancelled.push_back(id);
            if self.cancelled.len() > 32 {
                self.cancelled.pop_front();
            }
        }
    }
}
static SESSION: Mutex<Sessions> = Mutex::new(Sessions {
    active: None,
    cancelled: VecDeque::new(),
});

struct SessionGuard;
impl Drop for SessionGuard {
    fn drop(&mut self) {
        if let Ok(mut session) = SESSION.lock() {
            session.active = None;
        }
    }
}

fn log_pick_failure(error: &str) {
    let code = match error {
        "Invalid screen color request." => "INVALID_REQUEST",
        "Could not allocate screen color buffer." => "BUFFER_ALLOCATION_FAILED",
        "Could not allocate screen color bitmap." => "BITMAP_ALLOCATION_FAILED",
        "Could not select screen color bitmap." => "BITMAP_SELECTION_FAILED",
        "Could not read the desktop." => "DESKTOP_READ_FAILED",
        "Could not capture the desktop." => "DESKTOP_CAPTURE_FAILED",
        "Could not read the selected pixel." => "PIXEL_READ_FAILED",
        "Could not compose screen color preview." => "PREVIEW_COMPOSITION_FAILED",
        "Could not prepare color preview text." => "PREVIEW_TEXT_FAILED",
        "Could not prepare color preview drawing." => "PREVIEW_DRAW_FAILED",
        "Could not display screen color preview." => "PREVIEW_DISPLAY_FAILED",
        "Could not read the pointer position." => "POINTER_READ_FAILED",
        "Could not prepare screen pixel coordinates." => "COORDINATE_SETUP_FAILED",
        "Could not prepare screen color selection." => "WINDOW_SETUP_FAILED",
        "Could not open screen color selection." => "WINDOW_CREATE_FAILED",
        "Could not activate screen color selection." => "WINDOW_ACTIVATE_FAILED",
        "Screen color selection was interrupted." => "THREAD_INTERRUPTED",
        "Screen color selection is unavailable." => "SESSION_UNAVAILABLE",
        _ => "NATIVE_OPERATION_FAILED",
    };
    crate::diagnostics::warn("eyedropper.pick", code);
}

#[command]
pub async fn pick_screen_color(
    window: WebviewWindow,
    request_id: String,
    instruction: String,
    appearance: Option<Appearance>,
) -> Result<Option<String>, String> {
    let result: Result<Option<String>, String> = async {
        if window.label() != "preference"
            || request_id.is_empty()
            || request_id.len() > 128
            || instruction.len() > 256
            || appearance.is_some_and(|value| !value.valid())
        {
            return Err("Invalid screen color request.".into());
        }
        if !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false) {
            return Err("Open screen color selection from the focused preferences window.".into());
        }
        let owner = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let cancelled = {
            let mut session = SESSION
                .lock()
                .map_err(|_| "Screen color selection is unavailable.")?;
            let Some(cancelled) = session.start(request_id)? else {
                return Ok(None);
            };
            cancelled
        };
        let guard = SessionGuard;
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        // A dedicated thread owns its HWND, GDI resources and message loop.
        std::thread::Builder::new()
            .name("screen-color-picker".into())
            .spawn(move || {
                let result = overlay::pick(
                    owner,
                    cancelled,
                    instruction,
                    appearance.unwrap_or_default(),
                );
                drop(guard);
                let _ = sender.try_send(result);
            })
            .map_err(|e| e.to_string())?;
        receiver
            .recv()
            .await
            .ok_or("Screen color selection was interrupted.")?
    }.await;
    if let Err(error) = &result {
        if !matches!(error.as_str(), "Open screen color selection from the focused preferences window." | "Screen color selection is already active.") {
            log_pick_failure(error);
        }
    }
    result
}

#[command]
pub fn cancel_screen_color_pick(window: WebviewWindow, request_id: String) -> Result<(), String> {
    if window.label() != "preference" || request_id.is_empty() || request_id.len() > 128 {
        return Err("Invalid screen color request.".into());
    }
    let mut session = SESSION
        .lock()
        .map_err(|_| "Screen color selection is unavailable.")?;
    session.cancel(request_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_bound_to_the_request_even_before_start() {
        let mut sessions = Sessions::default();
        sessions.cancel("early".into());
        assert!(sessions.start("early".into()).unwrap().is_none());
        let active = sessions.start("current".into()).unwrap().unwrap();
        assert!(sessions.start("duplicate".into()).is_err());
        sessions.cancel("old".into());
        assert!(!active.load(Ordering::Relaxed));
        sessions.cancel("current".into());
        assert!(active.load(Ordering::Relaxed));
        sessions.active = None;
        assert!(sessions.start("next".into()).unwrap().is_some());
    }
}
