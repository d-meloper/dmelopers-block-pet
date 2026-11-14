//! Administrator input runs in a narrowly scoped headless worker. The GUI and
//! all durable-state writers retain the original account and process lifetime.
use crate::{
    data_paths::DataRoots,
    native_operation::OperationLease,
    windows_process::{Handle, wide},
};
use serde::{Deserialize, Serialize};
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
        DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ALREADY_EXISTS, ERROR_CANCELLED,
        ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE,
        INVALID_HANDLE_VALUE, LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_ELEVATION,
        TOKEN_QUERY, TokenElevation, TokenSessionId,
    },
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
        PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, SYNCHRONIZE,
    },
    System::{
        Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize},
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
            GetNamedPipeServerProcessId, PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_TYPE_MESSAGE, PIPE_WAIT,
        },
        RemoteDesktop::ProcessIdToSessionId,
        Threading::{
            CreateEventW, EVENT_MODIFY_STATE, GetCurrentProcess, GetProcessId, OpenEventW,
            OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            SetEvent, WaitForMultipleObjects, WaitForSingleObject,
        },
    },
    UI::{
        Shell::{
            SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
            ShellExecuteExW,
        },
        WindowsAndMessaging::SW_HIDE,
    },
};

#[path = "elevation/dpi.rs"]
mod dpi;
#[path = "elevation/transport.rs"]
mod transport;
pub(crate) use transport::Transport;

#[cfg(test)]
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};

const ARGUMENT: &str = "--block-pet-administrator-input-parent";
const RETIRED_ARGUMENT: &str = "--block-pet-elevated-restart-parent";
const HANDSHAKE_MS: u32 = 10_000;
const READY_TTL: Duration = Duration::from_secs(60);
const CHILD_WAIT_MS: u32 = 90_000;
static PREPARED: Mutex<Option<Prepared>> = Mutex::new(None);
static STARTUP_CHECKED: AtomicBool = AtomicBool::new(false);
static STARTUP_ATTEMPT: AtomicU8 = AtomicU8::new(0);

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
    input_elevated: bool,
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
        && std::env::var("DMELOPER_DEV_ELEVATION_PROTOCOL").as_deref() == Ok("1")
        && std::env::var("DMELOPER_DEV_RESTART_PROTOCOL").as_deref() == Ok("1");
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

// Never query a different administrator's token from the standard parent.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessIdentity {
    pid: u32,
    created: u64,
    session: u32,
    image: PathBuf,
}
impl From<&Identity> for ProcessIdentity {
    fn from(value: &Identity) -> Self {
        Self {
            pid: value.pid,
            created: value.created,
            session: value.session,
            image: value.image.clone(),
        }
    }
}
fn process_identity(process: HANDLE) -> Result<ProcessIdentity, String> {
    let pid = unsafe { GetProcessId(process) };
    let mut session = 0;
    if pid == 0 || unsafe { ProcessIdToSessionId(pid, &mut session) } == 0 {
        return Err("ELEVATION_IDENTITY_UNAVAILABLE".into());
    }
    Ok(ProcessIdentity {
        pid,
        created: crate::windows_process::creation_time(process)?,
        session,
        image: fs::canonicalize(crate::windows_process::executable(process)?)
            .map_err(|_| "ELEVATION_IMAGE_UNAVAILABLE")?,
    })
}
fn valid_worker_successor(parent: &ProcessIdentity, child: &ProcessIdentity) -> bool {
    parent.pid != child.pid
        && parent.created < child.created
        && parent.session == child.session
        && parent.image == child.image
}
fn worker_identity_allowed(parent: &ProcessIdentity, child: &Identity) -> bool {
    child.elevated && valid_worker_successor(parent, &ProcessIdentity::from(child))
}

#[tauri::command]
pub fn elevation_status(window: tauri::Window) -> Result<ElevationStatus, String> {
    require_visible_preference(&window)?;
    current_status(window.app_handle())
}

