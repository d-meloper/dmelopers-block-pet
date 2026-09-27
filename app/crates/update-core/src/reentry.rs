//! Operation-owned recovery entry for the original Windows user's next login.
//! The value is unique per request; cleanup requires exact command equality.
use super::{UpdateError, fail};
use std::path::Path;

pub fn command(root: &Path, digest: &str) -> Result<String, UpdateError> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(fail("INVALID_REQUEST"));
    }
    let value = format!(
        "\"{}\" --resume-update-helper {digest}",
        root.join("update-helper.exe").display()
    );
    if value.encode_utf16().count() > 260 {
        return Err(fail("RECOVERY_PATH_TOO_LONG"));
    }
    Ok(value)
}

trait ValueStore {
    fn read(&self) -> Result<Option<String>, UpdateError>;
    fn write(&self, value: &str) -> Result<(), UpdateError>;
    fn delete(&self) -> Result<(), UpdateError>;
    fn flush(&self) -> Result<(), UpdateError>;
}

fn reconcile(store: &impl ValueStore, expected: &str, remove: bool) -> Result<(), UpdateError> {
    let current = store.read()?;
    if current.as_deref().is_some_and(|value| value != expected) {
        return Err(fail("RECOVERY_REGISTRATION_CHANGED"));
    }
    if remove {
        if current.is_some() {
            store.delete()?;
            store.flush()?;
        }
        if store.read()?.is_some() {
            return Err(fail("RECOVERY_REGISTRATION_FAILED"));
        }
    } else {
        if current.is_none() {
            store.write(expected)?;
        }
        store.flush()?;
        if store.read()?.as_deref() != Some(expected) {
            return Err(fail("RECOVERY_REGISTRATION_FAILED"));
        }
    }
    Ok(())
}

