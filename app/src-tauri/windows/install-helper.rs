//! Purpose-limited NSIS helper, compiled separately without app dependencies.
//!
//! Only two commands exist: a read-only process guard and verified WebView2
//! installation with fixed arguments. This file also builds with `rustc --test`;
//! test fixtures and verification-only calls are absent from the shipped helper.
#![cfg(windows)]
#![cfg_attr(not(test), windows_subsystem = "windows")]

use std::{
    ffi::{OsString, c_void},
    fs::{File, OpenOptions},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Component, Path, PathBuf, Prefix},
    process::Command,
    ptr::{null, null_mut},
};

const APP_EXE: &str = "dmelopers-3d-block-pet.exe";
const ERROR_INVALID_PARAMETER: i32 = 87;
const ERROR_INSTALL_FAILURE: i32 = 1603;
const ERROR_INSTALL_ALREADY_RUNNING: i32 = 1618;
const ERROR_NO_MORE_FILES: u32 = 18;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_SHARE_READ: u32 = 1;
const FILE_READ_ATTRIBUTES: u32 = 0x80;
type Handle = *mut c_void;

#[repr(C)]
struct ProcessEntry {
    size: u32,
    usage: u32,
    process_id: u32,
    default_heap_id: usize,
    module_id: u32,
    threads: u32,
    parent_process_id: u32,
    priority: i32,
    flags: u32,
    exe_file: [u16; 260],
}

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

#[repr(C)]
struct WintrustFileInfo {
    size: u32,
    path: *const u16,
    file: Handle,
    known_subject: *const Guid,
}

#[repr(C)]
struct WintrustData {
    size: u32,
    policy_callback: *mut c_void,
    sip_client: *mut c_void,
    ui_choice: u32,
    revocation_checks: u32,
    union_choice: u32,
    file_info: *mut WintrustFileInfo,
    state_action: u32,
    state_data: Handle,
    url_reference: *mut u16,
    provider_flags: u32,
    ui_context: u32,
    signature_settings: *mut c_void,
}

// Only this documented prefix is read. The provider owns the complete object
// and its certificate until WTD_STATEACTION_CLOSE.
#[repr(C)]
struct ProviderCertificatePrefix {
    size: u32,
    certificate: *const c_void,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetLastError() -> u32;
}

#[link(name = "wintrust")]
unsafe extern "system" {
    fn WinVerifyTrust(window: Handle, action: *const Guid, data: *mut WintrustData) -> i32;
    fn WTHelperProvDataFromStateData(state: Handle) -> *mut c_void;
    fn WTHelperGetProvSignerFromChain(
        provider: *mut c_void,
        signer_index: u32,
        counter_signer: i32,
        counter_signer_index: u32,
    ) -> *mut c_void;
    fn WTHelperGetProvCertFromChain(
        signer: *mut c_void,
        certificate_index: u32,
    ) -> *const ProviderCertificatePrefix;
}

#[link(name = "crypt32")]
unsafe extern "system" {
    fn CertGetNameStringW(
        certificate: *const c_void,
        name_type: u32,
        flags: u32,
        type_parameter: *const c_void,
        output: *mut u16,
        capacity: u32,
    ) -> u32;
}

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    InvalidArguments,
    ProcessStateUnknown,
    AppRunning,
    UnsafePath,
    FileUnavailable,
    SignatureUntrusted(i32),
    PublisherNotMicrosoft,
    ChildLaunchFailed,
}

