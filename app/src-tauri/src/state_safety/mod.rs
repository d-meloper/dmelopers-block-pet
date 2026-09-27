//! Shared user-data safety for normal editing, preset import, and Quit/restart.
//! No installer, update metadata, program rollback, or worker is reachable here.
mod general_defaults;
mod shortcuts;
pub(crate) use general_defaults::initialize_store as initialize_general_defaults;
#[cfg(test)]
mod tests;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs, io,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::Manager;
use tauri_plugin_pinia::ManagerExt;
type Result<T> = std::result::Result<T, String>;
type Stores = BTreeMap<String, Value>;
const STORE_IDS: [&str; 4] = ["app", "cat", "general", "shortcut"];
const STORE_DIRECTORY: &str = "tauri-plugin-pinia";
static OPERATION: Mutex<()> = Mutex::new(());
static QUIESCENCE: Mutex<Option<Quiescence>> = Mutex::new(None);
static QUIESCENCE_ACTIVE: AtomicBool = AtomicBool::new(false);
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}
pub fn writes_locked() -> bool {
    QUIESCENCE_ACTIVE.load(Ordering::SeqCst)
}
pub fn check_path(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(ancestor) {
            Ok(m) if m.file_type().is_symlink() || is_reparse(&m) => {
                return Err("UNSAFE_STORAGE_PATH".into());
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("STORAGE_UNAVAILABLE".into()),
        }
    }
    Ok(())
}

#[derive(Default)]
struct Quiescence {
    request_id: String,
    participants: std::collections::BTreeSet<String>,
    stores_digest: Option<String>,
}
impl Quiescence {
    fn acknowledge(&mut self, label: &str, stores: &Stores) -> Result<()> {
        if !matches!(label, "main" | "preference") {
            return Err("INVALID_PARTICIPANT".into());
        }
        if !self.participants.insert(label.to_owned()) {
            return Err("DUPLICATE_PARTICIPANT".into());
        }
        if self.participants.len() == 2 {
            self.stores_digest = Some(stores_digest(stores)?);
        }
        Ok(())
    }
    fn verify(&self, stores: &Stores) -> Result<()> {
        let expected = self.stores_digest.as_ref().ok_or("QUIESCE_REQUIRED")?;
        if &stores_digest(stores)? != expected {
            return Err("QUIESCE_STATE_CHANGED".into());
        }
        Ok(())
    }
}
fn stores_digest(stores: &Stores) -> Result<String> {
    Ok(digest(
        &serde_json::to_vec(stores).map_err(|_| "INVALID_DATA")?,
    ))
}
#[tauri::command]
pub fn begin_state_quiescence(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
) -> Result<()> {
    let result: Result<()> = (|| {
        if !matches!(window.label(), "main" | "preference") {
            return Err("INVALID_WINDOW".into());
        }
        let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
        // An import owns its rollback journal until settings and native apply settle.
        // Do not close its write gate while waiting for that same owner to become ready.
        if crate::skin_library::preset_transfer::has_pending_import(&app)? {
            return Err("OPERATION_BUSY".into());
        }
        if request_id.is_empty() || request_id.len() > 128 {
            return Err("INVALID_REQUEST".into());
        }
        let mut lease = QUIESCENCE.lock().map_err(|_| "OPERATION_BUSY")?;
        if lease.is_some() {
            return Err("OPERATION_BUSY".into());
        }
        *lease = Some(Quiescence {
            request_id,
            ..Default::default()
        });
        QUIESCENCE_ACTIVE.store(true, Ordering::SeqCst);
        tauri_plugin_custom_window::hold_update_webviews(true);
        let result = wake_windows(app.clone());
        if result.is_err() {
            *lease = None;
            QUIESCENCE_ACTIVE.store(false, Ordering::SeqCst);
            restore_memory_policy(&app);
        }
        result
    })();
    if let Err(error) = &result {
        // A superseded request is normal during cancellation and shutdown.
        if !matches!(error.as_str(), "QUIESCE_CANCELLED" | "OPERATION_BUSY" | "OPERATION_LOCKED") {
            crate::diagnostics::warn("state_safety.begin", error);
        }
    }
    result
}
#[tauri::command]
pub fn acknowledge_state_quiescence(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
) -> Result<()> {
    let result: Result<()> = (|| {
        let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
        let mut lease = QUIESCENCE.lock().map_err(|_| "OPERATION_BUSY")?;
        let lease = lease
            .as_mut()
            .filter(|lease| lease.request_id == request_id)
            .ok_or("QUIESCE_CANCELLED")?;
        lease.acknowledge(window.label(), &backend_stores(&app)?)
    })();
    if let Err(error) = &result {
        // A superseded request is normal during cancellation and shutdown.
        if !matches!(error.as_str(), "QUIESCE_CANCELLED" | "OPERATION_BUSY" | "OPERATION_LOCKED") {
            crate::diagnostics::warn("state_safety.acknowledge", error);
        }
    }
    result
}
#[tauri::command]
pub fn release_state_quiescence(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
) -> Result<()> {
    let result: Result<()> = (|| {
        if !matches!(window.label(), "main" | "preference") {
            return Err("INVALID_WINDOW".into());
        }
        let mut lease = QUIESCENCE.lock().map_err(|_| "OPERATION_BUSY")?;
        if lease
            .as_ref()
            .is_some_and(|lease| lease.request_id == request_id)
        {
            *lease = None;
            QUIESCENCE_ACTIVE.store(false, Ordering::SeqCst);
            restore_memory_policy(&app);
        }
        Ok(())
    })();
    if let Err(error) = &result {
        // A superseded request is normal during cancellation and shutdown.
        if !matches!(error.as_str(), "QUIESCE_CANCELLED" | "OPERATION_BUSY" | "OPERATION_LOCKED") {
            crate::diagnostics::warn("state_safety.release", error);
        }
    }
    result
}
fn require_quiescence(app: &tauri::AppHandle) -> Result<Stores> {
    let lease = QUIESCENCE.lock().map_err(|_| "OPERATION_BUSY")?;
    let stores = backend_stores(app)?;
    lease.as_ref().ok_or("QUIESCE_REQUIRED")?.verify(&stores)?;
    Ok(stores)
}
pub fn guard_write() -> Result<std::sync::MutexGuard<'static, ()>> {
    let guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    if QUIESCENCE.lock().map_err(|_| "OPERATION_BUSY")?.is_some() {
        return Err("OPERATION_LOCKED".into());
    }
    Ok(guard)
}