#[cfg(windows)]
struct RegistryValue {
    key: windows_sys::Win32::System::Registry::HKEY,
    name: Vec<u16>,
}
#[cfg(windows)]
impl Drop for RegistryValue {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Registry::RegCloseKey(self.key);
        }
    }
}
#[cfg(windows)]
impl ValueStore for RegistryValue {
    fn read(&self) -> Result<Option<String>, UpdateError> {
        use windows_sys::Win32::System::Registry::{RRF_RT_REG_SZ, RegGetValueW};
        let mut buffer = vec![0u16; 32768];
        let mut size = (buffer.len() * 2) as u32;
        let read = unsafe {
            RegGetValueW(
                self.key,
                std::ptr::null(),
                self.name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if read == 2 {
            return Ok(None);
        }
        if read != 0 {
            return Err(fail("RECOVERY_REGISTRATION_FAILED"));
        }
        let length = buffer
            .iter()
            .position(|v| *v == 0)
            .ok_or_else(|| fail("RECOVERY_REGISTRATION_FAILED"))?;
        Ok(Some(String::from_utf16_lossy(&buffer[..length])))
    }
    fn write(&self, value: &str) -> Result<(), UpdateError> {
        use windows_sys::Win32::System::Registry::{REG_SZ, RegSetValueExW};
        let value: Vec<_> = value.encode_utf16().chain(Some(0)).collect();
        if unsafe {
            RegSetValueExW(
                self.key,
                self.name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        } != 0
        {
            return Err(fail("RECOVERY_REGISTRATION_FAILED"));
        }
        Ok(())
    }
    fn delete(&self) -> Result<(), UpdateError> {
        if unsafe {
            windows_sys::Win32::System::Registry::RegDeleteValueW(self.key, self.name.as_ptr())
        } != 0
        {
            return Err(fail("RECOVERY_REGISTRATION_FAILED"));
        }
        Ok(())
    }
    fn flush(&self) -> Result<(), UpdateError> {
        if unsafe { windows_sys::Win32::System::Registry::RegFlushKey(self.key) } != 0 {
            return Err(fail("RECOVERY_REGISTRATION_FAILED"));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub fn current_sid() -> Result<String, UpdateError> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        Security::TOKEN_QUERY,
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(fail("ORIGINAL_USER_UNAVAILABLE"));
        }
        let result = token_sid(token);
        CloseHandle(token);
        result
    }
}

#[cfg(windows)]
pub fn token_sid(token: windows_sys::Win32::Foundation::HANDLE) -> Result<String, UpdateError> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TOKEN_USER, TokenUser,
        },
    };
    unsafe {
        let mut size = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        let mut data = vec![0u8; size as usize];
        if size == 0
            || GetTokenInformation(token, TokenUser, data.as_mut_ptr().cast(), size, &mut size) == 0
        {
            return Err(fail("ORIGINAL_USER_UNAVAILABLE"));
        }
        let sid = (*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid;
        let mut text = std::ptr::null_mut();
        let success = ConvertSidToStringSidW(sid, &mut text);
        if success == 0 {
            return Err(fail("ORIGINAL_USER_UNAVAILABLE"));
        }
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        Ok(value)
    }
}

#[cfg(windows)]
pub fn update(
    root: &Path,
    id: &str,
    sid: &str,
    digest: &str,
    remove: bool,
) -> Result<(), UpdateError> {
    use windows_sys::Win32::System::Registry::{
        HKEY_USERS, KEY_QUERY_VALUE, KEY_SET_VALUE, KEY_WOW64_64KEY, RegCreateKeyExW, RegOpenKeyExW,
    };
    if id.len() != 32
        || !id.bytes().all(|b| b.is_ascii_hexdigit())
        || !sid.starts_with("S-1-")
        || !sid
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'S' || b == b'-')
    {
        return Err(fail("INVALID_REQUEST"));
    }
    let expected = command(root, digest)?;
    let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let path = wide(&format!(
        "{sid}\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce"
    ));
    let name = wide(&format!("DMeloperBlockPetRecovery-{id}"));
    unsafe {
        let mut key = std::ptr::null_mut();
        let opened = if remove {
            RegOpenKeyExW(
                HKEY_USERS,
                path.as_ptr(),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_64KEY,
                &mut key,
            )
        } else {
            RegCreateKeyExW(
                HKEY_USERS,
                path.as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_64KEY,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };
        if opened == 2 && remove {
            return Ok(());
        }
        if opened != 0 {
            return Err(fail("RECOVERY_REGISTRATION_FAILED"));
        }
        reconcile(&RegistryValue { key, name }, &expected, remove)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    #[derive(Default)]
    struct MemoryValue {
        value: RefCell<Option<String>>,
        lost_write: Cell<bool>,
        flush_failed: Cell<bool>,
        mutations: Cell<u32>,
    }
    impl ValueStore for MemoryValue {
        fn read(&self) -> Result<Option<String>, UpdateError> {
            Ok(self.value.borrow().clone())
        }
        fn write(&self, value: &str) -> Result<(), UpdateError> {
            self.mutations.set(self.mutations.get() + 1);
            if !self.lost_write.get() {
                *self.value.borrow_mut() = Some(value.into());
            }
            Ok(())
        }
        fn delete(&self) -> Result<(), UpdateError> {
            self.mutations.set(self.mutations.get() + 1);
            *self.value.borrow_mut() = None;
            Ok(())
        }
        fn flush(&self) -> Result<(), UpdateError> {
            if self.flush_failed.get() {
                Err(fail("RECOVERY_REGISTRATION_FAILED"))
            } else {
                Ok(())
            }
        }
    }
    #[test]
    fn operation_owned_registration_requires_durable_readback_and_preserves_changed_values() {
        let store = MemoryValue::default();
        reconcile(&store, "first exact command", false).unwrap();
        assert_eq!(
            store.read().unwrap().as_deref(),
            Some("first exact command")
        );
        let mutations = store.mutations.get();
        assert_eq!(
            reconcile(&store, "stale command", true).unwrap_err().code,
            "RECOVERY_REGISTRATION_CHANGED"
        );
        assert_eq!(store.mutations.get(), mutations);
        reconcile(&store, "first exact command", true).unwrap();
        assert!(store.read().unwrap().is_none());
        store.lost_write.set(true);
        assert!(reconcile(&store, "new operation", false).is_err());
        store.lost_write.set(false);
        store.flush_failed.set(true);
        assert!(reconcile(&store, "new operation", false).is_err());
    }
    #[test]
    fn reentry_command_uses_one_unicode_path_and_rejects_windows_runonce_overflow() {
        let value = command(
            Path::new("C:\\FixtureProfiles\\예시 😶\\recovery\\abc"),
            &"a".repeat(64),
        )
        .unwrap();
        assert!(value.contains("--resume-update-helper"));
        assert!(value.starts_with('"'));
        assert!(
            command(
                Path::new(&format!("C:\\{}", "x".repeat(260))),
                &"a".repeat(64)
            )
            .is_err()
        );
    }
}
