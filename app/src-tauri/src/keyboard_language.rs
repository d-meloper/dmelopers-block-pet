//! Foreground IME observation. Never runs in input hooks or reads typed text.
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Language {
    Ko,
    En,
    Ja,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Status {
    pub(crate) revision: u64,
    pub(crate) language: Language,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            revision: 0,
            language: Language::Ko,
        }
    }
}

#[derive(Default)]
struct Model {
    desktop: HashSet<String>,
    broadcast: bool,
    stopped: bool,
    status: Status,
}

impl Model {
    fn demanded(&self) -> bool {
        !self.desktop.is_empty() || self.broadcast
    }

    fn observe(&mut self, language: Option<Language>) -> Option<Status> {
        let language = language?;
        if self.stopped || !self.demanded() || language == self.status.language {
            return None;
        }
        self.status = Status {
            revision: self.status.revision + 1,
            language,
        };
        Some(self.status)
    }
}

#[derive(Default)]
struct Shared {
    model: Mutex<Model>,
    wake: Condvar,
    worker: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone, Default)]
pub struct KeyboardLanguageState(Arc<Shared>);

impl KeyboardLanguageState {
    pub fn start(&self, app: &tauri::AppHandle) -> std::io::Result<()> {
        let shared = self.0.clone();
        let app = app.clone();
        let mut worker = self.0.worker.lock().unwrap_or_else(|e| e.into_inner());
        if worker.is_some() {
            return Ok(());
        }
        *worker = Some(
            std::thread::Builder::new()
                .name("keyboard-language".into())
                .spawn(move || {
                    let mut model = shared.model.lock().unwrap_or_else(|e| e.into_inner());
                    loop {
                        while !model.stopped && !model.demanded() {
                            model = shared.wake.wait(model).unwrap_or_else(|e| e.into_inner());
                        }
                        if model.stopped {
                            break;
                        }
                        drop(model);
                        let observation = platform::sample();
                        model = shared.model.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(status) = model.observe(observation) {
                            // No native lock is held during downstream delivery.
                            drop(model);
                            let _ = app.emit_to("main", "system-keyboard-language", status);
                            app.state::<crate::broadcast::BroadcastState>()
                                .publish_keyboard_language(status);
                            model = shared.model.lock().unwrap_or_else(|e| e.into_inner());
                        }
                        if model.stopped {
                            break;
                        }
                        model = shared
                            .wake
                            .wait_timeout(model, Duration::from_millis(100))
                            .unwrap_or_else(|e| e.into_inner())
                            .0;
                    }
                })?,
        );
        Ok(())
    }

    fn configure_desktop(&self, owner: String, enabled: bool) -> Status {
        let mut model = self.0.model.lock().unwrap_or_else(|e| e.into_inner());
        if enabled {
            model.desktop.insert(owner);
        } else {
            model.desktop.remove(&owner);
        }
        self.0.wake.notify_one();
        model.status
    }

    pub(crate) fn configure_broadcast(&self, enabled: bool) {
        let mut model = self.0.model.lock().unwrap_or_else(|e| e.into_inner());
        model.broadcast = enabled;
        self.0.wake.notify_one();
    }

    pub fn shutdown(&self) {
        self.0
            .model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stopped = true;
        self.0.wake.notify_one();
        if let Some(worker) = self
            .0
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            // Each foreign getter is bounded to 50 ms; shutdown never waits on a webview.
            let _ = worker.join();
        }
    }
}

#[tauri::command]
pub fn configure_system_keyboard_language(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, KeyboardLanguageState>,
    enabled: bool,
    owner: String,
) -> Result<Status, String> {
    if window.label() != "main" {
        return Err("keyboard_language_main_only".into());
    }
    if owner.is_empty()
        || owner.len() > 64
        || !owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("keyboard_language_invalid_owner".into());
    }
    Ok(state.configure_desktop(owner, enabled))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Target {
    foreground: usize,
    focus: usize,
    thread: u32,
    layout: usize,
}

trait Probe {
    fn target(&self) -> Option<Target>;
    fn ime(&self, target: Target) -> Option<(bool, u32)>;
}