fn current_status(app: &tauri::AppHandle) -> Result<ElevationStatus, String> {
    let (elevated, _) = token_fields(unsafe { GetCurrentProcess() })?;
    Ok(ElevationStatus {
        supported: supported_here(),
        elevated,
        input_elevated: crate::core::device::elevated_input_active(),
        startup_attempt: startup_attempt(),
        always_run_as_administrator: app
            .try_state::<DataRoots>()
            .and_then(|roots| read_startup_preference(roots.inner()).ok()),
        administrator_reminder_dismissed: app.try_state::<DataRoots>().and_then(|roots| {
            read_saved_preference(roots.inner(), "administratorReminderDismissed").ok()
        }),
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
    // The original GUI account and process continue after worker activation.
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
                    crate::core::device::activate_elevated_input,
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

/// Only the originating user and elevated Administrators may rendezvous.
/// Exact kernel peer PID, image and session validation remains mandatory.
fn security_descriptor(sid: &str) -> String {
    format!("D:P(A;;GA;;;{sid})(A;;GA;;;BA)")
}
struct UserSecurity(PSECURITY_DESCRIPTOR);
impl UserSecurity {
    fn new(sid: &str) -> Result<Self, String> {
        let mut raw = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&security_descriptor(sid)).as_ptr(),
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
    let raw = unsafe { OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, 0, wide(name).as_ptr()) };
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
            #[cfg(test)]
            eprintln!("pipe_io begin failed: Win32={error}");
            return Err("ELEVATION_CHILD_NOT_READY".into());
        }
        let handles = [event.0, peer];
        let wait_result = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, HANDSHAKE_MS) };
        if wait_result != WAIT_OBJECT_0 {
            #[cfg(test)]
            eprintln!("pipe_io wait failed: wait={wait_result} Win32={}", unsafe {
                GetLastError()
            });
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
        #[cfg(test)]
        eprintln!("pipe_io completion failed: Win32={}", unsafe {
            GetLastError()
        });
        Err("ELEVATION_CHILD_NOT_READY".into())
    } else {
        Ok(transferred)
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase", deny_unknown_fields)]
enum Handshake {
    Ready { protocol: u8, nonce: String },
    Active { protocol: u8, nonce: String },
}
fn ready_message(nonce: &str) -> Handshake {
    Handshake::Ready {
        protocol: 1,
        nonce: nonce.into(),
    }
}
fn active_message(nonce: &str) -> Handshake {
    Handshake::Active {
        protocol: 1,
        nonce: nonce.into(),
    }
}
fn child_may_start(parent_alive: bool, committed: bool, cancelled: bool) -> bool {
    parent_alive && committed && !cancelled
}

fn child_handoff(value: &str) -> Result<(), String> {
    // This entry is before profiles, storage, logs, Tauri and WebView creation.
    if !supported(tauri::is_dev(), crate::distribution::channel(), true)
        || cfg!(feature = "channel-store")
    {
        return Err("ELEVATION_UNSUPPORTED".into());
    }
    let (pid, created, nonce) = handoff_fields(value)?;
    let own = identity(unsafe { GetCurrentProcess() })?;
    if !own.elevated {
        return Err("ELEVATION_IDENTITY_MISMATCH".into());
    }
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
    let parent = process_identity(parent_handle.0)?;
    if parent.created != created
        || !worker_identity_allowed(&parent, &own)
        || unsafe { WaitForSingleObject(parent_handle.0, 0) } != WAIT_TIMEOUT
    {
        return Err("ELEVATION_IDENTITY_MISMATCH".into());
    }
    let commit = open_event(&object_name(pid, nonce, "Commit"))?;
    let cancel = open_event(&object_name(pid, nonce, "Cancel"))?;
    let raw = unsafe {
        CreateFileW(
            wide(&pipe_name(pid, nonce)).as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            std::ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err("ELEVATION_HANDOFF_UNAVAILABLE".into());
    }
    let pipe = Handle(raw);
    let mut server_pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.0, &mut server_pid) } == 0 || server_pid != pid {
        return Err("ELEVATION_IDENTITY_MISMATCH".into());
    }
    let transport = Transport::new(pipe, parent_handle, cancel)?;
    transport.send(&ready_message(nonce))?;
    let waits = [transport.cancel_handle(), transport.peer_handle(), commit.0];
    let signalled = unsafe { WaitForMultipleObjects(3, waits.as_ptr(), 0, CHILD_WAIT_MS) };
    if signalled != WAIT_OBJECT_0 + 2
        || !child_may_start(
            transport.alive(),
            unsafe { WaitForSingleObject(commit.0, 0) } == WAIT_OBJECT_0,
            unsafe { WaitForSingleObject(transport.cancel_handle(), 0) } != WAIT_TIMEOUT,
        )
    {
        return Err("ELEVATION_CHILD_NOT_READY".into());
    }
    // The GUI normally initializes DPI through Tao; this worker skips that
    // event loop, so establish the same physical coordinate system explicitly.
    dpi::initialize();
    transport.send(&active_message(nonce))?;
    crate::core::device::admin_input::serve(transport)
}

