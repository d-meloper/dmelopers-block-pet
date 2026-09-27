//! Internal temporary snapshots and automatic recovery for verified updates.
//! Live mutable scope is the actual Pinia directory plus the entire skin library.
use block_pet_update_core::geometry;
mod health;
mod integrity;
pub mod notification;
mod shortcuts;
#[cfg(test)]
mod tests;

use health::{STORE_IDS, Stores};
use integrity::{Result, digest};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri_plugin_pinia::ManagerExt;

static OPERATION: Mutex<()> = Mutex::new(());
static WRITES_LOCKED: AtomicBool = AtomicBool::new(false);
static QUIESCENCE: Mutex<Option<Quiescence>> = Mutex::new(None);
static QUIESCENCE_ACTIVE: AtomicBool = AtomicBool::new(false);
const EVENT: &str = "update-recovery-changed";
pub(crate) use block_pet_update_core::data_recovery::STORE_DIRECTORY;
pub use block_pet_update_core::data_recovery::{OperationState, check_path};
use block_pet_update_core::data_recovery::{
    cleanup_resolved_backup, complete_program_commit, persist_at, read_state,
    record_cleanup_result, recovery_file_exists, scope_digest, tree_digest, tree_entries,
    valid_request, write_json,
};

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
pub fn begin_update_quiescence(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
) -> Result<()> {
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
    let result = update_wake_windows(app.clone());
    if result.is_err() {
        *lease = None;
        QUIESCENCE_ACTIVE.store(false, Ordering::SeqCst);
        restore_memory_policy(&app);
    }
    result
}
#[tauri::command]
pub fn acknowledge_update_quiescence(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
) -> Result<()> {
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    let mut lease = QUIESCENCE.lock().map_err(|_| "OPERATION_BUSY")?;
    let lease = lease
        .as_mut()
        .filter(|lease| lease.request_id == request_id)
        .ok_or("QUIESCE_CANCELLED")?;
    lease.acknowledge(window.label(), &backend_stores(&app)?)
}
#[tauri::command]
pub fn release_update_quiescence(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
) -> Result<()> {
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
}
fn require_quiescence(app: &tauri::AppHandle) -> Result<Stores> {
    let lease = QUIESCENCE.lock().map_err(|_| "OPERATION_BUSY")?;
    let stores = backend_stores(app)?;
    lease.as_ref().ok_or("QUIESCE_REQUIRED")?.verify(&stores)?;
    Ok(stores)
}
fn verify_saved_stores(root: &Path, expected: &Stores) -> Result<()> {
    if disk_stores(root)? != *expected {
        return Err("SAVE_VERIFICATION_FAILED".into());
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HealthProof {
    pub request_id: String,
    pub version: String,
    pub preset_id: String,
    pub rendered: bool,
    pub skin_hashes: Vec<String>,
    pub warnings: Vec<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn operation_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "STORAGE_UNAVAILABLE")?
        .join("update-recovery"))
}
fn user_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "STORAGE_UNAVAILABLE")?;
    if app.pinia().path() != root.join(STORE_DIRECTORY) {
        return Err("UNSUPPORTED_STORAGE_LOCATION".into());
    }
    Ok(root)
}
pub fn writes_locked() -> bool {
    WRITES_LOCKED.load(Ordering::SeqCst)
}
pub fn require_writable() -> Result<()> {
    if writes_locked() {
        Err("OPERATION_LOCKED".into())
    } else {
        Ok(())
    }
}
pub fn guard_write() -> Result<std::sync::MutexGuard<'static, ()>> {
    let guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    require_writable()?;
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
fn lock_writers(app: &tauri::AppHandle, locked: bool) {
    WRITES_LOCKED.store(locked, Ordering::SeqCst);
    restore_memory_policy(app);
    for id in STORE_IDS {
        if locked {
            app.pinia().deny_save(id);
        } else {
            app.pinia().allow_save(id);
        }
    }
    let _ = app.emit(EVENT, locked);
}
pub fn force_startup_lock(app: &tauri::AppHandle) {
    lock_writers(app, true);
}

