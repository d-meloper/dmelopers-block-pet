use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

pub(super) enum TopmostChange {
    AlwaysOnTop(bool),
    PreferenceFocused(bool),
    ColorPicker(Option<isize>),
}

pub(super) struct TopmostRequest {
    pub hwnd: isize,
    pub change: TopmostChange,
    pub completion: Option<Sender<Result<(), String>>>,
}

#[derive(Default)]
pub(super) struct WindowOrder {
    pub main_hwnd: isize,
    pub always_on_top: bool,
    pub preference_focused: bool,
    pub picker_hwnd: Option<isize>,
    raised_preference: Option<isize>,
}

impl WindowOrder {
    pub fn main_topmost(&self) -> bool {
        self.always_on_top || self.preference_focused
    }

    fn change(&mut self, request: &TopmostRequest) {
        self.main_hwnd = request.hwnd;
        match request.change {
            TopmostChange::AlwaysOnTop(value) => self.always_on_top = value,
            TopmostChange::PreferenceFocused(value) => {
                self.preference_focused = value;
                if !value {
                    self.picker_hwnd = None;
                }
            }
            TopmostChange::ColorPicker(hwnd) => self.picker_hwnd = hwnd,
        }
    }
}

/// One native writer owns the saved setting, focus and color-popup priority.
/// It sleeps when neither applies, and checks the native topmost state while
/// active. Rapid off/on requests cannot revive an older refresh thread.
pub(super) fn maintain_topmost(
    receiver: Receiver<TopmostRequest>,
    mut apply: impl FnMut(&mut WindowOrder) -> Result<(), String>,
) {
    let mut state = WindowOrder::default();
    loop {
        let request = if state.main_topmost()
            || state.picker_hwnd.is_some()
            || state.raised_preference.is_some()
        {
            receiver.recv_timeout(Duration::from_millis(16))
        } else {
            receiver.recv().map_err(|_| RecvTimeoutError::Disconnected)
        };
        let request = match request {
            Ok(request) => Some(request),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let mut needs_apply = request.is_none();
        for request in request.into_iter().chain(receiver.try_iter()) {
            state.change(&request);
            needs_apply = true;
            if let Some(completion) = request.completion {
                // A popup may open only after its own request has been applied.
                // Do not merge it with a later close and acknowledge both.
                let result = apply(&mut state);
                if result.is_err() && matches!(request.change, TopmostChange::ColorPicker(Some(_)))
                {
                    state.picker_hwnd = None;
                    let _ = apply(&mut state);
                }
                let _ = completion.send(result);
                needs_apply = false;
            }
        }
        if needs_apply {
            let _ = apply(&mut state);
        }
    }
}

/// Reasserting HWND_TOPMOST also reorders an already-topmost window above native
/// popups such as WebView2's eyedropper. Read live state on every check so we only
/// change levels when needed, but still recover if another native operation
/// changes the level. Unknown/destroyed windows must not be repositioned.
pub(super) fn reconcile_topmost(
    hwnd: isize,
    desired: bool,
    read: impl FnOnce(isize) -> Option<bool>,
    mut apply: impl FnMut(isize, bool) -> Result<(), String>,
) -> Result<bool, String> {
    if read(hwnd).is_some_and(|current| current != desired) {
        apply(hwnd, desired)?;
        return Ok(true);
    }
    Ok(false)
}

/// Only entering/recovering picker priority may reorder the preference window.
/// A closed picker must finish restoration before its owned eyedropper starts.
pub(super) fn reconcile_window_order(
    state: &mut WindowOrder,
    available: impl Fn(isize) -> bool,
    read: impl Fn(isize) -> Option<bool>,
    mut write: impl FnMut(isize, bool) -> Result<(), String>,
) -> Result<(), String> {
    let stale_open = state.picker_hwnd.is_some_and(|hwnd| !available(hwnd));
    if stale_open {
        state.picker_hwnd = None;
        state.preference_focused = false;
    }
    if let Some(hwnd) = state.raised_preference {
        if state.picker_hwnd != Some(hwnd) {
            reconcile_topmost(hwnd, false, &read, &mut write)?;
            state.raised_preference = None;
        }
    }
    let desired_main = state.main_topmost();
    let main_changed = reconcile_topmost(state.main_hwnd, desired_main, &read, &mut write)?;
    if let Some(hwnd) = state.picker_hwnd {
        if state.raised_preference != Some(hwnd) || main_changed || read(hwnd) != Some(true) {
            state.raised_preference = Some(hwnd);
            write(hwnd, true)?;
        }
    }
    if stale_open {
        Err("The color picker requires a visible, focused preference window.".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::sync::mpsc::{self, Sender};
    use std::thread::{self, JoinHandle};
    use std::time::Instant;

    #[test]
    fn picker_priority_is_temporary_and_does_not_reorder_on_every_check() {
        for always_on_top in [false, true] {
            for preference_focused in [false, true] {
                let levels = RefCell::new([always_on_top || preference_focused, false]);
                let writes = RefCell::new(Vec::new());
                let mut state = WindowOrder {
                    main_hwnd: 1,
                    always_on_top,
                    preference_focused,
                    picker_hwnd: Some(2),
                    ..Default::default()
                };
                let check = |state: &mut WindowOrder| {
                    reconcile_window_order(
                        state,
                        |_| true,
                        |hwnd| Some(levels.borrow()[(hwnd - 1) as usize]),
                        |hwnd, topmost| {
                            levels.borrow_mut()[(hwnd - 1) as usize] = topmost;
                            writes.borrow_mut().push((hwnd, topmost));
                            Ok(())
                        },
                    )
                    .unwrap();
                };
                check(&mut state);
                for _ in 0..100 {
                    check(&mut state);
                }
                assert_eq!(*writes.borrow(), [(2, true)]);
                if state.main_topmost() {
                    levels.borrow_mut()[0] = false;
                    check(&mut state);
                    assert_eq!(&writes.borrow()[1..], [(1, true), (2, true)]);
                }
                state.picker_hwnd = None;
                check(&mut state);
                let closed_writes = writes.borrow().len();
                // The owned screen eyedropper can now start safely: no further
                // preference demotion may propagate to that new owned window.
                check(&mut state);
                assert_eq!(writes.borrow().len(), closed_writes);
                assert_eq!(writes.borrow().last(), Some(&(2, false)));
                assert_eq!(
                    *levels.borrow(),
                    [always_on_top || preference_focused, false]
                );
            }
        }
    }

    #[test]
    fn hidden_or_unfocused_preference_releases_priority_without_changing_saved_setting() {
        for always_on_top in [false, true] {
            let levels = RefCell::new([true, true]);
            let mut state = WindowOrder {
                main_hwnd: 1,
                always_on_top,
                preference_focused: true,
                picker_hwnd: Some(2),
                raised_preference: Some(2),
            };
            let result = reconcile_window_order(
                &mut state,
                |_| false,
                |hwnd| Some(levels.borrow()[(hwnd - 1) as usize]),
                |hwnd, topmost| {
                    levels.borrow_mut()[(hwnd - 1) as usize] = topmost;
                    Ok(())
                },
            );
            assert!(result.is_err());
            assert_eq!(state.picker_hwnd, None);
            assert_eq!(state.raised_preference, None);
            assert!(!state.preference_focused);
            assert_eq!(state.always_on_top, always_on_top);
            assert_eq!(*levels.borrow(), [always_on_top, false]);
        }
    }

    #[test]
    fn stale_open_never_raises_preference_and_destroyed_preference_needs_no_restore() {
        let mut state = WindowOrder {
            main_hwnd: 1,
            picker_hwnd: Some(2),
            raised_preference: Some(2),
            ..Default::default()
        };
        assert!(
            reconcile_window_order(
                &mut state,
                |_| false,
                |hwnd| (hwnd == 1).then_some(false),
                |_, _| panic!("A stale or destroyed preference must not be raised"),
            )
            .is_err()
        );
        assert_eq!(state.raised_preference, None);
    }

    #[test]
    fn acknowledged_open_and_close_are_applied_separately_before_completion() {
        let (sender, receiver) = mpsc::channel();
        let (opened, open_done) = mpsc::channel();
        let (closed, close_done) = mpsc::channel();
        sender
            .send(TopmostRequest {
                hwnd: 1,
                change: TopmostChange::ColorPicker(Some(2)),
                completion: Some(opened),
            })
            .unwrap();
        sender
            .send(TopmostRequest {
                hwnd: 1,
                change: TopmostChange::ColorPicker(None),
                completion: Some(closed),
            })
            .unwrap();
        drop(sender);
        let mut applied = Vec::new();
        maintain_topmost(receiver, |state| {
            if state.picker_hwnd.is_some() {
                assert!(open_done.try_recv().is_err());
            } else {
                assert_eq!(open_done.try_recv(), Ok(Ok(())));
                assert!(close_done.try_recv().is_err());
            }
            applied.push(state.picker_hwnd);
            Ok(())
        });
        assert_eq!(applied, [Some(2), None]);
        assert_eq!(close_done.try_recv(), Ok(Ok(())));
    }

    #[test]
    fn failed_open_is_cleared_before_returning_error() {
        let (sender, receiver) = mpsc::channel();
        let (completion, completed) = mpsc::channel();
        sender
            .send(TopmostRequest {
                hwnd: 1,
                change: TopmostChange::ColorPicker(Some(2)),
                completion: Some(completion),
            })
            .unwrap();
        drop(sender);
        let mut applied = Vec::new();
        maintain_topmost(receiver, |state| {
            applied.push(state.picker_hwnd);
            if state.picker_hwnd.is_some() {
                Err("native failure".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(applied, [Some(2), None]);
        assert_eq!(completed.try_recv(), Ok(Err("native failure".into())));
    }

    #[test]
    fn focus_loss_clears_picker_and_failed_restoration_remains_pending() {
        let mut state = WindowOrder {
            main_hwnd: 1,
            picker_hwnd: Some(2),
            raised_preference: Some(2),
            ..Default::default()
        };
        state.change(&TopmostRequest {
            hwnd: 1,
            change: TopmostChange::PreferenceFocused(false),
            completion: None,
        });
        assert_eq!(state.picker_hwnd, None);
        let preference_level = Cell::new(true);
        let attempts = Cell::new(0);
        let mut check = || {
            reconcile_window_order(
                &mut state,
                |_| false,
                |hwnd| Some(hwnd == 2 && preference_level.get()),
                |hwnd, topmost| {
                    assert_eq!((hwnd, topmost), (2, false));
                    attempts.set(attempts.get() + 1);
                    if attempts.get() == 1 {
                        Err("temporary native failure".into())
                    } else {
                        preference_level.set(false);
                        Ok(())
                    }
                },
            )
        };
        assert!(check().is_err());
        assert!(check().is_ok());
        assert!(check().is_ok());
        assert_eq!(attempts.get(), 2);
        assert_eq!(state.raised_preference, None);
    }

    #[test]
    fn repeated_checks_preserve_popup_order_and_repair_external_demotion() {
        let native_level = Cell::new(false);
        let mut writes = Vec::new();
        let mut check = |desired| {
            reconcile_topmost(
                42,
                desired,
                |hwnd| {
                    assert_eq!(hwnd, 42);
                    Some(native_level.get())
                },
                |hwnd, level| {
                    native_level.set(level);
                    writes.push((hwnd, level));
                    Ok(())
                },
            )
            .unwrap();
        };
        check(false);
        check(true);
        // Opening a topmost popup above the pet does not change the pet's flag.
        for _ in 0..100 {
            check(true);
        }
        native_level.set(false);
        check(true);
        check(true);
        check(false);
        check(false);
        assert_eq!(writes, vec![(42, true), (42, true), (42, false)]);
    }

    #[test]
    fn unknown_window_state_never_repositions_the_window() {
        for desired in [false, true] {
            reconcile_topmost(0, desired, |_| None, |_, _| panic!("unexpected write")).unwrap();
        }
    }

    #[test]
    fn failed_native_write_is_retried_from_live_state() {
        let mut attempts = 0;
        for _ in 0..2 {
            assert!(
                reconcile_topmost(
                    42,
                    true,
                    |_| Some(false),
                    |_, _| {
                        attempts += 1;
                        Err("failed native write".into())
                    }
                )
                .is_err()
            );
        }
        assert_eq!(attempts, 2);
    }

    struct Harness {
        sender: Sender<TopmostRequest>,
        applied: Receiver<(isize, bool)>,
        worker: JoinHandle<()>,
    }

    impl Harness {
        fn new() -> Self {
            let (sender, receiver) = mpsc::channel();
            let (output, applied) = mpsc::channel();
            let worker = thread::spawn(move || {
                maintain_topmost(receiver, |state| {
                    output
                        .send((state.main_hwnd, state.main_topmost()))
                        .unwrap();
                    Ok(())
                });
            });
            Self {
                sender,
                applied,
                worker,
            }
        }

        fn change(&self, change: TopmostChange, expected: bool) {
            self.sender
                .send(TopmostRequest {
                    hwnd: 42,
                    change,
                    completion: None,
                })
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let (hwnd, topmost) = self
                    .applied
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap();
                assert_eq!(hwnd, 42);
                if topmost == expected {
                    return;
                }
            }
        }

        fn finish(self) {
            drop(self.sender);
            self.worker.join().unwrap();
        }
    }

    #[test]
    fn combines_pending_reasons_before_writing_the_native_window_level() {
        use TopmostChange::{AlwaysOnTop, PreferenceFocused};
        for (changes, expected) in [
            (vec![AlwaysOnTop(false), PreferenceFocused(true)], true),
            (
                vec![
                    AlwaysOnTop(true),
                    PreferenceFocused(true),
                    PreferenceFocused(false),
                ],
                true,
            ),
            (vec![PreferenceFocused(true), AlwaysOnTop(false)], true),
            (
                vec![
                    AlwaysOnTop(false),
                    PreferenceFocused(true),
                    AlwaysOnTop(true),
                    PreferenceFocused(false),
                ],
                true,
            ),
            (
                vec![
                    AlwaysOnTop(true),
                    PreferenceFocused(true),
                    AlwaysOnTop(false),
                    PreferenceFocused(false),
                ],
                false,
            ),
        ] {
            let (sender, receiver) = mpsc::channel();
            for change in changes {
                sender
                    .send(TopmostRequest {
                        hwnd: 42,
                        change,
                        completion: None,
                    })
                    .unwrap();
            }
            drop(sender);
            let mut writes = Vec::new();
            maintain_topmost(receiver, |state| {
                writes.push((state.main_hwnd, state.main_topmost()));
                Ok(())
            });
            assert_eq!(writes, vec![(42, expected)]);
        }
    }

    #[test]
    fn preference_focus_temporarily_raises_a_non_topmost_pet() {
        let h = Harness::new();
        h.change(TopmostChange::AlwaysOnTop(false), false);
        h.change(TopmostChange::PreferenceFocused(true), true);
        h.change(TopmostChange::PreferenceFocused(false), false);
        h.finish();
    }

    #[test]
    fn focus_loss_preserves_the_users_always_on_top_setting() {
        let h = Harness::new();
        h.change(TopmostChange::AlwaysOnTop(true), true);
        h.change(TopmostChange::PreferenceFocused(true), true);
        h.change(TopmostChange::PreferenceFocused(false), true);
        h.change(TopmostChange::AlwaysOnTop(false), false);
        h.finish();
    }

    #[test]
    fn setting_changes_during_focus_apply_after_focus_loss() {
        let h = Harness::new();
        h.change(TopmostChange::PreferenceFocused(true), true);
        h.change(TopmostChange::AlwaysOnTop(true), true);
        h.change(TopmostChange::AlwaysOnTop(false), true);
        h.change(TopmostChange::PreferenceFocused(false), false);
        h.finish();
    }

    #[test]
    fn rapid_focus_changes_leave_no_old_writer_raising_the_pet() {
        let h = Harness::new();
        h.change(TopmostChange::AlwaysOnTop(false), false);
        for _ in 0..50 {
            h.sender
                .send(TopmostRequest {
                    hwnd: 42,
                    change: TopmostChange::PreferenceFocused(true),
                    completion: None,
                })
                .unwrap();
            h.sender
                .send(TopmostRequest {
                    hwnd: 42,
                    change: TopmostChange::PreferenceFocused(false),
                    completion: None,
                })
                .unwrap();
        }
        h.change(TopmostChange::PreferenceFocused(false), false);
        drop(h.sender);
        h.worker.join().unwrap();
        assert!(
            h.applied
                .try_iter()
                .last()
                .is_none_or(|(_, topmost)| !topmost)
        );
    }
}