impl Failure {
    fn exit_code(&self) -> i32 {
        match self {
            Self::InvalidArguments => ERROR_INVALID_PARAMETER,
            Self::AppRunning => ERROR_INSTALL_ALREADY_RUNNING,
            _ => ERROR_INSTALL_FAILURE,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Guard,
    InstallWebview(PathBuf),
}

fn parse_request(args: &[OsString]) -> Result<Request, Failure> {
    match args {
        [command] if command == "--update-install-guard" => Ok(Request::Guard),
        [command, path] if command == "--install-webview2" => {
            let path = PathBuf::from(path);
            validate_path(&path)?;
            Ok(Request::InstallWebview(path))
        }
        _ => Err(Failure::InvalidArguments),
    }
}

fn validate_path(path: &Path) -> Result<(), Failure> {
    // Only an explicit local drive path is accepted. No UNC/device namespaces,
    // alternate streams, relative components or ambiguous Win32 normalization.
    let mut parts = path.components();
    if !matches!(parts.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
        || !matches!(parts.next(), Some(Component::RootDir))
    {
        return Err(Failure::UnsafePath);
    }
    let mut count = 0;
    for part in parts {
        let Component::Normal(name) = part else {
            return Err(Failure::UnsafePath);
        };
        let encoded: Vec<_> = name.encode_wide().collect();
        if encoded.is_empty()
            || encoded.iter().any(|c| matches!(*c, 0 | 34 | 58))
            || encoded.last().is_some_and(|c| matches!(*c, 32 | 46))
        {
            return Err(Failure::UnsafePath);
        }
        count += 1;
    }
    if count == 0
        || !path
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("exe"))
    {
        return Err(Failure::UnsafePath);
    }
    // Components normalizes interior `.` segments, so reject these in the
    // original representation as well, before opening or executing anything.
    if path
        .as_os_str()
        .encode_wide()
        .collect::<Vec<_>>()
        .split(|c| matches!(*c, 47 | 92))
        .any(|part| part == [46] || part == [46, 46])
    {
        return Err(Failure::UnsafePath);
    }
    Ok(())
}

fn require_no_app_process() -> Result<(), Failure> {
    // Toolhelp enumerates all sessions without requiring access to each owner.
    // Never terminate a process and never turn an enumeration error into clear.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        if snapshot == -1isize as Handle {
            return Err(Failure::ProcessStateUnknown);
        }
        let mut entry: ProcessEntry = std::mem::zeroed();
        entry.size = std::mem::size_of::<ProcessEntry>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry);
        let mut enumeration_error = if more == 0 { GetLastError() } else { 0 };
        let mut result = Ok(());
        while more != 0 {
            let length = entry.exe_file.iter().position(|v| *v == 0).unwrap_or(260);
            let name = String::from_utf16_lossy(&entry.exe_file[..length]);
            if name.eq_ignore_ascii_case(APP_EXE) {
                result = Err(Failure::AppRunning);
                break;
            }
            more = Process32NextW(snapshot, &mut entry);
            // Capture before `name` is dropped: its allocator may call Windows
            // APIs and overwrite the thread's last-error value.
            if more == 0 {
                enumeration_error = GetLastError();
            }
        }
        if result.is_ok() && enumeration_error != ERROR_NO_MORE_FILES {
            result = Err(Failure::ProcessStateUnknown);
        }
        CloseHandle(snapshot);
        result
    }
}

struct LockedExecutable {
    path: PathBuf,
    file: File,
    // Open each parent without write/delete sharing before opening its child.
    // This prevents replacing an ancestor or turning it into a reparse point
    // between signature verification and CreateProcess. These locks do not
    // prevent the child from creating ordinary files inside those directories.
    _parents: Vec<File>,
}

impl LockedExecutable {
    fn open(path: &Path) -> Result<Self, Failure> {
        validate_path(path)?;
        let mut parents = Vec::new();
        let ancestors: Vec<_> = path.ancestors().skip(1).collect();
        for ancestor in ancestors.into_iter().rev() {
            let directory = OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
                .open(ancestor)
                .map_err(|_| Failure::FileUnavailable)?;
            let metadata = directory.metadata().map_err(|_| Failure::FileUnavailable)?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(Failure::UnsafePath);
            }
            parents.push(directory);
        }
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| Failure::FileUnavailable)?;
        let metadata = file.metadata().map_err(|_| Failure::FileUnavailable)?;
        if !metadata.is_file()
            || metadata.len() == 0
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(Failure::UnsafePath);
        }
        Ok(Self {
            path: path.to_owned(),
            file,
            _parents: parents,
        })
    }

    fn verify_microsoft_signature(&self) -> Result<(), Failure> {
        let path: Vec<_> = self.path.as_os_str().encode_wide().chain(Some(0)).collect();
        let action = Guid {
            data1: 0x00aa_c56b,
            data2: 0xcd44,
            data3: 0x11d0,
            data4: [0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee],
        }; // WINTRUST_ACTION_GENERIC_VERIFY_V2
        let mut info = WintrustFileInfo {
            size: std::mem::size_of::<WintrustFileInfo>() as u32,
            path: path.as_ptr(),
            file: self.file.as_raw_handle(),
            known_subject: null(),
        };
        let mut trust = WintrustData {
            size: std::mem::size_of::<WintrustData>() as u32,
            policy_callback: null_mut(),
            sip_client: null_mut(),
            ui_choice: 2,
            revocation_checks: 0,
            union_choice: 1,
            file_info: &mut info,
            state_action: 1,
            state_data: null_mut(),
            url_reference: null_mut(),
            // Check revocation through the chain except the root and disable
            // MD2/MD4. Windows may retrieve CRL/AIA data. Offline trust failure
            // is an install failure; there is no trust-bypass retry.
            provider_flags: 0x80 | 0x2000,
            ui_context: 1,
            signature_settings: null_mut(),
        };
        unsafe {
            let status = WinVerifyTrust(-1isize as Handle, &action, &mut trust);
            let result = if status == 0 {
                verified_signer_is_microsoft(trust.state_data)
            } else {
                Err(Failure::SignatureUntrusted(status))
            };
            // Required after every VERIFY, including failed verification.
            trust.state_action = 2;
            WinVerifyTrust(-1isize as Handle, &action, &mut trust);
            result
        }
    }

    fn install_webview(&self) -> Result<i32, Failure> {
        self.verify_microsoft_signature()?;
        self.execute_fixed_webview_command()
    }

    fn execute_fixed_webview_command(&self) -> Result<i32, Failure> {
        // Command uses an explicit executable path and exactly these two
        // arguments. No shell, user-supplied switches or elevation is available.
        // Keep self (file and ancestors) alive until the child has exited.
        Command::new(&self.path)
            .args(["/silent", "/install"])
            .status()
            .map_err(|_| Failure::ChildLaunchFailed)?
            .code()
            .ok_or(Failure::ChildLaunchFailed)
    }
}

