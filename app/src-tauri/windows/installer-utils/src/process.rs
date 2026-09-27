// Derived from Tauri nsis-process 0.5.3; see ../upstream-provenance.json.
use nsis_plugin_api::*;
extern crate alloc;

use alloc::borrow::ToOwned;
use core::{ffi::c_void, mem, ops::Deref, ops::DerefMut, ptr};

use windows_sys::{
    core::PCWSTR,
    w,
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES,
            ERROR_NOT_ALL_ASSIGNED, FALSE, HANDLE, INVALID_HANDLE_VALUE, LUID, TRUE,
        },
        Security::{
            AdjustTokenPrivileges, DuplicateTokenEx, GetTokenInformation,
            LookupPrivilegeValueW, SecurityAnonymous, TokenElevation, TokenPrimary,
            LUID_AND_ATTRIBUTES, SE_IMPERSONATE_NAME, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_DEFAULT,
            TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
            TOKEN_ELEVATION, TOKEN_PRIVILEGES, TOKEN_QUERY,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                CreateProcessWithTokenW, GetCurrentProcess, GetCurrentProcessId, OpenProcess,
                OpenProcessToken, PROCESS_INFORMATION,
                PROCESS_QUERY_LIMITED_INFORMATION, STARTUPINFOW,
            },
        },
        UI::{
            Shell::ShellExecuteW,
            WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId, SW_SHOW},
        },
    },
};

/// Return 0 when another process matches, 1 only after a complete no-match scan,
/// and 2 on inspection failure. NSIS permits uninstall only for exactly 1.
#[nsis_fn]
fn FindProcess() -> Result<(), Error> {
    let name = popstr()?;
    match find_process(&name) {
        Ok(true) => push(ZERO),
        Ok(false) => push(ONE),
        Err(_) => push(TWO),
    }
}

fn find_process(name: &str) -> Result<bool, u32> {
    if name.is_empty() {
        return Err(ERROR_INVALID_PARAMETER);
    }
    unsafe {
        let handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if handle == INVALID_HANDLE_VALUE {
            return Err(GetLastError());
        }
        let handle = OwnedHandle::new(handle);
        if handle.is_invalid() {
            return Err(ERROR_INVALID_PARAMETER);
        }
        scan_processes(name, GetCurrentProcessId(), |first, entry| {
            let success = if first {
                Process32FirstW(*handle, entry)
            } else {
                Process32NextW(*handle, entry)
            };
            if success == TRUE {
                Ok(true)
            } else {
                // Read immediately: cleanup/API calls can replace last-error.
                match GetLastError() {
                    ERROR_NO_MORE_FILES => Ok(false),
                    error => Err(error),
                }
            }
        })
    }
}

fn scan_processes(
    name: &str,
    current_pid: u32,
    mut step: impl FnMut(bool, &mut PROCESSENTRY32W) -> Result<bool, u32>,
) -> Result<bool, u32> {
    let name = name.to_lowercase();
    let mut process = PROCESSENTRY32W {
        dwSize: mem::size_of::<PROCESSENTRY32W>() as u32,
        ..unsafe { mem::zeroed() }
    };
    let mut first = true;
    while step(first, &mut process)? {
        first = false;
        if current_pid != process.th32ProcessID
            && decode_utf16_lossy(&process.szExeFile).to_lowercase() == name
        {
            return Ok(true);
        }
    }
    Ok(false)
}


/// Run program as unelevated user
///
/// This function takes 2 strings on the stack as parameters:
///
/// - $1: program
/// - $2: arguments
#[nsis_fn]
fn RunAsUser() -> Result<(), Error> {
    let program = popstr()?;
    let arguments = popstr()?;
    if run_as_user(&program, &arguments) {
        push(ZERO)
    } else {
        push(ONE)
    }
}


unsafe fn is_elevated(process: HANDLE) -> Option<bool> {
    let mut token_handle: HANDLE = ptr::null_mut();

    if OpenProcessToken(process, TOKEN_QUERY, &mut token_handle) == FALSE {
        return None;
    }

    let _token = OwnedHandle::new(token_handle);

    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut size: u32 = 0;

    let result = GetTokenInformation(
        token_handle,
        TokenElevation,
        &mut elevation as *mut _ as *mut _,
        mem::size_of::<TOKEN_ELEVATION>() as u32,
        &mut size,
    );
    (result != FALSE).then_some(elevation.TokenIsElevated != 0)
}

