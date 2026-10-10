use super::pointer_mailbox::PointerMailbox;
use super::*;
use std::sync::{Arc, Mutex};

struct Harness {
    mailbox: PointerMailbox,
    state: AggregateState,
    desktop: u64,
    epoch: u64,
    generation: u64,
    observed: Vec<SemanticInputEvent>,
    accepted: Vec<EventType>,
    reset_count: usize,
}
impl Harness {
    fn new(now: Instant) -> Self {
        Self {
            mailbox: PointerMailbox::new(now, POINTER_INTERVAL),
            state: AggregateState::default(),
            desktop: next_consumer_word(0, Some(true)),
            epoch: 0,
            generation: 7,
            observed: Vec::new(),
            accepted: Vec::new(),
            reset_count: 0,
        }
    }
    fn apply(&mut self, messages: Vec<windows::InputMessage>) {
        for message in messages {
            match message {
                windows::InputMessage::ResetMouse => {
                    self.state.reset_mouse();
                    self.reset_count += 1;
                }
                windows::InputMessage::Event(event, generation, epoch) => {
                    if !is_current_input(&event, generation, self.generation)
                        || !accepts_captured_input(&event, epoch.desktop, self.desktop)
                    {
                        continue;
                    }
                    refresh_aggregate(&mut self.state, &mut self.epoch, epoch.desktop);
                    self.accepted.push(event);
                    process_input_event(&mut self.state, &event, |event| self.observed.push(event));
                }
                _ => panic!("mailbox must consume pointer slots"),
            }
        }
    }
    fn accept(&mut self, message: windows::InputMessage, now: Instant) {
        let mut output = Vec::new();
        self.mailbox
            .accept(message, now, &mut |message| output.push(message));
        self.apply(output);
    }
    fn tick(&mut self, now: Instant) {
        let mut output = Vec::new();
        self.mailbox
            .flush_due(now, &mut |message| output.push(message));
        self.apply(output);
    }
    fn discrete(&mut self, event: EventType, now: Instant) {
        self.accept(
            windows::InputMessage::Event(
                event,
                self.generation,
                InputEpoch {
                    desktop: self.desktop,
                    broadcast: 0,
                },
            ),
            now,
        );
    }
    fn slot(&self, x: f64) -> windows::PendingPointer {
        Arc::new(Mutex::new(Some((
            EventType::MouseMove { x, y: 2. },
            self.generation,
            InputEpoch {
                desktop: self.desktop,
                broadcast: 0,
            },
        ))))
    }
}

#[test]
fn native_mailbox_100000_reports_have_bounded_wakes_and_exact_final_tail() {
    let now = Instant::now();
    let mut h = Harness::new(now);
    let slot = h.slot(0.);
    let mut wakes = 0;
    for index in 0..100000 {
        let wake = slot.lock().unwrap().is_none() || index == 0;
        *slot.lock().unwrap() = Some((
            EventType::MouseMove {
                x: index as f64,
                y: 2.,
            },
            7,
            InputEpoch {
                desktop: h.desktop,
                broadcast: 0,
            },
        ));
        let time = now + Duration::from_millis(index);
        if wake {
            wakes += 1;
            h.accept(windows::InputMessage::Pointer(Arc::clone(&slot)), time);
        }
        h.tick(time);
    }
    assert!(
        matches!(h.observed.last(),Some(SemanticInputEvent::PointerActivity{x,..}) if *x==99984.)
    );
    h.tick(now + Duration::from_millis(100000));
    assert!(
        matches!(h.observed.last(),Some(SemanticInputEvent::PointerActivity{x,..}) if *x==99999.)
    );
    assert_eq!(wakes, 6251);
    assert_eq!(h.observed.len(), 6251);
    assert_eq!(h.mailbox.wait(now + Duration::from_millis(100001)), None);
    println!(
        "reports=100000 cadence_pointer_wakes={wakes} emissions={} final_x=99999 tail_delay_ms=1",
        h.observed.len()
    );
}

#[test]
fn native_mailbox_preserves_press_move_release_repeated_release_and_key_wheel_order() {
    let now = Instant::now();
    let mut h = Harness::new(now);
    h.accept(windows::InputMessage::Pointer(h.slot(0.)), now);
    h.discrete(
        EventType::ButtonPress(Button::Left),
        now + Duration::from_millis(1),
    );
    h.accept(
        windows::InputMessage::Pointer(h.slot(1.)),
        now + Duration::from_millis(2),
    );
    assert!(h.state.dragging, "first move after press remains immediate");
    h.accept(
        windows::InputMessage::Pointer(h.slot(2.)),
        now + Duration::from_millis(3),
    );
    h.discrete(
        EventType::ButtonRelease(Button::Left),
        now + Duration::from_millis(4),
    );
    h.discrete(
        EventType::ButtonRelease(Button::Left),
        now + Duration::from_millis(5),
    );
    h.accept(
        windows::InputMessage::Pointer(h.slot(3.)),
        now + Duration::from_millis(6),
    );
    h.discrete(
        EventType::KeyPress(Key::KeyF),
        now + Duration::from_millis(7),
    );
    h.accept(
        windows::InputMessage::Pointer(h.slot(4.)),
        now + Duration::from_millis(8),
    );
    h.discrete(
        EventType::Wheel {
            delta_x: 0,
            delta_y: 1,
        },
        now + Duration::from_millis(9),
    );
    assert_eq!(
        h.accepted,
        vec![
            EventType::MouseMove { x: 0., y: 2. },
            EventType::ButtonPress(Button::Left),
            EventType::MouseMove { x: 1., y: 2. },
            EventType::MouseMove { x: 2., y: 2. },
            EventType::ButtonRelease(Button::Left),
            EventType::ButtonRelease(Button::Left),
            EventType::MouseMove { x: 3., y: 2. },
            EventType::KeyPress(Key::KeyF),
            EventType::MouseMove { x: 4., y: 2. },
            EventType::Wheel {
                delta_x: 0,
                delta_y: 1
            }
        ]
    );
    assert!(!h.state.primary_pressed && !h.state.dragging);
    assert!(h.state.pressed_keys.contains(&Key::KeyF));
    h.tick(now + Duration::from_secs(1));
    assert_eq!(h.accepted.len(), 10);
}

