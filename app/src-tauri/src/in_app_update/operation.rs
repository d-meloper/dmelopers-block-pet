use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

#[derive(Clone, Default)]
pub(super) struct Cancellation(Arc<CancelState>);
#[derive(Default)]
struct CancelState {
    cancelled: AtomicBool,
    changed: Notify,
}
impl Cancellation {
    pub fn check(&self) -> Result<(), String> {
        if self.0.cancelled.load(Ordering::Acquire) {
            Err("UPDATE_CANCELLED".into())
        } else {
            Ok(())
        }
    }
    fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
        self.0.changed.notify_one();
    }
    pub async fn wait(&self) {
        loop {
            let notified = self.0.changed.notified();
            if self.check().is_err() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Phase {
    Downloading,
    Verifying,
    Verified,
    Saving,
    Installing,
}
struct Active {
    id: String,
    phase: Phase,
    cancellation: Cancellation,
    _lease: crate::native_operation::OperationLease,
}
#[derive(Default)]
pub(super) struct Control(Mutex<Option<Active>>);
impl Control {
    pub fn idle(&self) -> Result<(), String> {
        if self.0.lock().map_err(|_| "UPDATE_BUSY")?.is_some() {
            Err("UPDATE_BUSY".into())
        } else {
            Ok(())
        }
    }
    pub fn start(&self, id: &str) -> Result<Cancellation, String> {
        if id.is_empty()
            || id.len() > 80
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("UPDATE_REQUEST_INVALID".into());
        }
        let mut active = self.0.lock().map_err(|_| "UPDATE_BUSY")?;
        if active.is_some() {
            return Err("UPDATE_BUSY".into());
        }
        let lease = crate::native_operation::try_acquire("update")?;
        let cancellation = Cancellation::default();
        *active = Some(Active {
            id: id.into(),
            phase: Phase::Downloading,
            cancellation: cancellation.clone(),
            _lease: lease,
        });
        Ok(cancellation)
    }
    pub fn transition(&self, id: &str, from: Phase, to: Phase) -> Result<(), String> {
        let mut active = self.0.lock().map_err(|_| "UPDATE_BUSY")?;
        let active = active
            .as_mut()
            .filter(|a| a.id == id)
            .ok_or("UPDATE_REQUEST_INVALID")?;
        active.cancellation.check()?;
        if active.phase != from {
            return Err("UPDATE_PHASE_INVALID".into());
        }
        active.phase = to;
        Ok(())
    }
    pub fn cancel(&self, id: &str) -> Result<Phase, String> {
        let active = self.0.lock().map_err(|_| "UPDATE_BUSY")?;
        let active = active
            .as_ref()
            .filter(|a| a.id == id)
            .ok_or("UPDATE_REQUEST_INVALID")?;
        if matches!(active.phase, Phase::Saving | Phase::Installing) {
            return Err("UPDATE_TOO_LATE".into());
        }
        active.cancellation.cancel();
        Ok(active.phase)
    }
    pub fn abort_save(&self, id: &str) -> Result<(), String> {
        let active = self.0.lock().map_err(|_| "UPDATE_BUSY")?;
        let active = active
            .as_ref()
            .filter(|a| a.id == id)
            .ok_or("UPDATE_REQUEST_INVALID")?;
        if !matches!(active.phase, Phase::Verified | Phase::Saving) {
            return Err("UPDATE_TOO_LATE".into());
        }
        active.cancellation.cancel();
        Ok(())
    }
    pub fn finish(&self, id: &str) {
        if let Ok(mut active) = self.0.lock() {
            if active.as_ref().is_some_and(|a| a.id == id) {
                *active = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_before_subscription_is_not_lost() {
        let cancel = Cancellation::default();
        cancel.cancel();
        tokio::time::timeout(std::time::Duration::from_millis(50), cancel.wait())
            .await
            .unwrap();
        assert_eq!(cancel.check().unwrap_err(), "UPDATE_CANCELLED");
    }
    #[test]
    fn request_bound_cancellation_and_saving_are_atomic() {
        let control = Control::default();
        let token = control.start("test-operation").unwrap();
        assert!(control.cancel("stale").is_err());
        assert!(token.check().is_ok());
        control
            .transition("test-operation", Phase::Downloading, Phase::Verifying)
            .unwrap();
        control
            .transition("test-operation", Phase::Verifying, Phase::Verified)
            .unwrap();
        control
            .transition("test-operation", Phase::Verified, Phase::Saving)
            .unwrap();
        assert_eq!(
            control.cancel("test-operation").unwrap_err(),
            "UPDATE_TOO_LATE"
        );
        assert!(crate::native_operation::try_acquire("restart").is_err());
        control.finish("stale");
        assert!(control.idle().is_err());
        control.finish("test-operation");
        assert!(control.idle().is_ok());
    }
}
