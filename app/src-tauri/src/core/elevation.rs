//! Optional administrator execution. The working application exits only after a
//! same-account successor has authenticated and the existing save barrier passes.
use crate::{
    data_paths::DataRoots,
    native_operation::OperationLease,
    windows_process::{Handle, wide},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU8, Ordering},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use windows_sys::Win32::{
    Foundation::{
        ERROR_ALREADY_EXISTS, ERROR_CANCELLED, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED,
        GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_ELEVATION,
        TOKEN_QUERY, TokenElevation, TokenSessionId,
    },
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
        PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, SYNCHRONIZE,
        WriteFile,
    },
    System::{
        Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize},
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
            GetNamedPipeServerProcessId, PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_TYPE_MESSAGE, PIPE_WAIT,
        },
        Threading::{
            CreateEventW, GetCurrentProcess, GetProcessId, OpenEventW, OpenProcess,
            OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, SetEvent,
            WaitForMultipleObjects, WaitForSingleObject,
        },
    },
    UI::{
        Shell::{
            SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
            ShellExecuteExW,
        },
        WindowsAndMessaging::SW_SHOWNORMAL,
    },
};

const ARGUMENT: &str = "--block-pet-elevated-restart-parent";
const HANDSHAKE_MS: u32 = 10_000;
const READY_TTL: Duration = Duration::from_secs(60);
const CHILD_WAIT_MS: u32 = 90_000;
static PREPARED: Mutex<Option<Prepared>> = Mutex::new(None);
static STARTUP_CHECKED: AtomicBool = AtomicBool::new(false);
static STARTUP_ATTEMPT: AtomicU8 = AtomicU8::new(0);
static AUTHENTICATED_SUCCESSOR: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StartupAttempt {
    NotAttempted = 0,
    Cancelled = 1,
    Failed = 2,
}

fn startup_attempt() -> StartupAttempt {
    match STARTUP_ATTEMPT.load(Ordering::Acquire) {
        1 => StartupAttempt::Cancelled,
        2 => StartupAttempt::Failed,
        _ => StartupAttempt::NotAttempted,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationStatus {
    supported: bool,
    elevated: bool,
    startup_attempt: StartupAttempt,
    always_run_as_administrator: Option<bool>,
    administrator_reminder_dismissed: Option<bool>,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum Preparation {
    Ready { ticket: String },
    Cancelled,
}

fn require_preference(window: &tauri::Window) -> Result<(), String> {
    if window.label() == "preference" {
        Ok(())
    } else {
        Err("ELEVATION_WINDOW_DENIED".into())
    }
}

fn require_visible_preference(window: &tauri::Window) -> Result<(), String> {
    require_preference(window)?;
    if window.is_visible().unwrap_or(false) {
        Ok(())
    } else {
        Err("ELEVATION_WINDOW_HIDDEN".into())
    }
}

fn supported(
    development: bool,
    channel: crate::distribution::Channel,
    independent_frontend: bool,
) -> bool {
    use crate::distribution::Channel;
    if channel == Channel::Store {
        return false;
    }
    if development {
        return independent_frontend;
    }
    matches!(channel, Channel::Github | Channel::Test)
}

fn supported_here() -> bool {
    let development = tauri::is_dev();
    // Keep development-only environment reads out of packaged execution.
    let independent_frontend = development
        && (AUTHENTICATED_SUCCESSOR.load(Ordering::Acquire)
            || (std::env::var("DMELOPER_DEV_ELEVATION_PROTOCOL").as_deref() == Ok("1")
                && std::env::var("DMELOPER_DEV_RESTART_PROTOCOL").as_deref() == Ok("1")));
    supported(
        development,
        crate::distribution::channel(),
        // The dedicated test entry owns Vite outside Tauri CLI cleanup. An
        // ordinary supervised dev restart alone does not provide that lifetime.
        independent_frontend,
    ) && !cfg!(feature = "channel-store")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Identity {
    pid: u32,
    created: u64,
    sid: String,
    session: u32,
    elevated: bool,
    image: PathBuf,
}

fn token_fields(process: HANDLE) -> Result<(bool, u32), String> {
    let mut raw = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw) } == 0 {
        return Err("ELEVATION_IDENTITY_UNAVAILABLE".into());
    }
    let token = Handle(raw);
    let mut elevation = TOKEN_ELEVATION::default();
    let mut session = 0u32;
    let mut returned = 0;
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of_val(&elevation) as u32,
            &mut returned,
        )
    } == 0
        || returned as usize != std::mem::size_of_val(&elevation)
        || unsafe {
            GetTokenInformation(
                token.0,
                TokenSessionId,
                (&mut session as *mut u32).cast(),
                std::mem::size_of_val(&session) as u32,
                &mut returned,
            )
        } == 0
        || returned as usize != std::mem::size_of_val(&session)
    {
        return Err("ELEVATION_IDENTITY_UNAVAILABLE".into());
    }
    Ok((elevation.TokenIsElevated != 0, session))
}

