//! Shared Win32 handle and identity helpers for bootstrap and restart handoff.
use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, HANDLE, LocalFree},
    Security::{
        Authorization::ConvertSidToStringSidW, GetTokenInformation, TOKEN_QUERY, TOKEN_USER,
        TokenUser,
    },
    System::Threading::{
        GetCurrentProcess, GetProcessTimes, OpenProcessToken, QueryFullProcessImageNameW,
    },
};
#[cfg(any(feature = "channel-github", feature = "test-repository"))]
use windows_sys::Win32::{
    Foundation::{INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::{
            GetCurrentProcessId, OpenProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        },
    },
};

pub struct Handle(pub HANDLE);
// Kernel handles support cross-thread waits; ownership remains unique in this wrapper.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
pub fn user_sid(process: HANDLE) -> Result<String, String> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err("PROCESS_IDENTITY_UNAVAILABLE".into());
    }
    let token = Handle(token);
    let mut size = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut size);
    }
    if size == 0 {
        return Err("PROCESS_IDENTITY_UNAVAILABLE".into());
    }
    // usize storage provides alignment for TOKEN_USER, unlike a byte vector.
    let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err("PROCESS_IDENTITY_UNAVAILABLE".into());
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut raw = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut raw) } == 0 {
        return Err("PROCESS_IDENTITY_UNAVAILABLE".into());
    }
    let result = unsafe {
        let mut len = 0;
        while *raw.add(len) != 0 {
            len += 1;
        }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
        LocalFree(raw.cast());
        result
    };
    Ok(result)
}
pub fn current_sid() -> Result<String, String> {
    user_sid(unsafe { GetCurrentProcess() })
}
pub fn creation_time(process: HANDLE) -> Result<u64, String> {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err("PROCESS_IDENTITY_UNAVAILABLE".into());
    }
    Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}
pub fn executable(process: HANDLE) -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    let mut value = vec![0u16; 32768];
    let mut len = value.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, value.as_mut_ptr(), &mut len) } == 0 {
        return Err("PROCESS_IMAGE_UNAVAILABLE".into());
    }
    Ok(std::path::PathBuf::from(std::ffi::OsString::from_wide(
        &value[..len as usize],
    )))
}

/// Returns a live handle to this process's immediate parent, failing closed if
/// the process snapshot is incomplete or the parent has already exited.
#[cfg(any(feature = "channel-github", feature = "test-repository"))]
pub fn parent_process() -> Result<Handle, String> {
    let raw_snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw_snapshot == INVALID_HANDLE_VALUE {
        return Err("PROCESS_PARENT_UNAVAILABLE".into());
    }
    let snapshot = Handle(raw_snapshot);
    let current_pid = unsafe { GetCurrentProcessId() };
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
        return Err("PROCESS_PARENT_UNAVAILABLE".into());
    }

    let mut parent_pid = 0;
    loop {
        if entry.th32ProcessID == current_pid {
            parent_pid = entry.th32ParentProcessID;
            break;
        }
        if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
            break;
        }
    }
    if parent_pid == 0 || parent_pid == current_pid {
        return Err("PROCESS_PARENT_UNAVAILABLE".into());
    }

    let raw_parent = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            parent_pid,
        )
    };
    if raw_parent.is_null() {
        return Err("PROCESS_PARENT_UNAVAILABLE".into());
    }
    let parent = Handle(raw_parent);
    if unsafe { WaitForSingleObject(parent.0, 0) } != WAIT_TIMEOUT {
        return Err("PROCESS_PARENT_UNAVAILABLE".into());
    }
    Ok(parent)
}

/// Reads the current profile's registered install directory before Tauri starts.
/// The internal cleanup command is valid only for this registered channel.
#[cfg(any(feature = "channel-github", feature = "test-repository"))]
pub fn registered_install_root() -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY, RegGetValueW,
    };

    let product = if cfg!(feature = "test-repository") {
        "DMeloper's Block Pet Test"
    } else {
        "DMeloper's Block Pet"
    };
    let uninstall_key = format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{product}"
    );
    let mut buffer = vec![0u16; 32768];
    let mut size = std::mem::size_of_val(buffer.as_slice()) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            wide(&uninstall_key).as_ptr(),
            wide("InstallLocation").as_ptr(),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 || size < 2 || size as usize > std::mem::size_of_val(buffer.as_slice()) {
        return Err("INSTALLATION_IDENTITY_UNAVAILABLE".into());
    }
    let length = buffer
        .iter()
        .position(|value| *value == 0)
        .ok_or("INSTALLATION_IDENTITY_INVALID")?;
    let root = std::path::PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
    if !root.is_absolute() {
        return Err("INSTALLATION_IDENTITY_INVALID".into());
    }
    Ok(root)
}
