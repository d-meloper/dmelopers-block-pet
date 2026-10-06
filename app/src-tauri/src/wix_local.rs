//! Compile-time isolated official and test Burn installation/update handoff.
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
use windows_sys::Win32::System::{
    Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY},
    Threading::GetCurrentProcess,
};

// These compiled identities bind installation, signed feed and native handoff.
pub const KEY: &str = if cfg!(feature = "wix-github") { "Software\\DMeloper\\BlockPet\\Github" } else { "Software\\DMeloper\\BlockPet\\WixLocal" };
pub const MODE: &str = if cfg!(feature = "wix-github") { "block-pet-wix-v1" } else { "block-pet-wix-local-v1" };
pub const PRODUCT: &str = if cfg!(feature = "wix-github") { "dmelopers-block-pet" } else { "dmelopers-block-pet-wixlocal" };
pub const CHANNEL: &str = if cfg!(feature = "wix-github") { "stable" } else { "wixlocal" };
pub const BUNDLE_UPGRADE: &str = if cfg!(feature = "wix-github") { "{8AD6D51E-F120-55B8-90C3-C15CD80E8173}" } else { "{7239299E-8103-5BC6-93F7-93D036A22F71}" };
pub const MSI_UPGRADE: &str = if cfg!(feature = "wix-github") { "{70B77E49-EDA1-59D4-AFAB-7805E2FEA6A7}" } else { "{7D693AC9-0739-5A22-9237-A3506BCDE81E}" };
pub const REPOSITORY: &str = if cfg!(feature = "wix-github") { "d-meloper/dmelopers-block-pet" } else if cfg!(feature = "wix-github-test") { "oup030416/dmelopers-block-pet-test" } else { "local-wix-fixture" };
pub const REPOSITORY_ID: u64 = if cfg!(feature = "wix-github") { 1390031914 } else if cfg!(feature = "wix-github-test") { 1390032052 } else { 0 };
pub const EVENT_PREFIX: &str = if cfg!(feature = "wix-github") { "Local\\DMeloper.BlockPet.Update" } else { "Local\\DMeloper.BlockPet.WixLocal.Update" };
pub const ENDPOINT: &str = if cfg!(feature = "wix-github") {
    "https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/updates/tauri-stable.json"
} else if cfg!(feature = "wix-github-test") {
    "https://raw.githubusercontent.com/oup030416/dmelopers-block-pet-test/updates/wix-test.json"
} else { "http://127.0.0.1:17831/wix-local.json" };

pub fn registry(name: &str) -> Result<String, String> {
    let mut buffer = [0u16; 32768];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            crate::windows_process::wide(KEY).as_ptr(),
            crate::windows_process::wide(name).as_ptr(),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 || size < 2 || size as usize > std::mem::size_of_val(&buffer) {
        return Err("UPDATE_INSTALLED_APP_REQUIRED".into());
    }
    let end = buffer
        .iter()
        .position(|c| *c == 0)
        .ok_or("UPDATE_INSTALL_LOCATION_INVALID")?;
    String::from_utf16(&buffer[..end]).map_err(|_| "UPDATE_INSTALL_LOCATION_INVALID".into())
}

pub fn registration(root: &Path) -> Result<(), String> {
    crate::state_safety::check_path(root)?;
    let recorded = crate::windows_process::registered_install_root()?;
    crate::state_safety::check_path(&recorded)?;
    if fs::canonicalize(root).map_err(|_| "UPDATE_INSTALL_LOCATION_INVALID")?
        != fs::canonicalize(recorded).map_err(|_| "UPDATE_INSTALL_LOCATION_INVALID")?
        || registry("DeliveryMode")? != MODE
        || registry("BundleUpgradeCode")? != BUNDLE_UPGRADE
        || registry("MsiUpgradeCode")? != MSI_UPGRADE
        || !guid(&registry("MsiProductCode")?)
    {
        return Err("UPDATE_INSTALL_LOCATION_INVALID".into());
    }
    Ok(())
}

pub fn guid(value: &str) -> bool {
    value.len() == 38
        && value.starts_with('{')
        && value.ends_with('}')
        && value.bytes().enumerate().all(|(i, b)| match i {
            0 => b == b'{',
            37 => b == b'}',
            9 | 14 | 19 | 24 => b == b'-',
            _ => b.is_ascii_digit() || (b'A'..=b'F').contains(&b),
        })
}