fn identity(process: HANDLE) -> Result<Identity, String> {
    let (elevated, session) = token_fields(process)?;
    let pid = unsafe { GetProcessId(process) };
    if pid == 0 {
        return Err("ELEVATION_IDENTITY_UNAVAILABLE".into());
    }
    Ok(Identity {
        pid,
        created: crate::windows_process::creation_time(process)?,
        sid: crate::windows_process::user_sid(process)?,
        session,
        elevated,
        image: std::fs::canonicalize(crate::windows_process::executable(process)?)
            .map_err(|_| "ELEVATION_IMAGE_UNAVAILABLE")?,
    })
}

fn same_account_successor(parent: &Identity, child: &Identity) -> bool {
    parent.pid != child.pid
        && parent.created < child.created
        && !parent.elevated
        && child.elevated
        && parent.sid == child.sid
        && parent.session == child.session
        && parent.image == child.image
}

#[tauri::command]
pub fn elevation_status(window: tauri::Window) -> Result<ElevationStatus, String> {
    require_visible_preference(&window)?;
    let (elevated, _) = token_fields(unsafe { GetCurrentProcess() })?;
    Ok(ElevationStatus {
        supported: supported_here(),
        elevated,
        startup_attempt: startup_attempt(),
        always_run_as_administrator: window
            .app_handle()
            .try_state::<DataRoots>()
            .and_then(|roots| read_startup_preference(roots.inner()).ok()),
        administrator_reminder_dismissed: window.app_handle().try_state::<DataRoots>().and_then(
            |roots| read_saved_preference(roots.inner(), "administratorReminderDismissed").ok(),
        ),
    })
}

fn preference_file(debug: bool) -> &'static str {
    if debug {
        "general.dev.json"
    } else {
        "general.json"
    }
}

#[cfg(test)]
fn decode_preference(bytes: &[u8]) -> Result<bool, String> {
    decode_preference_field(bytes, "alwaysRunAsAdministrator")
}

fn decode_preference_field(bytes: &[u8], key: &str) -> Result<bool, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "ELEVATION_PREFERENCE_INVALID")?;
    let root = value.as_object().ok_or("ELEVATION_PREFERENCE_INVALID")?;
    let Some(app) = root.get("app") else {
        return Ok(false);
    };
    let app = app.as_object().ok_or("ELEVATION_PREFERENCE_INVALID")?;
    match app.get(key) {
        None => Ok(false),
        Some(serde_json::Value::Bool(value)) => Ok(*value),
        _ => Err("ELEVATION_PREFERENCE_INVALID".into()),
    }
}

