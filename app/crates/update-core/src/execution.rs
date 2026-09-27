//! Keep an authenticated installer's pathname bound until its process exits.
use crate::{UpdateError, fail};
use std::{
    ffi::OsStr,
    fs::{File, OpenOptions},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf, Prefix},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, STILL_ACTIVE, WAIT_OBJECT_0},
    Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    },
    System::Threading::{
        CreateProcessW, GetExitCodeProcess, INFINITE, PROCESS_INFORMATION, STARTUPINFOW,
        WaitForSingleObject,
    },
};

pub(crate) struct VerifiedExecutable {
    path: PathBuf,
    _file: File,
    _parents: Vec<File>,
}

impl VerifiedExecutable {
    pub(crate) fn verify(
        path: &Path,
        size: u64,
        sha256: &str,
        signature: &str,
        trust: &crate::feed::Trust,
    ) -> Result<Self, UpdateError> {
        let locked = Self::open(path)?;
        if locked._file.metadata()?.len() != size
            || crate::integrity::hash_file(path).map_err(|_| fail("IO_ERROR"))? != sha256
        {
            return Err(fail("INTEGRITY_FAILED"));
        }
        trust.verify_file(path, signature)?;
        Ok(locked)
    }

    fn open(path: &Path) -> Result<Self, UpdateError> {
        validate_path(path)?;
        let mut parents = Vec::new();
        // Acquire top down. An already checked ancestor must not be renamed
        // or converted to a junction while a descendant is being opened.
        for ancestor in path
            .ancestors()
            .skip(1)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            let file = OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
                .open(ancestor)?;
            let metadata = file.metadata()?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(fail("UNSAFE_PATH"));
            }
            parents.push(file);
        }
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.len() == 0
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(fail("UNSAFE_PATH"));
        }
        Ok(Self {
            path: path.to_owned(),
            _file: file,
            _parents: parents,
        })
    }

    pub(crate) fn run_nsis(
        &self,
        mode: &str,
        from_version: &str,
        install_root: &Path,
    ) -> Result<i32, UpdateError> {
        if !matches!(mode, "CurrentUser" | "AllUsers")
            || from_version.is_empty()
            || !from_version
                .bytes()
                .all(|c| c.is_ascii_digit() || c == b'.')
        {
            return Err(fail("INVALID_REQUEST"));
        }
        validate_path(&install_root.join("path-validation.exe"))?;
        let mut arguments: Vec<u16> = format!("/UPDATE /P /{mode} /FROMVERSION={from_version} /D=")
            .encode_utf16()
            .collect();
        // NSIS /D consumes the unquoted remainder and must stay last. Preserve
        // native UTF-16, including non-BMP profile names, without lossy display.
        arguments.extend(install_root.as_os_str().encode_wide());
        self.run(&arguments, || {})
    }

    fn run(&self, arguments: &[u16], after_launch: impl FnOnce()) -> Result<i32, UpdateError> {
        self.run_with_wait(arguments, after_launch, |process| unsafe {
            WaitForSingleObject(process, INFINITE)
        })
    }

    fn run_with_wait(
        &self,
        arguments: &[u16],
        after_launch: impl FnOnce(),
        mut wait: impl FnMut(HANDLE) -> u32,
    ) -> Result<i32, UpdateError> {
        if arguments.contains(&0) {
            return Err(fail("INVALID_REQUEST"));
        }
        let application = wide(self.path.as_os_str());
        let mut command = vec![b'"' as u16];
        command.extend(self.path.as_os_str().encode_wide());
        command.extend([b'"' as u16, b' ' as u16]);
        command.extend(arguments);
        command.push(0);
        if command.len() > 32767 {
            return Err(fail("INVALID_REQUEST"));
        }
        let directory = wide(
            self.path
                .parent()
                .ok_or_else(|| fail("UNSAFE_PATH"))?
                .as_os_str(),
        );
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut information: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // Explicit application and fixed adapter arguments, no shell or handle
        // inheritance. These are the caller's privileges; elevation stays in
        // the independently authenticated worker entry path.
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                0,
                std::ptr::null(),
                directory.as_ptr(),
                &startup,
                &mut information,
            )
        } == 0
        {
            return Err(fail("INSTALLER_LAUNCH_FAILED"));
        }
        let process = Process(information.hProcess);
        unsafe {
            CloseHandle(information.hThread);
        }
        after_launch();
        let mut wait_failed = false;
        loop {
            let signaled = wait(process.0) == WAIT_OBJECT_0;
            wait_failed |= !signaled;
            let mut code = 0;
            let observed = unsafe { GetExitCodeProcess(process.0, &mut code) } != 0;
            if signaled || (observed && code != STILL_ACTIVE as u32) {
                if wait_failed || !observed {
                    return Err(fail("INSTALLER_STATE_UNKNOWN"));
                }
                // Preserve the full Windows exit code, including 259 after a
                // signaled handle; that value alone cannot prove liveness.
                return Ok(code as i32);
            }
            // A failed wait does not prove termination. Keep this executable
            // and all ancestors locked, and retain the failure even if a later
            // query succeeds. Never start rollback against a live installer.
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

struct Process(HANDLE);
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn validate_path(path: &Path) -> Result<(), UpdateError> {
    let mut parts = path.components();
    if !matches!(parts.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        || !matches!(parts.next(), Some(Component::RootDir))
    {
        return Err(fail("UNSAFE_PATH"));
    }
    let mut count = 0;
    for part in parts {
        let Component::Normal(name) = part else {
            return Err(fail("UNSAFE_PATH"));
        };
        let text: Vec<_> = name.encode_wide().collect();
        if text.is_empty()
            || text.iter().any(|c| matches!(*c, 0 | 34 | 58))
            || text.last().is_some_and(|c| matches!(*c, 32 | 46))
        {
            return Err(fail("UNSAFE_PATH"));
        }
        count += 1;
    }
    if count == 0
        || path
            .as_os_str()
            .encode_wide()
            .collect::<Vec<_>>()
            .split(|c| matches!(*c, 47 | 92))
            .any(|part| part == [46] || part == [46, 46])
    {
        return Err(fail("UNSAFE_PATH"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn authenticates_the_locked_bytes_and_rejects_wrong_hash_size_or_signature() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src-tauri/src/update_delivery/signature-fixture.json"
        ))
        .unwrap();
        let trust = crate::feed::Trust {
            schema_version: 1,
            repository: crate::feed::OFFICIAL_REPOSITORY.into(),
            repository_id: Some(42),
            public_key: Some(fixture["publicKey"].as_str().unwrap().into()),
        };
        let message = fixture["message"].as_str().unwrap().as_bytes();
        let signature = fixture["signature"].as_str().unwrap();
        let digest = crate::integrity::digest(message);
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("installer.exe");
        fs::write(&path, message).unwrap();
        let verified =
            VerifiedExecutable::verify(&path, message.len() as u64, &digest, signature, &trust)
                .unwrap();
        assert!(fs::write(&path, b"replaced after signature check").is_err());
        drop(verified);
        assert!(
            VerifiedExecutable::verify(&path, message.len() as u64 + 1, &digest, signature, &trust)
                .is_err()
        );
        assert!(
            VerifiedExecutable::verify(
                &path,
                message.len() as u64,
                &"0".repeat(64),
                signature,
                &trust
            )
            .is_err()
        );
        assert!(
            VerifiedExecutable::verify(&path, message.len() as u64, &digest, "invalid", &trust)
                .is_err()
        );
        let changed = vec![b'x'; message.len()];
        fs::write(&path, &changed).unwrap();
        assert!(
            VerifiedExecutable::verify(
                &path,
                changed.len() as u64,
                &crate::integrity::digest(&changed),
                signature,
                &trust
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_a_junction_ancestor_without_trusting_its_target() {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn DeviceIoControl(
                handle: HANDLE,
                code: u32,
                input: *const std::ffi::c_void,
                input_size: u32,
                output: *mut std::ffi::c_void,
                output_size: u32,
                returned: *mut u32,
                overlapped: *mut std::ffi::c_void,
            ) -> i32;
        }
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        let link = temp.path().join("junction");
        fs::create_dir(&real).unwrap();
        fs::create_dir(&link).unwrap();
        fs::write(real.join("installer.exe"), b"fixture").unwrap();
        let target: Vec<u16> = format!("\\??\\{}", real.display()).encode_utf16().collect();
        let print: Vec<u16> = real.as_os_str().encode_wide().collect();
        let length = 8 + (target.len() + 1 + print.len() + 1) * 2;
        let mut buffer = Vec::new();
        buffer.extend(0xa0000003u32.to_le_bytes());
        for value in [
            length as u16,
            0,
            0,
            (target.len() * 2) as u16,
            ((target.len() + 1) * 2) as u16,
            (print.len() * 2) as u16,
        ] {
            buffer.extend(value.to_le_bytes());
        }
        for value in target
            .into_iter()
            .chain(Some(0))
            .chain(print)
            .chain(Some(0))
        {
            buffer.extend(value.to_le_bytes());
        }
        let handle = OpenOptions::new()
            .access_mode(0x40000000)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(&link)
            .unwrap();
        let mut returned = 0;
        assert_ne!(
            unsafe {
                DeviceIoControl(
                    handle.as_raw_handle(),
                    0x000900a4,
                    buffer.as_ptr().cast(),
                    buffer.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            },
            0,
            "{}",
            std::io::Error::last_os_error()
        );
        drop(handle);
        assert!(VerifiedExecutable::open(&link.join("installer.exe")).is_err());
        assert_eq!(fs::read(real.join("installer.exe")).unwrap(), b"fixture");
        fs::remove_dir(&link).unwrap();
    }

    #[test]
    fn denies_replacement_of_the_file_and_ancestors_until_release() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("업데이트 😶 공백");
        fs::create_dir(&dir).unwrap();
        let path = dir.join("installer.exe");
        fs::write(&path, b"verified fixture").unwrap();
        let locked = VerifiedExecutable::open(&path).unwrap();
        assert!(fs::write(&path, b"replacement").is_err());
        assert!(fs::rename(&path, dir.join("replaced.exe")).is_err());
        assert!(fs::rename(&dir, temp.path().join("moved")).is_err());
        assert_eq!(fs::read(&locked.path).unwrap(), b"verified fixture");
        fs::write(dir.join("ordinary-child"), b"allowed").unwrap();
        drop(locked);
        fs::write(&path, b"replacement after release").unwrap();
        fs::rename(&dir, temp.path().join("moved")).unwrap();
    }

    #[test]
    fn rejects_ambiguous_paths_before_opening() {
        for path in [
            r"relative\installer.exe",
            r"C:installer.exe",
            r"\\server\share\installer.exe",
            r"C:\safe\..\installer.exe",
            r"C:\safe\.\installer.exe",
            r"C:\safe\installer.exe:stream",
            "C:\\safe\\name.\\installer.exe",
            "C:\\safe\\name \\installer.exe",
            "C:\\safe\\bad\0.exe",
        ] {
            assert!(validate_path(Path::new(path)).is_err(), "{path:?}");
        }
        for path in [
            r"C:\업데이트 😶 공백\installer.exe",
            r"\\?\C:\safe\installer.exe",
        ] {
            validate_path(Path::new(path)).unwrap();
        }
    }

    #[test]
    fn running_child_keeps_file_and_parent_locks() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("실행 😶 폴더");
        fs::create_dir(&dir).unwrap();
        let path = dir.join("child.exe");
        fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
        let locked = VerifiedExecutable::open(&path).unwrap();
        let args: Vec<_> = "--exact execution::tests::child_wait --ignored"
            .encode_utf16()
            .collect();
        assert_eq!(
            locked
                .run(&args, || {
                    assert!(fs::write(&path, b"replacement").is_err());
                    assert!(fs::rename(&dir, temp.path().join("moved")).is_err());
                })
                .unwrap(),
            0
        );
        drop(locked);
        fs::rename(&dir, temp.path().join("moved")).unwrap();
    }

    #[test]
    fn returns_child_failure_and_rejects_unlaunchable_content() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("child.exe");
        fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
        let locked = VerifiedExecutable::open(&path).unwrap();
        let args: Vec<_> = "--exact execution::tests::child_failure --ignored"
            .encode_utf16()
            .collect();
        assert_ne!(locked.run(&args, || {}).unwrap(), 0);
        drop(locked);
        fs::write(&path, b"not an executable").unwrap();
        let locked = VerifiedExecutable::open(&path).unwrap();
        assert_eq!(
            locked
                .run(&[], || panic!("must not launch"))
                .unwrap_err()
                .code,
            "INSTALLER_LAUNCH_FAILED"
        );
    }

    #[test]
    fn a_wait_failure_keeps_locks_until_the_child_is_confirmed_exited() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("wait-error");
        fs::create_dir(&dir).unwrap();
        let path = dir.join("child.exe");
        fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
        let locked = VerifiedExecutable::open(&path).unwrap();
        let args: Vec<_> = "--exact execution::tests::child_wait --ignored"
            .encode_utf16()
            .collect();
        let mut calls = 0;
        let result = locked.run_with_wait(
            &args,
            || {},
            |process| {
                calls += 1;
                assert!(fs::write(&path, b"replacement").is_err());
                assert!(fs::rename(&dir, temp.path().join("moved")).is_err());
                if calls == 1 {
                    windows_sys::Win32::Foundation::WAIT_FAILED
                } else {
                    unsafe { WaitForSingleObject(process, INFINITE) }
                }
            },
        );
        assert!(
            calls >= 2,
            "must not release after the injected first wait failure"
        );
        assert_eq!(result.unwrap_err().code, "INSTALLER_STATE_UNKNOWN");
        drop(locked);
        fs::rename(&dir, temp.path().join("moved")).unwrap();
    }

    #[test]
    #[ignore = "child fixture, invoked only by running_child_keeps_file_and_parent_locks"]
    fn child_wait() {
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    #[test]
    #[ignore = "child fixture, invoked only by returns_child_failure_and_rejects_unlaunchable_content"]
    fn child_failure() {
        panic!("expected child failure");
    }
}
