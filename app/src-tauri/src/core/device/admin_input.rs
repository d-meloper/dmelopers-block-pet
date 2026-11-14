//! The privileged process owns only the existing input collector. All state,
//! windows, registry writes and application services stay in the original user.
use super::*;
use crate::core::elevation::Transport;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Condvar, atomic::AtomicBool};

const CONFIG_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT_MS: u32 = 5_000;
static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Target {
    Desktop,
    Broadcast,
}

impl Target {
    fn index(self) -> usize {
        match self {
            Self::Desktop => 0,
            Self::Broadcast => 1,
        }
    }
    fn word(self) -> u64 {
        match self {
            Self::Desktop => DESKTOP_INPUT.load(Ordering::SeqCst),
            Self::Broadcast => BROADCAST_INPUT.load(Ordering::SeqCst),
        }
    }
}

#[derive(Default)]
struct HeldInput {
    contacts: HashSet<(u8, u8)>,
}

impl HeldInput {
    fn observe(&mut self, event: &SemanticInputEvent) {
        if let SemanticInputEvent::Typing {
            contact: Some(contact),
            ..
        } = event
        {
            let identity = (contact.row, contact.column);
            if contact.pressed {
                self.contacts.insert(identity);
            } else {
                self.contacts.remove(&identity);
            }
        }
    }

    fn release(&mut self) -> Vec<SemanticInputEvent> {
        let mut releases: Vec<_> = self
            .contacts
            .drain()
            .map(|(row, column)| SemanticInputEvent::Typing {
                active: false,
                intensity: 0.0,
                contact: Some(KeyboardContact {
                    row,
                    column,
                    pressed: false,
                }),
            })
            .collect();
        releases.extend([
            SemanticInputEvent::Typing {
                active: false,
                intensity: 0.0,
                contact: None,
            },
            SemanticInputEvent::MousePrimary { active: false },
            SemanticInputEvent::MouseSecondary { active: false },
            SemanticInputEvent::MouseMiddle { active: false },
            SemanticInputEvent::Drag { active: false },
        ]);
        releases
    }
}

#[derive(Clone)]
pub(super) struct InputHost {
    deliver: Arc<dyn Fn(Target, SemanticInputEvent, u64) + Send + Sync>,
    status: Arc<dyn Fn() + Send + Sync>,
    failure: Arc<dyn Fn() + Send + Sync>,
    held: Arc<Mutex<[HeldInput; 2]>>,
}

pub(super) struct CollectorGuard {
    host: InputHost,
    expected_stop: Arc<AtomicBool>,
}

impl CollectorGuard {
    pub(super) fn new(host: InputHost, expected_stop: Arc<AtomicBool>) -> Self {
        Self {
            host,
            expected_stop,
        }
    }
}

impl Drop for CollectorGuard {
    fn drop(&mut self) {
        if !self.expected_stop.load(Ordering::SeqCst) {
            self.host.collector_failed();
        }
    }
}

impl InputHost {
    fn new(
        deliver: impl Fn(Target, SemanticInputEvent, u64) + Send + Sync + 'static,
        status: impl Fn() + Send + Sync + 'static,
        failure: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        Self {
            deliver: Arc::new(deliver),
            status: Arc::new(status),
            failure: Arc::new(failure),
            held: Arc::new(Mutex::new(Default::default())),
        }
    }

    pub(super) fn emit(&self, target: Target, event: SemanticInputEvent, epoch: u64) {
        if !accepts_semantic_epoch(&event, epoch, target.word()) {
            return;
        }
        if let Ok(mut held) = self.held.lock() {
            held[target.index()].observe(&event);
        }
        (self.deliver)(target, event, epoch);
    }

    fn reset(&self) {
        let releases = self
            .held
            .lock()
            .map(|mut held| [held[0].release(), held[1].release()])
            .unwrap_or_default();
        for (target, events) in [Target::Desktop, Target::Broadcast]
            .into_iter()
            .zip(releases)
        {
            for event in events {
                self.emit(target, event, target.word());
            }
        }
    }

    pub(super) fn status_changed(&self) {
        (self.status)();
    }
    pub(super) fn collector_failed(&self) {
        (self.failure)();
    }
}