fn read_preference_file(directory: &Path, debug: bool, key: &str) -> Result<bool, String> {
    use std::os::windows::fs::OpenOptionsExt;
    const MAXIMUM_BYTES: usize = 4 * 1024 * 1024;
    let path = directory.join(preference_file(debug));
    crate::state_safety::check_path(&path)?;
    let mut file = match fs::OpenOptions::new().read(true).share_mode(1).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("ELEVATION_PREFERENCE_UNAVAILABLE".into()),
    };
    if !file
        .metadata()
        .map_err(|_| "ELEVATION_PREFERENCE_UNAVAILABLE")?
        .is_file()
    {
        return Err("ELEVATION_PREFERENCE_INVALID".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAXIMUM_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "ELEVATION_PREFERENCE_UNAVAILABLE")?;
    if bytes.len() > MAXIMUM_BYTES {
        return Err("ELEVATION_PREFERENCE_INVALID".into());
    }
    decode_preference_field(&bytes, key)
}

fn read_startup_preference(roots: &DataRoots) -> Result<bool, String> {
    read_saved_preference(roots, "alwaysRunAsAdministrator")
}

fn read_saved_preference(roots: &DataRoots, key: &str) -> Result<bool, String> {
    crate::data_paths::validate_startup_storage(roots)?;
    read_preference_file(
        &roots.durable.join("tauri-plugin-pinia"),
        cfg!(debug_assertions),
        key,
    )
}

fn startup_should_elevate(supported: bool, elevated: bool, preferred: bool) -> bool {
    supported && !elevated && preferred
}

fn startup_attempt_with<T>(
    supported: bool,
    elevated: bool,
    read: impl FnOnce() -> Result<bool, String>,
    prepare: impl FnOnce() -> Result<Option<T>, String>,
    commit: impl FnOnce(T) -> Result<(), String>,
) -> Result<StartupAttempt, String> {
    if !supported || elevated || !startup_should_elevate(supported, elevated, read()?) {
        return Ok(StartupAttempt::NotAttempted);
    }
    let Some(prepared) = prepare()? else {
        return Ok(StartupAttempt::Cancelled);
    };
    commit(prepared)?;
    // In production a successful commit exits. Returning here supports an
    // isolated transaction fixture without ever exiting its test process.
    Ok(StartupAttempt::NotAttempted)
}

/// Private bootstrap-only entry. It cannot be invoked by a renderer, and the
/// caller still owns the lifetime/installation locks with no active editors.
pub(crate) fn try_startup_elevation(roots: &DataRoots) {
    if STARTUP_CHECKED.swap(true, Ordering::AcqRel) || !supported_here() {
        return;
    }
    let attempt = || -> Result<StartupAttempt, String> {
        let (elevated, _) = token_fields(unsafe { GetCurrentProcess() })?;
        startup_attempt_with(
            true,
            elevated,
            || read_startup_preference(roots),
            || {
                let lease = crate::native_operation::try_acquire("elevation")?;
                let roots_for_child = roots.clone();
                std::thread::Builder::new()
                    .name("startup-elevation-consent".into())
                    .spawn(move || prepare_child(roots_for_child, 0, lease))
                    .map_err(|_| "ELEVATION_HANDOFF_FAILED")?
                    .join()
                    .map_err(|_| "ELEVATION_HANDOFF_FAILED")?
            },
            |prepared| {
                commit_prepared(
                    prepared,
                    || {
                        if read_startup_preference(roots)? {
                            Ok(())
                        } else {
                            Err("ELEVATION_PREFERENCE_CHANGED".into())
                        }
                    },
                    |lease| {
                        lease.commit_exit();
                        // Keep bootstrap locks until OS process teardown. The successor
                        // waits for this exact process, then acquires its normal locks.
                        std::process::exit(0);
                    },
                )
            },
        )
    };
    STARTUP_ATTEMPT.store(
        attempt().unwrap_or(StartupAttempt::Failed) as u8,
        Ordering::Release,
    );
}

