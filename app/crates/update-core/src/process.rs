//! Query only the process identity needed by an update. No command lines,
//! environment blocks, working directories or process memory are inspected.
use std::{ffi::OsString, io, os::windows::ffi::OsStringExt, path::PathBuf};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, FILETIME, GetLastError, HANDLE,
        INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            QueryFullProcessImageNameW, WaitForSingleObject,
        },
    },
};

const WINDOWS_TO_UNIX_SECONDS: u64 = 11_644_473_600;
const FILETIME_TICKS_PER_SECOND: u64 = 10_000_000;

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

#[derive(Debug)]
pub struct ProcessEntry {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: OsString,
}

/// Toolhelp exposes only IDs, parent IDs and executable names. Enumeration
/// failure is distinct from an empty process list.
pub fn snapshot() -> io::Result<Vec<ProcessEntry>> {
    let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let handle = Handle(handle);
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut available = unsafe { Process32FirstW(handle.0, &mut entry) };
    let mut processes = Vec::new();
    while available != 0 {
        let length = entry
            .szExeFile
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(entry.szExeFile.len());
        processes.push(ProcessEntry {
            pid: entry.th32ProcessID,
            parent_pid: entry.th32ParentProcessID,
            name: OsString::from_wide(&entry.szExeFile[..length]),
        });
        available = unsafe { Process32NextW(handle.0, &mut entry) };
    }
    let error = unsafe { GetLastError() };
    if error != ERROR_NO_MORE_FILES {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    Ok(processes)
}

pub(crate) struct ProcessHandle(Handle);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CreationIdentity {
    LegacySeconds(u64),
    Filetime100ns(u64),
}

impl ProcessHandle {
    /// A nonexistent PID is `None`; access denial and other query failures are
    /// errors. Never turn a failed lookup into permission to replace files.
    pub(crate) fn open(pid: u32) -> io::Result<Option<Self>> {
        if pid == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "PID zero is not an update owner",
            ));
        }
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            return classify_open_failure(unsafe { GetLastError() }).map(|()| None);
        }
        Ok(Some(Self(Handle(raw))))
    }

    pub(crate) fn raw(&self) -> HANDLE {
        self.0.0
    }

    pub(crate) fn is_alive(&self) -> io::Result<bool> {
        // An actual exit code of STILL_ACTIVE (259) is still a terminated
        // process. The process object's signal, not its exit code, owns this.
        match unsafe { WaitForSingleObject(self.raw(), 0) } {
            WAIT_OBJECT_0 => Ok(false),
            WAIT_TIMEOUT => Ok(true),
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub(crate) fn started_seconds(&self) -> io::Result<u64> {
        unix_seconds(self.created_100ns()?)
    }

    pub(crate) fn created_100ns(&self) -> io::Result<u64> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe {
            GetProcessTimes(
                self.raw(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    pub(crate) fn matches_creation(&self, expected: CreationIdentity) -> io::Result<bool> {
        creation_matches(self.created_100ns()?, expected)
    }

    pub(crate) fn executable(&self) -> io::Result<PathBuf> {
        // Windows executable paths are bounded by the extended path limit.
        let mut path = vec![0u16; 32_768];
        let mut length = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(self.raw(), 0, path.as_mut_ptr(), &mut length) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(PathBuf::from(OsString::from_wide(&path[..length as usize])))
    }
}

fn classify_open_failure(error: u32) -> io::Result<()> {
    if error == ERROR_INVALID_PARAMETER {
        // For a nonzero PID, OpenProcess uses this when the PID no longer exists.
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(error as i32))
    }
}

#[cfg(test)]
fn filetime_to_unix_seconds(time: FILETIME) -> io::Result<u64> {
    let ticks = (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    unix_seconds(ticks)
}

pub(crate) fn unix_seconds(ticks: u64) -> io::Result<u64> {
    (ticks / FILETIME_TICKS_PER_SECOND)
        .checked_sub(WINDOWS_TO_UNIX_SECONDS)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid process creation time"))
}

fn creation_matches(actual: u64, expected: CreationIdentity) -> io::Result<bool> {
    let seconds = unix_seconds(actual)?;
    match expected {
        CreationIdentity::LegacySeconds(value) => Ok(seconds == value),
        CreationIdentity::Filetime100ns(value) => {
            unix_seconds(value)?;
            Ok(actual == value)
        }
    }
}

pub(crate) fn current_started_seconds() -> io::Result<u64> {
    ProcessHandle::open(std::process::id())?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "current process is unavailable"))?
        .started_seconds()
}

pub(crate) fn current_created_100ns() -> io::Result<u64> {
    ProcessHandle::open(std::process::id())?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "current process is unavailable"))?
        .created_100ns()
}

