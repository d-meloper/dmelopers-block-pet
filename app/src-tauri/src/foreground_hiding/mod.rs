//! One native foreground-application observation lifetime.
mod app_paths;
mod applications;
mod model;
mod search_index;
mod shortcuts;
mod windows;

#[cfg(test)]
#[path = "../foreground_hiding_tests.rs"]
mod observation_tests;

use model::{Config, Model, Observation, SAMPLE_MS, Status};
use serde_json::Value;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_pinia::ManagerExt;

const EVENT: &str = "foreground-hiding-status";
struct Shared {
    model: Mutex<Model>,
    stop: AtomicBool,
    wake: tokio::sync::Notify,
}
pub struct ForegroundHidingState(Arc<Shared>);
impl Default for ForegroundHidingState {
    fn default() -> Self {
        let mut model = Model::default();
        // Await the restored Preferences owner's display intent before sampling.
        model.set_desktop_visible(false);
        Self(Arc::new(Shared {
            model: Mutex::new(model),
            stop: AtomicBool::new(false),
            wake: tokio::sync::Notify::new(),
        }))
    }
}
impl ForegroundHidingState {
    fn status(&self) -> Status {
        self.0.model.lock().unwrap().status.clone()
    }
    pub fn start<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) {
        let raw = app
            .pinia()
            .try_state::<Value>("general")
            .ok()
            .and_then(|settings| settings.get("app")?.get("foregroundHiding").cloned());
        self.0
            .model
            .lock()
            .unwrap()
            .configure(raw.and_then(Config::read));
        let shared = self.0.clone();
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            run_observation(
                &shared,
                |model| match windows::foreground() {
                    Some(current) if current.own() => Observation::Own,
                    Some(current) => model
                        .application(&current.path)
                        .map_or(Observation::Outside, Observation::Match),
                    None => Observation::Unavailable,
                },
                || publish(&handle, &shared),
            )
            .await;
        });
    }
    pub fn shutdown(&self) {
        self.0.stop.store(true, Ordering::Release);
        self.0.wake.notify_one();
    }
}

async fn run_observation(
    shared: &Shared,
    probe: impl Fn(&Model) -> Observation,
    changed: impl Fn(),
) {
    let started = Instant::now();
    loop {
        if shared.stop.load(Ordering::Acquire) {
            break;
        }
        let (active, updated) = {
            let mut model = shared.model.lock().unwrap();
            if model.active() {
                // Serialize the synchronous probe with intent changes: after a
                // hide command is acknowledged, no older probe can still run.
                let observation = probe(&model);
                (
                    true,
                    model.observe(observation, started.elapsed().as_millis() as u64),
                )
            } else {
                (false, false)
            }
        };
        if !active {
            shared.wake.notified().await;
            continue;
        }
        if updated {
            changed();
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(SAMPLE_MS)) => {},
            _ = shared.wake.notified() => {},
        }
    }
}

fn publish<R: tauri::Runtime>(app: &tauri::AppHandle<R>, shared: &Shared) {
    let snapshot = shared.model.lock().unwrap().status.clone();
    for label in ["main", "preference"] {
        let _ = app.emit_to(label, EVENT, &snapshot);
    }
}

fn authorize(window: &tauri::WebviewWindow, preference_only: bool) -> Result<(), &'static str> {
    let url = window.url().map_err(|_| "FOREGROUND_HIDING_FORBIDDEN")?;
    if trusted_source(
        window.label(),
        &url,
        preference_only,
        window.app_handle().config().build.dev_url.as_ref(),
    ) {
        Ok(())
    } else {
        Err("FOREGROUND_HIDING_FORBIDDEN")
    }
}

fn trusted_source(
    label: &str,
    url: &tauri::Url,
    preference_only: bool,
    dev: Option<&tauri::Url>,
) -> bool {
    if !matches!(label, "main" | "preference") || (preference_only && label != "preference") {
        return false;
    }
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions) && dev.is_some_and(|dev| dev.origin() == url.origin()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observer_parks_without_probing_and_resumes_or_shuts_down_on_notification() {
        tauri::async_runtime::block_on(async {
            use std::sync::atomic::AtomicUsize;
            let state = ForegroundHidingState::default();
            state
                .0
                .model
                .lock()
                .unwrap()
                .configure(Config::read(serde_json::json!({
                    "enabled": true, "applications": ["C:\\Apps\\Player.exe"]
                })));
            let probes = Arc::new(AtomicUsize::new(0));
            let sampled = Arc::new(tokio::sync::Notify::new());
            let worker = state.0.clone();
            let worker_probes = probes.clone();
            let worker_sampled = sampled.clone();
            let task = tauri::async_runtime::spawn(async move {
                run_observation(
                    &worker,
                    |_| {
                        worker_probes.fetch_add(1, Ordering::SeqCst);
                        worker_sampled.notify_one();
                        Observation::Outside
                    },
                    || {},
                )
                .await;
            });
            tokio::time::sleep(Duration::from_millis(SAMPLE_MS + 30)).await;
            assert_eq!(
                probes.load(Ordering::SeqCst),
                0,
                "Startup hidden intent must not probe"
            );
            state.0.model.lock().unwrap().set_desktop_visible(true);
            state.0.wake.notify_one();
            tokio::time::timeout(Duration::from_secs(2), sampled.notified())
                .await
                .unwrap();
            state.0.model.lock().unwrap().set_desktop_visible(false);
            let parked_count = probes.load(Ordering::SeqCst);
            state.0.wake.notify_one();
            tokio::time::sleep(Duration::from_millis(SAMPLE_MS + 30)).await;
            assert_eq!(
                probes.load(Ordering::SeqCst),
                parked_count,
                "No probe after OFF acknowledgement"
            );
            state.0.model.lock().unwrap().set_desktop_visible(true);
            state.0.wake.notify_one();
            tokio::time::timeout(Duration::from_secs(2), sampled.notified())
                .await
                .unwrap();
            assert!(probes.load(Ordering::SeqCst) > parked_count);
            state.0.model.lock().unwrap().set_desktop_visible(false);
            state.shutdown();
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap();
        });
    }

    #[test]
    fn observation_commands_reject_remote_and_non_owner_windows() {
        let dev: tauri::Url = "http://localhost:1420".parse().unwrap();
        for label in ["main", "preference"] {
            for url in ["tauri://localhost/main", "http://tauri.localhost/main"] {
                let url = url.parse().unwrap();
                assert!(trusted_source(label, &url, false, Some(&dev)));
                assert_eq!(
                    trusted_source(label, &url, true, Some(&dev)),
                    label == "preference"
                );
            }
            for url in [
                "https://example.com/",
                "http://localhost:1421",
                "https://tauri.localhost.example.com/",
                "tauri://other/main",
            ] {
                assert!(!trusted_source(
                    label,
                    &url.parse().unwrap(),
                    false,
                    Some(&dev)
                ));
            }
        }
        assert!(!trusted_source(
            "other",
            &"tauri://localhost".parse().unwrap(),
            false,
            Some(&dev)
        ));
        assert_eq!(
            trusted_source("preference", &dev, true, Some(&dev)),
            cfg!(debug_assertions)
        );
    }
}