fn valid_ticket(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn handoff_fields(value: &str) -> Result<(u32, u64, &str), String> {
    let mut fields = value.split(':');
    let pid = fields.next().and_then(|v| v.parse::<u32>().ok());
    let created = fields.next().and_then(|v| v.parse::<u64>().ok());
    let nonce = fields.next().filter(|v| valid_ticket(v));
    match (pid, created, nonce, fields.next()) {
        (Some(pid), Some(created), Some(nonce), None) if pid > 0 && created > 0 => {
            Ok((pid, created, nonce))
        }
        _ => Err("ELEVATION_HANDOFF_INVALID".into()),
    }
}

fn object_name(pid: u32, nonce: &str, kind: &str) -> String {
    format!("Local\\DMeloper.BlockPet.Elevation.{pid}.{nonce}.{kind}")
}

fn pipe_name(pid: u32, nonce: &str) -> String {
    format!(r"\\.\pipe\DMeloper.BlockPet.Elevation.{pid}.{nonce}")
}

/// Restrict rendezvous objects to the current user. In particular, entering a
/// different administrator's credentials cannot redirect that account's data.
struct UserSecurity(PSECURITY_DESCRIPTOR);
impl UserSecurity {
    fn new(sid: &str) -> Result<Self, String> {
        let mut raw = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&format!("D:P(A;;GA;;;{sid})")).as_ptr(),
                SDDL_REVISION_1,
                &mut raw,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("ELEVATION_SECURITY_UNAVAILABLE".into());
        }
        Ok(Self(raw))
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}
impl Drop for UserSecurity {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

fn create_event(name: &str, security: &SECURITY_ATTRIBUTES) -> Result<Handle, String> {
    let raw = unsafe { CreateEventW(security, 1, 0, wide(name).as_ptr()) };
    if raw.is_null() {
        return Err("ELEVATION_HANDOFF_UNAVAILABLE".into());
    }
    let existing = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let event = Handle(raw);
    if existing {
        return Err("ELEVATION_HANDOFF_UNAVAILABLE".into());
    }
    Ok(event)
}

fn open_event(name: &str) -> Result<Handle, String> {
    let raw = unsafe { OpenEventW(SYNCHRONIZE, 0, wide(name).as_ptr()) };
    if raw.is_null() {
        Err("ELEVATION_HANDOFF_UNAVAILABLE".into())
    } else {
        Ok(Handle(raw))
    }
}

/// All pipe I/O is bounded by peer lifetime and a short handshake deadline.
/// Cancellation is drained before the stack OVERLAPPED or buffer is released.
fn pipe_io(
    pipe: HANDLE,
    peer: HANDLE,
    connected_is_success: bool,
    begin: impl FnOnce(*mut OVERLAPPED) -> i32,
) -> Result<u32, String> {
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        return Err("ELEVATION_HANDOFF_UNAVAILABLE".into());
    }
    let event = Handle(event);
    let mut overlapped = OVERLAPPED {
        hEvent: event.0,
        ..Default::default()
    };
    let immediate = begin(&mut overlapped) != 0;
    if !immediate {
        let error = unsafe { GetLastError() };
        if connected_is_success && error == ERROR_PIPE_CONNECTED {
            return Ok(0);
        }
        if error != ERROR_IO_PENDING {
            return Err("ELEVATION_CHILD_NOT_READY".into());
        }
        let handles = [event.0, peer];
        if unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, HANDSHAKE_MS) } != WAIT_OBJECT_0
        {
            unsafe {
                CancelIoEx(pipe, &overlapped);
                let mut drained = 0;
                GetOverlappedResult(pipe, &overlapped, &mut drained, 1);
            }
            return Err("ELEVATION_CHILD_NOT_READY".into());
        }
    }
    let mut transferred = 0;
    if unsafe { GetOverlappedResult(pipe, &overlapped, &mut transferred, 0) } == 0 {
        Err("ELEVATION_CHILD_NOT_READY".into())
    } else {
        Ok(transferred)
    }
}

fn roots_digest(roots: &DataRoots) -> String {
    let mut hash = Sha256::new();
    for path in [&roots.durable, &roots.local] {
        let units: Vec<_> = path.as_os_str().encode_wide().collect();
        hash.update((units.len() as u64).to_le_bytes());
        for unit in units {
            hash.update(unit.to_le_bytes());
        }
    }
    format!("{:x}", hash.finalize())
}