fn verified_signer_is_microsoft(state: Handle) -> Result<(), Failure> {
    // Retrieve the actual primary code signer selected by WinVerifyTrust, not a
    // timestamp signer or an unrelated certificate embedded in the PKCS#7.
    unsafe {
        let provider = WTHelperProvDataFromStateData(state);
        if provider.is_null() {
            return Err(Failure::PublisherNotMicrosoft);
        }
        let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
        if signer.is_null() {
            return Err(Failure::PublisherNotMicrosoft);
        }
        let certificate = WTHelperGetProvCertFromChain(signer, 0);
        if certificate.is_null() || (*certificate).certificate.is_null() {
            return Err(Failure::PublisherNotMicrosoft);
        }
        // CERT_NAME_ATTR_TYPE with the subject organization OID. Match the
        // entire attribute; display-name or subject substring matches can be
        // forged by an unrelated publisher. The OS validated the chain above.
        let oid = b"2.5.4.10\0";
        let size = CertGetNameStringW(
            (*certificate).certificate,
            3,
            0,
            oid.as_ptr().cast(),
            null_mut(),
            0,
        );
        if !(2..=256).contains(&size) {
            return Err(Failure::PublisherNotMicrosoft);
        }
        let mut value = vec![0u16; size as usize];
        if CertGetNameStringW(
            (*certificate).certificate,
            3,
            0,
            oid.as_ptr().cast(),
            value.as_mut_ptr(),
            size,
        ) != size
            || value.last() != Some(&0)
            || value[..value.len() - 1]
                != "Microsoft Corporation".encode_utf16().collect::<Vec<_>>()
        {
            return Err(Failure::PublisherNotMicrosoft);
        }
        Ok(())
    }
}

fn run(args: &[OsString]) -> Result<i32, Failure> {
    match parse_request(args)? {
        Request::Guard => require_no_app_process().map(|_| 0),
        Request::InstallWebview(path) => LockedExecutable::open(&path)?.install_webview(),
    }
}