#[test]
fn native_mailbox_reset_cancels_tail_preserves_keyboard_and_resumes_hover_immediately() {
    let now = Instant::now();
    let mut h = Harness::new(now);
    h.discrete(EventType::KeyPress(Key::KeyF), now);
    h.accept(windows::InputMessage::Pointer(h.slot(0.)), now);
    let old = h.slot(1.);
    h.accept(
        windows::InputMessage::Pointer(Arc::clone(&old)),
        now + Duration::from_millis(1),
    );
    h.accept(
        windows::InputMessage::ResetMouse,
        now + Duration::from_millis(2),
    );
    assert!(old.lock().unwrap().is_none());
    assert!(h.state.pressed_keys.contains(&Key::KeyF));
    h.generation += 1;
    h.desktop = next_consumer_word(h.desktop, Some(false));
    h.accept(
        windows::InputMessage::Pointer(h.slot(2.)),
        now + Duration::from_millis(3),
    );
    assert!(matches!(h.observed.last(),Some(SemanticInputEvent::PointerActivity{x,..}) if *x==2.));
    assert!(h.state.pressed_keys.contains(&Key::KeyF));
    h.discrete(
        EventType::KeyRelease(Key::KeyF),
        now + Duration::from_millis(4),
    );
    assert!(h.state.pressed_keys.is_empty());
    assert_eq!(h.reset_count, 1);
    h.tick(now + Duration::from_secs(1));
    assert!(
        !h.observed
            .iter()
            .any(|e| matches!(e,SemanticInputEvent::PointerActivity{x,..} if *x==1.))
    );
}

#[test]
fn native_mailbox_old_epoch_generation_and_retired_consumer_cannot_emit_tail() {
    let now = Instant::now();
    for change in 0..3 {
        let mut h = Harness::new(now);
        h.accept(windows::InputMessage::Pointer(h.slot(0.)), now);
        h.accept(
            windows::InputMessage::Pointer(h.slot(1.)),
            now + Duration::from_millis(1),
        );
        match change {
            0 => h.generation += 1,
            1 => h.desktop = next_consumer_word(h.desktop, Some(false)),
            _ => h.desktop = next_consumer_word(h.desktop, None),
        }
        h.tick(now + Duration::from_millis(16));
        assert_eq!(h.observed.len(), 1);
        assert_eq!(h.mailbox.wait(now + Duration::from_millis(17)), None);
    }
}

#[test]
fn native_mailbox_long_stationary_hold_has_no_pending_timer_or_duplicate_tail() {
    let now = Instant::now();
    let mut h = Harness::new(now);
    h.discrete(EventType::ButtonPress(Button::Left), now);
    for seconds in [1, 10, 60] {
        assert_eq!(h.mailbox.wait(now + Duration::from_secs(seconds)), None);
        h.tick(now + Duration::from_secs(seconds));
    }
    h.discrete(
        EventType::ButtonRelease(Button::Left),
        now + Duration::from_secs(61),
    );
    assert_eq!(h.accepted.len(), 2);
    assert_eq!(h.observed.len(), 2);
}

#[test]
fn native_mailbox_live_receiver_delivers_timer_tail_without_another_report_and_stops() {
    let (sender, receiver) = mpsc::channel();
    let (seen, output) = mpsc::channel();
    let worker = thread::spawn(move || {
        pointer_mailbox::consume_input(receiver, POINTER_INTERVAL, |event| {
            if let windows::InputMessage::Event(event, ..) = event {
                seen.send(event).unwrap();
            }
        })
    });
    let input = |x| {
        Arc::new(Mutex::new(Some((
            EventType::MouseMove { x, y: 2. },
            7,
            InputEpoch {
                desktop: 7,
                broadcast: 0,
            },
        ))))
    };
    sender
        .send(windows::InputMessage::Pointer(input(0.)))
        .unwrap();
    assert_eq!(
        output.recv_timeout(Duration::from_secs(1)).unwrap(),
        EventType::MouseMove { x: 0., y: 2. }
    );
    sender
        .send(windows::InputMessage::Pointer(input(1.)))
        .unwrap();
    assert_eq!(
        output.recv_timeout(Duration::from_secs(1)).unwrap(),
        EventType::MouseMove { x: 1., y: 2. }
    );
    drop(sender);
    worker.join().unwrap();
    assert!(output.recv().is_err());
}