fn readonly_child_preflight(image: &Path) -> Result<DataRoots, String> {
    let marker = image
        .parent()
        .ok_or("ELEVATION_IMAGE_UNAVAILABLE")?
        .join(".block-pet-installing");
    if marker
        .try_exists()
        .map_err(|_| "ELEVATION_PREFLIGHT_FAILED")?
    {
        return Err("ELEVATION_PREFLIGHT_FAILED".into());
    }
    if !tauri::webview_version().is_ok_and(|version| {
        version
            .split('.')
            .next()
            .and_then(|part| part.parse::<u32>().ok())
            .is_some_and(|major| major >= 120)
    }) {
        return Err("ELEVATION_PREFLIGHT_FAILED".into());
    }
    // Resolve only: initialize(), store plugins and WebViews stay behind commit.
    let roots = DataRoots::resolve().map_err(|_| "ELEVATION_PREFLIGHT_FAILED")?;
    crate::data_paths::validate_startup_storage(&roots)?;
    Ok(roots)
}

fn ready_message(nonce: &str, roots: &DataRoots) -> Vec<u8> {
    format!("READY:1:{nonce}:{}", roots_digest(roots)).into_bytes()
}

fn child_may_start(parent_exited: bool, committed: bool, cancelled: bool) -> bool {
    parent_exited && committed && !cancelled
}

fn child_handoff(value: &str) -> Result<bool, String> {
    // runas does not inherit the launcher's custom environment. A development
    // child is instead authorized by the exact parent/image/nonce handshake
    // below, before any startup state or frontend can be initialized.
    if !supported(tauri::is_dev(), crate::distribution::channel(), true)
        || cfg!(feature = "channel-store")
    {
        return Err("ELEVATION_UNSUPPORTED".into());
    }
    let (pid, created, nonce) = handoff_fields(value)?;
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if raw.is_null() {
        return Err("ELEVATION_PARENT_UNAVAILABLE".into());
    }
    let parent_handle = Handle(raw);
    let parent = identity(parent_handle.0)?;
    let child = identity(unsafe { GetCurrentProcess() })?;
    if parent.created != created
        || !same_account_successor(&parent, &child)
        || unsafe { WaitForSingleObject(parent_handle.0, 0) } != WAIT_TIMEOUT
    {
        return Err("ELEVATION_IDENTITY_MISMATCH".into());
    }
    let commit = open_event(&object_name(pid, nonce, "Commit"))?;
    let cancel = open_event(&object_name(pid, nonce, "Cancel"))?;
    let raw_pipe = unsafe {
        CreateFileW(
            wide(&pipe_name(pid, nonce)).as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            // Never allow the medium-integrity pipe server to impersonate this
            // elevated token. Authentication uses kernel peer PID, not impersonation.
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            std::ptr::null_mut(),
        )
    };
    if raw_pipe == INVALID_HANDLE_VALUE {
        return Err("ELEVATION_HANDOFF_UNAVAILABLE".into());
    }
    let pipe = Handle(raw_pipe);
    let mut server_pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.0, &mut server_pid) } == 0 || server_pid != pid {
        return Err("ELEVATION_IDENTITY_MISMATCH".into());
    }
    let roots = readonly_child_preflight(&child.image)?;
    let message = ready_message(nonce, &roots);
    let written = pipe_io(pipe.0, parent_handle.0, false, |overlapped| unsafe {
        WriteFile(
            pipe.0,
            message.as_ptr(),
            message.len() as u32,
            std::ptr::null_mut(),
            overlapped,
        )
    })?;
    if written as usize != message.len() {
        return Err("ELEVATION_CHILD_NOT_READY".into());
    }
    let handles = [cancel.0, parent_handle.0];
    let wait = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, CHILD_WAIT_MS) };
    Ok(child_may_start(
        wait == WAIT_OBJECT_0 + 1,
        unsafe { WaitForSingleObject(commit.0, 0) } == WAIT_OBJECT_0,
        unsafe { WaitForSingleObject(cancel.0, 0) } != WAIT_TIMEOUT,
    ))
}