fn update_wake_windows(app: tauri::AppHandle) -> Result<()> {
    for label in ["main", "preference"] {
        let window = app.get_webview_window(label).ok_or("WINDOW_NOT_READY")?;
        tauri_plugin_custom_window::set_webview_memory_active(&window, true)
            .map_err(|_| "WINDOW_WAKE_FAILED")?;
    }
    Ok(())
}
fn is_terminal(phase: &str) -> bool {
    matches!(phase, "verified" | "rolledBack")
}
fn request_root(app: &tauri::AppHandle, id: &str) -> Result<PathBuf> {
    if !valid_request(id) {
        return Err("INVALID_REQUEST".into());
    }
    Ok(operation_root(app)?.join(id))
}
pub fn read_operation(app: &tauri::AppHandle) -> Result<Option<OperationState>> {
    read_state(&operation_root(app)?)
}
fn persist(app: &tauri::AppHandle, state: &OperationState) -> Result<()> {
    persist_at(&operation_root(app)?, state)?;
    let _ = app.emit("update-recovery-status", state);
    notification::operation_changed(app, state);
    Ok(())
}

/// The helper completes its durable commit outside the WebView process. Reflect
/// that exact receipt before allowing writers to resume or reporting success.
fn refresh_program_result(app: &tauri::AppHandle) -> Result<bool> {
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    let Some(mut state) = read_operation(app)? else {
        return Ok(false);
    };
    if is_terminal(&state.phase) {
        if writes_locked() {
            lock_writers(app, false);
            let _ = app.emit("update-recovery-status", &state);
            notification::operation_changed(app, &state);
        }
        return Ok(false);
    }
    if state.phase == "failed" {
        return Ok(false);
    }
    let path = operation_root(app)?.join(format!("{}.program-failure.json", state.request_id));
    if recovery_file_exists(&path)? && !state.rollback_attempted {
        check_path(&path)?;
        let proof: Value = serde_json::from_slice(&fs::read(path).map_err(|_| "READ_FAILED")?)
            .map_err(|_| "INVALID_FAILURE_PROOF")?;
        if proof["requestId"] != state.request_id
            || proof["sourceVersion"] != state.source_version
            || proof["expectedVersion"] != state.expected_version
            || !matches!(
                proof["reason"].as_str(),
                Some(
                    "REGISTRY_COMMIT_FAILED"
                        | "PROGRAM_COMMIT_FAILED"
                        | "PROGRAM_COMMIT_STATE_UNKNOWN"
                )
            )
        {
            return Err("INVALID_FAILURE_PROOF".into());
        }
        let reason = proof["reason"]
            .as_str()
            .ok_or("INVALID_FAILURE_PROOF")?
            .to_owned();
        if reason == "PROGRAM_COMMIT_STATE_UNKNOWN" {
            state.phase = "ambiguous".into();
            state.error = Some(reason);
            persist(app, &state)?;
            return Ok(false);
        }
        state.failure_reason.get_or_insert_with(|| reason.clone());
        state.error = Some(reason);
        state.phase = "rollbackPending".into();
        persist(app, &state)?;
        drop(_guard);
        crate::update_delivery::exit_for_rollback(app)?;
        return Ok(false);
    }
    Ok(true)
}

pub fn schedule(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            match refresh_program_result(&app) {
                Ok(true) => {}
                Ok(false) => break,
                Err(_) => {
                    notification::report(&app, None, "RECOVERY_REQUIRED", "unknown", None, None);
                    break;
                }
            }
        }
    });
}

