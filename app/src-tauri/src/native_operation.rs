//! One native operation owns restart/update from download through exit.
use std::sync::atomic::{AtomicBool, Ordering};
static BUSY: AtomicBool = AtomicBool::new(false);
pub struct OperationLease {
    exiting: bool,
}
pub fn try_acquire(_operation: &str) -> Result<OperationLease, String> {
    BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "OPERATION_BUSY".to_string())?;
    Ok(OperationLease { exiting: false })
}
impl OperationLease {
    pub fn commit_exit(mut self) {
        self.exiting = true;
    }
}
impl Drop for OperationLease {
    fn drop(&mut self) {
        if !self.exiting {
            BUSY.store(false, Ordering::Release);
        }
    }
}