unsafe fn set_privilege(process: HANDLE, privilege: PCWSTR, enable: bool) -> Option<bool> {
    let mut token: HANDLE = ptr::null_mut();
    if OpenProcessToken(process, TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, &mut token) == FALSE {
        return None;
    }
    let token = OwnedHandle::new(token);

    let mut luid = LUID::default();
    if LookupPrivilegeValueW(ptr::null(), privilege, &mut luid) == FALSE {
        return None;
    }

    let token_privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: if enable { SE_PRIVILEGE_ENABLED } else { 0 },
        }],
    };

    let mut previous_state = TOKEN_PRIVILEGES::default();
    let mut return_length = 0;
    let result = AdjustTokenPrivileges(
        *token,
        FALSE,
        &token_privileges,
        mem::size_of::<TOKEN_PRIVILEGES>() as u32,
        &mut previous_state,
        &mut return_length,
    );
    if result == FALSE || GetLastError() == ERROR_NOT_ALL_ASSIGNED {
        return None;
    }

    if previous_state.PrivilegeCount == 1 {
        let was_enabled = (previous_state.Privileges[0].Attributes & SE_PRIVILEGE_ENABLED) != 0;
        Some(was_enabled)
    } else {
        Some(enable)
    }
}

/// Return true if success
///
/// Ported from https://source.chromium.org/chromium/chromium/src/+/main:base/win/elevation_util.cc;drc=36e1c43ace542988d624bd1bc0813c184482d2ab;l=69
/// Based on https://learn.microsoft.com/en-us/archive/blogs/aaron_margosis/faq-how-do-i-start-a-program-as-the-desktop-user-from-an-elevated-app
unsafe fn run_as_user(program: &str, arguments: &str) -> bool {
    let current_process = GetCurrentProcess();
    match is_elevated(current_process) {
        Some(false) => return shell_execute(&encode_utf16(program), arguments),
        Some(true) => {},
        None => return false, // Do not treat a token-query failure as unelevated.
    }

    let hwnd = GetShellWindow();
    if hwnd.is_null() {
        return false;
    }

    let mut process_id = 0;
    if GetWindowThreadProcessId(hwnd, &mut process_id) == FALSE as u32 {
        return false;
    }

    let process = OwnedHandle::new(OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION,
        FALSE,
        process_id,
    ));
    if process.is_invalid() || is_elevated(*process) != Some(false) {
        return false;
    }

    let privilege = SE_IMPERSONATE_NAME;
    let Some(enabled_previously) = set_privilege(current_process, privilege, true) else {
        return false;
    };
    let _impersonate_guard = RevertPrivilegeOnDrop {
        process: current_process,
        privilege,
        previous_state: enabled_previously,
    };

    let mut handle_token: HANDLE = ptr::null_mut();
    if OpenProcessToken(*process, TOKEN_QUERY | TOKEN_DUPLICATE, &mut handle_token) == FALSE {
        return false;
    }
    let handle_token = OwnedHandle::new(handle_token);

    let mut handle_new_token: HANDLE = ptr::null_mut();
    if DuplicateTokenEx(
        *handle_token,
        TOKEN_QUERY
            | TOKEN_ASSIGN_PRIMARY
            | TOKEN_DUPLICATE
            | TOKEN_ADJUST_DEFAULT
            | TOKEN_ADJUST_SESSIONID,
        ptr::null(),
        SecurityAnonymous,
        TokenPrimary,
        &mut handle_new_token,
    ) == FALSE
    {
        return false;
    }
    let handle_new_token = OwnedHandle::new(handle_new_token);

    let program_wide = encode_utf16(program);
    let mut command_line = "\"".to_owned() + program + "\"";
    if !arguments.is_empty() {
        command_line.push(' ');
        command_line.push_str(arguments);
    }
    let mut command_line_wide = encode_utf16(&command_line);

    let startup_info = STARTUPINFOW {
        cb: mem::size_of::<STARTUPINFOW>() as u32,
        ..mem::zeroed()
    };
    let mut process_info: PROCESS_INFORMATION = mem::zeroed();

    let success = CreateProcessWithTokenW(
        *handle_new_token,
        0,
        program_wide.as_ptr(),
        command_line_wide.as_mut_ptr(),
        0,
        ptr::null(),
        ptr::null(),
        &startup_info,
        &mut process_info,
    );

    if success != FALSE {
        CloseHandle(process_info.hProcess);
        CloseHandle(process_info.hThread);
        true
    // The installed application must launch as the shell user. Never fall back
    // to launching it with the elevated installer token after token launch fails.
    } else {
        false
    }
}