fn fresh_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "RANDOM_UNAVAILABLE")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    check_path(from)?;
    check_path(to)?;
    if !from.exists() {
        fs::create_dir_all(to).map_err(|_| "WRITE_FAILED")?;
        return Ok(());
    }
    fs::create_dir_all(to).map_err(|_| "WRITE_FAILED")?;
    for item in fs::read_dir(from).map_err(|_| "READ_FAILED")? {
        let item = item.map_err(|_| "READ_FAILED")?;
        let source = item.path();
        check_path(&source)?;
        let metadata = fs::symlink_metadata(&source).map_err(|_| "READ_FAILED")?;
        let target = to.join(item.file_name());
        if metadata.is_dir() {
            copy_tree(&source, &target)?;
        } else if metadata.is_file() {
            fs::copy(&source, &target).map_err(|_| "WRITE_FAILED")?;
            fs::OpenOptions::new()
                .write(true)
                .open(&target)
                .and_then(|file| file.sync_all())
                .map_err(|_| "WRITE_FAILED")?;
        } else {
            return Err("UNSAFE_STORAGE_PATH".into());
        }
    }
    Ok(())
}
fn snapshot_live(root: &Path, target: &Path) -> Result<String> {
    for name in [STORE_DIRECTORY, "skin-library"] {
        copy_tree(&root.join(name), &target.join(name))?;
    }
    let expected = scope_digest(root)?;
    if scope_digest(target)? != expected {
        return Err("BACKUP_VERIFICATION_FAILED".into());
    }
    Ok(expected)
}
fn replace_scope(root: &Path, source: &Path) -> Result<()> {
    // Work only below a resolved app-owned root. Recovery evidence is copied,
    // never moved, so a second power loss cannot consume the only good snapshot.
    check_path(root)?;
    check_path(source)?;
    for name in [STORE_DIRECTORY, "skin-library"] {
        let target = root.join(name);
        let candidate = root.join(format!(".{name}-update-recovery"));
        if candidate.exists() {
            check_path(&candidate)?;
            fs::remove_dir_all(&candidate).map_err(|_| "WRITE_FAILED")?;
        }
        copy_tree(&source.join(name), &candidate)?;
        if tree_digest(&candidate)? != tree_digest(&source.join(name))? {
            return Err("WRITE_VERIFICATION_FAILED".into());
        }
        if target.exists() {
            check_path(&target)?;
            fs::remove_dir_all(&target).map_err(|_| "WRITE_FAILED")?;
        }
        fs::rename(candidate, target).map_err(|_| "WRITE_FAILED")?;
        #[cfg(test)]
        if name == STORE_DIRECTORY
            && std::env::var("BLOCK_PET_TEST_FAULT").as_deref() == Ok("after-pinia")
        {
            // Tests spawn this executable with an isolated fixture root. Exit
            // at the real replacement boundary, without unwinding/cleanup.
            std::process::exit(73);
        }
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
fn disk_stores(root: &Path) -> Result<Stores> {
    STORE_IDS
        .into_iter()
        .map(|id| {
            let bytes = fs::read(root.join(STORE_DIRECTORY).join(format!("{id}.json")))
                .map_err(|_| "MISSING_CURRENT_STATE")?;
            Ok((
                id.into(),
                serde_json::from_slice(&bytes).map_err(|_| "INVALID_CURRENT_STATE")?,
            ))
        })
        .collect()
}
fn semantic_digest(stores: &Stores) -> Result<String> {
    Ok(digest(
        &serde_json::to_vec(&health::semantic_state(stores)?).map_err(|_| "INVALID_DATA")?,
    ))
}
fn proof_fields(stores: &Stores, library: &Path) -> Result<(String, String, Vec<String>)> {
    let cat = &stores["cat"];
    let preset = cat["presetCollection"]["activeId"]
        .as_str()
        .ok_or("MISSING_PRESETS")?
        .to_owned();
    let mut hashes = vec![];
    if let Some(entries) = cat["presetCollection"]["entries"].as_array() {
        for entry in entries {
            if let Some(url) = entry["snapshot"]["appearance"]["dmeloperSkinDataUrl"].as_str() {
                use base64::Engine as _;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(
                        url.strip_prefix("data:image/png;base64,")
                            .ok_or("INVALID_PNG")?,
                    )
                    .map_err(|_| "INVALID_PNG")?;
                integrity::validate_png(&bytes)?;
                hashes.push(digest(&bytes));
            }
        }
    }
    let mut files = BTreeMap::new();
    tree_entries(library, &library.join("raw"), &mut files)?;
    hashes.extend(files.into_values());
    hashes.sort();
    hashes.dedup();
    Ok((semantic_digest(stores)?, preset, hashes))
}
fn new_operation(app: &tauri::AppHandle, expected: &str) -> Result<OperationState> {
    if read_operation(app)?.is_some_and(|s| !is_terminal(&s.phase)) {
        return Err("OPERATION_BUSY".into());
    }
    let id = fresh_id()?;
    let root = user_root(app)?;
    let work = request_root(app, &id)?;
    let backup = recovery_snapshot(&root, &work.join("backup"))?;
    let stores = disk_stores(&root)?;
    let (data, preset, skins) = proof_fields(&stores, &root.join("skin-library"))?;
    Ok(OperationState {
        request_id: id,
        phase: "prepared".into(),
        expected_version: expected.into(),
        source_version: app.package_info().version.to_string(),
        started_at: now(),
        rollback_attempted: false,
        data_digest: data,
        preset_id: preset,
        skin_hashes: skins,
        backup_digest: backup,
        error: None,
        failure_reason: None,
        warnings: vec![],
        rendered: false,
        window_digest: String::new(),
        window_geometry: None,
    })
}
fn recovery_snapshot(root: &Path, target: &Path) -> Result<String> {
    snapshot_live(root, target).map_err(|error| format!("SNAPSHOT_FAILED:{error}"))
}

/// Called in native setup before a store is loaded or a webview is mounted.
pub fn initialize(app: &tauri::AppHandle) -> Result<()> {
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    let Some(mut state) = read_operation(app)? else {
        return Ok(());
    };
    if is_terminal(&state.phase) {
        return Ok(());
    }
    lock_writers(app, true);
    let root = user_root(app)?;
    let work = request_root(app, &state.request_id)?;
    if cancel_unstarted_update(
        &root,
        &work,
        &mut state,
        &app.package_info().version.to_string(),
    )? {
        persist(app, &state)?;
        let _ = cleanup_resolved_backup(
            &root,
            &state.request_id,
            &state.source_version,
            &state.expected_version,
        );
        lock_writers(app, false);
        return Ok(());
    }
    if recovery_file_exists(
        &operation_root(app)?.join(format!("{}.cancel.json", state.request_id)),
    )? && app.package_info().version.to_string() != state.source_version
    {
        return Err("INVALID_CANCEL_PROOF".into());
    }
    resume_operation(&root, &work, &operation_root(app)?, &mut state)?;
    if state.phase == "failed" {
        return Err("RECOVERY_REQUIRED".into());
    }
    persist(app, &state)?;
    if is_terminal(&state.phase) {
        lock_writers(app, false);
    }
    Ok(())
}

fn cancel_unstarted_update(
    root: &Path,
    work: &Path,
    state: &mut OperationState,
    running_version: &str,
) -> Result<bool> {
    if state.phase != "prepared" {
        return Ok(false);
    }
    if running_version != state.source_version {
        return Err("INVALID_CANCEL_PROOF".into());
    }
    let operations = root.join("update-recovery");
    // Windows may report NotFound for a child below a regular-file parent.
    // Only a real directory can support the locator absence proof.
    match fs::symlink_metadata(&operations) {
        Ok(metadata) if metadata.is_dir() && !integrity::is_reparse(&metadata) => {}
        _ => return Err("RECOVERY_LOCATOR_UNREADABLE".into()),
    }
    match fs::symlink_metadata(operations.join("program-recovery.json")) {
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("RECOVERY_LOCATOR_UNREADABLE".into()),
    }
    if state.rollback_attempted
        || scope_digest(root)? != state.backup_digest
        || scope_digest(&work.join("backup"))? != state.backup_digest
    {
        return Err("INVALID_CANCEL_PROOF".into());
    }
    // Helper preparation guarantees its locator is durable before any helper
    // launch or commit. Exact absence here proves installation never started.
    state.phase = "rolledBack".into();
    state.error = Some("CANCELLED_BEFORE_INSTALL".into());
    Ok(true)
}

// Both real startup and fault-injection tests enter this exact transition.
fn resume_operation(
    root: &Path,
    work: &Path,
    operations: &Path,
    state: &mut OperationState,
) -> Result<()> {
    let cancelled = operations.join(format!("{}.cancel.json", state.request_id));
    if recovery_file_exists(&cancelled)? {
        check_path(&cancelled)?;
        let proof: Value =
            serde_json::from_slice(&fs::read(&cancelled).map_err(|_| "READ_FAILED")?)
                .map_err(|_| "INVALID_CANCEL_PROOF")?;
        if proof["requestId"] != state.request_id
            || proof["expectedVersion"] != state.expected_version
            || proof["sourceVersion"] != state.source_version
            || proof["reason"] != "UPDATE_NOT_COMMITTED"
            || !matches!(state.phase.as_str(), "prepared" | "awaitingHealth")
            || state.rollback_attempted
            || scope_digest(root)? != state.backup_digest
            || scope_digest(&work.join("backup"))? != state.backup_digest
        {
            return Err("INVALID_CANCEL_PROOF".into());
        }
        state.phase = "rolledBack".into();
        state.error = Some("CANCELLED_BEFORE_INSTALL".into());
        return persist_at(operations, state);
    }
    let failure = operations.join(format!("{}.failure.json", state.request_id));
    if recovery_file_exists(&failure)? {
        check_path(&failure)?;
        let proof: Value = serde_json::from_slice(&fs::read(&failure).map_err(|_| "READ_FAILED")?)
            .map_err(|_| "INVALID_FAILURE_PROOF")?;
        if proof["requestId"] != state.request_id
            || proof["expectedVersion"] != state.expected_version
            || proof["reason"] != "INSTALLER_FAILED"
        {
            return Err("INVALID_FAILURE_PROOF".into());
        }
        if !state.rollback_attempted {
            state.phase = "rollbackPending".into();
            state
                .failure_reason
                .get_or_insert_with(|| "INSTALLER_FAILED".into());
            state.error = Some("INSTALLER_FAILED".into());
        }
    }
    if state.phase == "rollbackPending" {
        if state.failure_reason.is_none() {
            state.failure_reason = state.error.clone();
        }
        if state.rollback_attempted {
            state.phase = "failed".into();
            state.error = Some("ROLLBACK_ALREADY_ATTEMPTED".into());
            persist_at(operations, state)?;
            return Ok(());
        }
        state.rollback_attempted = true;
        state.phase = "rollingBack".into();
        persist_at(operations, state)?;
    }
    if state.phase == "rollingBack" {
        if !state.rollback_attempted {
            return Err("INVALID_ROLLBACK_STATE".into());
        }
        let result = (|| {
            if scope_digest(&work.join("backup"))? != state.backup_digest {
                return Err("BACKUP_VERIFICATION_FAILED".into());
            }
            replace_scope(&root, &work.join("backup"))?;
            if scope_digest(&root)? != state.backup_digest {
                return Err("ROLLBACK_VERIFICATION_FAILED".into());
            }
            let stores = disk_stores(&root)?;
            let (data, preset, skins) = proof_fields(&stores, &root.join("skin-library"))?;
            state.data_digest = data;
            state.preset_id = preset;
            state.skin_hashes = skins;
            Ok(())
        })();
        match result {
            Ok(()) => {
                state.phase = "awaitingRollbackHealth".into();
                state.started_at = now();
            }
            Err(error) => {
                state.phase = "failed".into();
                state.error = Some(error);
            }
        }
    }
    persist_at(operations, state)
}
#[tauri::command]
pub fn update_recovery_status(app: tauri::AppHandle) -> Result<Option<OperationState>> {
    refresh_program_result(&app)?;
    read_operation(&app)
}
#[tauri::command]
pub fn initialize_shortcut_defaults(app: tauri::AppHandle, window: tauri::Window) -> Result<()> {
    if !matches!(window.label(), "main" | "preference") {
        return Err("INVALID_WINDOW".into());
    }
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    // Pinia installs its watcher after loading. Untouched frontend defaults
    // therefore need a native write before the settings readback barrier.
    // Never alter a pending transaction's acknowledged stores or proof digest.
    shortcuts::initialize_store(
        &app,
        !writes_locked() && !QUIESCENCE_ACTIVE.load(Ordering::SeqCst),
    )
}
pub fn begin_update_recovery(app: &tauri::AppHandle, expected_version: &str) -> Result<String> {
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    require_writable()?;
    let current = require_quiescence(app)?;
    app.pinia().save_all_now().map_err(|_| "SAVE_FAILED")?;
    verify_saved_stores(&user_root(app)?, &current)?;
    lock_writers(app, true);
    let result = (|| {
        let state = new_operation(app, expected_version)?;
        persist(app, &state)?;
        Ok(state.request_id)
    })();
    if result.is_err() {
        lock_writers(app, false);
    }
    result
}
pub fn abort_update_recovery(app: &tauri::AppHandle, request_id: &str) -> Result<()> {
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    let mut state = read_operation(app)?.ok_or("NO_OPERATION")?;
    if state.request_id != request_id || state.phase != "prepared" {
        return Err("INVALID_PHASE".into());
    }
    require_unchanged_backup(&user_root(app)?, &request_root(app, request_id)?, &state)?;
    state.phase = "rolledBack".into();
    state.error = Some("CANCELLED_BEFORE_INSTALL".into());
    persist(app, &state)?;
    let _ = cleanup_resolved_backup(
        &user_root(app)?,
        &state.request_id,
        &state.source_version,
        &state.expected_version,
    );
    lock_writers(app, false);
    Ok(())
}
/// Caller owns the helper handshake and has proved that no commit signal was
/// delivered. This cannot be used after installation has been authorized.
pub fn abort_update_before_commit(app: &tauri::AppHandle, request_id: &str) -> Result<()> {
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    let mut state = read_operation(app)?.ok_or("NO_OPERATION")?;
    if state.request_id != request_id
        || !matches!(state.phase.as_str(), "prepared" | "awaitingHealth")
    {
        return Err("INVALID_PHASE".into());
    }
    require_unchanged_backup(&user_root(app)?, &request_root(app, request_id)?, &state)?;
    state.phase = "rolledBack".into();
    state.error = Some("CANCELLED_BEFORE_INSTALL".into());
    persist(app, &state)?;
    let _ = cleanup_resolved_backup(
        &user_root(app)?,
        &state.request_id,
        &state.source_version,
        &state.expected_version,
    );
    lock_writers(app, false);
    Ok(())
}

fn require_unchanged_backup(root: &Path, work: &Path, state: &OperationState) -> Result<()> {
    if state.rollback_attempted
        || scope_digest(root)? != state.backup_digest
        || scope_digest(&work.join("backup"))? != state.backup_digest
    {
        return Err("INVALID_CANCEL_PROOF".into());
    }
    Ok(())
}
pub fn mark_update_launched(app: &tauri::AppHandle, request_id: &str) -> Result<()> {
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    let mut state = read_operation(app)?.ok_or("NO_OPERATION")?;
    if state.request_id != request_id || state.phase != "prepared" {
        return Err("INVALID_PHASE".into());
    }
    state.phase = "awaitingHealth".into();
    state.started_at = now();
    persist(app, &state)
}
#[tauri::command]
pub fn acknowledge_update_health(
    app: tauri::AppHandle,
    window: tauri::Window,
    proof: HealthProof,
) -> Result<OperationState> {
    if window.label() != "main" {
        return Err("INVALID_WINDOW".into());
    }
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    let mut state = read_operation(&app)?.ok_or("NO_OPERATION")?;
    let rollback = state.rollback_attempted;
    let version = if rollback {
        &state.source_version
    } else {
        &state.expected_version
    };
    if !matches!(
        state.phase.as_str(),
        "awaitingHealth" | "ambiguous" | "awaitingRollbackHealth"
    ) || proof.request_id != state.request_id
        || &proof.version != version
        || proof.version != app.package_info().version.to_string()
        || !proof.rendered
        || proof.preset_id != state.preset_id
    {
        return Err("HEALTH_PROOF_MISMATCH".into());
    }
    let current = require_quiescence(&app)?;
    let (data, preset, skins) = proof_fields(&current, &user_root(&app)?.join("skin-library"))?;
    let mut claimed = proof.skin_hashes;
    claimed.sort();
    claimed.dedup();
    if data != state.data_digest
        || preset != state.preset_id
        || skins != state.skin_hashes
        || claimed != skins
    {
        return Err("HEALTH_DATA_MISMATCH".into());
    }
    let root = user_root(&app)?;
    let expected = disk_stores(&request_root(&app, &state.request_id)?.join("backup"))?;
    let monitors = app
        .available_monitors()
        .map_err(|_| "WINDOW_NATIVE_MISMATCH")?
        .into_iter()
        .map(|monitor| {
            let area = monitor.work_area();
            geometry::Rect {
                x: area.position.x as f64,
                y: area.position.y as f64,
                width: area.size.width as f64,
                height: area.size.height as f64,
            }
        })
        .collect::<Vec<_>>();
    let mut window_geometry = geometry::Evidence {
        monitor_work_areas: monitors,
        windows: BTreeMap::new(),
    };
    for label in ["main", "preference"] {
        let window = app
            .get_webview_window(label)
            .ok_or("WINDOW_NATIVE_MISMATCH")?;
        let p = window
            .outer_position()
            .map_err(|_| "WINDOW_NATIVE_MISMATCH")?;
        let size = window.outer_size().map_err(|_| "WINDOW_NATIVE_MISMATCH")?;
        let inner = window.inner_size().map_err(|_| "WINDOW_NATIVE_MISMATCH")?;
        let monitor = window
            .current_monitor()
            .map_err(|_| "WINDOW_NATIVE_MISMATCH")?
            .ok_or("WINDOW_NATIVE_MISMATCH")?;
        let area = monitor.work_area();
        let scale_factor = monitor.scale_factor();
        let minimum_size = app
            .config()
            .app
            .windows
            .iter()
            .find(|config| config.label == label)
            .map(|config| geometry::Size {
                width: config.min_width.unwrap_or(0.0) * scale_factor,
                height: config.min_height.unwrap_or(0.0) * scale_factor,
            })
            .unwrap_or(geometry::Size {
                width: 0.0,
                height: 0.0,
            });
        window_geometry.windows.insert(
            label.into(),
            geometry::WindowObservation {
                position: geometry::Position {
                    x: p.x as f64,
                    y: p.y as f64,
                },
                inner_size: geometry::Size {
                    width: inner.width as f64,
                    height: inner.height as f64,
                },
                outer_size: geometry::Size {
                    width: size.width as f64,
                    height: size.height as f64,
                },
                monitor_work_area: geometry::Rect {
                    x: area.position.x as f64,
                    y: area.position.y as f64,
                    width: area.size.width as f64,
                    height: area.size.height as f64,
                },
                scale_factor,
                minimum_size,
            },
        );
    }
    window_geometry.verify(
        &expected["app"]["windowState"],
        &current["app"]["windowState"],
    )?;
    state.window_digest =
        digest(&serde_json::to_vec(&current["app"]["windowState"]).map_err(|_| "INVALID_DATA")?);
    state.window_geometry = Some(window_geometry);
    for (id, value) in &current {
        write_json(
            &user_root(&app)?
                .join(STORE_DIRECTORY)
                .join(format!("{id}.json")),
            value,
        )?;
    }
    if semantic_digest(&disk_stores(&root)?)? != state.data_digest
        || verify_saved_stores(&root, &current).is_err()
    {
        lock_writers(&app, true);
        return Err("SAVE_VERIFICATION_FAILED".into());
    }
    state.phase = if rollback {
        "rolledBack"
    } else {
        "awaitingCommit"
    }
    .into();
    state.rendered = true;
    state.warnings = proof.warnings;
    persist(&app, &state)?;
    if rollback {
        let _ = cleanup_resolved_backup(
            &root,
            &state.request_id,
            &state.source_version,
            &state.expected_version,
        );
        lock_writers(&app, false);
    }
    Ok(state)
}
#[tauri::command]
pub fn confirm_update_failure(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
    reason: String,
) -> Result<OperationState> {
    if window.label() != "main" {
        return Err("INVALID_WINDOW".into());
    }
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    let mut state = read_operation(&app)?.ok_or("NO_OPERATION")?;
    if state.request_id != request_id
        || !matches!(
            state.phase.as_str(),
            "awaitingHealth" | "awaitingRollbackHealth" | "ambiguous"
        )
    {
        return Err("INVALID_PHASE".into());
    }
    state.failure_reason.get_or_insert_with(|| reason.clone());
    state.error = Some(reason);
    state.phase = if state.rollback_attempted {
        "failed"
    } else {
        "rollbackPending"
    }
    .into();
    persist(&app, &state)?;
    if state.phase == "rollbackPending" {
        drop(_guard);
        crate::update_delivery::exit_for_rollback(&app)?;
    }
    Ok(state)
}
#[tauri::command]
pub fn recheck_update_recovery(app: tauri::AppHandle) -> Result<Option<OperationState>> {
    refresh_program_result(&app)?;
    let _guard = OPERATION.lock().map_err(|_| "OPERATION_BUSY")?;
    let Some(mut state) = read_operation(&app)? else {
        return Ok(None);
    };
    if matches!(
        state.phase.as_str(),
        "awaitingHealth" | "awaitingRollbackHealth"
    ) && now().saturating_sub(state.started_at) >= 120_000
    {
        state.phase = "ambiguous".into();
        persist(&app, &state)?;
        notification::report(
            &app,
            Some(state.request_id.clone()),
            "HEALTH_CHECK_PENDING",
            "unknown",
            Some(state.source_version.clone()),
            Some(state.expected_version.clone()),
        );
    } else if state.phase == "awaitingCommit" && now().saturating_sub(state.started_at) >= 120_000 {
        // Observation timeout is not proof that program commit failed.
        notification::report(
            &app,
            Some(state.request_id.clone()),
            "PROGRAM_COMMIT_PENDING",
            "unknown",
            Some(state.source_version.clone()),
            Some(state.expected_version.clone()),
        );
    }
    Ok(Some(state))
}
