//! A dedicated, byte-bound worker owns the transaction after the app exits.
//! READY and COMMIT are separate: owner death before COMMIT never starts setup.
use super::{
    UpdateError, fail,
    feed::{Feed, Trust},
};
use super::{
    journal::{Journal, Phase},
    reentry,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

const APP_EXE: &str = "dmelopers-3d-block-pet.exe";
pub const WORKER_EXE: &str = "block-pet-update-worker.exe";
const MAX_WORKER_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerIdentity {
    pub schema_version: u32,
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

impl WorkerIdentity {
    pub fn validate(&self, version: &str) -> Result<(), UpdateError> {
        if self.schema_version != 1
            || self.path != WORKER_EXE
            || super::feed::version(version).is_err()
            || !super::feed::valid_sha256(&self.sha256)
            || self.size == 0
            || self.size > MAX_WORKER_BYTES
        {
            return Err(fail("WORKER_IDENTITY_INVALID"));
        }
        Ok(())
    }

    fn verify_file(&self, path: &Path) -> Result<(), UpdateError> {
        let metadata = fs::symlink_metadata(path).map_err(|_| fail("PACKAGED_WORKER_REQUIRED"))?;
        if !metadata.is_file()
            || is_reparse(&metadata)
            || metadata.len() != self.size
            || hash(path)? != self.sha256
        {
            return Err(fail("WORKER_INTEGRITY_FAILED"));
        }
        Ok(())
    }
}

fn legacy_schema() -> u32 {
    1
}
fn is_legacy_schema(value: &u32) -> bool {
    *value == 1
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    #[serde(default = "legacy_schema", skip_serializing_if = "is_legacy_schema")]
    schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worker: Option<WorkerIdentity>,
    request_id: String,
    expected_version: String,
    source_version: String,
    install_root: PathBuf,
    data_root: PathBuf,
    mode: String,
    parent_pid: u32,
    parent_started: u64,
    #[serde(
        default,
        rename = "parentCreated100ns",
        skip_serializing_if = "Option::is_none"
    )]
    parent_created_100ns: Option<u64>,
    original_sid: String,
    signed_feed: String,
    signed_feed_signature: String,
    feed: Feed,
    files: BTreeMap<String, String>,
}

impl Record {
    fn parent_creation(&self) -> Result<super::process::CreationIdentity, UpdateError> {
        match (self.schema_version, self.parent_created_100ns) {
            (1, None) => Ok(super::process::CreationIdentity::LegacySeconds(
                self.parent_started,
            )),
            (2, Some(ticks))
                if super::process::unix_seconds(ticks).ok() == Some(self.parent_started) =>
            {
                Ok(super::process::CreationIdentity::Filetime100ns(ticks))
            }
            _ => Err(fail("PROCESS_IDENTITY_INVALID")),
        }
    }

    fn resume_creation(&self, value: u64) -> Result<super::process::CreationIdentity, UpdateError> {
        match self.schema_version {
            1 => Ok(super::process::CreationIdentity::LegacySeconds(value)),
            2 => {
                super::process::unix_seconds(value)
                    .map_err(|_| fail("PROCESS_IDENTITY_INVALID"))?;
                Ok(super::process::CreationIdentity::Filetime100ns(value))
            }
            _ => Err(fail("PROCESS_IDENTITY_INVALID")),
        }
    }

    fn validate_worker(&self) -> Result<(), UpdateError> {
        self.parent_creation()?;
        self.feed.require_supported_installer()?;
        match (self.schema_version, &self.worker) {
            (1, None)
                if self
                    .files
                    .get(APP_EXE)
                    .is_some_and(|value| super::feed::valid_sha256(value)) =>
            {
                Ok(())
            }
            (2, Some(worker)) => {
                worker.validate(&self.source_version)?;
                if self.files.get(WORKER_EXE) != Some(&worker.sha256) {
                    return Err(fail("WORKER_IDENTITY_INVALID"));
                }
                Ok(())
            }
            _ => Err(fail("WORKER_IDENTITY_INVALID")),
        }
    }

