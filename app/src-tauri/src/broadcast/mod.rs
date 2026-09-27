//! A private, loopback-only browser renderer. It exposes fixed application
//! assets and semantic animation events, never IPC, file paths or key text.
mod identity;
mod scene;
mod server;

use identity::Identity;
pub use scene::BroadcastScene;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex as AsyncMutex, broadcast, watch};

const MAX_CLIENTS: usize = 8;
const STATUS_EVENT: &str = "broadcast-status";
const PREFERENCE_WINDOW: &str = "preference";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastStatus {
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    clients: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

pub struct BroadcastState {
    service: Arc<Service>,
}

impl BroadcastState {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "endpoint_unavailable".to_string());
        let loader: IdentityLoader = Arc::new(move |expected| {
            root.as_ref()
                .map_err(Clone::clone)
                .and_then(|root| identity::load_known(root, expected))
        });
        let status_app = app.clone();
        let input_app = app.clone();
        Self {
            service: Service::new(
                loader,
                Arc::new(move |status| {
                    if status_app.emit_to(PREFERENCE_WINDOW, STATUS_EVENT, status).is_err() {
                        crate::diagnostics::warn("broadcast.status", "event_delivery_failed");
                    }
                }),
                Arc::new(move |demand| {
                    crate::core::device::set_broadcast_input(input_app.clone(), demand)
                }),
            ),
        }
    }

    pub(crate) fn publish_input(&self, event: crate::core::device::SemanticInputEvent) {
        self.service.publish_input(event);
    }

    pub fn shutdown(&self) {
        // Application exit cannot wait for a webview or an async command. Closing
        // this channel directly invalidates all sockets; lib.rs stops the hooks.
        let mut inner = self
            .service
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        inner.enabled = false;
        inner.clients.clear();
        inner.render_failures.clear();
        if let Some(shutdown) = &inner.shutdown {
            let _ = shutdown.send(true);
        }
    }
}

#[tauri::command]
pub async fn configure_broadcast(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BroadcastState>,
    enabled: bool,
    scene: Option<BroadcastScene>,
) -> Result<BroadcastStatus, String> {
    require_preference(window.label())?;
    state.service.configure(enabled, scene).await
}

#[tauri::command]
pub fn get_broadcast_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BroadcastState>,
) -> Result<BroadcastStatus, String> {
    require_preference(window.label())?;
    Ok(state.service.status())
}

fn require_preference(label: &str) -> Result<(), String> {
    if label == PREFERENCE_WINDOW {
        Ok(())
    } else {
        crate::diagnostics::warn("broadcast.access", "preference_only");
        Err("broadcast_preference_only".into())
    }
}

type IdentityLoader =
    Arc<dyn Fn(Option<&Identity>) -> Result<identity::LoadedIdentity, String> + Send + Sync>;
type StatusSink = Arc<dyn Fn(BroadcastStatus) + Send + Sync>;
type InputControl = Arc<dyn Fn(Option<bool>) -> Result<(), String> + Send + Sync>;

struct Running {
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct Inner {
    enabled: bool,
    error: Option<String>,
    endpoint_error: Option<String>,
    endpoint_warning: Option<String>,
    clients: HashMap<u64, bool>,
    render_failures: HashSet<u64>,
    next_client_id: u64,
    shutdown: Option<watch::Sender<bool>>,
}

struct ScenePacket {
    revision: u64,
    scene: BroadcastScene,
    json: String,
}

struct Service {
    identity: OnceLock<Identity>,
    identity_loader: IdentityLoader,
    inner: Mutex<Inner>,
    // Configure, initial readiness and disconnect share one native input gate.
    // No synchronous mutex is held while hook-thread acknowledgements are awaited.
    control: AsyncMutex<Option<Running>>,
    scenes: watch::Sender<Option<Arc<ScenePacket>>>,
    inputs: broadcast::Sender<String>,
    status_sink: StatusSink,
    input_control: InputControl,
}

impl Service {
    fn new(
        identity_loader: IdentityLoader,
        status_sink: StatusSink,
        input_control: InputControl,
    ) -> Arc<Self> {
        let loaded = identity_loader(None);
        let error = loaded.as_ref().err().cloned();
        let warning = loaded.as_ref().ok().and_then(|value| value.warning.clone());
        if let Some(code) = &error {
            crate::diagnostics::error("broadcast.identity", code);
        }
        if let Some(code) = &warning {
            crate::diagnostics::warn("broadcast.identity", code);
        }
        let identity = OnceLock::new();
        if let Ok(loaded) = loaded {
            let _ = identity.set(loaded.identity);
        }
        let (scenes, _) = watch::channel(None);
        let (inputs, _) = broadcast::channel(256);
        Arc::new(Self {
            identity,
            identity_loader,
            inner: Mutex::new(Inner {
                error: error.clone(),
                endpoint_error: error,
                endpoint_warning: warning,
                ..Inner::default()
            }),
            control: AsyncMutex::new(None),
            scenes,
            inputs,
            status_sink,
            input_control,
        })
    }