pub(super) fn bind_host<R: Runtime>(registry: &mut ListenerRegistry, app: AppHandle<R>) {
    if registry.host.is_none() {
        let status_app = app.clone();
        registry.host = Some(InputHost::new(
            move |target, event, epoch| match target {
                Target::Desktop => emit_to_main(&app, event, epoch),
                Target::Broadcast => emit_to_broadcast(&app, event, epoch),
            },
            move || {
                let _ = status_app.emit("admin-input-status", ());
            },
            || crate::diagnostics::warn("input.collector", "HOOK_THREAD_EXITED"),
        ));
    }
    if let Some(remote) = &registry.remote {
        if let Ok(mut host) = remote.host.lock() {
            *host = registry.host.clone();
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ConsumerConfig {
    word: u64,
    keyboard_since: u64,
    mouse_since: u64,
}

impl ConsumerConfig {
    fn current(word: &AtomicU64, cutoffs: &InputCutoffs) -> Self {
        Self {
            word: word.load(Ordering::SeqCst),
            keyboard_since: cutoffs.keyboard.load(Ordering::SeqCst),
            mouse_since: cutoffs.mouse.load(Ordering::SeqCst),
        }
    }
    fn plan(self, demand: Option<bool>, now: u64) -> Self {
        let word = next_consumer_word(self.word, demand);
        if word == self.word {
            return self;
        }
        Self {
            word,
            keyboard_since: if word >> 32 == self.word >> 32 {
                self.keyboard_since
            } else {
                now
            },
            mouse_since: now,
        }
    }
    fn valid(self, now: u64) -> bool {
        self.word & 3 != 2 && self.keyboard_since <= now && self.mouse_since <= now
    }
    fn install(self, word: &AtomicU64, cutoffs: &InputCutoffs) {
        cutoffs
            .keyboard
            .store(self.keyboard_since, Ordering::SeqCst);
        cutoffs.mouse.store(self.mouse_since, Ordering::SeqCst);
        word.store(self.word, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    desktop: ConsumerConfig,
    broadcast: ConsumerConfig,
}

impl Configuration {
    fn current() -> Self {
        Self {
            desktop: ConsumerConfig::current(&DESKTOP_INPUT, &DESKTOP_CUTOFFS),
            broadcast: ConsumerConfig::current(&BROADCAST_INPUT, &BROADCAST_CUTOFFS),
        }
    }
    fn plan(consumers: Consumers) -> Self {
        let current = Self::current();
        let now = unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() };
        Self {
            desktop: current.desktop.plan(consumers.desktop, now),
            broadcast: current.broadcast.plan(consumers.broadcast, now),
        }
    }
    fn consumers(self) -> Consumers {
        Consumers {
            desktop: consumer_demand(self.desktop.word),
            broadcast: consumer_demand(self.broadcast.word),
        }
    }
    fn install(self) {
        self.desktop.install(&DESKTOP_INPUT, &DESKTOP_CUTOFFS);
        self.broadcast.install(&BROADCAST_INPUT, &BROADCAST_CUTOFFS);
    }
    fn valid(self) -> bool {
        let now = unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() };
        self.desktop.valid(now) && self.broadcast.valid(now)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Control {
    Configure {
        request: u64,
        configuration: Configuration,
    },
    // An empty struct keeps deny_unknown_fields active; serde's internally
    // tagged unit variant otherwise accepts and discards extra map entries.
    Stop {},
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WorkerMessage {
    Configured {
        request: u64,
    },
    Input {
        target: Target,
        epoch: u64,
        event: SemanticInputEvent,
    },
}

fn valid_semantic(event: &SemanticInputEvent) -> bool {
    match event {
        SemanticInputEvent::Typing {
            active,
            intensity,
            contact,
        } => {
            intensity.is_finite()
                && (0.0..=1.0).contains(intensity)
                && contact.as_ref().is_none_or(|contact| {
                    contact.row < 5 && contact.column < 16 && (!contact.pressed || *active)
                })
        }
        SemanticInputEvent::PointerActivity { x, y } => {
            x.is_finite()
                && y.is_finite()
                && *x >= i32::MIN as f64
                && *x <= i32::MAX as f64
                && *y >= i32::MIN as f64
                && *y <= i32::MAX as f64
        }
        SemanticInputEvent::Scroll { delta_x, delta_y } => {
            (-1200..=1200).contains(delta_x) && (-1200..=1200).contains(delta_y)
        }
        _ => true,
    }
}

#[derive(Default)]
struct Acknowledgements {
    last: u64,
    failed: bool,
}

struct Shared {
    delivery: Mutex<bool>,
    alive: AtomicBool,
    acknowledgement: Mutex<Acknowledgements>,
    changed: Condvar,
}

impl Shared {
    fn fail(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut delivery) = self.delivery.lock() {
            *delivery = false;
        }
        if let Ok(mut state) = self.acknowledgement.lock() {
            state.failed = true;
        }
        self.changed.notify_all();
    }
    fn wait(&self, request: u64, timeout: Duration) -> Result<(), String> {
        let state = self
            .acknowledgement
            .lock()
            .map_err(|_| "INPUT_ADMIN_UNAVAILABLE")?;
        let (state, wait) = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                !state.failed && state.last < request
            })
            .map_err(|_| "INPUT_ADMIN_UNAVAILABLE")?;
        if state.failed || wait.timed_out() || state.last != request {
            Err("INPUT_ADMIN_UNAVAILABLE".into())
        } else {
            Ok(())
        }
    }
}

pub(super) struct Connection {
    id: u64,
    transport: Transport,
    shared: Arc<Shared>,
    host: Arc<Mutex<Option<InputHost>>>,
    reader: Option<JoinHandle<()>>,
    next_request: AtomicU64,
}

// Retain the exact worker handle after disconnect/cancellation until its kernel
// process handle signals. A cancelled pipe alone never proves privilege ended.
#[derive(Clone)]
pub(super) struct StoppingPeer {
    id: u64,
    transport: Transport,
}

impl StoppingPeer {
    fn from_connection(connection: &Connection) -> Self {
        Self {
            id: connection.id,
            transport: connection.transport.clone(),
        }
    }
    fn running_or_unknown(&self) -> bool {
        self.transport.wait_for_peer_exit(0).is_err()
    }
    pub(super) fn cancel(&self) {
        self.transport.cancel();
    }
}

impl Connection {
    fn start(transport: Transport, host: Option<InputHost>) -> Result<Self, String> {
        let id = NEXT_CONNECTION.fetch_add(1, Ordering::SeqCst);
        let shared = Arc::new(Shared {
            delivery: Mutex::new(true),
            alive: AtomicBool::new(true),
            acknowledgement: Mutex::new(Acknowledgements::default()),
            changed: Condvar::new(),
        });
        let host = Arc::new(Mutex::new(host));
        let io = transport.clone();
        let observed = shared.clone();
        let delivery_host = host.clone();
        let reader = thread::Builder::new()
            .name("pet-admin-input-reader".into())
            .spawn(move || {
                while observed.alive.load(Ordering::SeqCst) && io.alive() {
                    match io.receive::<WorkerMessage>() {
                        Ok(WorkerMessage::Configured { request }) => {
                            let Ok(mut ack) = observed.acknowledgement.lock() else {
                                break;
                            };
                            if request <= ack.last {
                                break;
                            }
                            ack.last = request;
                            observed.changed.notify_all();
                        }
                        Ok(WorkerMessage::Input {
                            target,
                            epoch,
                            event,
                        }) if valid_semantic(&event) => {
                            let Ok(enabled) = observed.delivery.lock() else {
                                break;
                            };
                            if !*enabled {
                                break;
                            }
                            let host = delivery_host.lock().ok().and_then(|host| host.clone());
                            if let Some(host) = host {
                                host.emit(target, event, epoch);
                            }
                        }
                        _ => break,
                    }
                }
                observed.fail();
                io.cancel();
                recover_local(id);
            })
            .map_err(|_| {
                transport.cancel();
                "INPUT_ADMIN_UNAVAILABLE".to_owned()
            })?;
        Ok(Self {
            id,
            transport,
            shared,
            host,
            reader: Some(reader),
            next_request: AtomicU64::new(1),
        })
    }
    fn alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
            && self.transport.alive()
            && self
                .reader
                .as_ref()
                .is_some_and(|reader| !reader.is_finished())
    }
    fn configure(&self, configuration: Configuration) -> Result<(), String> {
        let request = self.next_request.fetch_add(1, Ordering::SeqCst);
        if request == 0 || !self.alive() {
            return Err("INPUT_ADMIN_UNAVAILABLE".into());
        }
        if self
            .transport
            .send(&Control::Configure {
                request,
                configuration,
            })
            .is_err()
            || self.shared.wait(request, CONFIG_TIMEOUT).is_err()
            || !self.alive()
        {
            self.cancel();
            return Err("INPUT_ADMIN_UNAVAILABLE".into());
        }
        Ok(())
    }
    pub(super) fn cancel(&self) {
        self.shared.fail();
        self.transport.cancel();
    }
    pub(super) fn join(mut self) {
        self.cancel();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
    fn join_bounded(mut self) -> Result<(), String> {
        self.cancel();
        let deadline = Instant::now() + Duration::from_millis(500);
        if let Some(reader) = self.reader.take() {
            while !reader.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            if !reader.is_finished() {
                // Cancellation already disabled delivery. Detach rather than
                // block the UI indefinitely on an unrelated event-loop stall.
                return Err("INPUT_ADMIN_UNAVAILABLE".into());
            }
            reader
                .join()
                .map_err(|_| "INPUT_ADMIN_UNAVAILABLE".to_owned())?;
        }
        Ok(())
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn recover_local(id: u64) {
    let Ok(mut registry) = WINDOWS_LISTENER.lock() else {
        return;
    };
    if registry
        .remote
        .as_ref()
        .is_none_or(|remote| remote.id != id)
    {
        return;
    }
    // Dropping our own JoinHandle detaches only this already finishing reader.
    if let Some(remote) = registry.remote.take() {
        registry.stopping = Some(StoppingPeer::from_connection(&remote));
    }
    let peer = registry.stopping.clone();
    let host = registry.host.clone();
    if let Some(host) = &host {
        host.reset();
        if registry.consumers.active() {
            match create_windows_listener(host.clone(), registry.consumers.mouse_enabled()) {
                Ok(listener) => registry.listener = Some(listener),
                Err(error) => log_input_failure("input.admin_fallback", &error),
            }
        }
    }
    crate::diagnostics::warn("input.admin_connection", "INPUT_ADMIN_DISCONNECTED");
    drop(registry);
    if let Some(host) = host {
        host.status_changed();
    }
    // Finish this reader with one bounded kernel wait, never a watcher or
    // polling loop. Explicit disable already took remote, so it returns above.
    if let Some(peer) = peer {
        if peer.transport.wait_for_peer_exit(STOP_TIMEOUT_MS).is_ok() {
            let host = WINDOWS_LISTENER.lock().ok().and_then(|mut registry| {
                clear_stopping_after_confirmed_exit(&mut registry, peer.id)
            });
            if let Some(host) = host {
                host.status_changed();
            }
        }
    }
}

fn clear_stopping_after_confirmed_exit(
    registry: &mut ListenerRegistry,
    id: u64,
) -> Option<InputHost> {
    if registry.stopping.as_ref().is_some_and(|peer| peer.id == id) {
        registry.stopping = None;
        registry.host.clone()
    } else {
        None
    }
}

pub(super) fn configure_remote(
    registry: &mut ListenerRegistry,
    consumers: Consumers,
) -> Result<bool, String> {
    let Some(remote) = registry.remote.as_ref() else {
        return Ok(false);
    };
    if !remote.alive() {
        if let Some(remote) = registry.remote.take() {
            registry.stopping = Some(StoppingPeer::from_connection(&remote));
        }
        if let Some(host) = &registry.host {
            host.reset();
            host.status_changed();
        }
        return Ok(false);
    }
    let configuration = Configuration::plan(consumers);
    remote.configure(configuration)?;
    // The frontend acknowledgement follows the worker's completed registration.
    // Failed/unknown configuration never commits a new parent consumer epoch.
    configuration.install();
    registry.consumers = consumers;
    Ok(true)
}

pub(crate) fn elevated_input_active() -> bool {
    WINDOWS_LISTENER.lock().ok().is_some_and(|registry| {
        registry.remote.as_ref().is_some_and(Connection::alive)
            || registry
                .stopping
                .as_ref()
                .is_some_and(StoppingPeer::running_or_unknown)
    })
}

pub(crate) fn activate_elevated_input(transport: Transport) -> Result<(), String> {
    let mut registry = WINDOWS_LISTENER
        .lock()
        .map_err(|_| "INPUT_ADMIN_UNAVAILABLE")?;
    if registry.remote.as_ref().is_some_and(Connection::alive) {
        transport.cancel();
        return Err("INPUT_ADMIN_ALREADY_ACTIVE".into());
    }
    if let Some(remote) = registry.remote.take() {
        registry.stopping = Some(StoppingPeer::from_connection(&remote));
    }
    if registry
        .stopping
        .as_ref()
        .is_some_and(StoppingPeer::running_or_unknown)
    {
        transport.cancel();
        return Err("INPUT_ADMIN_STOPPING".into());
    }
    registry.stopping = None;
    if let Some(listener) = registry.listener.as_mut() {
        if let Err(error) = listener.stop() {
            transport.cancel();
            return Err(error);
        }
    }
    registry.listener = None;
    let host = registry.host.clone();
    if let Some(host) = &host {
        host.reset();
    }
    let connection = Connection::start(transport, host.clone()).and_then(|connection| {
        connection.configure(Configuration::current())?;
        Ok(connection)
    });
    let connection = match connection {
        Ok(connection) => connection,
        Err(error) => {
            if let Some(host) = &host {
                host.reset();
            }
            if registry.consumers.active() {
                if let Some(host) = host.clone() {
                    registry.listener = Some(create_windows_listener(
                        host,
                        registry.consumers.mouse_enabled(),
                    )?);
                }
            }
            return Err(error);
        }
    };
    registry.remote = Some(connection);
    drop(registry);
    if let Some(host) = host {
        host.status_changed();
    }
    Ok(())
}

pub(crate) fn deactivate_elevated_input() -> Result<(), String> {
    deactivate_with_timeout(STOP_TIMEOUT_MS)
}

fn deactivate_with_timeout(timeout_ms: u32) -> Result<(), String> {
    let (connection, peer, restore) = {
        let mut registry = WINDOWS_LISTENER
            .lock()
            .map_err(|_| "INPUT_ADMIN_UNAVAILABLE")?;
        let connection = registry.remote.take();
        if let Some(connection) = &connection {
            registry.stopping = Some(StoppingPeer::from_connection(connection));
            // Disable event delivery before resetting the held contacts. The
            // reader may finish, but cannot reenter recovery for a removed id.
            connection.cancel();
        }
        let peer = registry.stopping.clone();
        if let Some(peer) = &peer {
            peer.cancel();
        }
        if connection.is_some() || peer.is_some() {
            if let Some(host) = &registry.host {
                host.reset();
            }
        }
        let restore = restore_standard_listener(&mut registry);
        (connection, peer, restore)
    };

    // No registry lock is held across reader cleanup or the bounded kernel
    // wait. An errored/late worker cannot block ordinary input while stopping.
    let exited = peer.as_ref().map_or(Ok(()), |peer| {
        peer.transport
            .wait_for_peer_exit(timeout_ms.min(STOP_TIMEOUT_MS))
    });
    let reader = connection.map_or(Ok(()), Connection::join_bounded);
    let host = {
        let mut registry = WINDOWS_LISTENER
            .lock()
            .map_err(|_| "INPUT_ADMIN_UNAVAILABLE")?;
        if exited.is_ok()
            && peer.as_ref().is_some_and(|peer| {
                registry
                    .stopping
                    .as_ref()
                    .is_some_and(|current| current.id == peer.id)
            })
        {
            registry.stopping = None;
        }
        registry.host.clone()
    };
    if let Some(host) = host {
        host.status_changed();
    }
    // Both the worker's actual exit and ordinary collector restoration must be
    // confirmed. Timeout retains the peer for status readback and a later retry.
    exited?;
    reader?;
    restore
}

fn restore_standard_listener(registry: &mut ListenerRegistry) -> Result<(), String> {
    if !registry.consumers.active() {
        if let Some(listener) = registry.listener.as_mut() {
            listener.stop()?;
        }
        registry.listener = None;
        return Ok(());
    }
    if registry
        .listener
        .as_ref()
        .is_some_and(|listener| listener.hooks.is_finished())
    {
        if let Some(listener) = registry.listener.as_mut() {
            listener.stop()?;
        }
        registry.listener = None;
    }
    if registry.consumers.active() && registry.listener.is_none() {
        let host = registry.host.clone().ok_or("INPUT_HOST_UNAVAILABLE")?;
        registry.listener = Some(create_windows_listener(
            host,
            registry.consumers.mouse_enabled(),
        )?);
    }
    if let Some(listener) = &registry.listener {
        if listener.hooks.state()?.mouse_enabled != registry.consumers.mouse_enabled() {
            listener
                .hooks
                .configure(registry.consumers.mouse_enabled())?;
        }
    }
    Ok(())
}

/// No Tauri app, profile, registry or data root is created in this process.
pub(crate) fn serve(transport: Transport) -> Result<(), String> {
    let sink = transport.clone();
    let failure = transport.clone();
    let host = InputHost::new(
        move |target, event, epoch| {
            if sink
                .send(&WorkerMessage::Input {
                    target,
                    epoch,
                    event,
                })
                .is_err()
            {
                sink.cancel();
            }
        },
        || {},
        move || failure.cancel(),
    );
    let mut listener: Option<WindowsListener> = None;
    let mut last_request = 0;
    let result = (|| {
        while transport.alive() {
            match transport.receive::<Control>()? {
                Control::Stop {} => return Ok(()),
                Control::Configure {
                    request,
                    configuration,
                } => {
                    if request == 0 || request <= last_request || !configuration.valid() {
                        return Err("INPUT_ADMIN_PROTOCOL_INVALID".into());
                    }
                    let consumers = configuration.consumers();
                    configuration.install();
                    if !consumers.active() {
                        if let Some(mut current) = listener.take() {
                            current.stop()?;
                        }
                    } else if let Some(current) = &listener {
                        if current.hooks.is_finished() {
                            return Err("INPUT_ADMIN_UNAVAILABLE".into());
                        }
                        current.hooks.configure(consumers.mouse_enabled())?;
                    } else {
                        listener = Some(create_windows_listener(
                            host.clone(),
                            consumers.mouse_enabled(),
                        )?);
                    }
                    last_request = request;
                    transport.send(&WorkerMessage::Configured { request })?;
                }
            }
        }
        Ok(())
    })();
    transport.cancel();
    if let Some(mut listener) = listener {
        let _ = listener.stop();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct IdleRegistry {
        configuration: Configuration,
    }
    impl IdleRegistry {
        fn new() -> Self {
            let registry = WINDOWS_LISTENER.lock().unwrap();
            assert!(
                registry.remote.is_none()
                    && registry.stopping.is_none()
                    && registry.listener.is_none()
                    && registry.host.is_none()
            );
            assert_eq!(registry.consumers, Consumers::default());
            let configuration = Configuration::current();
            idle().install();
            Self { configuration }
        }
    }
    impl Drop for IdleRegistry {
        fn drop(&mut self) {
            let _ = stop_listening();
            self.configuration.install();
        }
    }

    #[test]
    fn deactivate_without_a_worker_is_an_idempotent_noop() {
        let _registry = IdleRegistry::new();
        let before = serde_json::to_value(Configuration::current()).unwrap();
        deactivate_with_timeout(0).unwrap();
        deactivate_with_timeout(0).unwrap();
        assert!(!elevated_input_active());
        assert_eq!(
            serde_json::to_value(Configuration::current()).unwrap(),
            before
        );
        let registry = WINDOWS_LISTENER.lock().unwrap();
        assert_eq!(registry.consumers, Consumers::default());
        assert!(registry.listener.is_none());
    }

    #[test]
    fn deactivate_retains_an_unexited_peer_and_never_calls_a_closed_pipe_process_exit() {
        let _registry = IdleRegistry::new();
        let worker = RunningWorker::new();
        activate_elevated_input(worker.io.clone()).unwrap();
        let before = serde_json::to_value(Configuration::current()).unwrap();
        assert!(elevated_input_active());
        // The real pipe fixture uses this test process as its peer. Its serve
        // thread can finish, but this process remains live: exit is unconfirmed.
        assert_eq!(
            deactivate_with_timeout(0).unwrap_err(),
            "ELEVATION_CHILD_NOT_READY"
        );
        let _ = worker.results.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(
            elevated_input_active(),
            "cancelled transport is not an exited worker"
        );
        assert_eq!(
            deactivate_with_timeout(0).unwrap_err(),
            "ELEVATION_CHILD_NOT_READY"
        );
        assert_eq!(
            serde_json::to_value(Configuration::current()).unwrap(),
            before
        );
        let registry = WINDOWS_LISTENER.lock().unwrap();
        assert!(registry.remote.is_none() && registry.stopping.is_some());
        assert_eq!(registry.consumers, Consumers::default());
        assert!(registry.listener.is_none());
    }

    #[test]
    fn standard_collector_restoration_is_real_idempotent_and_preserves_consumer_epochs() {
        let before = serde_json::to_value(Configuration::current()).unwrap();
        let host = InputHost::new(|_, _, _| {}, || {}, || {});
        let mut registry = ListenerRegistry {
            listener: None,
            remote: None,
            stopping: None,
            host: Some(host),
            consumers: Consumers {
                desktop: Some(false),
                broadcast: None,
            },
        };
        restore_standard_listener(&mut registry).unwrap();
        let first = registry.listener.as_ref().unwrap().hooks.state().unwrap();
        assert!(!first.mouse_enabled);
        restore_standard_listener(&mut registry).unwrap();
        assert_eq!(
            registry.listener.as_ref().unwrap().hooks.state().unwrap(),
            first
        );
        registry.consumers = Consumers {
            desktop: None,
            broadcast: Some(true),
        };
        restore_standard_listener(&mut registry).unwrap();
        assert!(
            registry
                .listener
                .as_ref()
                .unwrap()
                .hooks
                .state()
                .unwrap()
                .mouse_enabled
        );
        assert_eq!(
            serde_json::to_value(Configuration::current()).unwrap(),
            before
        );
        registry.consumers = Consumers::default();
        restore_standard_listener(&mut registry).unwrap();
        assert!(registry.listener.is_none());
    }

    #[test]
    fn missing_standard_host_is_reported_as_restoration_failure() {
        let mut registry = ListenerRegistry {
            listener: None,
            remote: None,
            stopping: None,
            host: None,
            consumers: Consumers {
                desktop: Some(false),
                broadcast: None,
            },
        };
        assert_eq!(
            restore_standard_listener(&mut registry).unwrap_err(),
            "INPUT_HOST_UNAVAILABLE"
        );
        assert!(registry.listener.is_none());
    }

    #[test]
    fn confirmed_exit_cleanup_preserves_a_new_remote_and_other_pending_peer() {
        let (parent, _child) = crate::core::elevation::test_transport_pair();
        let connection = Connection::start(parent.clone(), None).unwrap();
        let active_id = connection.id;
        let old_id = active_id.wrapping_add(1);
        let mut registry = ListenerRegistry {
            listener: None,
            remote: Some(connection),
            stopping: Some(StoppingPeer {
                id: old_id,
                transport: parent,
            }),
            host: None,
            consumers: Consumers::default(),
        };
        // Only the transition after a confirmed kernel wait is exercised here;
        // this fixture's current-process peer has not actually exited.
        assert!(clear_stopping_after_confirmed_exit(&mut registry, active_id).is_none());
        assert_eq!(registry.stopping.as_ref().unwrap().id, old_id);
        assert_eq!(registry.remote.as_ref().unwrap().id, active_id);
        clear_stopping_after_confirmed_exit(&mut registry, old_id);
        assert!(registry.stopping.is_none());
        assert_eq!(registry.remote.as_ref().unwrap().id, active_id);
        registry.remote.take().unwrap().join();
    }

    struct RestoreConfiguration(Configuration);
    impl Drop for RestoreConfiguration {
        fn drop(&mut self) {
            self.0.install();
        }
    }

    struct RunningWorker {
        io: Transport,
        results: mpsc::Receiver<Result<(), String>>,
        thread: Option<JoinHandle<()>>,
    }
    impl RunningWorker {
        fn new() -> Self {
            let (parent, child) = crate::core::elevation::test_transport_pair();
            let (send, results) = mpsc::channel();
            let thread = thread::spawn(move || {
                let _ = send.send(serve(child));
            });
            Self {
                io: parent,
                results,
                thread: Some(thread),
            }
        }
    }
    impl Drop for RunningWorker {
        fn drop(&mut self) {
            self.io.cancel();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn idle() -> Configuration {
        let consumer = ConsumerConfig {
            word: 0,
            keyboard_since: 0,
            mouse_since: 0,
        };
        Configuration {
            desktop: consumer,
            broadcast: consumer,
        }
    }

    #[test]
    fn real_worker_acknowledges_idle_configuration_without_an_app_and_stops() {
        let _restore = RestoreConfiguration(Configuration::current());
        let worker = RunningWorker::new();
        let connection = Connection::start(worker.io.clone(), None).unwrap();
        connection.configure(idle()).unwrap();
        assert!(connection.alive());
        assert_eq!(Configuration::current().consumers(), Consumers::default());
        connection.transport.send(&Control::Stop {}).unwrap();
        assert!(
            worker
                .results
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .is_ok()
        );
        connection.join();
    }

    #[test]
    fn real_worker_rejects_commands_outside_the_fixed_input_protocol() {
        let _restore = RestoreConfiguration(Configuration::current());
        let worker = RunningWorker::new();
        let connection = Connection::start(worker.io.clone(), None).unwrap();
        connection.configure(idle()).unwrap();
        connection
            .transport
            .send(&serde_json::json!({
                "type": "execute", "program": "cmd.exe", "arguments": ["/c", "exit 0"]
            }))
            .unwrap();
        assert!(
            worker
                .results
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .is_err()
        );
        assert!(!connection.transport.alive());
        connection.join();
    }

    #[test]
    fn admin_wire_accepts_only_fixed_controls_and_geometry_events() {
        assert!(matches!(
            serde_json::from_str::<Control>(r#"{"type":"stop"}"#).unwrap(),
            Control::Stop {}
        ));
        assert_eq!(
            serde_json::to_value(Control::Stop {}).unwrap(),
            serde_json::json!({"type":"stop"})
        );
        assert!(serde_json::from_str::<Control>(r#"{"type":"stop","program":"cmd.exe"}"#).is_err());
        assert!(
            serde_json::from_str::<Control>(r#"{"type":"execute","program":"cmd.exe"}"#).is_err()
        );
        assert!(serde_json::from_str::<WorkerMessage>(r#"{"type":"input","target":"desktop","epoch":1,"event":{"kind":"typing","active":true,"intensity":0.5,"contact":{"row":2,"column":1,"pressed":true,"key":"A"}}}"#).is_err());
        let message = WorkerMessage::Input {
            target: Target::Desktop,
            epoch: 1,
            event: SemanticInputEvent::Typing {
                active: true,
                intensity: 0.5,
                contact: Some(KeyboardContact {
                    row: 2,
                    column: 1,
                    pressed: true,
                }),
            },
        };
        let encoded = serde_json::to_vec(&message).unwrap();
        assert!(encoded.len() < 4096);
        assert!(!String::from_utf8(encoded.clone()).unwrap().contains("key"));
        assert!(serde_json::from_slice::<WorkerMessage>(&encoded).is_ok());
        assert!(!valid_semantic(&SemanticInputEvent::PointerActivity {
            x: f64::INFINITY,
            y: 1.0
        }));
        assert!(!valid_semantic(&SemanticInputEvent::Scroll {
            delta_x: 1201,
            delta_y: 0
        }));
    }

    #[test]
    fn planned_configurations_preserve_keyboard_releases_and_reject_old_mouse_events() {
        let before = ConsumerConfig {
            word: next_consumer_word(0, Some(true)),
            keyboard_since: 10,
            mouse_since: 10,
        };
        let off = before.plan(Some(false), 100);
        assert_eq!(off.keyboard_since, 10);
        assert_eq!(off.mouse_since, 100);
        assert!(accepts_captured_input(
            &EventType::KeyRelease(Key::KeyA),
            before.word,
            off.word
        ));
        assert!(!accepts_captured_input(
            &EventType::ButtonRelease(Button::Left),
            before.word,
            off.word
        ));
        let resumed = off.plan(None, 200).plan(Some(true), 300);
        assert_eq!(resumed.keyboard_since, 300);
        assert!(!accepts_captured_input(
            &EventType::KeyRelease(Key::KeyA),
            before.word,
            resumed.word
        ));
        assert!(!ConsumerConfig { word: 2, ..before }.valid(100));
        assert!(
            !ConsumerConfig {
                mouse_since: 101,
                ..before
            }
            .valid(100)
        );
    }

    #[test]
    fn backend_disconnect_releases_each_current_geometry_contact_and_all_mouse_buttons() {
        let mut held = HeldInput::default();
        for (row, column) in [(2, 1), (2, 3), (2, 1)] {
            held.observe(&SemanticInputEvent::Typing {
                active: true,
                intensity: 0.5,
                contact: Some(KeyboardContact {
                    row,
                    column,
                    pressed: true,
                }),
            });
        }
        let releases = held.release();
        let contacts: Vec<_> = releases
            .iter()
            .filter_map(|event| match event {
                SemanticInputEvent::Typing {
                    contact: Some(contact),
                    ..
                } => Some((contact.row, contact.column, contact.pressed)),
                _ => None,
            })
            .collect();
        assert_eq!(contacts.len(), 2);
        assert!(contacts.contains(&(2, 1, false)) && contacts.contains(&(2, 3, false)));
        assert!(
            releases
                .iter()
                .any(|event| matches!(event, SemanticInputEvent::MousePrimary { active: false }))
        );
        assert!(
            releases
                .iter()
                .any(|event| matches!(event, SemanticInputEvent::MouseSecondary { active: false }))
        );
        assert!(
            releases
                .iter()
                .any(|event| matches!(event, SemanticInputEvent::MouseMiddle { active: false }))
        );
        assert!(held.contacts.is_empty());
    }

    #[test]
    fn configuration_requires_its_exact_ack_and_failure_wakes_waiters() {
        let state = Arc::new(Shared {
            delivery: Mutex::new(true),
            alive: AtomicBool::new(true),
            acknowledgement: Mutex::new(Acknowledgements::default()),
            changed: Condvar::new(),
        });
        assert!(state.wait(1, Duration::from_millis(1)).is_err());
        state.acknowledgement.lock().unwrap().last = 1;
        assert!(state.wait(1, Duration::from_millis(1)).is_ok());
        let waiting = state.clone();
        let join = thread::spawn(move || waiting.wait(2, Duration::from_secs(5)));
        state.fail();
        assert!(join.join().unwrap().is_err());
        assert!(!state.alive.load(Ordering::SeqCst));
    }
}