fn sample(probe: &impl Probe) -> Option<Language> {
    let target = probe.target()?;
    let language = match target.layout & 0xffff {
        layout @ (0x0411 | 0x0412) => {
            let (open, conversion) = probe.ime(target)?;
            if open && conversion & 1 != 0 {
                // IME_CMODE_NATIVE, independent of ROMAN/KATAKANA/FULLSHAPE.
                if layout == 0x0411 {
                    Language::Ja
                } else {
                    Language::Ko
                }
            } else {
                Language::En
            }
        }
        _ => Language::En,
    };
    // Activation/focus/layout may change during the cross-thread queries.
    (probe.target() == Some(target)).then_some(language)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::UI::{
        Input::{Ime::ImmGetDefaultIMEWnd, KeyboardAndMouse::GetKeyboardLayout},
        WindowsAndMessaging::{
            GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId,
            SendMessageTimeoutW, GUITHREADINFO, SMTO_ABORTIFHUNG, SMTO_BLOCK, SMTO_ERRORONEXIT,
            WM_IME_CONTROL,
        },
    };

    struct WindowsProbe;
    impl Probe for WindowsProbe {
        fn target(&self) -> Option<Target> {
            unsafe {
                let foreground = GetForegroundWindow();
                if foreground.is_null() {
                    return None;
                }
                let mut class = [0u16; 128];
                let length = GetClassNameW(foreground, class.as_mut_ptr(), class.len() as i32);
                if length == 0 {
                    return None;
                }
                let class = String::from_utf16_lossy(&class[..length as usize]);
                if matches!(
                    class.as_str(),
                    "Shell_TrayWnd"
                        | "Shell_SecondaryTrayWnd"
                        | "NotifyIconOverflowWindow"
                        | "#32768"
                        | "InputSwitch"
                ) {
                    return None;
                }
                let thread = GetWindowThreadProcessId(foreground, std::ptr::null_mut());
                if thread == 0 {
                    return None;
                }
                let mut info: GUITHREADINFO = std::mem::zeroed();
                info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
                if GetGUIThreadInfo(thread, &mut info) == 0 {
                    return None;
                }
                // Hold the last known input mode while a menu has temporary focus.
                if info.flags & (4 | 8 | 16) != 0 {
                    return None;
                }
                let focus = if info.hwndFocus.is_null() {
                    foreground
                } else {
                    info.hwndFocus
                };
                let focus_thread = GetWindowThreadProcessId(focus, std::ptr::null_mut());
                if focus_thread == 0 {
                    return None;
                }
                let layout = GetKeyboardLayout(focus_thread);
                if layout.is_null() {
                    return None;
                }
                Some(Target {
                    foreground: foreground as usize,
                    focus: focus as usize,
                    thread: focus_thread,
                    layout: layout as usize,
                })
            }
        }

        fn ime(&self, target: Target) -> Option<(bool, u32)> {
            unsafe {
                let ime = ImmGetDefaultIMEWnd(target.focus as _);
                if ime.is_null() {
                    return None;
                }
                let query = |command| {
                    let mut value = 0usize;
                    let success = SendMessageTimeoutW(
                        ime,
                        WM_IME_CONTROL,
                        command,
                        0,
                        SMTO_BLOCK | SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
                        50,
                        &mut value,
                    );
                    (success != 0).then_some(value)
                };
                // Win32 IMM getter commands: IMC_GETCONVERSIONMODE / IMC_GETOPENSTATUS.
                let conversion = query(1)? as u32;
                let open = query(5)? != 0;
                Some((open, conversion))
            }
        }
    }
    pub(super) fn sample() -> Option<Language> {
        super::sample(&WindowsProbe)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Fake {
        target: Target,
        next: Option<Target>,
        calls: Cell<usize>,
        ime: Option<(bool, u32)>,
    }
    impl Probe for Fake {
        fn target(&self) -> Option<Target> {
            let count = self.calls.replace(self.calls.get() + 1);
            if count == 0 {
                Some(self.target)
            } else {
                self.next
            }
        }
        fn ime(&self, _: Target) -> Option<(bool, u32)> {
            self.ime
        }
    }
    fn probe(layout: usize, ime: Option<(bool, u32)>, changed: bool) -> Fake {
        let target = Target {
            foreground: 1,
            focus: 2,
            thread: 3,
            layout,
        };
        Fake {
            target,
            next: (!changed).then_some(target),
            calls: Cell::new(0),
            ime,
        }
    }
    #[test]
    fn follows_actual_open_native_mode_and_layout_without_key_events() {
        assert_eq!(
            sample(&probe(0x0412, Some((true, 0x0fbb)), false)),
            Some(Language::Ko)
        );
        assert_eq!(
            sample(&probe(0x0412, Some((true, 0)), false)),
            Some(Language::En)
        );
        assert_eq!(
            sample(&probe(0x0412, Some((false, 1)), false)),
            Some(Language::En)
        );
        assert_eq!(sample(&probe(0x0409, None, false)), Some(Language::En));
        assert_eq!(sample(&probe(0x0412, None, false)), None);
        assert_eq!(sample(&probe(0x0412, Some((true, 1)), true)), None);
    }
    #[test]
    fn japanese_native_modes_are_distinct_from_latin_and_preserve_raced_or_failed_queries() {
        for layout in [0x0411, 0xe0010411] {
            for conversion in [0, 1, 3, 8, 9, 0x10, 0x11, 0x19] {
                for open in [false, true] {
                    let expected = if open && conversion & 1 != 0 {
                        Language::Ja
                    } else {
                        Language::En
                    };
                    assert_eq!(
                        sample(&probe(layout, Some((open, conversion)), false)),
                        Some(expected)
                    );
                }
            }
            assert_eq!(sample(&probe(layout, None, false)), None);
            assert_eq!(sample(&probe(layout, Some((true, 1)), true)), None);
            for change_focus in [false, true] {
                let mut raced = probe(layout, Some((true, 1)), false);
                if change_focus {
                    raced.next.as_mut().unwrap().focus += 1;
                } else {
                    raced.next.as_mut().unwrap().layout = 0x0412;
                }
                assert_eq!(sample(&raced), None);
            }
        }
        let mut model = Model::default();
        model.broadcast = true;
        let status = model.observe(Some(Language::Ja)).unwrap();
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({"revision":1,"language":"ja"})
        );
        assert!(model.observe(None).is_none());
        assert_eq!(model.status.language, Language::Ja);
        assert_eq!(model.status.revision, 1);
        assert!(model.observe(Some(Language::Ja)).is_none());
        assert_eq!(model.observe(Some(Language::Ko)).unwrap().revision, 2);
    }

    #[test]
    fn demand_and_unknown_samples_preserve_last_valid_revision() {
        let mut model = Model::default();
        assert!(model.observe(Some(Language::En)).is_none());
        model.broadcast = true;
        assert_eq!(model.observe(Some(Language::En)).unwrap().revision, 1);
        assert!(model.observe(None).is_none());
        assert!(model.observe(Some(Language::En)).is_none());
        model.desktop.insert("current".into());
        model.broadcast = false;
        assert_eq!(model.observe(Some(Language::Ko)).unwrap().revision, 2);
        model.stopped = true;
        assert!(model.observe(Some(Language::En)).is_none());
    }

    #[test]
    fn retiring_desktop_owner_cannot_disable_replacement_or_broadcast_observer() {
        let state = KeyboardLanguageState::default();
        state.configure_desktop("old".into(), true);
        state.configure_desktop("new".into(), true);
        state.configure_desktop("old".into(), false);
        assert!(state.0.model.lock().unwrap().demanded());
        state.configure_broadcast(true);
        state.configure_desktop("new".into(), false);
        assert!(state.0.model.lock().unwrap().demanded());
        state.configure_broadcast(false);
        assert!(!state.0.model.lock().unwrap().demanded());
    }

    #[test]
    #[ignore = "read-only live foreground observation; run explicitly"]
    fn live_foreground_input_mode_probe() {
        let expected = std::env::var("BLOCK_PET_EXPECTED_KEYCAP_LANGUAGE").ok();
        for _ in 0..20 {
            if let Some(language) = platform::sample() {
                let value = serde_json::to_value(language).unwrap();
                if expected
                    .as_ref()
                    .is_none_or(|expected| value == expected.as_str())
                {
                    println!("{value}");
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("No stable supported foreground input mode matched the explicit probe.");
    }
}