#[tauri::command]
pub fn get_foreground_hiding_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ForegroundHidingState>,
) -> Result<Status, &'static str> {
    authorize(&window, false)?;
    Ok(state.status())
}

#[tauri::command]
pub fn configure_foreground_hiding(
    window: tauri::WebviewWindow,
    config: Value,
    desktop_visible: Option<bool>,
    state: tauri::State<'_, ForegroundHidingState>,
) -> Result<Status, &'static str> {
    authorize(&window, true)?;
    let changed = {
        let mut model = state.0.model.lock().unwrap();
        let configuration_changed = model.configure(Config::read(config));
        let visibility_changed = model.set_desktop_visible(desktop_visible.unwrap_or(true));
        configuration_changed || visibility_changed
    };
    if changed {
        state.0.wake.notify_one();
        publish(window.app_handle(), &state.0);
    }
    Ok(state.status())
}

#[tauri::command]
pub fn show_foreground_hiding_visit(
    window: tauri::WebviewWindow,
    revision: u64,
    visit: u64,
    state: tauri::State<'_, ForegroundHidingState>,
) -> Result<Status, &'static str> {
    authorize(&window, true)?;
    if state
        .0
        .model
        .lock()
        .unwrap()
        .show_current_visit(revision, visit)
    {
        publish(window.app_handle(), &state.0);
    }
    Ok(state.status())
}

#[tauri::command]
pub async fn list_foreground_applications(
    window: tauri::WebviewWindow,
) -> Result<Vec<applications::Application>, &'static str> {
    authorize(&window, true)?;
    application_list(None).await
}

#[tauri::command]
pub async fn stream_foreground_applications(
    window: tauri::WebviewWindow,
    on_application: tauri::ipc::Channel<applications::Application>,
) -> Result<Vec<applications::Application>, &'static str> {
    authorize(&window, true)?;
    application_list(Some(on_application)).await
}

#[tauri::command]
pub async fn stream_foreground_programs(
    window: tauri::WebviewWindow,
    on_application: tauri::ipc::Channel<applications::Application>,
) -> Result<applications::Catalog, &'static str> {
    authorize(&window, true)?;
    tauri::async_runtime::spawn_blocking(move || {
        applications::catalog(|row| on_application.send(row.clone()).map_err(|_| ()))
    })
    .await
    .map_err(|_| "FOREGROUND_APPLICATIONS_UNAVAILABLE")?
    .map_err(|_| "FOREGROUND_APPLICATIONS_UNAVAILABLE")
}

async fn application_list(
    on_application: Option<tauri::ipc::Channel<applications::Application>>,
) -> Result<Vec<applications::Application>, &'static str> {
    tauri::async_runtime::spawn_blocking(move || {
        applications::installed(|application| {
            if let Some(channel) = &on_application {
                channel.send(application.clone()).map_err(|_| ())?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|_| "FOREGROUND_APPLICATIONS_UNAVAILABLE")?
    .map_err(|_| "FOREGROUND_APPLICATIONS_UNAVAILABLE")
}

#[tauri::command]
pub async fn describe_foreground_applications(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
) -> Result<Vec<applications::Application>, &'static str> {
    authorize(&window, true)?;
    if paths.len() > 128 || !paths.iter().all(|path| model::valid_application(path)) {
        return Err("FOREGROUND_APPLICATIONS_INVALID");
    }
    tauri::async_runtime::spawn_blocking(move || applications::describe(paths))
        .await
        .map_err(|_| "FOREGROUND_APPLICATIONS_UNAVAILABLE")?
        .map_err(|_| "FOREGROUND_APPLICATIONS_UNAVAILABLE")
}

#[tauri::command]
pub async fn select_foreground_application(
    window: tauri::WebviewWindow,
) -> Result<Option<applications::Application>, &'static str> {
    authorize(&window, true)?;
    let owner = window
        .hwnd()
        .map_err(|_| "FOREGROUND_APPLICATION_PICK_FAILED")?
        .0 as usize;
    tauri::async_runtime::spawn_blocking(move || applications::select(owner))
        .await
        .map_err(|_| "FOREGROUND_APPLICATION_PICK_FAILED")?
        .map_err(|_| "FOREGROUND_APPLICATION_PICK_FAILED")
}
