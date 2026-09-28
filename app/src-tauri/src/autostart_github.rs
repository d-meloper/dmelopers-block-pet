//! Fixed native5 ownership and read-only StartupApproved compatibility contract.
//! Unknown approval representations fail closed; Windows decisions are never written.
use super::AutostartStatus;
use crate::windows_process::wide;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
    System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, KEY_WOW64_64KEY, REG_OPTION_NON_VOLATILE, REG_SZ,
        RRF_RT_REG_BINARY, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY, RegCloseKey, RegCreateKeyExW,
        RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW,
    },
};
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
static MUTATION: Mutex<()> = Mutex::new(());

fn read_value(key: &str, name: &str, kind: u32, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let mut bytes = vec![0u8; limit];
    let mut size = limit as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            wide(key).as_ptr(),
            wide(name).as_ptr(),
            kind | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            bytes.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND {
        return Ok(None);
    }
    if result != ERROR_SUCCESS || size as usize > limit {
        return Err("AUTOSTART_REGISTRATION_UNKNOWN".into());
    }
    bytes.truncate(size as usize);
    Ok(Some(bytes))
}
fn approved(bytes: Option<&[u8]>) -> Result<bool, String> {
    let Some(bytes) = bytes else {
        return Ok(true);
    };
    if bytes.len() != 12 || bytes[1..4] != [0, 0, 0] {
        return Err("AUTOSTART_APPROVAL_UNKNOWN".into());
    }
    match bytes[0] {
        2 => Ok(true),
        3 => Ok(false),
        _ => Err("AUTOSTART_APPROVAL_UNKNOWN".into()),
    }
}
fn windows_approved(name: &str) -> Result<bool, String> {
    let mut allowed = true;
    for kind in ["Run", "Run32"] {
        let key =
            format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\{kind}");
        allowed &= approved(read_value(&key, name, RRF_RT_REG_BINARY, 12)?.as_deref())?;
    }
    Ok(allowed)
}
fn registered_image(bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.len() < 2 || bytes.len() % 2 != 0 {
        return Err("AUTOSTART_REGISTRATION_UNKNOWN".into());
    }
    let mut units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|v| u16::from_le_bytes([v[0], v[1]]))
        .collect();
    if units.pop() != Some(0) || units.contains(&0) {
        return Err("AUTOSTART_REGISTRATION_UNKNOWN".into());
    }
    let text = String::from_utf16(&units).map_err(|_| "AUTOSTART_REGISTRATION_UNKNOWN")?;
    let image = if text.starts_with('"') && text.ends_with('"') && text.len() > 2 {
        &text[1..text.len() - 1]
    } else {
        text.strip_suffix(' ')
            .ok_or("AUTOSTART_REGISTRATION_UNKNOWN")?
    };
    let path = PathBuf::from(image);
    if !path.is_absolute()
        || image.contains('"')
        || image.starts_with(r"\\")
        || !path
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("exe"))
    {
        return Err("AUTOSTART_REGISTRATION_UNKNOWN".into());
    }
    Ok(path)
}
fn same_file(left: &Path, right: &Path) -> Result<bool, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
    };
    fn identity(path: &Path) -> Result<(u64, [u8; 16]), String> {
        let file = std::fs::File::open(path).map_err(|_| "AUTOSTART_IMAGE_UNAVAILABLE")?;
        let mut info = FILE_ID_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                (&mut info as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } == 0
        {
            return Err("AUTOSTART_IMAGE_UNAVAILABLE".into());
        }
        Ok((info.VolumeSerialNumber, info.FileId.Identifier))
    }
    Ok(identity(left)? == identity(right)?)
}
fn registration(name: &str, exe: &Path) -> Result<bool, String> {
    let Some(bytes) = read_value(RUN, name, RRF_RT_REG_SZ, 32768)? else {
        return Ok(false);
    };
    if !same_file(&registered_image(&bytes)?, exe)? {
        return Err("AUTOSTART_OWNERSHIP_CONFLICT".into());
    }
    Ok(true)
}
pub(super) fn status() -> Result<AutostartStatus, String> {
    let name = crate::distribution::channel().autostart_name();
    let exe = std::env::current_exe().map_err(|_| "AUTOSTART_IMAGE_UNAVAILABLE")?;
    let registered = registration(name, &exe)?;
    if !windows_approved(name)? {
        return Ok(AutostartStatus {
            enabled: false,
            state: "disabledByUser",
            can_enable: false,
            can_disable: registered,
        });
    }
    Ok(AutostartStatus {
        enabled: registered,
        state: if registered { "enabled" } else { "disabled" },
        can_enable: true,
        can_disable: registered,
    })
}
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
pub(super) fn set(enabled: bool) -> Result<AutostartStatus, String> {
    let _guard = MUTATION.lock().map_err(|_| "AUTOSTART_BUSY")?;
    let before = status()?;
    if enabled && !before.can_enable {
        return Ok(before);
    }
    let name = crate::distribution::channel().autostart_name();
    let exe = std::env::current_exe().map_err(|_| "AUTOSTART_IMAGE_UNAVAILABLE")?;
    let owned = registration(name, &exe)?;
    if !enabled && !owned {
        return Ok(before);
    }
    // Validate the complete command before creating even a missing Run key.
    let exe = exe.to_str().ok_or("AUTOSTART_IMAGE_UNAVAILABLE")?;
    if exe.contains('"') || exe.starts_with(r"\\") {
        return Err("AUTOSTART_IMAGE_UNAVAILABLE".into());
    }
    let value = wide(&format!("\"{exe}\""));
    if value.len() > 260 {
        return Err("AUTOSTART_IMAGE_PATH_TOO_LONG".into());
    }
    let mut key = std::ptr::null_mut();
    let result = unsafe {
        if enabled {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide(RUN).as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE | KEY_WOW64_64KEY,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        } else {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                wide(RUN).as_ptr(),
                0,
                KEY_SET_VALUE | KEY_WOW64_64KEY,
                &mut key,
            )
        }
    };
    if result != ERROR_SUCCESS {
        return Err("AUTOSTART_WRITE_FAILED".into());
    }
    let key = Key(key);
    let result = if enabled {
        unsafe {
            RegSetValueExW(
                key.0,
                wide(name).as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        }
    } else {
        unsafe { RegDeleteValueW(key.0, wide(name).as_ptr()) }
    };
    if result != ERROR_SUCCESS {
        return Err("AUTOSTART_WRITE_FAILED".into());
    }
    status()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_disabled_and_unknown_approval_never_mean_enabled() {
        assert!(approved(None).unwrap());
        let mut value = [0; 12];
        value[0] = 2;
        assert!(approved(Some(&value)).unwrap());
        value[0] = 3;
        assert!(!approved(Some(&value)).unwrap());
        value[0] = 6;
        assert!(approved(Some(&value)).is_err());
        assert!(approved(Some(&[2, 0, 0, 0])).is_err());
    }
    #[test]
    fn parser_preserves_unicode_and_refuses_arguments_or_bad_encoding() {
        let encode = |s: &str| {
            wide(s)
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            registered_image(&encode("\"C:\\사용자 []\\pet.exe\"")).unwrap(),
            PathBuf::from("C:\\사용자 []\\pet.exe")
        );
        assert!(registered_image(&encode("C:\\pet.exe ")).is_ok());
        for text in ["\"C:\\pet.exe\" --other", "pet.exe ", "\"\"", ""] {
            assert!(registered_image(&encode(text)).is_err());
        }
        assert!(registered_image(&[0, 216, 0, 0]).is_err());
    }
    #[test]
    fn file_ownership_handles_aliases_without_claiming_foreign_files() {
        let temp = tempfile::tempdir().unwrap();
        let image = temp.path().join("app.exe");
        let alias = temp.path().join("alias.exe");
        let other = temp.path().join("other.exe");
        std::fs::write(&image, b"image").unwrap();
        std::fs::hard_link(&image, &alias).unwrap();
        std::fs::write(&other, b"image").unwrap();
        assert!(same_file(&image, &alias).unwrap());
        assert!(!same_file(&image, &other).unwrap());
    }
}