pub(crate) fn identity_alive(pid: u32, created: CreationIdentity) -> io::Result<bool> {
    let Some(process) = ProcessHandle::open(pid)? else {
        return Ok(false);
    };
    Ok(process.is_alive()? && process.matches_creation(created)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_time_keeps_legacy_unix_seconds_including_fraction_truncation() {
        let seconds = 1_700_000_001;
        let ticks = (seconds + WINDOWS_TO_UNIX_SECONDS) * FILETIME_TICKS_PER_SECOND + 9_999_999;
        assert_eq!(
            filetime_to_unix_seconds(FILETIME {
                dwLowDateTime: ticks as u32,
                dwHighDateTime: (ticks >> 32) as u32,
            })
            .unwrap(),
            seconds
        );
        assert!(filetime_to_unix_seconds(FILETIME::default()).is_err());
    }

    #[test]
    fn denied_or_failed_queries_are_not_reported_as_exit() {
        use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_INVALID_HANDLE};
        assert!(classify_open_failure(ERROR_INVALID_PARAMETER).is_ok());
        assert_eq!(
            classify_open_failure(ERROR_ACCESS_DENIED)
                .unwrap_err()
                .raw_os_error(),
            Some(5)
        );
        assert!(classify_open_failure(ERROR_INVALID_HANDLE).is_err());
        assert!(ProcessHandle::open(0).is_err());
    }

    #[test]
    fn current_process_identity_uses_a_limited_handle_and_rejects_pid_reuse() {
        let current = ProcessHandle::open(std::process::id()).unwrap().unwrap();
        assert!(current.is_alive().unwrap());
        let started = current.started_seconds().unwrap();
        let mut legacy = sysinfo::System::new();
        let pid = sysinfo::Pid::from_u32(std::process::id());
        legacy.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[pid]),
            true,
            sysinfo::ProcessRefreshKind::nothing().without_tasks(),
        );
        assert_eq!(started, legacy.process(pid).unwrap().start_time());
        assert!(
            identity_alive(std::process::id(), CreationIdentity::LegacySeconds(started)).unwrap()
        );
        assert!(
            !identity_alive(
                std::process::id(),
                CreationIdentity::LegacySeconds(started - 1)
            )
            .unwrap()
        );
        let ticks = current.created_100ns().unwrap();
        assert_eq!(unix_seconds(ticks).unwrap(), started);
        assert_eq!(current_created_100ns().unwrap(), ticks);
        assert!(
            identity_alive(std::process::id(), CreationIdentity::Filetime100ns(ticks)).unwrap()
        );
        assert!(
            !identity_alive(
                std::process::id(),
                CreationIdentity::Filetime100ns(ticks + 1)
            )
            .unwrap()
        );
        assert_eq!(
            current.executable().unwrap(),
            std::env::current_exe().unwrap()
        );
        assert!(
            snapshot()
                .unwrap()
                .iter()
                .any(|entry| entry.pid == std::process::id())
        );
    }

    #[test]
    fn exact_creation_ticks_reject_different_processes_in_the_same_legacy_second() {
        let first = (1_700_000_001 + WINDOWS_TO_UNIX_SECONDS) * FILETIME_TICKS_PER_SECOND + 100;
        let reused = first + 1;
        let seconds = unix_seconds(first).unwrap();
        assert_eq!(unix_seconds(reused).unwrap(), seconds);
        assert!(creation_matches(reused, CreationIdentity::LegacySeconds(seconds)).unwrap());
        assert!(!creation_matches(reused, CreationIdentity::Filetime100ns(first)).unwrap());
        assert!(creation_matches(first, CreationIdentity::Filetime100ns(first)).unwrap());
    }

    #[test]
    fn exited_child_with_still_active_exit_code_is_not_alive() {
        use std::{
            os::windows::process::CommandExt,
            process::{Command, Stdio},
        };
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "process_exit_code_fixture", "--nocapture"])
            .env("DMELOPER_PROCESS_EXIT_TEST", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let process = ProcessHandle::open(child.id()).unwrap().unwrap();
        assert!(process.is_alive().unwrap());
        drop(child.stdin.take());
        assert_eq!(child.wait().unwrap().code(), Some(259));
        assert!(!process.is_alive().unwrap());
    }

    #[test]
    #[ignore = "subprocess fixture; only the lifecycle test supplies its input pipe"]
    fn process_exit_code_fixture() {
        if std::env::var("DMELOPER_PROCESS_EXIT_TEST").as_deref() == Ok("1") {
            use std::io::Read;
            let _ = std::io::stdin().read(&mut [0u8; 1]);
            std::process::exit(259);
        }
    }
}