/// RFC 4122 UUID v5 uses SHA-1 only to derive a stable MSI identity, not to authenticate bytes.
#[cfg(feature = "wix-github")]
pub fn product_code(version: &str) -> String {
    let namespace = [0xe6, 0x54, 0x53, 0x12, 0xe3, 0x82, 0x51, 0x62, 0xb6, 0x4f, 0x49, 0x3b, 0x27, 0x2f, 0xb6, 0xad];
    let mut digest = sha1::Sha1::new();
    digest.update(namespace);
    digest.update(format!("product:{version}"));
    let hash = digest.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02X}")).collect();
    format!("{{{}-{}-{}-{}-{}}}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

pub fn artifact_url(version: &str, sha256: &str) -> String {
    if cfg!(feature = "wix-github") {
        return format!("https://github.com/{REPOSITORY}/releases/download/v{version}/dmelopers-block-pet_{version}_x64-setup.exe");
    }
    if cfg!(feature = "wix-github-test") {
        return format!("https://github.com/{REPOSITORY}/releases/download/v{version}/dmelopers-block-pet_{version}_x64-setup.exe?sha256={sha256}");
    }
    format!(
        "http://127.0.0.1:17831/files/dmelopers-block-pet_{version}_x64-setup.exe?sha256={sha256}"
    )
}

pub fn allowed_request(url: &reqwest::Url) -> bool {
    if cfg!(any(feature = "wix-github", feature = "wix-github-test")) {
        return url.scheme() == "https"
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty() && url.password().is_none() && url.fragment().is_none()
            && ((url.host_str() == Some("raw.githubusercontent.com")
                && (url.path() == ENDPOINT.strip_prefix("https://raw.githubusercontent.com").unwrap_or("")
                    || url.path() == format!("{}.sig", ENDPOINT.strip_prefix("https://raw.githubusercontent.com").unwrap_or(""))))
                || (url.host_str() == Some("github.com")
                    && url.path().starts_with(&format!("/{REPOSITORY}/releases/download/v"))
                    && url.path().contains("/dmelopers-block-pet_")
                    && url.path().ends_with("_x64-setup.exe")));
    }
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(17831)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && (matches!(url.path(), "/wix-local.json" | "/wix-local.json.sig")
            || (url
                .path()
                .starts_with("/files/dmelopers-block-pet_")
                && url.path().ends_with("_x64-setup.exe")))
}

pub fn cleanup_caller(app: &Path, registered: &Path, parent: &Path) -> bool {
    fn check(app: &Path, registered: &Path, parent: &Path) -> Option<bool> {
        if !app
            .file_name()?
            .to_str()?
            .eq_ignore_ascii_case(concat!(env!("CARGO_PKG_NAME"), ".exe"))
        {
            return None;
        }
        registration(registered).ok()?;
        if fs::canonicalize(app.parent()?).ok()? != fs::canonicalize(registered).ok()? {
            return None;
        }
        crate::state_safety::check_path(parent).ok()?;
        use std::os::windows::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(parent)
            .ok()?;
        let size = file.metadata().ok()?.len();
        if size == 0 || size > 4 * 1024 * 1024 {
            return None;
        }
        let mut bytes = Vec::with_capacity(size as usize);
        Read::by_ref(&mut file)
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        Some(
            bytes.len() as u64 == size
                && format!("{:x}", Sha256::digest(bytes)) == env!("DMELOPER_WIX_BA_SHA256"),
        )
    }
    check(app, registered, parent) == Some(true)
}

/// The caller has freshly reverified feed, installer signature, hash and save barrier.
/// A failed spawn leaves the running app usable; success is handoff, not installation.
pub fn handoff(
    app: &tauri::AppHandle,
    root: &Path,
    bytes: &[u8],
    hash: &str,
) -> Result<(), String> {
    use std::os::windows::{fs::OpenOptionsExt, process::CommandExt};
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_ALREADY_EXISTS, WAIT_OBJECT_0},
        System::Threading::{CreateEventW, SetEvent, WaitForSingleObject},
    };
    registration(root)?;
    if format!("{:x}", Sha256::digest(bytes)) != hash {
        return Err("UPDATE_HASH_INVALID".into());
    }
    let created = crate::windows_process::creation_time(unsafe { GetCurrentProcess() })?;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| "UPDATE_INSTALL_FAILED")?;
    let unique: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let event = |phase: &str| -> Result<crate::windows_process::Handle, String> {
        let name = crate::windows_process::wide(&format!(
            "{EVENT_PREFIX}{phase}.{}.{created}.{unique}",
            std::process::id()
        ));
        let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
        if handle.is_null() {
            return Err("UPDATE_INSTALL_FAILED".into());
        }
        let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let handle = crate::windows_process::Handle(handle);
        if exists {
            return Err("UPDATE_INSTALL_FAILED".into());
        }
        Ok(handle)
    };
    let ready = event("Ready")?;
    let commit = event("Commit")?;
    let stage_root = crate::data_paths::DataRoots::resolve()?
        .local
        .join("update-staging");
    crate::state_safety::check_path(&stage_root)?;
    fs::create_dir_all(&stage_root).map_err(|_| "UPDATE_INSTALL_FAILED")?;
    let directory = stage_root.join(format!("{}-{created}-{unique}", std::process::id()));
    fs::create_dir(&directory).map_err(|_| "UPDATE_INSTALL_FAILED")?;
    crate::state_safety::check_path(&directory)?;
    let target = directory.join(if cfg!(feature = "wix-github") { "block-pet-update.exe" } else { "wix-local-update.exe" });
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(&target)
            .map_err(|_| "UPDATE_INSTALL_FAILED")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "UPDATE_INSTALL_FAILED")?;
    }
    let mut locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&target)
        .map_err(|_| "UPDATE_INSTALL_FAILED")?;
    let mut written = Vec::new();
    locked
        .read_to_end(&mut written)
        .map_err(|_| "UPDATE_INSTALL_FAILED")?;
    if written != bytes {
        return Err("UPDATE_HASH_INVALID".into());
    }
    let _child = std::process::Command::new(&target)
        .args([
            "--bp-update",
            "--bp-parent-pid",
            &std::process::id().to_string(),
            "--bp-parent-created",
            &created.to_string(),
            "--bp-install-dir",
        ])
        .arg(root)
        .args(["--bp-attempt", &unique])
        .arg("--bp-restart")
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|_| "UPDATE_INSTALL_FAILED")?;
    if unsafe { WaitForSingleObject(ready.0, 15000) } != WAIT_OBJECT_0 {
        return Err("UPDATE_INSTALL_FAILED".into());
    }
    if unsafe { SetEvent(commit.0) } == 0 {
        return Err("UPDATE_INSTALL_FAILED".into());
    }
    app.cleanup_before_exit();
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(feature = "wix-github")]
    fn official_identity_rejects_local_and_test_delivery() {
        assert_eq!(product_code("1.0.0"), "{0BB3A6AA-6DD1-5F05-A40F-37DA82D896CD}");
        assert_eq!(product_code("1.0.1"), "{9AEADDD4-2CAB-581F-99C1-722CE5381CA6}" );
        assert_eq!(crate::distribution::Channel::Github.identifier(), "com.dmeloper.blockpet");
        let expected_native = if tauri::is_dev() { "com.dmeloper.blockpet.development" } else { "com.dmeloper.blockpet" };
        assert_eq!(crate::application_context::native_identifier(), expected_native);
        if cfg!(debug_assertions) && tauri::is_dev() {
            assert_eq!(crate::distribution::channel(), crate::distribution::Channel::Development);
            assert!(!crate::in_app_update::in_app_updater_enabled());
        }
        assert!(allowed_request(&ENDPOINT.parse().unwrap()));
        assert!(allowed_request(&artifact_url("1.0.1", &"a".repeat(64)).parse().unwrap()));
        for foreign in ["http://127.0.0.1:17831/wix-local.json",
            "https://raw.githubusercontent.com/oup030416/dmelopers-block-pet-test/updates/wix-test.json",
            "https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/main/tauri-stable.json",
            "https://github.com/oup030416/dmelopers-block-pet-test/releases/download/v1.0.1/dmelopers-block-pet_1.0.1_x64-setup.exe"] {
            assert!(!allowed_request(&foreign.parse().unwrap()));
        }
    }
    #[test]
    #[cfg(not(feature = "wix-github"))]
    fn local_transport_and_identity_are_exact() {
        assert!(guid(BUNDLE_UPGRADE));
        assert!(guid(MSI_UPGRADE));
        assert!(!guid(&MSI_UPGRADE.to_lowercase()));
        let good = artifact_url("1.0.1", &"a".repeat(64));
        assert!(allowed_request(&good.parse().unwrap()));
        assert!(allowed_request(&ENDPOINT.parse().unwrap()));
        if cfg!(any(feature = "wix-github", feature = "wix-github-test")) {
            for bad in ["http://127.0.0.1:17831/wix-local.json", "https://raw.githubusercontent.com/oup030416/dmelopers-block-pet-test/updates/tauri-test.json", "https://github.com:444/oup030416/dmelopers-block-pet-test/releases/download/v1.0.1/dmelopers-block-pet_1.0.1_x64-setup.exe"] {
                assert!(!allowed_request(&bad.parse().unwrap()));
            }
        }
        for bad in [
            "http://localhost:17831/wix-local.json",
            "http://127.0.0.1:17832/wix-local.json",
            "http://user@127.0.0.1:17831/wix-local.json",
            "https://user@raw.githubusercontent.com/oup030416/dmelopers-block-pet-test/updates/wix-test.json",
            "http://127.0.0.1:17831/other",
            "https://127.0.0.1:17831/wix-local.json",
            "https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/updates/wix-test.json",
            "https://github.com/d-meloper/dmelopers-block-pet/releases/download/v1.0.1/dmelopers-block-pet_1.0.1_x64-setup.exe",
        ] {
            assert!(!allowed_request(&bad.parse().unwrap()));
        }
        assert_eq!(
            crate::distribution::Channel::Test.identifier(),
            "com.dmeloper.blockpet.wixlocal"
        );
        assert_eq!(
            crate::application_context::native_identifier(),
            crate::distribution::Channel::Test.identifier()
        );
    }
}