    fn status(&self) -> BroadcastStatus {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        BroadcastStatus {
            enabled: inner.enabled,
            url: self.identity.get().map(Identity::url),
            clients: inner.clients.values().filter(|ready| **ready).count(),
            warning: inner.endpoint_warning.clone(),
            error: inner
                .endpoint_error
                .clone()
                .or_else(|| inner.error.clone())
                .or_else(|| (!inner.render_failures.is_empty()).then(|| "render_failed".into())),
        }
    }

    fn emit_status(&self) {
        (self.status_sink)(self.status());
    }

    fn set_error(&self, error: Option<String>) {
        if let Some(code) = &error {
            crate::diagnostics::error("broadcast.service", code);
        }
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .error = error;
    }

    // A successful identity never changes during the process. Failed startup
    // reads and incomplete backup writes are retryable under the configure gate.
    fn refresh_identity(&self) {
        let needs_retry = {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            self.identity.get().is_none()
                || inner.endpoint_warning.is_some()
                || inner.endpoint_error.is_some()
        };
        if !needs_retry {
            return;
        }
        let loaded = (self.identity_loader)(self.identity.get());
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let previous_error = inner.endpoint_error.clone();
        match loaded {
            Ok(loaded)
                if self
                    .identity
                    .get()
                    .is_none_or(|value| value == &loaded.identity) =>
            {
                let _ = self.identity.set(loaded.identity);
                inner.endpoint_error = None;
                inner.endpoint_warning = loaded.warning;
            }
            Ok(_) => {
                inner.endpoint_error = Some("endpoint_conflict".into());
            }
            Err(error) => {
                inner.endpoint_error = Some(error);
            }
        }
        if inner.error == previous_error {
            inner.error = inner.endpoint_error.clone();
        }
        if let Some(code) = &inner.endpoint_error {
            crate::diagnostics::error("broadcast.identity", code);
        }
        if let Some(code) = &inner.endpoint_warning {
            crate::diagnostics::warn("broadcast.identity", code);
        }
    }

    async fn configure(
        self: &Arc<Self>,
        enabled: bool,
        scene: Option<BroadcastScene>,
    ) -> Result<BroadcastStatus, String> {
        let mut running = self.control.lock().await;
        self.refresh_identity();
        let previous = self.scenes.borrow().clone();
        let release_mouse = previous
            .as_ref()
            .is_some_and(|packet| packet.scene.mouse_enabled())
            && scene.as_ref().is_some_and(|scene| !scene.mouse_enabled());
        if let Some(scene) = &scene {
            scene.validate(previous.as_ref().map(|packet| &packet.scene)).inspect_err(|code| {
                crate::diagnostics::warn("broadcast.scene_validation", code);
            })?;
        }
        if enabled && scene.is_none() && previous.is_none() {
            crate::diagnostics::warn("broadcast.configure", "scene_required");
            return Err("scene_required".into());
        }

        let retry_render = enabled
            && !self
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .render_failures
                .is_empty();
        let scene = scene.or_else(|| {
            if retry_render {
                previous.as_ref().map(|packet| packet.scene.clone())
            } else {
                None
            }
        });
        if let Some(scene) = scene.filter(|scene| {
            retry_render
                || previous
                    .as_ref()
                    .is_none_or(|packet| &packet.scene != scene)
        }) {
            let revision = previous.as_ref().map_or(1, |packet| packet.revision + 1);
            let json = serde_json::to_string(
                &serde_json::json!({"type":"scene", "revision":revision, "scene":scene}),
            )
            .map_err(|_| {
                crate::diagnostics::error("broadcast.scene_serialize", "scene_invalid");
                "scene_invalid"
            })?;
            self.scenes.send_replace(Some(Arc::new(ScenePacket {
                revision,
                scene,
                json,
            })));
        }

        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .enabled = enabled;
        if !enabled {
            {
                let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
                inner.clients.clear();
                inner.render_failures.clear();
                inner.shutdown = None;
            }
            if let Some(mut current) = running.take() {
                let _ = current.shutdown.send(true);
                match tokio::time::timeout(Duration::from_secs(3), &mut current.task).await {
                    Err(_) => {
                        crate::diagnostics::warn("broadcast.shutdown", "timeout");
                        current.task.abort();
                    }
                    Ok(Err(_)) => crate::diagnostics::error("broadcast.server", "task_failed"),
                    Ok(Ok(())) => {}
                }
            }
            let endpoint_error = self
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .endpoint_error
                .clone();
            self.set_error(endpoint_error);
            self.refresh_input().await;
        } else if running.is_none()
            || running
                .as_ref()
                .is_some_and(|current| current.task.is_finished())
        {
            if let Some(old) = running.take() {
                let _ = old.shutdown.send(true);
            }
            let endpoint_error = self
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .endpoint_error
                .clone();
            match (endpoint_error, self.identity.get()) {
                (Some(error), _) => self.set_error(Some(error)),
                (None, None) => self.set_error(Some("endpoint_unavailable".into())),
                (None, Some(identity)) => match tokio::net::TcpListener::bind((
                    std::net::Ipv4Addr::LOCALHOST,
                    identity.port,
                ))
                .await
                {
                    Err(error) => self.set_error(Some(
                        if error.kind() == std::io::ErrorKind::AddrInUse {
                            "port_in_use"
                        } else {
                            "server_unavailable"
                        }
                        .into(),
                    )),
                    Ok(listener) => {
                        let (shutdown, receiver) = watch::channel(false);
                        self.inner
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .shutdown = Some(shutdown.clone());
                        self.set_error(None);
                        let service = Arc::clone(self);
                        let router = server::router(Arc::clone(self));
                        let task = tokio::spawn(async move {
                            let mut receiver = receiver;
                            let result = axum::serve(listener, router)
                                .with_graceful_shutdown(async move {
                                    if !*receiver.borrow() {
                                        let _ = receiver.changed().await;
                                    }
                                })
                                .await;
                            if result.is_err() {
                                service.set_error(Some("server_unavailable".into()));
                                service.emit_status();
                            }
                        });
                        *running = Some(Running { shutdown, task });
                        self.refresh_input().await;
                    }
                },
            }
        } else {
            self.refresh_input().await;
        }
        if release_mouse {
            // Scene snapshots may coalesce OFF -> ON. Ordered releases in the
            // event queue still clear older button presses, preserving typing.
            use crate::core::device::SemanticInputEvent;
            for event in [
                SemanticInputEvent::MousePrimary { active: false },
                SemanticInputEvent::MouseSecondary { active: false },
                SemanticInputEvent::MouseMiddle { active: false },
                SemanticInputEvent::Drag { active: false },
            ] {
                self.publish_input(event);
            }
        }
        self.emit_status();
        Ok(self.status())
    }