fn main() {
    let result = run(&std::env::args_os().skip(1).collect::<Vec<_>>());
    std::process::exit(match result {
        Ok(code) => code,
        Err(error) => error.exit_code(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_extra_switches_relative_device_and_ambiguous_paths() {
        assert_eq!(
            parse_request(&["--update-install-guard".into()]),
            Ok(Request::Guard)
        );
        for args in [
            vec![],
            vec!["--update-install-guard", "extra"],
            vec!["--install-webview2"],
            vec!["--install-webview2", r"C:\valid.exe", "/evil"],
            vec!["--anything"],
        ] {
            let args: Vec<_> = args.into_iter().map(OsString::from).collect();
            assert_eq!(parse_request(&args), Err(Failure::InvalidArguments));
        }
        for path in [
            r"file.exe",
            r"C:file.exe",
            r"\\server\share\file.exe",
            r"\\?\C:\file.exe",
            r"\\.\C:\file.exe",
            r"C:\a\..\file.exe",
            r"C:\a\.\file.exe",
            r"C:\file.exe:stream",
            "C:\\file.exe ",
            r"C:\folder.\file.exe",
            "C:\\a\0.exe",
            r"C:\file.cmd",
        ] {
            assert_eq!(
                validate_path(Path::new(path)),
                Err(Failure::UnsafePath),
                "{path:?}"
            );
        }
        assert!(
            validate_path(Path::new(r"C:\한글 😶 test\MicrosoftEdgeWebview2Setup.exe")).is_ok()
        );
    }

    #[test]
    fn ffi_layout_matches_windows_x64_sdk() {
        assert_eq!(std::mem::size_of::<ProcessEntry>(), 568);
        assert_eq!(std::mem::offset_of!(ProcessEntry, exe_file), 44);
        assert_eq!(std::mem::size_of::<WintrustFileInfo>(), 32);
        assert_eq!(std::mem::size_of::<WintrustData>(), 88);
        assert_eq!(
            std::mem::offset_of!(ProviderCertificatePrefix, certificate),
            8
        );
    }

    #[test]
    fn fixture_signatures_locks_and_rejection() {
        // The private runner supplies temporary unsigned/tampered copies and
        // genuine signed vendor executables. This only verifies them: no
        // WebView2/vendor executable is launched by this test.
        let fixture = PathBuf::from(
            std::env::var_os("BLOCK_PET_HELPER_TEST_FIXTURES")
                .expect("run through test_install_helper.py"),
        );
        let unsigned = fixture.join("unsigned.exe");
        let file = LockedExecutable::open(&unsigned).unwrap();
        assert!(matches!(
            file.verify_microsoft_signature(),
            Err(Failure::SignatureUntrusted(_))
        ));
        assert!(OpenOptions::new().write(true).open(&unsigned).is_err());
        assert!(std::fs::remove_file(&unsigned).is_err());
        assert!(
            std::fs::rename(unsigned.parent().unwrap(), fixture.with_extension("moved")).is_err()
        );
        // A directory handle lock must not prevent normal child-file creation.
        let sibling = fixture.join("sibling.txt");
        std::fs::write(&sibling, b"allowed").unwrap();
        std::fs::remove_file(sibling).unwrap();
        drop(file);
        assert!(OpenOptions::new().write(true).open(&unsigned).is_ok());
        let microsoft = LockedExecutable::open(&fixture.join("microsoft.exe")).unwrap();
        assert_eq!(microsoft.verify_microsoft_signature(), Ok(()));
        let other = LockedExecutable::open(&fixture.join("other-publisher.exe")).unwrap();
        assert_eq!(
            other.verify_microsoft_signature(),
            Err(Failure::PublisherNotMicrosoft)
        );
        let tampered = LockedExecutable::open(&fixture.join("tampered.exe")).unwrap();
        assert!(matches!(
            tampered.verify_microsoft_signature(),
            Err(Failure::SignatureUntrusted(_))
        ));
        assert!(LockedExecutable::open(&fixture.join("missing.exe")).is_err());
        assert!(LockedExecutable::open(&fixture.join("directory.exe")).is_err());
        assert!(LockedExecutable::open(&fixture.join("junction").join("unsigned.exe")).is_err());
    }

    #[test]
    fn fixed_child_arguments_locks_wait_and_exit_code() {
        // Only a test can call the private execution boundary without first
        // verifying the signature. Production exposes no verification bypass.
        let fixture = PathBuf::from(
            std::env::var_os("BLOCK_PET_HELPER_TEST_FIXTURES")
                .expect("run through test_install_helper.py"),
        );
        for (name, expected) in [("child-zero.exe", 0), ("child-nonzero.exe", 37)] {
            let path = fixture.join(name);
            let started = path.with_extension("started");
            let proceed = path.with_extension("continue");
            let locked = LockedExecutable::open(&path).unwrap();
            let worker = std::thread::spawn(move || locked.execute_fixed_webview_command());
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !started.exists() && !worker.is_finished() && std::time::Instant::now() < deadline
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            let started_ok = started.exists();
            let waiting = !worker.is_finished();
            let write_blocked = OpenOptions::new().write(true).open(&path).is_err();
            let delete_blocked = std::fs::remove_file(&path).is_err();
            let parent_rename_blocked =
                std::fs::rename(&fixture, fixture.with_extension("moved")).is_err();
            // Child created its own sibling marker; parent can signal it while
            // all executable and ancestor locks remain alive in the worker.
            std::fs::write(proceed, b"continue").unwrap();
            let actual = worker.join().unwrap();
            assert!(
                started_ok && waiting && write_blocked && delete_blocked && parent_rename_blocked
            );
            assert_eq!(actual, Ok(expected));
            assert!(OpenOptions::new().write(true).open(&path).is_ok());
        }
        let invalid = fixture.join("invalid-image.exe");
        std::fs::write(&invalid, b"not a PE image").unwrap();
        let locked = LockedExecutable::open(&invalid).unwrap();
        assert_eq!(
            locked.execute_fixed_webview_command(),
            Err(Failure::ChildLaunchFailed)
        );
    }
}