fn shell_execute(program_wide: &[u16], arguments: &str) -> bool {
    let arguments_wide = encode_utf16(arguments);
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            w!("open"),
            program_wide.as_ptr(),
            arguments_wide.as_ptr(),
            ptr::null(),
            SW_SHOW,
        )
    };
    result as isize > 32
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE) -> Self {
        Self(handle)
    }

    fn is_invalid(&self) -> bool {
        self.0.is_null() || self.0 == INVALID_HANDLE_VALUE
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.is_invalid() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

impl Deref for OwnedHandle {
    type Target = HANDLE;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for OwnedHandle {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

struct RevertPrivilegeOnDrop {
    process: *mut c_void,
    privilege: *const u16,
    previous_state: bool,
}

impl Drop for RevertPrivilegeOnDrop {
    fn drop(&mut self) {
        unsafe {
            set_privilege(self.process, self.privilege, self.previous_state);
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(entry: &mut PROCESSENTRY32W, pid: u32, name: &str) {
        entry.th32ProcessID = pid;
        entry.szExeFile.fill(0);
        for (slot, value) in entry.szExeFile.iter_mut().zip(name.encode_utf16()) {
            *slot = value;
        }
    }

    #[test]
    fn first_entry_and_case_insensitive_match_are_not_skipped() {
        let mut calls = 0;
        let result = scan_processes("PeT.ExE", 7, |first, entry| {
            calls += 1;
            assert!(first);
            record(entry, 8, "pet.exe");
            Ok(true)
        });
        assert_eq!(result, Ok(true));
        assert_eq!(calls, 1);
    }

    #[test]
    fn host_pid_is_skipped_and_scan_reaches_last_entry() {
        let mut calls = 0;
        let result = scan_processes("pet.exe", 7, |first, entry| {
            calls += 1;
            assert_eq!(first, calls == 1);
            record(entry, if calls == 1 { 7 } else { 8 }, "PET.EXE");
            Ok(true)
        });
        assert_eq!(result, Ok(true));
        assert_eq!(calls, 2);
    }

    #[test]
    fn only_end_of_enumeration_proves_no_match() {
        let mut calls = 0;
        assert_eq!(scan_processes("pet.exe", 7, |_, entry| {
            calls += 1;
            record(entry, 8, "other.exe");
            Ok(calls == 1)
        }), Ok(false));
        assert_eq!(calls, 2);
        assert_eq!(scan_processes("pet.exe", 7, |_, _| Err(5)), Err(5));
        let mut calls = 0;
        assert_eq!(scan_processes("pet.exe", 7, |_, entry| {
            calls += 1;
            record(entry, 8, "other.exe");
            if calls == 1 { Ok(true) } else { Err(5) }
        }), Err(5));
    }

    #[test]
    fn invalid_handles_and_empty_queries_are_rejected() {
        assert!(OwnedHandle::new(INVALID_HANDLE_VALUE).is_invalid());
        assert!(OwnedHandle::new(ptr::null_mut()).is_invalid());
        assert_eq!(find_process(""), Err(ERROR_INVALID_PARAMETER));
    }

    #[test]
    fn invalid_token_query_cannot_choose_direct_launch() {
        // -1 is GetCurrentProcess's valid pseudo-handle for token APIs.
        assert_eq!(unsafe { is_elevated(ptr::null_mut()) }, None);
    }
}