/// Called before ordinary bootstrap. A rejected/cancelled prepared child exits
/// quietly; it must never show a startup prompt or initialize a different profile.
pub(crate) fn wait_for_parent() -> bool {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let Some(index) = args.iter().position(|arg| arg == ARGUMENT) else {
        return true;
    };
    if args.len() != 2 || index != 0 {
        return false;
    }
    let accepted = args[1]
        .to_str()
        .and_then(|value| child_handoff(value).ok())
        .unwrap_or(false);
    if accepted {
        AUTHENTICATED_SUCCESSOR.store(true, Ordering::Release);
    }
    accepted
}

struct ComApartment;
impl ComApartment {
    fn initialize() -> Result<Self, String> {
        if unsafe {
            CoInitializeEx(
                std::ptr::null(),
                (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            )
        } < 0
        {
            return Err("ELEVATION_SPAWN_FAILED".into());
        }
        Ok(Self)
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn launch_elevated(parent: &Identity, nonce: &str, owner: usize) -> Result<Option<Handle>, String> {
    let _apartment = ComApartment::initialize()?;
    let image: Vec<_> = parent
        .image
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let parameters = wide(&format!(
        "{ARGUMENT} {}:{}:{nonce}",
        parent.pid, parent.created
    ));
    let verb = wide("runas");
    let mut execute = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        hwnd: owner as _,
        lpVerb: verb.as_ptr(),
        lpFile: image.as_ptr(),
        lpParameters: parameters.as_ptr(),
        nShow: SW_SHOWNORMAL,
        ..Default::default()
    };
    // Windows owns the consent UI. No application timeout runs while it is open.
    let succeeded = unsafe { ShellExecuteExW(&mut execute) } != 0;
    let error = unsafe { GetLastError() };
    let process = (!execute.hProcess.is_null()).then(|| Handle(execute.hProcess));
    launch_result(succeeded, error, process)
}

fn launch_result<T>(succeeded: bool, error: u32, process: Option<T>) -> Result<Option<T>, String> {
    if !succeeded {
        if error == ERROR_CANCELLED {
            Ok(None)
        } else {
            Err("ELEVATION_SPAWN_FAILED".into())
        }
    } else {
        process
            .map(Some)
            .ok_or_else(|| "ELEVATION_CHILD_UNAVAILABLE".into())
    }
}

struct ExpirySignal {
    completed: Mutex<bool>,
    changed: Condvar,
}

struct Prepared {
    ticket: String,
    ready: Instant,
    child: PreparedChild,
    // Drop the cancelled child before releasing the operation lease on failure.
    lease: OperationLease,
}

struct PreparedChild {
    process: Handle,
    commit: Handle,
    cancel: Handle,
    expiry: Arc<ExpirySignal>,
    committed: bool,
}
impl Drop for PreparedChild {
    fn drop(&mut self) {
        if let Ok(mut completed) = self.expiry.completed.lock() {
            *completed = true;
            self.expiry.changed.notify_one();
        }
        if !self.committed {
            unsafe {
                SetEvent(self.cancel.0);
                // The child runs only this bounded handoff until commit. Do not
                // terminate arbitrary or already running elevated applications.
                WaitForSingleObject(self.process.0, 5_000);
            }
        }
    }
}

fn prepare_child(
    roots: DataRoots,
    owner: usize,
    lease: OperationLease,
) -> Result<Option<Prepared>, String> {
    let parent = identity(unsafe { GetCurrentProcess() })?;
    if parent.elevated {
        return Err("ELEVATION_ALREADY_ELEVATED".into());
    }
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| "ELEVATION_ENTROPY_UNAVAILABLE")?;
    let ticket: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let security = UserSecurity::new(&parent.sid)?;
    let attributes = security.attributes();
    let commit = create_event(&object_name(parent.pid, &ticket, "Commit"), &attributes)?;
    let cancel = create_event(&object_name(parent.pid, &ticket, "Cancel"), &attributes)?;
    let raw_pipe = unsafe {
        CreateNamedPipeW(
            wide(&pipe_name(parent.pid, &ticket)).as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            512,
            512,
            HANDSHAKE_MS,
            &attributes,
        )
    };
    if raw_pipe == INVALID_HANDLE_VALUE {
        return Err("ELEVATION_HANDOFF_UNAVAILABLE".into());
    }
    let pipe = Handle(raw_pipe);
    let Some(child) = launch_elevated(&parent, &ticket, owner)? else {
        return Ok(None);
    };
    // From this point every failure signals cancellation while the parent stays alive.
    let mut prepared = Prepared {
        ticket,
        ready: Instant::now(),
        child: PreparedChild {
            process: child,
            commit,
            cancel,
            expiry: Arc::new(ExpirySignal {
                completed: Mutex::new(false),
                changed: Condvar::new(),
            }),
            committed: false,
        },
        lease,
    };
    let child = identity(prepared.child.process.0)?;
    if !same_account_successor(&parent, &child) {
        return Err("ELEVATION_IDENTITY_MISMATCH".into());
    }
    pipe_io(
        pipe.0,
        prepared.child.process.0,
        true,
        |overlapped| unsafe { ConnectNamedPipe(pipe.0, overlapped) },
    )?;
    let mut client_pid = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe.0, &mut client_pid) } == 0
        || client_pid != child.pid
    {
        return Err("ELEVATION_IDENTITY_MISMATCH".into());
    }
    let expected = ready_message(&prepared.ticket, &roots);
    let mut actual = vec![0u8; expected.len()];
    let read = pipe_io(
        pipe.0,
        prepared.child.process.0,
        false,
        |overlapped| unsafe {
            ReadFile(
                pipe.0,
                actual.as_mut_ptr(),
                actual.len() as u32,
                std::ptr::null_mut(),
                overlapped,
            )
        },
    )?;
    if read as usize != expected.len()
        || actual != expected
        || unsafe { WaitForSingleObject(prepared.child.process.0, 0) } != WAIT_TIMEOUT
    {
        return Err("ELEVATION_CHILD_NOT_READY".into());
    }
    prepared.ready = Instant::now();
    Ok(Some(prepared))
}