    fn verify_staged_worker(&self, path: &Path) -> Result<(), UpdateError> {
        self.validate_worker()?;
        if let Some(worker) = &self.worker {
            worker.verify_file(path)
        } else if Some(&hash(path)?) == self.files.get(APP_EXE) {
            Ok(())
        } else {
            Err(fail("WORKER_INTEGRITY_FAILED"))
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Locator {
    request_id: String,
    record_path: PathBuf,
    record_hash: String,
}

fn bound_journal(staging: &Path, request_id: &str, digest: &str) -> Result<Journal, UpdateError> {
    let bytes = fs::read(staging.join("operation.json"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err(fail("CORRUPT_PROGRAM_JOURNAL"));
    }
    let record: Record =
        serde_json::from_slice(&bytes).map_err(|_| fail("CORRUPT_PROGRAM_JOURNAL"))?;
    record.validate_worker()?;
    let journal = Journal::read(staging, request_id)?;
    if journal.schema_version != record.schema_version
        || record.request_id != request_id
        || journal.record_sha256.as_deref() != Some(digest)
    {
        return Err(fail("CORRUPT_PROGRAM_JOURNAL"));
    }
    Ok(journal)
}

fn locator_path(record: &Record) -> PathBuf {
    record
        .data_root
        .join("update-recovery/program-recovery.json")
}

fn path_present(path: &Path) -> Result<bool, UpdateError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_reparse(&metadata) => Err(fail("UNSAFE_PATH")),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Windows can report NotFound for a child whose parent is a file.
            // Only absent paths under plain directory ancestors prove absence.
            for ancestor in path.ancestors().skip(1) {
                match fs::symlink_metadata(ancestor) {
                    Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {}
                    Ok(_) => return Err(fail("UNSAFE_PATH")),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}

fn read_locator(path: &Path) -> Result<Option<Vec<u8>>, UpdateError> {
    if !path_present(path)? {
        return Ok(None);
    }
    require_plain_directory(path.parent().ok_or_else(|| fail("UNSAFE_PATH"))?)?;
    Ok(Some(fs::read(path)?))
}

fn clear_reentry(staging: &Path, record: &Record, digest: &str) -> Result<(), UpdateError> {
    reentry::update(
        staging,
        &record.request_id,
        &record.original_sid,
        digest,
        true,
    )?;
    let path = locator_path(record);
    if path_present(&path)? {
        let locator: Locator = serde_json::from_slice(&fs::read(&path)?)
            .map_err(|_| fail("CORRUPT_PROGRAM_JOURNAL"))?;
        if locator.request_id != record.request_id
            || locator.record_hash != digest
            || locator.record_path != staging.join("operation.json")
        {
            return Err(fail("RECOVERY_REGISTRATION_CHANGED"));
        }
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Called before the data coordinator or any stores may write on every app boot.
pub fn guard_boot(data_root: &Path) -> Result<(), String> {
    let path = data_root.join("update-recovery/program-recovery.json");
    let guard = || -> Result<(), UpdateError> {
        let Some(bytes) = read_locator(&path)? else {
            return Ok(());
        };
        let locator: Locator =
            serde_json::from_slice(&bytes).map_err(|_| fail("CORRUPT_PROGRAM_JOURNAL"))?;
        if hash(&locator.record_path)? != locator.record_hash {
            return Err(fail("CORRUPT_PROGRAM_JOURNAL"));
        }
        let staging = locator
            .record_path
            .parent()
            .ok_or_else(|| fail("UNSAFE_PATH"))?;
        let record: Record = serde_json::from_slice(&fs::read(&locator.record_path)?)
            .map_err(|_| fail("CORRUPT_PROGRAM_JOURNAL"))?;
        if locator.request_id != record.request_id || record.original_sid != reentry::current_sid()?
        {
            return Err(fail("INVALID_REQUEST"));
        }
        let journal = bound_journal(staging, &record.request_id, &locator.record_hash)?;
        match journal.phase {
            Phase::AwaitingHealth
            | Phase::ProgramRestored
            | Phase::Verified
            | Phase::RolledBack
            | Phase::Cancelled => Ok(()),
            Phase::Failed => Err(fail("ROLLBACK_FAILED")),
            _ => {
                // Verify the retained v1 executable or v2 worker before resuming it.
                record.verify_staged_worker(&staging.join("update-helper.exe"))?;
                spawn_arguments(
                    &staging.join("update-helper.exe"),
                    &format!("--resume-update-helper {}", locator.record_hash),
                    false,
                )?;
                Err(fail("PROGRAM_RECOVERY_PENDING"))
            }
        }
    };
    guard().map_err(|error| error.code)
}

pub fn require_plain_directory(path: &Path) -> Result<(), UpdateError> {
    for ancestor in path.ancestors() {
        let meta = fs::symlink_metadata(ancestor)?;
        if !meta.is_dir() || is_reparse(&meta) {
            return Err(fail("UNSAFE_PATH"));
        }
    }
    Ok(())
}

fn is_reparse(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
}

fn hash(path: &Path) -> Result<String, UpdateError> {
    hash_cancellable(path, &|| false)
}

fn hash_cancellable(path: &Path, cancelled: &impl Fn() -> bool) -> Result<String, UpdateError> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || is_reparse(&meta) {
        return Err(fail("UNSAFE_PATH"));
    }
    let mut input = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        if cancelled() {
            return Err(fail("CANCELLED"));
        }
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn inventory(root: &Path) -> Result<BTreeMap<String, String>, UpdateError> {
    inventory_cancellable(root, &|| false)
}

fn inventory_cancellable(
    root: &Path,
    cancelled: &impl Fn() -> bool,
) -> Result<BTreeMap<String, String>, UpdateError> {
    require_plain_directory(root)?;
    let mut result = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir)? {
            if cancelled() {
                return Err(fail("CANCELLED"));
            }
            let path = entry?.path();
            let meta = fs::symlink_metadata(&path)?;
            if is_reparse(&meta) {
                return Err(fail("UNSAFE_PATH"));
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| fail("UNSAFE_PATH"))?
                    .to_str()
                    .ok_or_else(|| fail("UNSAFE_PATH"))?
                    .replace('\\', "/");
                result.insert(relative, hash_cancellable(&path, cancelled)?);
            } else {
                return Err(fail("UNSAFE_PATH"));
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
fn copy_snapshot(
    source: &Path,
    target: &Path,
    files: &BTreeMap<String, String>,
) -> Result<(), UpdateError> {
    copy_snapshot_cancellable(source, target, files, &|| false)
}

fn copy_snapshot_cancellable(
    source: &Path,
    target: &Path,
    files: &BTreeMap<String, String>,
    cancelled: &impl Fn() -> bool,
) -> Result<(), UpdateError> {
    fs::create_dir(target)?;
    for (relative, expected) in files {
        let source = source.join(relative);
        let destination = target.join(relative);
        fs::create_dir_all(destination.parent().ok_or_else(|| fail("UNSAFE_PATH"))?)?;
        copy_file_cancellable(&source, &destination, expected, true, cancelled)?;
    }
    if inventory_cancellable(target, cancelled)? != *files {
        return Err(fail("RECOVERY_PREPARE_FAILED"));
    }
    Ok(())
}

fn copy_file_cancellable(
    source: &Path,
    destination: &Path,
    expected: &str,
    create_new: bool,
    cancelled: &impl Fn() -> bool,
) -> Result<(), UpdateError> {
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(fail("UNSAFE_PATH"));
    }
    let mut source = fs::File::open(source)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create(!create_new)
        .create_new(create_new)
        .truncate(!create_new)
        .open(destination)?;
    let mut buffer = [0; 65536];
    let mut digest = Sha256::new();
    loop {
        if cancelled() {
            return Err(fail("CANCELLED"));
        }
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
        digest.update(&buffer[..count]);
    }
    output.sync_all()?;
    drop(output);
    if format!("{:x}", digest.finalize()) != expected
        || hash_cancellable(destination, cancelled)? != expected
    {
        return Err(fail("RECOVERY_PREPARE_FAILED"));
    }
    Ok(())
}

fn atomic_new(path: &Path, bytes: &[u8]) -> Result<(), UpdateError> {
    let temporary = path.with_extension(format!("pending-{}", super::new_request_id()?));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
        let source: Vec<_> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(fail("IO_ERROR"));
        }
    }
    if fs::read(path)? != bytes {
        return Err(fail("IO_ERROR"));
    }
    Ok(())
}

pub fn prepare(
    data_root: &Path,
    source_version: &str,
    expected_worker: &WorkerIdentity,
    staging: &Path,
    request_id: &str,
    feed: &Feed,
    cancelled: impl Fn() -> bool,
) -> Result<(), UpdateError> {
    feed.require_supported_installer()?;
    expected_worker.validate(source_version)?;
    require_no_other_account_process()?;
    let exe = std::env::current_exe()?;
    if exe.file_name().and_then(|s| s.to_str()) != Some(APP_EXE) {
        return Err(fail("PACKAGED_APP_REQUIRED"));
    }
    let install_root = exe
        .parent()
        .ok_or_else(|| fail("UNSAFE_PATH"))?
        .to_path_buf();
    require_plain_directory(&install_root)?;
    let worker_source = install_root.join(WORKER_EXE);
    expected_worker.verify_file(&worker_source)?;
    let mode = fs::read_to_string(install_root.join("block-pet-install-mode.txt"))?;
    if !matches!(mode.as_str(), "CurrentUser" | "AllUsers") {
        return Err(fail("INSTALL_IDENTITY_INVALID"));
    }
    let original_sid = reentry::current_sid()?;
    validate_registry_identity(&install_root, &mode, &original_sid, source_version, false)?;
    reentry::command(staging, &"0".repeat(64))?;
    if cancelled() {
        return Err(fail("CANCELLED"));
    }
    let files = inventory_cancellable(&install_root, &cancelled)?;
    if files.get(WORKER_EXE) != Some(&expected_worker.sha256) {
        return Err(fail("WORKER_INTEGRITY_FAILED"));
    }
    copy_snapshot_cancellable(
        &install_root,
        &staging.join("program-recovery"),
        &files,
        &cancelled,
    )?;
    if inventory_cancellable(&install_root, &cancelled)? != files {
        return Err(fail("RECOVERY_PREPARE_FAILED"));
    }
    let helper = staging.join("update-helper.exe");
    copy_file_cancellable(
        &worker_source,
        &helper,
        files
            .get(WORKER_EXE)
            .ok_or_else(|| fail("INSTALL_IDENTITY_INVALID"))?,
        true,
        &cancelled,
    )?;
    let parent_created_100ns =
        super::process::current_created_100ns().map_err(|_| fail("PROCESS_STATE_UNKNOWN"))?;
    let parent_started = super::process::unix_seconds(parent_created_100ns)
        .map_err(|_| fail("PROCESS_STATE_UNKNOWN"))?;
    expected_worker.verify_file(&helper)?;
    let record = Record {
        schema_version: 2,
        worker: Some(expected_worker.clone()),
        request_id: request_id.into(),
        expected_version: feed.version.clone(),
        source_version: source_version.to_owned(),
        install_root,
        data_root: data_root.to_path_buf(),
        mode: mode.clone(),
        parent_pid: std::process::id(),
        parent_started,
        parent_created_100ns: Some(parent_created_100ns),
        original_sid,
        signed_feed: String::from_utf8(feed.authenticated_bytes.clone())
            .map_err(|_| fail("METADATA_INVALID"))?,
        signed_feed_signature: feed.authenticated_signature.clone(),
        feed: feed.clone(),
        files,
    };
    let bytes = serde_json::to_vec(&record).map_err(|_| fail("IO_ERROR"))?;
    let record_path = staging.join("operation.json");
    atomic_new(&record_path, &bytes)?;
    let record_hash = format!("{:x}", Sha256::digest(&bytes));
    let mut journal = Journal::new(request_id);
    journal.schema_version = record.schema_version;
    journal.record_sha256 = Some(record_hash.clone());
    journal.save(staging)?;
    atomic_new(
        &locator_path(&record),
        &serde_json::to_vec(&Locator {
            request_id: request_id.into(),
            record_path: record_path.clone(),
            record_hash: record_hash.clone(),
        })
        .map_err(|_| fail("IO_ERROR"))?,
    )?;
    reentry::update(
        staging,
        request_id,
        &record.original_sid,
        &record_hash,
        false,
    )?;
    if cancelled() {
        cancel_prepared(staging);
        return Err(fail("CANCELLED"));
    }
    spawn_helper(&helper, &record_path, &record_hash, mode == "AllUsers")?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if cancelled() {
            cancel_prepared(staging);
            return Err(fail("CANCELLED"));
        }
        if fs::read_to_string(staging.join("ready")).ok().as_deref() == Some(request_id) {
            return Ok(());
        }
        if path_present(&staging.join("helper-failed"))? {
            return Err(fail("HELPER_FAILED"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    cancel_prepared(staging);
    Err(fail("HELPER_NOT_READY"))
}

pub fn cancel_prepared(staging: &Path) {
    let _ = atomic_new(&staging.join("cancel"), b"cancel");
    let cancel = || -> Result<(), UpdateError> {
        let record_path = staging.join("operation.json");
        let record: Record = serde_json::from_slice(&fs::read(&record_path)?)
            .map_err(|_| fail("INVALID_REQUEST"))?;
        let _owner = HelperOwner::acquire(&record.request_id)?;
        let mut journal = bound_journal(staging, &record.request_id, &hash(&record_path)?)?;
        if journal.phase == Phase::Prepared && !read_commit(staging)? {
            mark_not_committed(staging, &record, &mut journal)?;
            clear_reentry(staging, &record, &hash(&record_path)?)?;
        }
        Ok(())
    };
    let _ = cancel();
}
pub enum CommitOutcome {
    Committed,
    NotCommitted(UpdateError),
    Ambiguous,
}
pub fn commit(staging: &Path) -> CommitOutcome {
    if let Err(error) = atomic_new(&staging.join("commit"), b"commit") {
        return match fs::read(staging.join("commit")) {
            Ok(bytes) if bytes == b"commit" => CommitOutcome::Committed,
            Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => {
                CommitOutcome::NotCommitted(error)
            }
            _ => CommitOutcome::Ambiguous,
        };
    }
    CommitOutcome::Committed
}

#[cfg(windows)]
fn spawn_helper(
    exe: &Path,
    record: &Path,
    digest: &str,
    elevated: bool,
) -> Result<(), UpdateError> {
    spawn_arguments(
        exe,
        &format!("--update-helper {} {digest}", quote(record.as_os_str())),
        elevated,
    )
}

#[cfg(windows)]
fn spawn_arguments(exe: &Path, arguments: &str, elevated: bool) -> Result<(), UpdateError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        UI::{
            Shell::{
                SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
            },
            WindowsAndMessaging::SW_HIDE,
        },
    };
    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let filename = wide(exe.as_os_str());
    let parameters = wide(std::ffi::OsStr::new(arguments));
    let verb = wide(std::ffi::OsStr::new(if elevated {
        "runas"
    } else {
        "open"
    }));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = filename.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(fail("HELPER_LAUNCH_FAILED"));
    }
    if !info.hProcess.is_null() {
        unsafe {
            CloseHandle(info.hProcess);
        }
    }
    Ok(())
}

fn quote(value: &std::ffi::OsStr) -> String {
    // Paths cannot contain quotes on Windows. Reject other data before this boundary.
    format!("\"{}\"", value.to_string_lossy())
}

/// Enumerate all sessions, including inaccessible owners, and never terminate them.
pub fn require_no_other_account_process() -> Result<(), UpdateError> {
    require_no_process_except(Some(std::process::id()))
}

#[cfg(windows)]
fn require_no_process_except(allowed: Option<u32>) -> Result<(), UpdateError> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_NO_MORE_FILES, GetLastError, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(fail("PROCESS_STATE_UNKNOWN"));
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut success = Process32FirstW(snapshot, &mut entry);
        let mut result = Ok(());
        while success != 0 {
            let length = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
            if name.eq_ignore_ascii_case(APP_EXE) && allowed != Some(entry.th32ProcessID) {
                result = Err(fail("OTHER_ACCOUNT_RUNNING"));
                break;
            }
            success = Process32NextW(snapshot, &mut entry);
        }
        if result.is_ok() && GetLastError() != ERROR_NO_MORE_FILES {
            result = Err(fail("PROCESS_STATE_UNKNOWN"));
        }
        CloseHandle(snapshot);
        result
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvocationRole {
    Application,
    InstallGuard,
    Worker,
}

pub fn invocation_role(argument: Option<&std::ffi::OsStr>) -> InvocationRole {
    match argument.and_then(|value| value.to_str()) {
        Some("--update-install-guard") => InvocationRole::InstallGuard,
        Some("--update-helper" | "--resume-update-helper" | "--resume-elevated-helper") => {
            InvocationRole::Worker
        }
        _ => InvocationRole::Application,
    }
}

pub fn install_guard_exit_code() -> i32 {
    if require_no_process_except(None).is_ok() {
        0
    } else {
        1618
    }
}

pub fn run_from_args(notice: &dyn Fn(&str)) -> Option<i32> {
    run_from_arguments(&std::env::args_os().collect::<Vec<_>>(), notice)
}

fn run_from_arguments(args: &[std::ffi::OsString], notice: &dyn Fn(&str)) -> Option<i32> {
    match invocation_role(args.get(1).map(|value| value.as_os_str())) {
        InvocationRole::Application => return None,
        InvocationRole::InstallGuard => return Some(install_guard_exit_code()),
        InvocationRole::Worker => {}
    }
    let mode = args.get(1).map(|v| v.to_string_lossy()).unwrap_or_default();
    let result = if mode == "--resume-update-helper" {
        args.get(2)
            .ok_or_else(|| fail("INVALID_REQUEST"))
            .and_then(|digest| resume(&digest.to_string_lossy(), notice))
    } else {
        args.get(2)
            .zip(args.get(3))
            .ok_or_else(|| fail("INVALID_REQUEST"))
            .and_then(|(path, digest)| {
                let parent = if mode == "--resume-elevated-helper" {
                    Some((
                        args.get(4)
                            .and_then(|v| v.to_str()?.parse::<u32>().ok())
                            .ok_or_else(|| fail("INVALID_REQUEST"))?,
                        args.get(5)
                            .and_then(|v| v.to_str()?.parse::<u64>().ok())
                            .ok_or_else(|| fail("INVALID_REQUEST"))?,
                    ))
                } else {
                    None
                };
                run(
                    Path::new(path),
                    &digest.to_string_lossy(),
                    parent,
                    mode != "--update-helper",
                    notice,
                )
            })
    };
    if let Err(error) = result {
        record_failure_marker(args, &error.code);
        if error.code != "HELPER_ALREADY_RUNNING" {
            notice(&error.code);
        }
        return Some(1);
    }
    Some(0)
}

fn record_failure_marker(args: &[std::ffi::OsString], code: &str) {
    let marker = || -> Result<(), UpdateError> {
        let executable = std::env::current_exe()?;
        let staging = executable.parent().ok_or_else(|| fail("UNSAFE_PATH"))?;
        require_plain_directory(staging)?;
        let record_path = staging.join("operation.json");
        let index = if args
            .get(1)
            .is_some_and(|arg| arg == "--resume-update-helper")
        {
            2
        } else {
            3
        };
        let expected = args
            .get(index)
            .and_then(|value| value.to_str())
            .ok_or_else(|| fail("INVALID_REQUEST"))?;
        if hash(&record_path)? != expected {
            return Err(fail("INVALID_REQUEST"));
        }
        let record: Record =
            serde_json::from_slice(&fs::read(record_path)?).map_err(|_| fail("INVALID_REQUEST"))?;
        record.verify_staged_worker(&executable)?;
        atomic_new(&staging.join("helper-failed"), code.as_bytes())
    };
    let _ = marker();
}

fn resume(digest: &str, notice: &dyn Fn(&str)) -> Result<(), UpdateError> {
    let executable = std::env::current_exe()?;
    let staging = executable.parent().ok_or_else(|| fail("UNSAFE_PATH"))?;
    let path = staging.join("operation.json");
    if hash(&path)? != digest {
        return Err(fail("INVALID_REQUEST"));
    }
    let record: Record =
        serde_json::from_slice(&fs::read(&path)?).map_err(|_| fail("INVALID_REQUEST"))?;
    record.verify_staged_worker(&executable)?;
    record.feed.require_supported_installer()?;
    if record.original_sid != reentry::current_sid()? {
        return Err(fail("ORIGINAL_USER_UNAVAILABLE"));
    }
    let mut journal = bound_journal(staging, &record.request_id, digest)?;
    if journal.phase == Phase::Verified {
        verified_postprocess(staging, &mut journal, || {
            crate::data_recovery::complete_program_commit(
                &record.data_root,
                &record.request_id,
                &record.source_version,
                &record.expected_version,
            )
            .map_err(|_| fail("RECOVERY_REQUIRED"))?;
            crate::data_recovery::cleanup_resolved_backup(
                &record.data_root,
                &record.request_id,
                &record.source_version,
                &record.expected_version,
            )
            .map_err(|_| fail("CLEANUP_PENDING"))?;
            clear_reentry(staging, &record, digest)
        });
        return Ok(());
    }
    if journal.terminal() {
        return clear_reentry(staging, &record, digest);
    }
    if journal.phase == Phase::Failed {
        return Err(fail("ROLLBACK_FAILED"));
    }
    // Windows removes this operation's RunOnce value before launching it.
    // Re-arm only this unfinished installation, never an unrelated startup value.
    reentry::update(
        staging,
        &record.request_id,
        &record.original_sid,
        digest,
        false,
    )?;
    if record.mode == "CurrentUser" {
        return run(&path, digest, None, true, notice);
    }
    let pid = std::process::id();
    let started = if record.schema_version == 2 {
        super::process::current_created_100ns()
    } else {
        super::process::current_started_seconds()
    }
    .map_err(|_| fail("ORIGINAL_USER_UNAVAILABLE"))?;
    let acknowledgement = staging.join(format!("resume-ready-{pid}-{started}"));
    spawn_arguments(
        &executable,
        &format!(
            "--resume-elevated-helper {} {digest} {pid} {started}",
            quote(path.as_os_str())
        ),
        true,
    )?;
    let deadline = Instant::now() + Duration::from_secs(60);
    // Keep the interactive user's primary token alive until the elevated child
    // duplicates and SID-checks it. No administrator-profile restart is allowed.
    while Instant::now() < deadline {
        if fs::read_to_string(&acknowledgement).ok().as_deref() == Some(&record.request_id) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(fail("HELPER_NOT_READY"))
}

fn run(
    record_path: &Path,
    digest: &str,
    resume_parent: Option<(u32, u64)>,
    resuming: bool,
    notice: &dyn Fn(&str),
) -> Result<(), UpdateError> {
    let staging = record_path.parent().ok_or_else(|| fail("UNSAFE_PATH"))?;
    require_plain_directory(staging)?;
    if hash(record_path)? != digest {
        return Err(fail("INVALID_REQUEST"));
    }
    let record: Record =
        serde_json::from_slice(&fs::read(record_path)?).map_err(|_| fail("INVALID_REQUEST"))?;
    if record.request_id.len() != 32
        || !record.request_id.bytes().all(|b| b.is_ascii_hexdigit())
        || !matches!(record.mode.as_str(), "CurrentUser" | "AllUsers")
        || record.expected_version != record.feed.version
        || staging.starts_with(&record.install_root)
        || record.install_root.starts_with(staging)
    {
        return Err(fail("INVALID_REQUEST"));
    }
    record.verify_staged_worker(&staging.join("update-helper.exe"))?;
    if fs::canonicalize(std::env::current_exe()?)?
        != fs::canonicalize(staging.join("update-helper.exe"))?
    {
        return Err(fail("WORKER_IDENTITY_INVALID"));
    }
    require_plain_directory(&record.install_root)?;
    require_plain_directory(&record.data_root)?;
    let trust = Trust::for_repository(&record.feed.repository)?;
    let signed = Feed::parse(
        record.signed_feed.as_bytes(),
        &record.signed_feed_signature,
        &trust,
    )?;
    super::require_same_feed(&record.feed, &signed)?;
    signed.require_supported_installer()?;
    let _owner = HelperOwner::acquire(&record.request_id)?;
    let mut journal = bound_journal(staging, &record.request_id, digest)?;
    if journal.phase == Phase::Verified {
        verified_postprocess(staging, &mut journal, || {
            crate::data_recovery::complete_program_commit(
                &record.data_root,
                &record.request_id,
                &record.source_version,
                &record.expected_version,
            )
            .map_err(|_| fail("RECOVERY_REQUIRED"))?;
            crate::data_recovery::cleanup_resolved_backup(
                &record.data_root,
                &record.request_id,
                &record.source_version,
                &record.expected_version,
            )
            .map_err(|_| fail("CLEANUP_PENDING"))?;
            clear_reentry(staging, &record, digest)
        });
        return Ok(());
    }
    if journal.terminal() {
        return clear_reentry(staging, &record, digest);
    }
    verify_installer(staging, &record)?;
    if inventory(&staging.join("program-recovery"))? != record.files {
        return Err(fail("RECOVERY_PREPARE_FAILED"));
    }
    let launcher = OriginalUser::capture(&record, resume_parent, resuming)?;
    if let Some((pid, started)) = resume_parent {
        atomic_new(
            &staging.join(format!("resume-ready-{pid}-{started}")),
            record.request_id.as_bytes(),
        )?;
    }
    if journal.phase == Phase::Prepared {
        if !resuming {
            atomic_new(&staging.join("ready"), record.request_id.as_bytes())?;
        }
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            match read_commit(staging)? {
                true => break,
                false
                    if path_present(&staging.join("cancel"))?
                        || resuming
                        || !parent_alive(&record)?
                        || Instant::now() >= deadline =>
                {
                    mark_not_committed(staging, &record, &mut journal)?;
                    clear_reentry(staging, &record, digest)?;
                    if resuming {
                        launcher.launch(&record, true)?;
                    }
                    return Ok(());
                }
                false => {}
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        journal.transition(staging, Phase::Committed)?;
    }
    if journal.phase == Phase::Committed {
        let deadline = Instant::now() + Duration::from_secs(60);
        while parent_alive(&record)? {
            if Instant::now() >= deadline {
                return Err(fail("PARENT_NOT_EXITED"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        wait_for_apps_exit()?;
        verify_installer(staging, &record)?;
        validate_registry_identity(
            &record.install_root,
            &record.mode,
            &record.original_sid,
            &record.source_version,
            false,
        )?;
        if inventory(&record.install_root)? != record.files {
            return Err(fail("INSTALL_DRIFT"));
        }
        journal.transition(staging, Phase::Installing)?;
        let exit = launch_installer(staging, &record)?;
        journal.installer_exit = Some(exit);
        journal.save(staging)?;
        if exit == 0 && target_matches(&record)? {
            journal.transition(staging, Phase::AwaitingHealth)?;
        } else {
            rollback_program(staging, &record, &mut journal)?;
        }
    } else if journal.phase == Phase::Installing {
        if installer_alive()? {
            return Err(fail("INSTALLER_STATE_UNKNOWN"));
        }
        wait_for_apps_exit()?;
        if target_matches(&record)? {
            journal.transition(staging, Phase::AwaitingHealth)?;
        } else {
            rollback_program(staging, &record, &mut journal)?;
        }
    } else if journal.phase == Phase::RestoringProgram {
        rollback_program(staging, &record, &mut journal)?;
    }
    if matches!(
        journal.phase,
        Phase::AwaitingHealth | Phase::ProgramRestored
    ) {
        launcher.launch(&record, journal.phase == Phase::ProgramRestored)?;
    }
    monitor(staging, &record, digest, &launcher, &mut journal, notice)
}

fn read_commit(staging: &Path) -> Result<bool, UpdateError> {
    match fs::read(staging.join("commit")) {
        Ok(bytes) if bytes == b"commit" => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        _ => Err(fail("COMMIT_STATE_UNKNOWN")),
    }
}

fn mark_not_committed(
    staging: &Path,
    record: &Record,
    journal: &mut Journal,
) -> Result<(), UpdateError> {
    if read_commit(staging)? || journal.phase != Phase::Prepared {
        return Err(fail("COMMIT_STATE_UNKNOWN"));
    }
    if inventory(&record.install_root)? != record.files {
        return Err(fail("INSTALL_DRIFT"));
    }
    let marker = serde_json::json!({ "requestId": record.request_id, "expectedVersion": record.expected_version,
        "sourceVersion": record.source_version, "reason": "UPDATE_NOT_COMMITTED" });
    let path = record
        .data_root
        .join("update-recovery")
        .join(format!("{}.cancel.json", record.request_id));
    let bytes = serde_json::to_vec(&marker).map_err(|_| fail("IO_ERROR"))?;
    if path_present(&path)? {
        if fs::read(&path)? != bytes {
            return Err(fail("INVALID_REQUEST"));
        }
    } else {
        atomic_new(&path, &bytes)?;
    }
    journal.transition(staging, Phase::Cancelled)
}

fn installer_alive() -> Result<bool, UpdateError> {
    // Legacy journals do not bind an installer PID. Preserve their conservative
    // name check, but only enumerate names; never read all process parameters.
    let processes = super::process::snapshot().map_err(|_| fail("INSTALLER_STATE_UNKNOWN"))?;
    Ok(processes
        .iter()
        .any(|process| process.name.eq_ignore_ascii_case("installer.exe")))
}

fn target_matches(record: &Record) -> Result<bool, UpdateError> {
    require_plain_directory(&record.install_root)?;
    for (relative, expected) in &record.feed.asset.installed_files {
        let path = record.install_root.join(relative);
        if !path_present(&path)? || hash(&path)? != *expected {
            return Ok(false);
        }
    }
    if let Some(installer) = &record.feed.installer {
        if fs::symlink_metadata(record.install_root.join(&installer.worker.path))?.len()
            != installer.worker.size
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn rollback_program(
    staging: &Path,
    record: &Record,
    journal: &mut Journal,
) -> Result<(), UpdateError> {
    // Validate the immutable source before recording the single restoration attempt.
    if inventory(&staging.join("program-recovery"))? != record.files {
        return Err(fail("ROLLBACK_FAILED"));
    }
    let current_version = InstallKey::open(
        &record.install_root,
        &record.mode,
        &record.original_sid,
        false,
    )?
    .read("DisplayVersion")?;
    if current_version != record.source_version && current_version != record.expected_version {
        return Err(fail("INSTALL_IDENTITY_INVALID"));
    }
    journal.begin_rollback(staging)?;
    if let Err(error) = restore_program(staging, record) {
        journal.transition(staging, Phase::Failed)?;
        return Err(error);
    }
    let marker = serde_json::json!({ "requestId": record.request_id, "expectedVersion": record.expected_version, "reason": "INSTALLER_FAILED" });
    let path = record
        .data_root
        .join("update-recovery")
        .join(format!("{}.failure.json", record.request_id));
    let bytes = serde_json::to_vec(&marker).map_err(|_| fail("IO_ERROR"))?;
    if path_present(&path)? {
        if fs::read(&path)? != bytes {
            return Err(fail("ROLLBACK_FAILED"));
        }
    } else {
        atomic_new(&path, &bytes)?;
    }
    journal.transition(staging, Phase::ProgramRestored)
}

fn parent_alive(record: &Record) -> Result<bool, UpdateError> {
    super::process::identity_alive(record.parent_pid, record.parent_creation()?)
        .map_err(|_| fail("PROCESS_STATE_UNKNOWN"))
}

fn verify_installer(
    staging: &Path,
    record: &Record,
) -> Result<crate::execution::VerifiedExecutable, UpdateError> {
    let path = staging.join("installer.exe");
    crate::execution::VerifiedExecutable::verify(
        &path,
        record.feed.asset.size,
        &record.feed.asset.sha256,
        &record.feed.asset.signature,
        &Trust::for_repository(&record.feed.repository)?,
    )
}

fn launch_installer(staging: &Path, record: &Record) -> Result<i32, UpdateError> {
    record.feed.require_supported_installer()?;
    // The earlier preflight is not execution authority. Verify again while
    // holding the file and every ancestor through the actual child exit.
    let installer = verify_installer(staging, record)?;
    installer.run_nsis(&record.mode, &record.source_version, &record.install_root)
}

fn restore_program(staging: &Path, record: &Record) -> Result<(), UpdateError> {
    wait_for_apps_exit()?;
    let recovery = staging.join("program-recovery");
    restore_files(&record.install_root, &recovery, &record.files, |_| Ok(()))?;
    write_registry_version(record, &record.source_version)?;
    let marker = staging.join("program-rolled-back");
    if path_present(&marker)? {
        if fs::read(&marker)? != record.request_id.as_bytes() {
            return Err(fail("ROLLBACK_FAILED"));
        }
    } else {
        atomic_new(&marker, record.request_id.as_bytes())?;
    }
    Ok(())
}

fn restore_files(
    root: &Path,
    recovery: &Path,
    files: &BTreeMap<String, String>,
    mut after_copy: impl FnMut(usize) -> Result<(), UpdateError>,
) -> Result<(), UpdateError> {
    require_plain_directory(root)?;
    if inventory(recovery)? != *files {
        return Err(fail("ROLLBACK_FAILED"));
    }
    let current = inventory(root)?;
    for relative in current.keys().filter(|key| !files.contains_key(*key)) {
        fs::remove_file(root.join(relative))?;
    }
    for (index, (relative, expected)) in files.iter().enumerate() {
        let destination = root.join(relative);
        fs::create_dir_all(destination.parent().ok_or_else(|| fail("UNSAFE_PATH"))?)?;
        copy_file_cancellable(
            &recovery.join(relative),
            &destination,
            expected,
            false,
            &|| false,
        )?;
        after_copy(index)?;
    }
    if inventory(root)? != *files {
        return Err(fail("ROLLBACK_FAILED"));
    }
    Ok(())
}

fn commit_program_health(
    staging: &Path,
    record: &Record,
    journal: &mut Journal,
    commit_registry: impl FnOnce() -> Result<(), UpdateError>,
) -> Result<bool, UpdateError> {
    if journal.phase == Phase::Verified {
        return Ok(true);
    }
    if journal.phase != Phase::AwaitingHealth || journal.rollback_attempted {
        return Err(fail("INVALID_REQUEST"));
    }
    let failure = record
        .data_root
        .join("update-recovery")
        .join(format!("{}.program-failure.json", record.request_id));
    if path_present(&failure)? {
        return Ok(false);
    }
    if commit_registry().is_err() {
        let proof = serde_json::json!({"requestId":record.request_id,"sourceVersion":record.source_version,"expectedVersion":record.expected_version,"reason":"REGISTRY_COMMIT_FAILED"});
        atomic_new(
            &failure,
            &serde_json::to_vec(&proof).map_err(|_| fail("IO_ERROR"))?,
        )?;
        return Ok(false);
    }
    if journal.transition(staging, Phase::Verified).is_err() {
        // Distinguish a lost write acknowledgement from a durable old phase.
        // An unreadable journal is ambiguous and never authorizes overwrite.
        let reason = match bound_journal(
            staging,
            &record.request_id,
            journal
                .record_sha256
                .as_deref()
                .ok_or_else(|| fail("CORRUPT_PROGRAM_JOURNAL"))?,
        ) {
            Ok(saved) if saved.phase == Phase::Verified => return Ok(true),
            Ok(saved) if saved.phase == Phase::AwaitingHealth => "PROGRAM_COMMIT_FAILED",
            _ => "PROGRAM_COMMIT_STATE_UNKNOWN",
        };
        let proof = serde_json::json!({"requestId":record.request_id,"sourceVersion":record.source_version,"expectedVersion":record.expected_version,"reason":reason});
        atomic_new(
            &failure,
            &serde_json::to_vec(&proof).map_err(|_| fail("IO_ERROR"))?,
        )?;
        journal.phase = Phase::AwaitingHealth;
        return Ok(false);
    }
    Ok(true)
}

fn monitor(
    staging: &Path,
    record: &Record,
    digest: &str,
    launcher: &OriginalUser,
    journal: &mut Journal,
    notice: &dyn Fn(&str),
) -> Result<(), UpdateError> {
    let mut next_notice = Instant::now() + Duration::from_secs(120);
    let mut notice_shown = false;
    loop {
        let receipt = record
            .data_root
            .join("update-recovery")
            .join(format!("{}.result.json", record.request_id));
        if let Ok(bytes) = fs::read(&receipt) {
            if let Ok(result) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if result["requestId"] == record.request_id
                    && result["expectedVersion"] == record.expected_version
                {
                    if result["phase"] == "awaitingCommit" || result["phase"] == "verified" {
                        // Only the coordinator's validated data + real renderer receipt commits.
                        if !journal.rollback_attempted
                            && result["sourceVersion"] == record.source_version
                            && result["dataDigest"].as_str().is_some_and(|s| s.len() == 64)
                            && result["presetId"].is_string()
                            && result["skinHashes"].is_array()
                            && result["rendered"] == true
                            && result["windowDigest"]
                                .as_str()
                                .is_some_and(|value| value.len() == 64)
                            && result["windowGeometry"].is_object()
                        {
                            if !commit_program_health(staging, record, journal, || {
                                commit_registry_version(record)
                            })? {
                                // The native coordinator observes the request-bound failure
                                // and exits before the helper restores program and data.
                            }
                            if journal.phase == Phase::Verified {
                                verified_postprocess(staging, journal, || {
                                    crate::data_recovery::complete_program_commit(
                                        &record.data_root,
                                        &record.request_id,
                                        &record.source_version,
                                        &record.expected_version,
                                    )
                                    .map_err(|_| fail("RECOVERY_REQUIRED"))?;
                                    clear_reentry(staging, record, digest)?;
                                    crate::data_recovery::cleanup_resolved_backup(
                                        &record.data_root,
                                        &record.request_id,
                                        &record.source_version,
                                        &record.expected_version,
                                    )
                                    .map_err(|_| fail("CLEANUP_PENDING"))?;
                                    cleanup_terminal_payloads(staging, record)
                                });
                                return Ok(());
                            }
                        }
                    }
                    if result["phase"] == "rolledBack"
                        && result["rendered"] == true
                        && result["sourceVersion"] == record.source_version
                    {
                        if !path_present(&staging.join("program-rolled-back"))? {
                            return Err(fail("ROLLBACK_FAILED"));
                        }
                        journal.transition(staging, Phase::RolledBack)?;
                        verified_postprocess(staging, journal, || {
                            crate::data_recovery::cleanup_resolved_backup(
                                &record.data_root,
                                &record.request_id,
                                &record.source_version,
                                &record.expected_version,
                            )
                            .map_err(|_| fail("CLEANUP_PENDING"))?;
                            clear_reentry(staging, record, digest)?;
                            cleanup_terminal_payloads(staging, record)
                        });
                        return Ok(());
                    }
                }
            }
        }
        let active = record.data_root.join("update-recovery/active.json");
        if let Ok(bytes) = fs::read(active) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if value["requestId"] == record.request_id
                    && value["expectedVersion"] == record.expected_version
                    && value["phase"] == "rollbackPending"
                    && value["rollbackAttempted"] == false
                    && !path_present(&staging.join("program-rolled-back"))?
                {
                    let deadline = Instant::now() + Duration::from_secs(60);
                    while require_no_process_except(None).is_err() {
                        if Instant::now() >= deadline {
                            return Err(fail("ROLLBACK_WAITING_FOR_EXIT"));
                        }
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    rollback_program(staging, record, journal)?;
                    launcher.launch(record, true)?;
                    next_notice = Instant::now() + Duration::from_secs(120);
                    notice_shown = false;
                }
            }
        }
        if !notice_shown && Instant::now() >= next_notice {
            // Delay is ambiguous, never a signal to overwrite or report success.
            let _ = launcher.launch(record, true);
            if require_no_process_except(None).is_ok() {
                notice("HEALTH_CHECK_PENDING");
            }
            notice_shown = true;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn wait_for_apps_exit() -> Result<(), UpdateError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match require_no_process_except(None) {
            Ok(()) => return Ok(()),
            Err(error) if error.code == "OTHER_ACCOUNT_RUNNING" && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(200))
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(windows)]
struct HelperOwner(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl HelperOwner {
    fn acquire(id: &str) -> Result<Self, UpdateError> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError},
            System::Threading::CreateMutexW,
        };
        let name: Vec<_> = format!("Global\\DMeloperBlockPetRecovery-{id}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            let handle = CreateMutexW(std::ptr::null(), 1, name.as_ptr());
            if handle.is_null() {
                return Err(fail("HELPER_OWNERSHIP_UNKNOWN"));
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                CloseHandle(handle);
                return Err(fail("HELPER_ALREADY_RUNNING"));
            }
            Ok(Self(handle))
        }
    }
}
#[cfg(windows)]
impl Drop for HelperOwner {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Threading::ReleaseMutex(self.0);
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn cleanup_terminal_payloads(staging: &Path, record: &Record) -> Result<(), UpdateError> {
    let snapshot = staging.join("program-recovery");
    if path_present(&snapshot)? && inventory(&snapshot)? != record.files {
        return Err(fail("INTEGRITY_FAILED"));
    }
    let installer = staging.join("installer.exe");
    if path_present(&installer)? && hash(&installer)? != record.feed.asset.sha256 {
        return Err(fail("INTEGRITY_FAILED"));
    }
    cleanup_verified(staging)
}

fn cleanup_verified(staging: &Path) -> Result<(), UpdateError> {
    require_plain_directory(staging)?;
    let recovery = staging.join("program-recovery");
    if recovery.is_dir() {
        require_plain_directory(&recovery)?;
        fs::remove_dir_all(recovery)?;
    }
    fs::remove_file(staging.join("installer.exe"))?;
    Ok(())
}

fn verified_postprocess(
    staging: &Path,
    journal: &mut Journal,
    work: impl FnOnce() -> Result<(), UpdateError>,
) {
    if let Err(error) = work() {
        journal.cleanup_warning = Some(error.code.clone());
        let _ = journal.save(staging);
        log::warn!("Verified update cleanup is pending: {}", error.code);
    }
}

pub fn cleanup_verified_operations(root: &Path, data_root: &Path) -> bool {
    let Ok(sid) = reentry::current_sid() else {
        return false;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return false;
    };
    let mut pending = false;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.len() != 32 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        if let Err(error) = cleanup_verified_directory(&root, &entry.path(), &data_root, &sid) {
            pending = true;
            if error.code != "HELPER_ALREADY_RUNNING" {
                log::warn!("Verified update cleanup is pending: {}", error.code);
            }
        }
    }
    pending
}

fn cleanup_verified_directory(
    root: &Path,
    staging: &Path,
    data_root: &Path,
    sid: &str,
) -> Result<bool, UpdateError> {
    require_plain_directory(root)?;
    require_plain_directory(staging)?;
    if !root.is_absolute() || staging.parent() != Some(root) || staging == root {
        return Err(fail("UNSAFE_PATH"));
    }
    let record_path = staging.join("operation.json");
    if !path_present(&record_path)? {
        return Ok(false);
    }
    let digest = hash(&record_path)?;
    let record: Record =
        serde_json::from_slice(&fs::read(&record_path)?).map_err(|_| fail("INVALID_REQUEST"))?;
    let mut journal = bound_journal(staging, &record.request_id, &digest)?;
    if journal.phase == Phase::Prepared && path_present(&staging.join("cancel"))? {
        if record.original_sid != sid || record.data_root != data_root {
            return Err(fail("INVALID_REQUEST"));
        }
        let receipt: serde_json::Value = serde_json::from_slice(&fs::read(
            data_root
                .join("update-recovery")
                .join(format!("{}.result.json", record.request_id)),
        )?)
        .map_err(|_| fail("INVALID_REQUEST"))?;
        if receipt["requestId"] != record.request_id
            || receipt["sourceVersion"] != record.source_version
            || receipt["expectedVersion"] != record.expected_version
            || receipt["phase"] != "rolledBack"
            || receipt["rollbackAttempted"] != false
            || receipt["error"] != "CANCELLED_BEFORE_INSTALL"
        {
            return Err(fail("INVALID_REQUEST"));
        }
        // Preparation can fail after the record is durable but before the helper
        // launches. Finish its proven cancellation under the same owner mutex.
        let _owner = HelperOwner::acquire(&record.request_id)?;
        mark_not_committed(staging, &record, &mut journal)?;
    }
    if !matches!(
        journal.phase,
        Phase::Verified | Phase::RolledBack | Phase::Cancelled
    ) {
        return Ok(false);
    }
    if record.original_sid != sid || record.data_root != data_root {
        return Err(fail("INVALID_REQUEST"));
    }
    let mut receipt: serde_json::Value = serde_json::from_slice(&fs::read(
        data_root
            .join("update-recovery")
            .join(format!("{}.result.json", record.request_id)),
    )?)
    .map_err(|_| fail("INVALID_REQUEST"))?;
    if journal.phase == Phase::Verified && receipt["phase"] == "awaitingCommit" {
        crate::data_recovery::complete_program_commit(
            data_root,
            &record.request_id,
            &record.source_version,
            &record.expected_version,
        )
        .map_err(|_| fail("RECOVERY_REQUIRED"))?;
        receipt = serde_json::from_slice(&fs::read(
            data_root
                .join("update-recovery")
                .join(format!("{}.result.json", record.request_id)),
        )?)
        .map_err(|_| fail("INVALID_REQUEST"))?;
    }
    let terminal_receipt = match journal.phase {
        Phase::Verified => {
            !journal.rollback_attempted
                && receipt["phase"] == "verified"
                && receipt["rendered"] == true
        }
        Phase::RolledBack => {
            journal.rollback_attempted
                && receipt["phase"] == "rolledBack"
                && receipt["rollbackAttempted"] == true
                && receipt["rendered"] == true
        }
        Phase::Cancelled => {
            !journal.rollback_attempted
                && receipt["phase"] == "rolledBack"
                && receipt["rollbackAttempted"] == false
                && receipt["error"] == "CANCELLED_BEFORE_INSTALL"
        }
        _ => false,
    };
    if receipt["requestId"] != record.request_id
        || receipt["expectedVersion"] != record.expected_version
        || receipt["sourceVersion"] != record.source_version
        || !terminal_receipt
    {
        return Err(fail("INVALID_REQUEST"));
    }
    if journal.phase != Phase::Verified && inventory(&record.install_root)? != record.files {
        return Err(fail("INTEGRITY_FAILED"));
    }
    // A live helper owns this mutex, even after writing its successful receipt.
    // Failure to acquire is observation only; it never permits termination.
    let _owner = HelperOwner::acquire(&record.request_id)?;
    let remove = || -> Result<(), UpdateError> {
        match fs::read(locator_path(&record)) {
            Ok(bytes) => {
                let locator: Locator =
                    serde_json::from_slice(&bytes).map_err(|_| fail("INVALID_REQUEST"))?;
                if locator.request_id == record.request_id {
                    clear_reentry(staging, &record, &digest)?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(fail("CLEANUP_PENDING")),
        }
        crate::data_recovery::cleanup_resolved_backup(
            data_root,
            &record.request_id,
            &record.source_version,
            &record.expected_version,
        )
        .map_err(|_| fail("CLEANUP_PENDING"))?;
        for entry in fs::read_dir(staging)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| fail("UNSAFE_PATH"))?;
            let known = matches!(
                name.as_str(),
                "operation.json"
                    | "program-journal.json"
                    | "program-journal.part"
                    | "program-recovery"
                    | "installer.exe"
                    | "update-helper.exe"
                    | "commit"
                    | "ready"
                    | "cancel"
                    | "helper-failed"
                    | "program-rolled-back"
            ) || name.strip_prefix("resume-ready-").is_some_and(|suffix| {
                suffix.split_once('-').is_some_and(|(pid, time)| {
                    pid.parse::<u32>().is_ok() && time.parse::<u64>().is_ok()
                })
            }) || name
                .split_once(".pending-")
                .is_some_and(|(prefix, suffix)| {
                    matches!(
                        prefix,
                        "operation" | "ready" | "commit" | "cancel" | "helper-failed"
                    ) && suffix.len() == 32
                        && suffix.bytes().all(|b| b.is_ascii_hexdigit())
                });
            if !known {
                return Err(fail("CLEANUP_UNKNOWN_FILE"));
            }
            if is_reparse(&fs::symlink_metadata(entry.path())?) {
                return Err(fail("UNSAFE_PATH"));
            }
        }
        let helper = staging.join("update-helper.exe");
        if path_present(&helper)? {
            record.verify_staged_worker(&helper)?;
            // Delete the executable first, so a Windows sharing violation cannot
            // erase the journal needed to retry after that process exits.
            fs::remove_file(helper)?;
        }
        let recovery = staging.join("program-recovery");
        if path_present(&recovery)? {
            require_plain_directory(&recovery)?;
            if inventory(&recovery)? != record.files {
                return Err(fail("INTEGRITY_FAILED"));
            }
            fs::remove_dir_all(recovery)?;
        }
        for entry in fs::read_dir(staging)? {
            let entry = entry?;
            if entry.file_name() != "operation.json" && entry.file_name() != "program-journal.json"
            {
                fs::remove_file(entry.path())?;
            }
        }
        fs::remove_file(&record_path)?;
        fs::remove_file(staging.join("program-journal.json"))?;
        fs::remove_dir(staging)?;
        Ok(())
    };
    if let Err(error) = remove() {
        journal.cleanup_warning = Some(error.code.clone());
        let _ = journal.save(staging);
        return Err(error);
    }
    Ok(true)
}

#[cfg(windows)]
struct OriginalUser {
    token: Option<windows_sys::Win32::Foundation::HANDLE>,
}

#[cfg(windows)]
impl Drop for OriginalUser {
    fn drop(&mut self) {
        if let Some(token) = self.token {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(token);
            }
        }
    }
}

#[cfg(windows)]
impl OriginalUser {
    fn capture(
        record: &Record,
        resume_parent: Option<(u32, u64)>,
        resuming: bool,
    ) -> Result<Self, UpdateError> {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            Security::{
                DuplicateTokenEx, SecurityImpersonation, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
                TOKEN_QUERY, TokenPrimary,
            },
            System::Threading::OpenProcessToken,
        };
        if record.mode == "CurrentUser" {
            if reentry::current_sid()? != record.original_sid {
                return Err(fail("ORIGINAL_USER_UNAVAILABLE"));
            }
            return Ok(Self { token: None });
        }
        let (pid, created) = if resuming {
            let (pid, value) = resume_parent.ok_or_else(|| fail("ORIGINAL_USER_UNAVAILABLE"))?;
            (pid, record.resume_creation(value)?)
        } else {
            (record.parent_pid, record.parent_creation()?)
        };
        let process = super::process::ProcessHandle::open(pid)
            .map_err(|_| fail("PROCESS_STATE_UNKNOWN"))?
            .ok_or_else(|| fail("PARENT_NOT_FOUND"))?;
        if !process
            .is_alive()
            .map_err(|_| fail("PROCESS_STATE_UNKNOWN"))?
            || !process
                .matches_creation(created)
                .map_err(|_| fail("PROCESS_STATE_UNKNOWN"))?
        {
            return Err(fail("PARENT_NOT_FOUND"));
        }
        let expected_parent = if resuming {
            std::env::current_exe()?
        } else {
            record.install_root.join(APP_EXE)
        };
        let actual_parent = process
            .executable()
            .map_err(|_| fail("PROCESS_STATE_UNKNOWN"))?;
        if fs::canonicalize(actual_parent).map_err(|_| fail("PROCESS_STATE_UNKNOWN"))?
            != fs::canonicalize(expected_parent).map_err(|_| fail("PROCESS_STATE_UNKNOWN"))?
        {
            return Err(fail("PARENT_NOT_FOUND"));
        }
        unsafe {
            let mut source = std::ptr::null_mut();
            // Creation time and the token are read through the same process
            // handle, so a reused PID cannot substitute another process here.
            let opened =
                OpenProcessToken(process.raw(), TOKEN_DUPLICATE | TOKEN_QUERY, &mut source);
            if opened == 0 {
                return Err(fail("ORIGINAL_USER_UNAVAILABLE"));
            }
            if !matches!(reentry::token_sid(source), Ok(sid) if sid == record.original_sid) {
                CloseHandle(source);
                return Err(fail("ORIGINAL_USER_UNAVAILABLE"));
            }
            let mut token = std::ptr::null_mut();
            let duplicated = DuplicateTokenEx(
                source,
                TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY,
                std::ptr::null(),
                SecurityImpersonation,
                TokenPrimary,
                &mut token,
            );
            CloseHandle(source);
            if duplicated == 0 {
                return Err(fail("ORIGINAL_USER_UNAVAILABLE"));
            }
            Ok(Self { token: Some(token) })
        }
    }

    fn launch(&self, record: &Record, recovery: bool) -> Result<(), UpdateError> {
        use std::os::windows::{ffi::OsStrExt, process::CommandExt};
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::{
                Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock},
                Threading::{
                    CREATE_UNICODE_ENVIRONMENT, CreateProcessWithTokenW, LOGON_WITH_PROFILE,
                    PROCESS_INFORMATION, STARTUPINFOW,
                },
            },
        };
        let exe = record.install_root.join(APP_EXE);
        let argument = if recovery {
            "--update-recovery"
        } else {
            "--update-request-id"
        };
        let Some(token) = self.token else {
            Command::new(exe)
                .args([argument, &record.request_id])
                .current_dir(&record.install_root)
                .creation_flags(0x08000000)
                .spawn()?;
            return Ok(());
        };
        let wide = |value: &std::ffi::OsStr| value.encode_wide().chain(Some(0)).collect::<Vec<_>>();
        let application = wide(exe.as_os_str());
        let mut command = wide(std::ffi::OsStr::new(&format!(
            "{} {argument} {}",
            quote(exe.as_os_str()),
            record.request_id
        )));
        let directory = wide(record.install_root.as_os_str());
        unsafe {
            let mut environment = std::ptr::null_mut();
            if CreateEnvironmentBlock(&mut environment, token, 0) == 0 {
                return Err(fail("ORIGINAL_USER_UNAVAILABLE"));
            }
            let mut startup: STARTUPINFOW = std::mem::zeroed();
            startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            let mut process: PROCESS_INFORMATION = std::mem::zeroed();
            let result = CreateProcessWithTokenW(
                token,
                LOGON_WITH_PROFILE,
                application.as_ptr(),
                command.as_mut_ptr(),
                CREATE_UNICODE_ENVIRONMENT,
                environment,
                directory.as_ptr(),
                &startup,
                &mut process,
            );
            DestroyEnvironmentBlock(environment);
            if result == 0 {
                return Err(fail("RESTART_FAILED"));
            }
            CloseHandle(process.hProcess);
            CloseHandle(process.hThread);
        }
        Ok(())
    }
}

#[cfg(windows)]
struct InstallKey(windows_sys::Win32::System::Registry::HKEY);
#[cfg(windows)]
impl Drop for InstallKey {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Registry::RegCloseKey(self.0);
        }
    }
}
#[cfg(windows)]
impl InstallKey {
    fn open(root: &Path, mode: &str, sid: &str, write: bool) -> Result<Self, UpdateError> {
        use windows_sys::Win32::System::Registry::*;
        if !matches!(mode, "CurrentUser" | "AllUsers")
            || !sid.starts_with("S-1-")
            || !sid
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'S' || b == b'-')
        {
            return Err(fail("INSTALL_IDENTITY_INVALID"));
        }
        let suffix =
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DMeloper's 3D Block Pet";
        let path = if mode == "AllUsers" {
            suffix.to_owned()
        } else {
            format!("{sid}\\{suffix}")
        };
        let path: Vec<_> = path.encode_utf16().chain(Some(0)).collect();
        let mut key = std::ptr::null_mut();
        unsafe {
            if RegOpenKeyExW(
                if mode == "AllUsers" {
                    HKEY_LOCAL_MACHINE
                } else {
                    HKEY_USERS
                },
                path.as_ptr(),
                0,
                KEY_QUERY_VALUE | KEY_WOW64_64KEY | if write { KEY_SET_VALUE } else { 0 },
                &mut key,
            ) != 0
            {
                return Err(fail("INSTALL_IDENTITY_INVALID"));
            }
        }
        let key = Self(key);
        if key.read("InstallLocation")? != quote(root.as_os_str())
            || key.read("MainBinaryName")? != APP_EXE
            || key.read("DisplayName")? != "DMeloper's 3D Block Pet"
            || key.read(mode)? != "1"
            || fs::read_to_string(root.join("block-pet-install-mode.txt"))? != mode
        {
            return Err(fail("INSTALL_IDENTITY_INVALID"));
        }
        Ok(key)
    }
    fn read(&self, name: &str) -> Result<String, UpdateError> {
        use windows_sys::Win32::System::Registry::{RRF_RT_REG_SZ, RegGetValueW};
        let name: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
        let mut buffer = vec![0u16; 32768];
        let mut size = (buffer.len() * 2) as u32;
        if unsafe {
            RegGetValueW(
                self.0,
                std::ptr::null(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        } != 0
        {
            return Err(fail("INSTALL_IDENTITY_INVALID"));
        }
        Ok(String::from_utf16_lossy(
            &buffer[..buffer
                .iter()
                .position(|v| *v == 0)
                .ok_or_else(|| fail("INSTALL_IDENTITY_INVALID"))?],
        ))
    }
}

#[cfg(windows)]
fn validate_registry_identity(
    root: &Path,
    mode: &str,
    sid: &str,
    expected: &str,
    _: bool,
) -> Result<(), UpdateError> {
    if InstallKey::open(root, mode, sid, false)?.read("DisplayVersion")? != expected {
        return Err(fail("INSTALL_IDENTITY_INVALID"));
    }
    Ok(())
}

#[cfg(windows)]
fn commit_registry_version(record: &Record) -> Result<(), UpdateError> {
    write_registry_version(record, &record.expected_version)
}

#[cfg(windows)]
fn write_registry_version(record: &Record, version: &str) -> Result<(), UpdateError> {
    use windows_sys::Win32::System::Registry::{REG_SZ, RegFlushKey, RegSetValueExW};
    let key = InstallKey::open(
        &record.install_root,
        &record.mode,
        &record.original_sid,
        true,
    )?;
    let current = key.read("DisplayVersion")?;
    if current != record.source_version && current != record.expected_version {
        return Err(fail("INSTALL_IDENTITY_INVALID"));
    }
    let name: Vec<_> = "DisplayVersion".encode_utf16().chain(Some(0)).collect();
    let value: Vec<_> = version.encode_utf16().chain(Some(0)).collect();
    unsafe {
        if RegSetValueExW(
            key.0,
            name.as_ptr(),
            0,
            REG_SZ,
            value.as_ptr().cast(),
            (value.len() * 2) as u32,
        ) != 0
            || RegFlushKey(key.0) != 0
        {
            return Err(fail("REGISTRY_COMMIT_FAILED"));
        }
    }
    if key.read("DisplayVersion")? != version {
        return Err(fail("REGISTRY_COMMIT_FAILED"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_dispatch_accepts_worker_modes_and_bounds_incomplete_requests() {
        use std::cell::RefCell;
        for flag in [
            "--update-helper",
            "--resume-update-helper",
            "--resume-elevated-helper",
        ] {
            let notices = RefCell::new(Vec::new());
            let arguments = vec![std::ffi::OsString::from("update-helper.exe"), flag.into()];
            assert_eq!(
                run_from_arguments(&arguments, &|reason| notices
                    .borrow_mut()
                    .push(reason.to_owned())),
                Some(1)
            );
            assert_eq!(&*notices.borrow(), &["INVALID_REQUEST"]);
        }
        assert_eq!(
            run_from_arguments(
                &["update-helper.exe".into(), "--update-request".into()],
                &|_| panic!("notice")
            ),
            None
        );
    }

    fn binding_fixture(root: &Path) -> Record {
        let install_root = root.join("설치 O'Brien 😶");
        fs::create_dir(&install_root).unwrap();
        fs::write(install_root.join(APP_EXE), b"application bytes").unwrap();
        fs::write(install_root.join(WORKER_EXE), b"dedicated worker bytes").unwrap();
        let worker = WorkerIdentity {
            schema_version: 1,
            path: WORKER_EXE.into(),
            sha256: hash(&install_root.join(WORKER_EXE)).unwrap(),
            size: fs::metadata(install_root.join(WORKER_EXE)).unwrap().len(),
        };
        Record {
            schema_version: 2,
            worker: Some(worker),
            request_id: "a".repeat(32),
            expected_version: "1.2.3".into(),
            source_version: "1.0.0".into(),
            files: inventory(&install_root).unwrap(),
            install_root,
            data_root: root.join("data"),
            mode: "CurrentUser".into(),
            parent_pid: 1,
            parent_started: 1_700_000_001,
            parent_created_100ns: Some((1_700_000_001 + 11_644_473_600) * 10_000_000 + 100),
            original_sid: "S-1-5-21-123".into(),
            signed_feed: String::new(),
            signed_feed_signature: String::new(),
            feed: super::super::tests::sample(),
        }
    }

    #[test]
    fn v2_worker_binding_rejects_main_self_copy_missing_changed_and_unbound_workers() {
        let temp = tempfile::tempdir().unwrap();
        let mut record = binding_fixture(temp.path());
        let worker = record.install_root.join(WORKER_EXE);
        record.validate_worker().unwrap();
        record.verify_staged_worker(&worker).unwrap();
        assert!(
            record
                .verify_staged_worker(&record.install_root.join(APP_EXE))
                .is_err()
        );
        let original = fs::read(&worker).unwrap();
        fs::write(&worker, vec![b'x'; original.len()]).unwrap();
        assert_eq!(
            record.verify_staged_worker(&worker).unwrap_err().code,
            "WORKER_INTEGRITY_FAILED"
        );
        fs::remove_file(&worker).unwrap();
        assert_eq!(
            record.verify_staged_worker(&worker).unwrap_err().code,
            "PACKAGED_WORKER_REQUIRED"
        );
        fs::write(&worker, &original).unwrap();
        record.worker.as_mut().unwrap().size += 1;
        assert!(record.verify_staged_worker(&worker).is_err());
        record.worker.as_mut().unwrap().size -= 1;
        record.files.insert(WORKER_EXE.into(), "f".repeat(64));
        assert_eq!(
            record.validate_worker().unwrap_err().code,
            "WORKER_IDENTITY_INVALID"
        );
        record.worker = None;
        assert!(record.validate_worker().is_err());
        assert!(serde_json::from_str::<WorkerIdentity>("null").is_err());
    }

    #[test]
    fn legacy_operation_is_read_without_rewriting_and_v2_requires_a_matching_journal() {
        let temp = tempfile::tempdir().unwrap();
        let mut record = binding_fixture(temp.path());
        let staging = temp.path().join("operation");
        fs::create_dir(&staging).unwrap();
        record.schema_version = 1;
        record.worker = None;
        let precise_creation = record.parent_created_100ns.take();
        let bytes = serde_json::to_vec(&record).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(json.get("schemaVersion").is_none());
        assert!(json.get("worker").is_none());
        assert!(json.get("parentCreated100ns").is_none());
        fs::write(staging.join("operation.json"), &bytes).unwrap();
        let digest = hash(&staging.join("operation.json")).unwrap();
        let mut journal = Journal::new(&record.request_id);
        journal.record_sha256 = Some(digest.clone());
        journal.save(&staging).unwrap();
        let journal_bytes = fs::read(staging.join("program-journal.json")).unwrap();
        bound_journal(&staging, &record.request_id, &digest).unwrap();
        record
            .verify_staged_worker(&record.install_root.join(APP_EXE))
            .unwrap();
        assert!(
            record
                .verify_staged_worker(&record.install_root.join(WORKER_EXE))
                .is_err()
        );
        assert_eq!(fs::read(staging.join("operation.json")).unwrap(), bytes);
        assert_eq!(
            fs::read(staging.join("program-journal.json")).unwrap(),
            journal_bytes
        );

        record.schema_version = 2;
        record.parent_created_100ns = precise_creation;
        let worker = record.install_root.join(WORKER_EXE);
        record.worker = Some(WorkerIdentity {
            schema_version: 1,
            path: WORKER_EXE.into(),
            sha256: hash(&worker).unwrap(),
            size: fs::metadata(&worker).unwrap().len(),
        });
        fs::write(
            staging.join("operation.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        let digest = hash(&staging.join("operation.json")).unwrap();
        journal.record_sha256 = Some(digest.clone());
        journal.save(&staging).unwrap();
        assert_eq!(
            bound_journal(&staging, &record.request_id, &digest)
                .unwrap_err()
                .code,
            "CORRUPT_PROGRAM_JOURNAL"
        );
        journal.schema_version = 2;
        journal.save(&staging).unwrap();
        bound_journal(&staging, &record.request_id, &digest).unwrap();
        fs::write(staging.join("operation.json"), b"changed record").unwrap();
        assert!(bound_journal(&staging, &record.request_id, &digest).is_err());
    }

    #[test]
    fn rollback_restores_the_original_worker_as_part_of_the_exact_program_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let record = binding_fixture(temp.path());
        let snapshot = temp.path().join("snapshot");
        copy_snapshot(&record.install_root, &snapshot, &record.files).unwrap();
        fs::write(record.install_root.join(APP_EXE), b"new app").unwrap();
        fs::write(record.install_root.join(WORKER_EXE), b"new worker").unwrap();
        restore_files(&record.install_root, &snapshot, &record.files, |_| Ok(())).unwrap();
        assert_eq!(inventory(&record.install_root).unwrap(), record.files);
        record
            .verify_staged_worker(&record.install_root.join(WORKER_EXE))
            .unwrap();
    }

    #[test]
    fn v1_bridge_signature_covers_new_worker_bytes_and_v2_checks_its_size() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let temp = tempfile::tempdir().unwrap();
        let mut record = binding_fixture(temp.path());
        let fixture = crate::tests::protocol_fixture();
        for (path, contents) in fixture["files"].as_object().unwrap() {
            let path = record.install_root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents.as_str().unwrap()).unwrap();
        }
        record.files = inventory(&record.install_root).unwrap();
        let worker_path = record.install_root.join(WORKER_EXE);
        record.worker = Some(WorkerIdentity {
            schema_version: 1,
            path: WORKER_EXE.into(),
            sha256: hash(&worker_path).unwrap(),
            size: fs::metadata(&worker_path).unwrap().len(),
        });
        let (feed, trust) = crate::tests::protocol_case("legacy_bridge");
        let installer = temp.path().join("installer.exe");
        let mut bytes = STANDARD
            .decode(fixture["installerBase64"].as_str().unwrap())
            .unwrap();
        fs::write(&installer, &bytes).unwrap();
        trust
            .verify_file(&installer, &feed.asset.signature)
            .unwrap();
        assert_eq!(hash(&installer).unwrap(), feed.asset.sha256);
        assert_eq!(bytes.len() as u64, feed.asset.size);
        assert_eq!(feed.asset.installed_files.len(), 4);
        record.feed = feed;
        record.validate_worker().unwrap();
        assert_eq!(record.schema_version, 2);
        assert!(target_matches(&record).unwrap());
        let needle = fixture["files"][WORKER_EXE].as_str().unwrap().as_bytes();
        let offset = bytes
            .windows(needle.len())
            .position(|value| value == needle)
            .unwrap();
        bytes[offset] ^= 1;
        fs::write(&installer, bytes).unwrap();
        assert!(
            trust
                .verify_file(&installer, &record.feed.asset.signature)
                .is_err()
        );

        record.feed = crate::tests::protocol_case("nsis_v2").0;
        assert!(target_matches(&record).unwrap());
        record.feed.installer.as_mut().unwrap().worker.size += 1;
        assert!(!target_matches(&record).unwrap());
    }

    #[test]
    fn signed_burn_metadata_is_rejected_before_preparation_touches_any_files() {
        let temp = tempfile::tempdir().unwrap();
        let record = binding_fixture(temp.path());
        let feed = crate::tests::protocol_case("burn_v2_gated").0;
        let before = inventory(temp.path()).unwrap();
        let result = prepare(
            &record.data_root,
            &record.source_version,
            record.worker.as_ref().unwrap(),
            &temp.path().join("new-operation"),
            &record.request_id,
            &feed,
            || false,
        );
        assert_eq!(result.unwrap_err().code, "INSTALLER_FORMAT_UNSUPPORTED");
        assert_eq!(inventory(temp.path()).unwrap(), before);
        assert!(!record.data_root.exists());
        assert!(!temp.path().join("new-operation").exists());
    }

    #[test]
    fn original_user_capture_binds_time_path_and_sid_to_the_same_process() {
        let temp = tempfile::tempdir().unwrap();
        let started = super::super::process::current_started_seconds().unwrap();
        let mut record = Record {
            schema_version: 1,
            worker: None,
            request_id: "a".repeat(32),
            expected_version: "1.0.0".into(),
            source_version: "0.9.0".into(),
            install_root: temp.path().join("installed"),
            data_root: temp.path().join("data"),
            mode: "AllUsers".into(),
            parent_pid: std::process::id(),
            parent_started: started,
            parent_created_100ns: None,
            original_sid: reentry::current_sid().unwrap(),
            signed_feed: String::new(),
            signed_feed_signature: String::new(),
            feed: super::super::tests::sample(),
            files: BTreeMap::new(),
        };
        // Reentry's original-user parent and elevated child execute the same
        // worker path. This exercises token duplication without elevating or
        // launching an application.
        let owner =
            OriginalUser::capture(&record, Some((std::process::id(), started)), true).unwrap();
        assert!(owner.token.is_some());
        assert!(
            OriginalUser::capture(&record, Some((std::process::id(), started - 1)), true).is_err()
        );
        record.original_sid = "S-1-5-21-0".into();
        assert!(OriginalUser::capture(&record, Some((std::process::id(), started)), true).is_err());
        record.original_sid = reentry::current_sid().unwrap();
        record.schema_version = 2;
        let ticks = super::super::process::current_created_100ns().unwrap();
        record.parent_created_100ns = Some(ticks);
        let precise_owner =
            OriginalUser::capture(&record, Some((std::process::id(), ticks)), true).unwrap();
        assert!(precise_owner.token.is_some());
        assert!(
            OriginalUser::capture(&record, Some((std::process::id(), ticks + 1)), true).is_err()
        );
        assert!(OriginalUser::capture(&record, Some((std::process::id(), started)), true).is_err());
    }

    #[test]
    fn v2_parent_identity_requires_precise_time_without_a_legacy_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let mut record = binding_fixture(temp.path());
        record.parent_pid = std::process::id();
        let ticks = super::super::process::current_created_100ns().unwrap();
        record.parent_created_100ns = Some(ticks);
        record.parent_started = super::super::process::unix_seconds(ticks).unwrap();
        record.validate_worker().unwrap();
        assert!(parent_alive(&record).unwrap());
        let other = ticks / 10_000_000 * 10_000_000 + (ticks % 10_000_000 + 1) % 10_000_000;
        record.parent_created_100ns = Some(other);
        assert_eq!(
            super::super::process::unix_seconds(other).unwrap(),
            record.parent_started
        );
        assert!(!parent_alive(&record).unwrap());
        record.parent_created_100ns = None;
        assert_eq!(
            record.validate_worker().unwrap_err().code,
            "PROCESS_IDENTITY_INVALID"
        );
        assert!(parent_alive(&record).is_err());
        record.parent_created_100ns = Some(ticks);
        record.parent_started += 1;
        assert!(record.validate_worker().is_err());
    }

    #[test]
    fn registry_commit_failure_keeps_program_uncommitted_and_requests_automatic_rollback() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join("staging");
        let data = temp.path().join("data");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(data.join("update-recovery")).unwrap();
        let id = "a".repeat(32);
        let record = Record {
            schema_version: 1,
            worker: None,
            request_id: id.clone(),
            expected_version: "1.0.0".into(),
            source_version: "0.9.0".into(),
            install_root: temp.path().join("installed"),
            data_root: data.clone(),
            mode: "CurrentUser".into(),
            parent_pid: 0,
            parent_started: 0,
            parent_created_100ns: None,
            original_sid: "S-1-5-21-123".into(),
            signed_feed: String::new(),
            signed_feed_signature: String::new(),
            feed: super::super::tests::sample(),
            files: BTreeMap::new(),
        };
        let mut journal = Journal::new(&id);
        journal.record_sha256 = Some("0".repeat(64));
        journal.transition(&staging, Phase::AwaitingHealth).unwrap();
        let backup = data.join("update-recovery").join(&id).join("backup");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("original"), b"original user settings").unwrap();
        assert!(
            !commit_program_health(&staging, &record, &mut journal, || Err(fail(
                "REGISTRY_COMMIT_FAILED"
            )))
            .unwrap()
        );
        assert_eq!(
            Journal::read(&staging, &id).unwrap().phase,
            Phase::AwaitingHealth
        );
        let proof: serde_json::Value = serde_json::from_slice(
            &fs::read(
                data.join("update-recovery")
                    .join(format!("{id}.program-failure.json")),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            proof,
            serde_json::json!({"requestId":id,"sourceVersion":"0.9.0","expectedVersion":"1.0.0","reason":"REGISTRY_COMMIT_FAILED"})
        );
        assert_eq!(
            fs::read(backup.join("original")).unwrap(),
            b"original user settings"
        );
        assert!(
            !commit_program_health(&staging, &record, &mut journal, || panic!(
                "a recorded failure is never retried as a commit"
            ))
            .unwrap()
        );
    }

    #[test]
    fn registry_readback_precedes_durable_program_verification_and_snapshot_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join("staging");
        let data = temp.path().join("data");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(data.join("update-recovery")).unwrap();
        let id = "b".repeat(32);
        let record = Record {
            schema_version: 1,
            worker: None,
            request_id: id.clone(),
            expected_version: "1.0.0".into(),
            source_version: "0.9.0".into(),
            install_root: temp.path().join("installed"),
            data_root: data.clone(),
            mode: "CurrentUser".into(),
            parent_pid: 0,
            parent_started: 0,
            parent_created_100ns: None,
            original_sid: "S-1-5-21-123".into(),
            signed_feed: String::new(),
            signed_feed_signature: String::new(),
            feed: super::super::tests::sample(),
            files: BTreeMap::new(),
        };
        let mut journal = Journal::new(&id);
        journal.record_sha256 = Some("0".repeat(64));
        journal.transition(&staging, Phase::AwaitingHealth).unwrap();
        let retained = data.join("update-recovery").join(&id).join("backup");
        fs::create_dir_all(&retained).unwrap();
        assert!(
            commit_program_health(&staging, &record, &mut journal, || {
                assert_eq!(
                    Journal::read(&staging, &id).unwrap().phase,
                    Phase::AwaitingHealth
                );
                assert!(retained.exists());
                Ok(())
            })
            .unwrap()
        );
        assert_eq!(Journal::read(&staging, &id).unwrap().phase, Phase::Verified);
        assert!(
            retained.exists(),
            "program commit never deletes a snapshot before native receipt finalization"
        );
        assert!(
            commit_program_health(&staging, &record, &mut journal, || panic!(
                "verified registry commit is not repeated"
            ))
            .unwrap()
        );
    }
    #[test]
    fn boot_locator_only_accepts_actual_not_found_and_blocks_windows_read_denial() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("program-recovery.json");
        assert!(read_locator(&path).unwrap().is_none());
        fs::write(&path, b"durable locator").unwrap();
        assert_eq!(read_locator(&path).unwrap().unwrap(), b"durable locator");
        let exclusive = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        // Metadata still exists, but Windows refuses the actual read. This must
        // block startup, never masquerade as an absent transaction.
        assert!(path_present(&path).unwrap());
        assert_eq!(read_locator(&path).unwrap_err().code, "IO_ERROR");
        drop(exclusive);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(read_locator(&path).unwrap_err().code, "IO_ERROR");
        assert!(!path_present(&path.join("missing")).unwrap());
        fs::remove_dir(&path).unwrap();
        fs::write(&path, b"parent is a file").unwrap();
        assert_eq!(
            path_present(&path.join("child")).unwrap_err().code,
            "UNSAFE_PATH"
        );
    }
    #[test]
    fn cleanup_io_failure_after_verified_is_a_warning_and_does_not_fail_the_operation() {
        let temp = tempfile::tempdir().unwrap();
        // The real cleanup syscall fails because this installer path is a directory.
        fs::create_dir(temp.path().join("installer.exe")).unwrap();
        let mut journal = Journal::new("request");
        journal.transition(temp.path(), Phase::Verified).unwrap();
        verified_postprocess(temp.path(), &mut journal, || cleanup_verified(temp.path()));
        let result = Journal::read(temp.path(), "request").unwrap();
        assert_eq!(result.phase, Phase::Verified);
        assert_eq!(result.cleanup_warning.as_deref(), Some("IO_ERROR"));
        assert!(!temp.path().join("helper-failed").exists());
    }
    #[test]
    fn verified_cleanup_waits_for_owner_and_preserves_unknown_files_and_failed_transactions() {
        for final_phase in [Phase::Verified, Phase::Prepared] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("updates");
            let staging = root.join("a".repeat(32));
            let data = temp.path().join("data");
            fs::create_dir_all(&staging).unwrap();
            fs::create_dir_all(data.join("update-recovery")).unwrap();
            let id = "b".repeat(32);
            fs::write(staging.join("update-helper.exe"), b"old helper").unwrap();
            let record = Record {
                schema_version: 1,
                worker: None,
                request_id: id.clone(),
                expected_version: "1.2.3".into(),
                source_version: "1.0.0".into(),
                install_root: temp.path().join("installed"),
                data_root: data.clone(),
                mode: "CurrentUser".into(),
                parent_pid: 0,
                parent_started: 0,
                parent_created_100ns: None,
                original_sid: "S-1-5-21-123".into(),
                signed_feed: String::new(),
                signed_feed_signature: String::new(),
                feed: super::super::tests::sample(),
                files: BTreeMap::from([(
                    APP_EXE.into(),
                    hash(&staging.join("update-helper.exe")).unwrap(),
                )]),
            };
            atomic_new(
                &staging.join("operation.json"),
                &serde_json::to_vec(&record).unwrap(),
            )
            .unwrap();
            let mut journal = Journal::new(&id);
            journal.record_sha256 = Some(hash(&staging.join("operation.json")).unwrap());
            journal.transition(&staging, Phase::Verified).unwrap();
            fs::write(data.join("update-recovery").join(format!("{id}.result.json")), serde_json::to_vec(&serde_json::json!({"requestId":id,"expectedVersion":"1.2.3","sourceVersion":"1.0.0","phase":"verified","rendered":true,"startedAt":0,"rollbackAttempted":false,"dataDigest":"0".repeat(64),"presetId":"initial","skinHashes":[],"backupDigest":"0".repeat(64),"error":null,"warnings":[],"windowDigest":"0".repeat(64),"windowGeometry":{"monitorWorkAreas":[],"windows":{}}})).unwrap()).unwrap();
            let owner = HelperOwner::acquire(&id).unwrap();
            assert_eq!(
                cleanup_verified_directory(&root, &staging, &data, &record.original_sid)
                    .unwrap_err()
                    .code,
                "HELPER_ALREADY_RUNNING"
            );
            assert!(staging.join("update-helper.exe").exists());
            drop(owner);
            fs::write(staging.join("user-backup.zip"), b"preserve").unwrap();
            assert!(
                cleanup_verified_directory(&root, &staging, &data, &record.original_sid).is_err()
            );
            assert!(staging.join("update-helper.exe").exists());
            assert_eq!(Journal::read(&staging, &id).unwrap().phase, Phase::Verified);
            fs::remove_file(staging.join("user-backup.zip")).unwrap();
            journal.transition(&staging, Phase::Failed).unwrap();
            assert!(
                !cleanup_verified_directory(&root, &staging, &data, &record.original_sid).unwrap()
            );
            assert!(staging.join("update-helper.exe").exists());
            if final_phase == Phase::Prepared {
                fs::create_dir_all(&record.install_root).unwrap();
                fs::write(record.install_root.join(APP_EXE), b"old helper").unwrap();
                let receipt_path = data
                    .join("update-recovery")
                    .join(format!("{id}.result.json"));
                let mut receipt: serde_json::Value =
                    serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
                receipt["phase"] = "rolledBack".into();
                receipt["rendered"] = false.into();
                receipt["error"] = "CANCELLED_BEFORE_INSTALL".into();
                fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
                atomic_new(&staging.join("cancel"), b"cancel").unwrap();
            }
            journal.transition(&staging, final_phase).unwrap();
            assert!(
                cleanup_verified_directory(&root, &staging, &data, &record.original_sid).unwrap()
            );
            assert!(!staging.exists());
        }
    }
    #[test]
    fn snapshot_reads_back_every_byte_and_preserves_unicode_paths() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("사용자 O'Brien 😶");
        fs::create_dir_all(source.join("assets/sub")).unwrap();
        fs::write(source.join(APP_EXE), b"old executable").unwrap();
        fs::write(source.join("assets/sub/model.glb"), b"model bytes").unwrap();
        let files = inventory(&source).unwrap();
        let recovery = temp.path().join("snapshot");
        copy_snapshot(&source, &recovery, &files).unwrap();
        assert_eq!(inventory(&recovery).unwrap(), files);
        fs::write(recovery.join(APP_EXE), b"corrupt").unwrap();
        assert_ne!(inventory(&recovery).unwrap(), files);
    }
    #[test]
    fn commit_is_separate_from_ready_and_cannot_overwrite_an_existing_operation() {
        let temp = tempfile::tempdir().unwrap();
        atomic_new(&temp.path().join("ready"), b"request").unwrap();
        assert!(!temp.path().join("commit").exists());
        assert!(matches!(commit(temp.path()), CommitOutcome::Committed));
        assert_eq!(fs::read(temp.path().join("commit")).unwrap(), b"commit");
        assert!(matches!(commit(temp.path()), CommitOutcome::Committed));
        fs::write(temp.path().join("commit"), b"partial").unwrap();
        assert!(matches!(commit(temp.path()), CommitOutcome::Ambiguous));
        assert_eq!(
            read_commit(temp.path()).unwrap_err().code,
            "COMMIT_STATE_UNKNOWN"
        );
        let missing = temp.path().join("missing");
        assert!(matches!(commit(&missing), CommitOutcome::NotCommitted(_)));
    }

    #[test]
    fn interrupted_program_copy_resumes_same_durable_attempt_and_rejects_corrupt_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("설치 O'Brien 😶");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join(APP_EXE), b"old executable").unwrap();
        fs::write(root.join("assets/model.glb"), b"old model").unwrap();
        let expected = inventory(&root).unwrap();
        let snapshot = temp.path().join("snapshot");
        copy_snapshot(&root, &snapshot, &expected).unwrap();
        fs::write(root.join(APP_EXE), b"partial new executable").unwrap();
        fs::write(root.join("assets/model.glb"), b"new model").unwrap();
        fs::write(root.join("new-only.tmp"), b"new version residue").unwrap();
        let mut journal = Journal::new("request");
        journal.transition(temp.path(), Phase::Installing).unwrap();
        journal.begin_rollback(temp.path()).unwrap();
        assert!(
            restore_files(&root, &snapshot, &expected, |_| Err(fail(
                "SIMULATED_POWER_LOSS"
            )))
            .is_err()
        );
        let mut resumed = Journal::read(temp.path(), "request").unwrap();
        assert_eq!(resumed.phase, Phase::RestoringProgram);
        resumed.begin_rollback(temp.path()).unwrap();
        restore_files(&root, &snapshot, &expected, |_| Ok(())).unwrap();
        assert_eq!(inventory(&root).unwrap(), expected);
        assert!(!root.join("new-only.tmp").exists());
        let before = inventory(&root).unwrap();
        fs::write(snapshot.join(APP_EXE), b"damaged backup").unwrap();
        assert!(restore_files(&root, &snapshot, &expected, |_| Ok(())).is_err());
        assert_eq!(inventory(&root).unwrap(), before);
    }

    #[test]
    fn cancellation_stops_a_large_file_copy_before_it_is_complete() {
        use std::cell::Cell;
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("large.bin");
        fs::write(&source, vec![91u8; 1024 * 1024]).unwrap();
        let target = temp.path().join("partial.bin");
        let checks = Cell::new(0);
        let result =
            copy_file_cancellable(&source, &target, &hash(&source).unwrap(), true, &|| {
                checks.set(checks.get() + 1);
                checks.get() > 3
            });
        assert_eq!(result.unwrap_err().code, "CANCELLED");
        assert!(fs::metadata(target).unwrap().len() < fs::metadata(source).unwrap().len());
    }
}
