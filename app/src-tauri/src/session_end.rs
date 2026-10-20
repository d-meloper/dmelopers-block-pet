//! Tao 0.35 resumes dispatch after WM_ENDSESSION has destroyed its event loop.
//! Match upstream tao#1157 after cleanup; requested exits remain runtime-owned.

pub fn finish_unrequested_exit(requested: bool, cleanup: impl FnOnce(), exit: impl FnOnce(i32)) {
    if !requested {
        cleanup();
        exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::finish_unrequested_exit;
    use std::cell::{Cell, RefCell};

    #[test]
    fn session_end_finishes_cleanup_before_terminating_successfully() {
        let effects = RefCell::new(Vec::new());
        finish_unrequested_exit(
            false,
            || effects.borrow_mut().push(("cleanup", None)),
            |code| effects.borrow_mut().push(("exit", Some(code))),
        );
        assert_eq!(*effects.borrow(), [("cleanup", None), ("exit", Some(0))]);
    }

    #[test]
    fn requested_exits_leave_cleanup_and_exit_codes_to_the_runtime() {
        finish_unrequested_exit(
            true,
            || panic!("runtime still owns requested cleanup"),
            |_| panic!("must not replace normal, restart or nonzero exit codes"),
        );
    }

    #[test]
    fn failed_cleanup_is_not_hidden_by_successful_termination() {
        let terminated = Cell::new(false);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            finish_unrequested_exit(
                false,
                || panic!("controlled cleanup failure"),
                |_| terminated.set(true),
            );
        }));
        assert!(result.is_err());
        assert!(!terminated.get());
    }
}
