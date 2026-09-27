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