fn take_prepared(ticket: &str) -> Result<Option<Prepared>, String> {
    let mut prepared = PREPARED.lock().map_err(|_| "ELEVATION_HANDOFF_FAILED")?;
    if prepared
        .as_ref()
        .is_some_and(|pending| pending.ticket == ticket)
    {
        Ok(prepared.take())
    } else {
        Ok(None)
    }
}

fn install_prepared(prepared: Prepared) -> Result<String, String> {
    let ticket = prepared.ticket.clone();
    let expiry = prepared.child.expiry.clone();
    let watch_ticket = ticket.clone();
    let mut slot = PREPARED.lock().map_err(|_| "ELEVATION_HANDOFF_FAILED")?;
    if slot.is_some() {
        return Err("OPERATION_BUSY".into());
    }
    *slot = Some(prepared);
    drop(slot);
    if std::thread::Builder::new()
        .name("elevation-expiry".into())
        .spawn(move || {
            let Ok(completed) = expiry.completed.lock() else {
                return;
            };
            let Ok((completed, wait)) =
                expiry
                    .changed
                    .wait_timeout_while(completed, READY_TTL, |done| !*done)
            else {
                return;
            };
            if *completed || !wait.timed_out() {
                return;
            }
            drop(completed);
            // An old watchdog can never remove a newer transaction.
            drop(take_prepared(&watch_ticket));
        })
        .is_err()
    {
        drop(take_prepared(&ticket));
        return Err("ELEVATION_HANDOFF_FAILED".into());
    }
    Ok(ticket)
}

