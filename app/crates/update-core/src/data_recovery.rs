//! Filesystem-only update recovery receipts shared by the UI and worker.
//! No stores, windows, input, networking or application lifecycle is started here.
use crate::{geometry, integrity};
use integrity::{Result, digest};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::Path,
};

pub const STORE_DIRECTORY: &str = "tauri-plugin-pinia";

pub fn record_cleanup_result(state: &mut OperationState, result: Result<()>) {
    if result.is_err()
        && !state
            .warnings
            .iter()
            .any(|warning| warning == "RECOVERY_CLEANUP_DEFERRED")
    {
        state.warnings.push("RECOVERY_CLEANUP_DEFERRED".into());
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationState {
    pub request_id: String,
    pub phase: String,
    pub expected_version: String,
    pub source_version: String,
    pub started_at: u64,
    pub rollback_attempted: bool,
    pub data_digest: String,
    pub preset_id: String,
    pub skin_hashes: Vec<String>,
    pub backup_digest: String,
    pub error: Option<String>,
    #[serde(default)]
    pub failure_reason: Option<String>,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub rendered: bool,
    #[serde(default)]
    pub window_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_geometry: Option<geometry::Evidence>,
}

pub fn valid_request(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn read_state(root: &Path) -> Result<Option<OperationState>> {
    let path = root.join("active.json");
    if !recovery_file_exists(&path)? {
        return Ok(None);
    }
    check_path(&path)?;
    let state: OperationState = serde_json::from_slice(&fs::read(path).map_err(|_| "READ_FAILED")?)
        .map_err(|_| "CORRUPT_OPERATION")?;
    if !valid_request(&state.request_id) {
        return Err("CORRUPT_OPERATION".into());
    }
    Ok(Some(state))
}
pub fn recovery_file_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("READ_FAILED".into()),
    }
}
pub fn persist_at(root: &Path, state: &OperationState) -> Result<()> {
    write_json(&root.join("active.json"), state)?;
    if matches!(
        state.phase.as_str(),
        "awaitingCommit" | "verified" | "rolledBack" | "failed" | "ambiguous"
    ) {
        write_json(
            &root.join(format!("{}.result.json", state.request_id)),
            state,
        )?;
    }
    Ok(())
}

/// Only the bound program helper calls this after registry and program commit.
pub fn complete_program_commit(
    root: &Path,
    request_id: &str,
    source_version: &str,
    expected_version: &str,
) -> Result<()> {
    let operations = root.join("update-recovery");
    let mut state = read_state(&operations)?.ok_or("NO_OPERATION")?;
    if state.request_id != request_id
        || state.source_version != source_version
        || state.expected_version != expected_version
        || !matches!(state.phase.as_str(), "awaitingCommit" | "verified")
        || !state.rendered
        || state.rollback_attempted
        || state.window_digest.len() != 64
        || state.window_geometry.is_none()
    {
        return Err("HEALTH_PROOF_MISMATCH".into());
    }
    state.phase = "verified".into();
    persist_at(&operations, &state)
}

/// The program helper calls this only after the exact program journal commits.
/// The receipt is retained, but temporary user-data copies are removed. This
/// function cannot touch legacy user archives or another request's directory.
pub fn cleanup_resolved_backup(
    root: &Path,
    request_id: &str,
    source_version: &str,
    expected_version: &str,
) -> Result<()> {
    if !valid_request(request_id) {
        return Err("INVALID_REQUEST".into());
    }
    let operations = root.join("update-recovery");
    let receipt_path = operations.join(format!("{request_id}.result.json"));
    check_path(&receipt_path)?;
    let mut state: OperationState =
        serde_json::from_slice(&fs::read(&receipt_path).map_err(|_| "READ_FAILED")?)
            .map_err(|_| "CORRUPT_OPERATION")?;
    let cancelled = state.phase == "rolledBack"
        && !state.rollback_attempted
        && state.error.as_deref() == Some("CANCELLED_BEFORE_INSTALL");
    let confirmed = (state.phase == "verified" && !state.rollback_attempted
        || state.phase == "rolledBack" && state.rollback_attempted)
        && state.rendered
        && state.window_digest.len() == 64
        && state.window_geometry.is_some();
    if state.request_id != request_id
        || state.source_version != source_version
        || state.expected_version != expected_version
        || !(cancelled || confirmed)
    {
        return Err("INVALID_REQUEST".into());
    }
    let result = (|| {
        let work = operations.join(request_id);
        check_path(&work)?;
        if !recovery_file_exists(&work)? {
            return Ok(());
        }
        if !fs::symlink_metadata(&work)
            .map_err(|_| "READ_FAILED")?
            .is_dir()
        {
            return Err("UNSAFE_STORAGE_PATH".into());
        }
        for entry in fs::read_dir(&work).map_err(|_| "READ_FAILED")? {
            let entry = entry.map_err(|_| "READ_FAILED")?;
            if entry.file_name() != "backup" {
                return Err("RECOVERY_CLEANUP_DEFERRED".into());
            }
        }
        if cancelled && scope_digest(root)? != state.backup_digest {
            return Err("INVALID_CANCEL_PROOF".into());
        }
        let backup = work.join("backup");
        // A previous interrupted cleanup may already have removed some files.
        // Verify the full snapshot before starting a durable cleanup attempt.
        let cleanup_marker = operations.join(format!("{request_id}.cleanup.json"));
        if recovery_file_exists(&cleanup_marker)? {
            check_path(&cleanup_marker)?;
            let proof: Value =
                serde_json::from_slice(&fs::read(&cleanup_marker).map_err(|_| "READ_FAILED")?)
                    .map_err(|_| "INVALID_CLEANUP_PROOF")?;
            if proof != json!({"requestId":request_id,"backupDigest":state.backup_digest}) {
                return Err("INVALID_CLEANUP_PROOF".into());
            }
        } else {
            if scope_digest(&backup)? != state.backup_digest {
                return Err("BACKUP_VERIFICATION_FAILED".into());
            }
            write_json(
                &cleanup_marker,
                &json!({"requestId":request_id,"backupDigest":state.backup_digest}),
            )?;
        }
        // Recheck every remaining descendant before recursive deletion.
        tree_digest(&work)?;
        fs::remove_dir_all(&work).map_err(|_| "RECOVERY_CLEANUP_DEFERRED")?;
        fs::remove_file(cleanup_marker).map_err(|_| "RECOVERY_CLEANUP_DEFERRED")?;
        Ok(())
    })();
    if result.is_err() {
        record_cleanup_result(&mut state, Err("RECOVERY_CLEANUP_DEFERRED".into()));
        let _ = write_json(&receipt_path, &state);
        if read_state(&operations)
            .ok()
            .flatten()
            .is_some_and(|active| active.request_id == request_id)
        {
            let _ = write_json(&operations.join("active.json"), &state);
        }
    }
    result
}

pub fn check_path(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(ancestor) {
            Ok(m) if m.file_type().is_symlink() || integrity::is_reparse(&m) => {
                return Err("UNSAFE_STORAGE_PATH".into());
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("STORAGE_UNAVAILABLE".into()),
        }
    }
    Ok(())
}

pub fn tree_entries(
    root: &Path,
    path: &Path,
    entries: &mut BTreeMap<String, String>,
) -> Result<()> {
    check_path(path)?;
    if !path.exists() {
        return Ok(());
    }
    for item in fs::read_dir(path).map_err(|_| "READ_FAILED")? {
        let item = item.map_err(|_| "READ_FAILED")?;
        let p = item.path();
        check_path(&p)?;
        let m = fs::symlink_metadata(&p).map_err(|_| "READ_FAILED")?;
        if m.is_dir() {
            tree_entries(root, &p, entries)?;
        } else if m.is_file() {
            let key = p
                .strip_prefix(root)
                .map_err(|_| "UNSAFE_STORAGE_PATH")?
                .to_string_lossy()
                .replace('\\', "/");
            entries.insert(key, integrity::hash_file(&p)?);
        } else {
            return Err("UNSAFE_STORAGE_PATH".into());
        }
    }
    Ok(())
}
pub fn tree_digest(root: &Path) -> Result<String> {
    let mut entries = BTreeMap::new();
    tree_entries(root, root, &mut entries)?;
    Ok(digest(
        &serde_json::to_vec(&entries).map_err(|_| "INVALID_DATA")?,
    ))
}

pub fn scope_digest(root: &Path) -> Result<String> {
    let hashes = [
        tree_digest(&root.join(STORE_DIRECTORY))?,
        tree_digest(&root.join("skin-library"))?,
    ];
    Ok(digest(&serde_json::to_vec(&hashes).unwrap()))
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    check_path(path)?;
    fs::create_dir_all(path.parent().ok_or("UNSAFE_STORAGE_PATH")?).map_err(|_| "WRITE_FAILED")?;
    let bytes = serde_json::to_vec(value).map_err(|_| "INVALID_DATA")?;
    let temp = path.with_extension("json.part");
    // A retained partial file can exist after interruption. Reject redirects
    // before opening it: truncate and source canonicalization both follow them.
    check_path(&temp)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp)
        .map_err(|_| "WRITE_FAILED")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "WRITE_FAILED")?;
    drop(file);
    atomic_replace(&temp, path).map_err(|_| "WRITE_FAILED".to_string())
}
pub fn atomic_replace(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = fs::canonicalize(source)?;
    let target = fs::canonicalize(
        target
            .parent()
            .ok_or_else(|| io::Error::other("missing parent"))?,
    )?
    .join(
        target
            .file_name()
            .ok_or_else(|| io::Error::other("missing name"))?,
    );
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
