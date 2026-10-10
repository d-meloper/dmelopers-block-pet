//! Retain the collector slot until the semantic cadence or a discrete boundary.
//! High-rate reports update that slot without waking the consumer again.
use super::windows::{CapturedInput, InputMessage, PendingPointer};
use std::{
    sync::{
        Arc,
        mpsc::{Receiver, RecvTimeoutError},
    },
    time::{Duration, Instant},
};

pub(super) struct PointerMailbox {
    pending: Option<PendingPointer>,
    ready_at: Instant,
    interval: Duration,
}
impl PointerMailbox {
    pub(super) fn new(now: Instant, interval: Duration) -> Self {
        Self {
            pending: None,
            ready_at: now,
            interval,
        }
    }
    pub(super) fn wait(&self, now: Instant) -> Option<Duration> {
        self.pending
            .as_ref()
            .map(|_| self.ready_at.saturating_duration_since(now))
    }
    fn take_pointer(&mut self) -> Option<CapturedInput> {
        self.pending.take()?.lock().ok()?.take()
    }
    fn flush(&mut self, now: Instant, dispatch: &mut impl FnMut(InputMessage)) {
        if let Some((event, generation, epoch)) = self.take_pointer() {
            self.ready_at = now + self.interval;
            dispatch(InputMessage::Event(event, generation, epoch));
        }
    }
    pub(super) fn flush_due(&mut self, now: Instant, dispatch: &mut impl FnMut(InputMessage)) {
        if now >= self.ready_at {
            self.flush(now, dispatch);
        }
    }
    pub(super) fn accept(
        &mut self,
        message: InputMessage,
        now: Instant,
        dispatch: &mut impl FnMut(InputMessage),
    ) {
        match message {
            InputMessage::Pointer(slot) => {
                if self
                    .pending
                    .as_ref()
                    .is_some_and(|pending| !Arc::ptr_eq(pending, &slot))
                {
                    self.flush(now, dispatch);
                }
                self.pending = Some(slot);
                self.flush_due(now, dispatch);
            }
            InputMessage::ResetMouse => {
                let _ = self.take_pointer();
                self.ready_at = now;
                dispatch(InputMessage::ResetMouse);
            }
            message @ InputMessage::Event(..) => {
                // The collector seals preceding motion before each discrete event.
                // Flush that slot now; keys, buttons and wheel never wait for a timer.
                self.flush(now, dispatch);
                if matches!(
                    &message,
                    InputMessage::Event(rdev::EventType::ButtonPress(_), ..)
                ) {
                    self.ready_at = now;
                }
                dispatch(message);
            }
        }
    }
}

pub(super) fn consume_input(
    receiver: Receiver<InputMessage>,
    interval: Duration,
    mut dispatch: impl FnMut(InputMessage),
) {
    let mut mailbox = PointerMailbox::new(Instant::now(), interval);
    loop {
        let message = match mailbox.wait(Instant::now()) {
            Some(wait) => receiver.recv_timeout(wait),
            None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match message {
            Ok(message) => mailbox.accept(message, Instant::now(), &mut dispatch),
            Err(RecvTimeoutError::Timeout) => mailbox.flush_due(Instant::now(), &mut dispatch),
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}
