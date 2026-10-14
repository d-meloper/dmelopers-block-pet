//! Documented App Paths registrations, read without running registered commands.
use crate::windows_process::wide;
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
    System::{
        Environment::ExpandEnvironmentStringsW,
        Registry::{
            HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY,
            KEY_WOW64_64KEY, REG_EXPAND_SZ, REG_SZ, RegCloseKey, RegEnumKeyExW, RegOpenKeyExW,
            RegQueryValueExW,
        },
    },
};

const REGISTRATION: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths";
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

pub struct Registration {
    pub filename: String,
    pub path: Option<String>,
}

pub(super) fn expand(value: &str) -> Option<String> {
    if value.contains('\0') || value.encode_utf16().count() > 32767 {
        return None;
    }
    let input = wide(value);
    let length = unsafe { ExpandEnvironmentStringsW(input.as_ptr(), std::ptr::null_mut(), 0) };
    if length == 0 || length > 32768 {
        return None;
    }
    let mut output = vec![0u16; length as usize];
    let copied = unsafe { ExpandEnvironmentStringsW(input.as_ptr(), output.as_mut_ptr(), length) };
    if copied == 0 || copied > length {
        return None;
    }
    let end = output.iter().position(|character| *character == 0)?;
    String::from_utf16(&output[..end]).ok()
}

fn registered_path(key: HKEY) -> Option<String> {
    let mut kind = 0;
    let mut bytes = 0;
    if unsafe {
        RegQueryValueExW(
            key,
            std::ptr::null(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut bytes,
        )
    } != ERROR_SUCCESS
        || !matches!(kind, REG_SZ | REG_EXPAND_SZ)
        || bytes == 0
        || bytes > 65536
        || bytes % 2 != 0
    {
        return None;
    }
    let mut buffer = vec![0u16; bytes as usize / 2 + 1];
    let capacity = bytes;
    if unsafe {
        RegQueryValueExW(
            key,
            std::ptr::null(),
            std::ptr::null(),
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    } != ERROR_SUCCESS
        || bytes > capacity
        || bytes % 2 != 0
        || !matches!(kind, REG_SZ | REG_EXPAND_SZ)
    {
        return None;
    }
    let end = buffer.iter().position(|character| *character == 0)?;
    let value = String::from_utf16(&buffer[..end]).ok()?;
    let value = if kind == REG_EXPAND_SZ {
        expand(&value)?
    } else {
        value
    };
    let value = value.trim();
    // App Paths stores a fully qualified executable, not an arbitrary launch command.
    let path = value
        .strip_prefix('"')
        .and_then(|path| path.strip_suffix('"'))
        .unwrap_or(value);
    super::model::valid_application(path).then(|| path.to_owned())
}

pub fn enumerate(
    mut on_registration: impl FnMut(Registration) -> Result<(), ()>,
) -> Result<(), ()> {
    let mut incomplete = false;
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let mut raw = std::ptr::null_mut();
            let status = unsafe {
                RegOpenKeyExW(
                    hive,
                    wide(REGISTRATION).as_ptr(),
                    0,
                    KEY_READ | view,
                    &mut raw,
                )
            };
            if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
                continue;
            }
            if status != ERROR_SUCCESS {
                incomplete = true;
                continue;
            }
            let root = Key(raw);
            for index in 0..65536 {
                let mut name = [0u16; 256];
                let mut length = name.len() as u32;
                let status = unsafe {
                    RegEnumKeyExW(
                        root.0,
                        index,
                        name.as_mut_ptr(),
                        &mut length,
                        std::ptr::null(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                if status == ERROR_NO_MORE_ITEMS {
                    break;
                }
                if status != ERROR_SUCCESS {
                    incomplete = true;
                    break;
                }
                if index == 65535 {
                    incomplete = true;
                }
                let Ok(filename) = String::from_utf16(&name[..length as usize]) else {
                    continue;
                };
                if !filename.to_ascii_lowercase().ends_with(".exe") {
                    continue;
                }
                let mut child = std::ptr::null_mut();
                let status = unsafe {
                    RegOpenKeyExW(
                        root.0,
                        wide(&filename).as_ptr(),
                        0,
                        KEY_READ | view,
                        &mut child,
                    )
                };
                let path = if status == ERROR_SUCCESS {
                    let child = Key(child);
                    registered_path(child.0)
                } else {
                    incomplete = true;
                    None
                };
                on_registration(Registration { filename, path })?;
            }
        }
    }
    if incomplete { Err(()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_expansion_is_bounded_and_does_not_accept_embedded_terminators() {
        let expanded = expand(r"%SystemRoot%\System32\notepad.exe").unwrap();
        assert!(super::super::model::valid_application(&expanded));
        assert!(!expanded.contains("%SystemRoot%"));
        assert!(expand("C:\\good.exe\0C:\\other.exe").is_none());
        assert!(expand(&"x".repeat(32768)).is_none());
    }
}