#[tauri::command]
pub async fn prepare_elevated_restart(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<Preparation, String> {
    require_visible_preference(&window)?;
    if !supported_here() {
        return Err("ELEVATION_UNSUPPORTED".into());
    }
    let lease = crate::native_operation::try_acquire("elevation")?;
    let roots = app
        .try_state::<DataRoots>()
        .ok_or("ELEVATION_STARTUP_INCOMPLETE")?
        .inner()
        .clone();
    let owner = window.hwnd().map_err(|_| "ELEVATION_WINDOW_UNAVAILABLE")?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        // A dedicated STA gives ShellExecute a stable COM apartment regardless
        // of earlier work performed on Tauri's blocking pool thread.
        let prepared = std::thread::Builder::new()
            .name("elevation-consent".into())
            .spawn(move || prepare_child(roots, owner, lease))
            .map_err(|_| "ELEVATION_HANDOFF_FAILED")?
            .join()
            .map_err(|_| "ELEVATION_HANDOFF_FAILED")??;
        match prepared {
            Some(prepared) => {
                require_visible_preference(&window)?;
                Ok(Preparation::Ready {
                    ticket: install_prepared(prepared)?,
                })
            }
            None => Ok(Preparation::Cancelled),
        }
    })
    .await
    .map_err(|_| "ELEVATION_HANDOFF_FAILED")?
}

#[tauri::command]
pub async fn cancel_elevated_restart(window: tauri::Window, ticket: String) -> Result<(), String> {
    require_preference(&window)?;
    if !valid_ticket(&ticket) {
        return Err("ELEVATION_TICKET_INVALID".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Idempotent cancellation cannot cancel another ticket or exit the app.
        drop(take_prepared(&ticket)?);
        Ok(())
    })
    .await
    .map_err(|_| "ELEVATION_HANDOFF_FAILED")?
}

fn commit_sequence(
    child_ready: impl Fn() -> bool,
    barrier: impl FnOnce() -> Result<(), String>,
    signal: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !child_ready() {
        return Err("ELEVATION_TICKET_EXPIRED".into());
    }
    // Revalidate after all waiting and immediately before the commit signal.
    barrier()?;
    if !child_ready() {
        return Err("ELEVATION_TICKET_EXPIRED".into());
    }
    signal()?;
    Ok(())
}

fn commit_prepared(
    mut prepared: Prepared,
    barrier: impl FnOnce() -> Result<(), String>,
    exit: impl FnOnce(OperationLease),
) -> Result<(), String> {
    let child_ready = || {
        prepared.ready.elapsed() < READY_TTL
            && unsafe { WaitForSingleObject(prepared.child.process.0, 0) } == WAIT_TIMEOUT
    };
    let commit = prepared.child.commit.0;
    commit_sequence(child_ready, barrier, || {
        if unsafe { SetEvent(commit) } == 0 {
            Err("ELEVATION_COMMIT_FAILED".into())
        } else {
            Ok(())
        }
    })?;
    // No await, fallible work or renderer acknowledgement between commit and
    // exit. On earlier failure, field order cancels the child before the lease.
    prepared.child.committed = true;
    exit(prepared.lease);
    Ok(())
}

#[tauri::command]
pub async fn restart_elevated_application(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
    ticket: String,
) -> Result<(), String> {
    require_visible_preference(&window)?;
    if !valid_ticket(&ticket) {
        return Err("ELEVATION_TICKET_INVALID".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = take_prepared(&ticket)?.ok_or("ELEVATION_TICKET_EXPIRED")?;
        commit_prepared(
            prepared,
            || {
                require_visible_preference(&window)?;
                crate::state_safety::verify_state_quiescence(
                    app.clone(),
                    window.clone(),
                    request_id,
                )?;
                require_visible_preference(&window)
            },
            |lease| {
                lease.commit_exit();
                app.exit(0);
            },
        )
    })
    .await
    .map_err(|_| "ELEVATION_HANDOFF_FAILED")?
}

#[cfg(test)]
#[path = "elevation_tests.rs"]
mod tests;