#[derive(Debug, PartialEq)]
enum Invocation {
    Ordinary,
    Worker(String),
    Rejected,
}
fn invocation(args: &[std::ffi::OsString]) -> Invocation {
    if args.iter().any(|arg| arg == RETIRED_ARGUMENT) {
        return Invocation::Rejected;
    }
    let Some(index) = args.iter().position(|arg| arg == ARGUMENT) else {
        return Invocation::Ordinary;
    };
    if index != 0 || args.len() != 2 {
        return Invocation::Rejected;
    }
    match args[1].to_str() {
        Some(value) if handoff_fields(value).is_ok() => Invocation::Worker(value.into()),
        _ => Invocation::Rejected,
    }
}
/// Worker/retired invocations always exit before normal profile bootstrap.
pub(crate) fn wait_for_parent() -> bool {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match invocation(&args) {
        Invocation::Ordinary => true,
        Invocation::Worker(value) => {
            let _ = child_handoff(&value);
            false
        }
        Invocation::Rejected => false,
    }
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
        nShow: SW_HIDE,
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
    // Cancel the worker before releasing the operation lease on failure.
    _lease: OperationLease,
}

struct PreparedChild {
    transport: Option<Transport>,
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
            if let Some(transport) = &self.transport {
                transport.cancel();
            }
            unsafe {
                SetEvent(self.cancel.0);
                // This handle refers only to the worker created by this request.
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
    crate::data_paths::validate_startup_storage(&roots)?;
    let parent = identity(unsafe { GetCurrentProcess() })?;
    if parent.elevated || crate::core::device::elevated_input_active() {
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
            transport: None,
            process: child,
            commit,
            cancel,
            expiry: Arc::new(ExpirySignal {
                completed: Mutex::new(false),
                changed: Condvar::new(),
            }),
            committed: false,
        },
        _lease: lease,
    };
    let child = process_identity(prepared.child.process.0)?;
    if !valid_worker_successor(&ProcessIdentity::from(&parent), &child) {
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
    let transport = Transport::new(
        pipe,
        clone_handle(prepared.child.process.0)?,
        clone_handle(prepared.child.cancel.0)?,
    )?;
    prepared.child.transport = Some(transport.clone());
    let actual: Handshake = transport.receive_for(HANDSHAKE_MS)?;
    if actual != ready_message(&prepared.ticket) || !transport.alive() {
        return Err("ELEVATION_CHILD_NOT_READY".into());
    }

    prepared.ready = Instant::now();
    Ok(Some(prepared))
}

fn clone_handle(raw: HANDLE) -> Result<Handle, String> {
    let mut duplicate = std::ptr::null_mut();
    let process = unsafe { GetCurrentProcess() };
    if unsafe {
        DuplicateHandle(
            process,
            raw,
            process,
            &mut duplicate,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err("ELEVATION_HANDOFF_UNAVAILABLE".into());
    }
    Ok(Handle(duplicate))
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

// A saved false choice is verified before touching the active worker. A failed
// readback or shutdown never becomes a successful disable acknowledgement.
fn disable_after_saved_choice(
    read_enabled: impl FnOnce() -> Result<bool, String>,
    disable: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if read_enabled()? {
        return Err("ELEVATION_PREFERENCE_CHANGED".into());
    }
    disable()
}

#[tauri::command]
pub async fn disable_elevated_input(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<ElevationStatus, String> {
    require_visible_preference(&window)?;
    if !supported_here() {
        return Err("ELEVATION_UNSUPPORTED".into());
    }
    let lease = crate::native_operation::try_acquire("elevation-disable")?;
    let roots = app
        .try_state::<DataRoots>()
        .ok_or("ELEVATION_STARTUP_INCOMPLETE")?
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        disable_after_saved_choice(
            || {
                require_visible_preference(&window)?;
                let enabled = read_startup_preference(&roots)?;
                require_visible_preference(&window)?;
                Ok(enabled)
            },
            crate::core::device::deactivate_elevated_input,
        )?;
        // This is the real GUI token. A manually elevated GUI remains elevated
        // even after its optional input worker has been retired.
        current_status(&app)
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
    activate: impl FnOnce(Transport) -> Result<(), String>,
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
    let transport = prepared
        .child
        .transport
        .as_ref()
        .ok_or("ELEVATION_CHILD_NOT_READY")?
        .clone();
    let acknowledgement: Handshake = transport.receive_for(HANDSHAKE_MS)?;
    if acknowledgement != active_message(&prepared.ticket) || !transport.alive() {
        return Err("ELEVATION_CHILD_NOT_READY".into());
    }
    // Activation acknowledges the current consumer configuration before success.
    // Failure still cancels this exact worker; no parent exit is authorized.
    activate(transport)?;
    prepared.child.committed = true;
    Ok(())
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum InputElevationOutcome {
    InputReady,
}

#[tauri::command]
pub async fn restart_elevated_application(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
    ticket: String,
) -> Result<InputElevationOutcome, String> {
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
            crate::core::device::activate_elevated_input,
        )?;
        Ok(InputElevationOutcome::InputReady)
    })
    .await
    .map_err(|_| "ELEVATION_HANDOFF_FAILED")?
}

#[cfg(test)]
#[path = "elevation_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) use tests::transport_pair as test_transport_pair;