    async fn refresh_input(&self) {
        let active = {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.enabled && inner.clients.values().any(|ready| *ready)
        };
        let mouse_enabled = self
            .scenes
            .borrow()
            .as_ref()
            .is_some_and(|packet| packet.scene.mouse_enabled());
        let callback = Arc::clone(&self.input_control);
        let result =
            tokio::task::spawn_blocking(move || callback(active.then_some(mouse_enabled))).await;
        if !matches!(result, Ok(Ok(()))) {
            self.set_error(Some("input_unavailable".into()));
        } else {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if inner.error.as_deref() == Some("input_unavailable") {
                inner.error = None;
            }
        }
    }

    fn register_client(&self) -> Option<(u64, watch::Receiver<bool>)> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if !inner.enabled {
            return None;
        }
        if inner.clients.len() >= MAX_CLIENTS {
            crate::diagnostics::warn("broadcast.connect", "client_limit_reached");
            return None;
        }
        let shutdown = inner.shutdown.as_ref()?.subscribe();
        inner.next_client_id += 1;
        let id = inner.next_client_id;
        inner.clients.insert(id, false);
        Some((id, shutdown))
    }

    async fn ready(&self, id: u64, revision: u64) -> bool {
        let _control = self.control.lock().await;
        if self
            .scenes
            .borrow()
            .as_ref()
            .is_none_or(|packet| packet.revision != revision)
        {
            return false;
        }
        let changed = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let Some(ready) = inner.clients.get_mut(&id) else {
                return false;
            };
            let changed = !*ready;
            *ready = true;
            changed
        };
        if changed {
            self.refresh_input().await;
        }
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .render_failures
            .remove(&id);
        self.emit_status();
        true
    }

    async fn render_error(&self, id: u64, revision: u64) {
        let _control = self.control.lock().await;
        if self
            .scenes
            .borrow()
            .as_ref()
            .is_none_or(|packet| packet.revision != revision)
        {
            return;
        }
        let failed = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if inner.clients.contains_key(&id) {
                inner.render_failures.insert(id);
                true
            } else {
                false
            }
        };
        if failed {
            crate::diagnostics::error("broadcast.renderer", "render_failed");
            self.emit_status();
        }
    }

    async fn remove_client(&self, id: u64) {
        let _control = self.control.lock().await;
        let (removed, failed) = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            (inner.clients.remove(&id), inner.render_failures.remove(&id))
        };
        if removed == Some(true) {
            self.refresh_input().await;
        }
        if removed == Some(true) || failed {
            self.emit_status();
        }
    }

    fn publish_input(&self, event: crate::core::device::SemanticInputEvent) {
        if self.inputs.receiver_count() == 0 {
            return;
        }
        let accepting = {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.enabled && inner.clients.values().any(|ready| *ready)
        };
        if accepting {
            match serde_json::to_string(&serde_json::json!({"type":"input", "event":event})) {
                Ok(json) => { let _ = self.inputs.send(json); }
                Err(_) => crate::diagnostics::error("broadcast.input_serialize", "serialization_failed"),
            }
        }
    }
}

#[cfg(test)]
mod tests;