pub(crate) fn guard_read() -> Result<std::sync::MutexGuard<'static, ()>> {
    OPERATION.lock().map_err(|_| "OPERATION_BUSY".into())
}
fn restore_memory_policy(app: &tauri::AppHandle) {
    let held = writes_locked() || QUIESCENCE_ACTIVE.load(Ordering::SeqCst);
    tauri_plugin_custom_window::hold_update_webviews(held);
    if !held {
        for label in ["main", "preference"] {
            if let Some(window) = app.get_webview_window(label) {
                let _ = tauri_plugin_custom_window::set_webview_memory_active(
                    &window,
                    window.is_visible().unwrap_or(true),
                );
            }
        }
    }
}
fn wake_windows(app: tauri::AppHandle) -> Result<()> {
    for label in ["main", "preference"] {
        let window = app.get_webview_window(label).ok_or("WINDOW_NOT_READY")?;
        tauri_plugin_custom_window::set_webview_memory_active(&window, true)
            .map_err(|_| "WINDOW_WAKE_FAILED")?;
    }
    Ok(())
}
fn backend_stores(app: &tauri::AppHandle) -> Result<Stores> {
    STORE_IDS
        .into_iter()
        .map(|id| {
            app.pinia()
                .state(id)
                .map_err(|_| "STORES_NOT_READY".to_string())
                .and_then(|s| {
                    serde_json::to_value(s)
                        .map(|v| (id.to_owned(), v))
                        .map_err(|_| "INVALID_DATA".into())
                })
        })
        .collect()
}
fn disk_stores(app: &tauri::AppHandle) -> Result<Stores> {
    STORE_IDS
        .into_iter()
        .map(|id| {
            // Ask Pinia for its actual path: development stores use .dev.json.
            let path = app
                .pinia()
                .with_store(id, |store| store.path())
                .map_err(|_| "STORES_NOT_READY")?;
            if path.parent() != Some(app.pinia().path().as_path()) {
                return Err("UNSUPPORTED_STORAGE_LOCATION".into());
            }
            check_path(&path)?;
            let bytes = fs::read(path).map_err(|_| "MISSING_CURRENT_STATE")?;
            Ok((
                id.into(),
                serde_json::from_slice(&bytes).map_err(|_| "INVALID_CURRENT_STATE")?,
            ))
        })
        .collect()
}
#[tauri::command]
pub fn initialize_shortcut_defaults(app: tauri::AppHandle, window: tauri::Window) -> Result<()> {
    let result: Result<()> = (|| {
        if !matches!(window.label(), "main" | "preference") {
            return Err("INVALID_WINDOW".into());
        }
        let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
        // Pinia installs its watcher after loading. Untouched frontend defaults
        // therefore need a native write before the settings readback barrier.
        // A pending save barrier must keep its acknowledged stores unchanged.
        shortcuts::initialize_store(
            &app,
            !writes_locked() && !QUIESCENCE_ACTIVE.load(Ordering::SeqCst),
        )
    })();
    if let Err(error) = &result {
        // A superseded request is normal during cancellation and shutdown.
        if !matches!(error.as_str(), "QUIESCE_CANCELLED" | "OPERATION_BUSY" | "OPERATION_LOCKED") {
            crate::diagnostics::warn("state_safety.shortcut_defaults", error);
        }
    }
    result
}

/// Both frontend owners and the final disk write must agree before Quit/restart.
#[tauri::command]
pub fn verify_state_quiescence(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
) -> Result<()> {
    let result: Result<()> = (|| {
        if !matches!(window.label(), "main" | "preference") {
            return Err("INVALID_WINDOW".into());
        }
        let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
        {
            let lease = QUIESCENCE.lock().map_err(|_| "OPERATION_BUSY")?;
            if lease
                .as_ref()
                .is_none_or(|lease| lease.request_id != request_id)
            {
                return Err("QUIESCE_CANCELLED".into());
            }
        }
        let stores = require_quiescence(&app)?;
        let root = crate::data_paths::durable_root(&app)?;
        if app.pinia().path() != root.join(STORE_DIRECTORY) {
            return Err("UNSUPPORTED_STORAGE_LOCATION".into());
        }
        check_path(&root.join(STORE_DIRECTORY))?;
        if disk_stores(&app)? != stores {
            return Err("SAVE_VERIFICATION_FAILED".into());
        }
        Ok(())
    })();
    if let Err(error) = &result {
        // A superseded request is normal during cancellation and shutdown.
        if !matches!(error.as_str(), "QUIESCE_CANCELLED" | "OPERATION_BUSY" | "OPERATION_LOCKED") {
            crate::diagnostics::warn("state_safety.verify", error);
        }
    }
    result
}
