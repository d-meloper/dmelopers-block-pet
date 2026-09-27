use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    thread,
    time::Duration,
};

const IDENTITY_FILE: &str = "broadcast-endpoint.json";
const BACKUP_FILE: &str = "broadcast-endpoint.backup.json";
const MAX_BYTES: u64 = 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Identity {
    schema_version: u8,
    pub port: u16,
    pub token: String,
}

impl Identity {
    pub fn host(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }
    pub fn origin(&self) -> String {
        format!("http://{}", self.host())
    }
    pub fn url(&self) -> String {
        format!("{}/{}/", self.origin(), self.token)
    }
}

#[derive(Debug)]
pub(super) struct LoadedIdentity {
    pub identity: Identity,
    pub warning: Option<String>,
}

#[derive(Debug, PartialEq)]
enum Stored {
    Missing,
    Invalid,
    Unavailable,
    Valid(Identity),
}

fn safe(path: &Path) -> Result<(), String> {
    crate::state_safety::check_path(path).map_err(|_| "endpoint_unavailable".into())
}

fn read(path: &Path) -> Stored {
    if safe(path).is_err() {
        return Stored::Unavailable;
    }
    // Keep write/delete sharing closed while validating the exact open object.
    let mut file = match fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .custom_flags(0x0020_0000)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Stored::Missing,
        Err(_) => return Stored::Unavailable,
    };
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return Stored::Unavailable,
    };
    if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
        return Stored::Unavailable;
    }
    if metadata.len() > MAX_BYTES {
        return Stored::Invalid;
    }
    let mut bytes = Vec::new();
    if (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Stored::Unavailable;
    }
    if bytes.len() as u64 > MAX_BYTES {
        return Stored::Invalid;
    }
    let identity: Identity = match serde_json::from_slice(&bytes) {
        Ok(identity) => identity,
        Err(_) => return Stored::Invalid,
    };
    if identity.schema_version != 1
        || identity.port < 1024
        || identity.token.len() != 64
        || !identity
            .token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Stored::Invalid;
    }
    Stored::Valid(identity)
}

fn nonce() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "endpoint_unavailable")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn lock(root: &Path) -> Result<fs::File, String> {
    safe(root)?;
    fs::create_dir_all(root).map_err(|_| "endpoint_unavailable")?;
    let path = root.join(".broadcast-endpoint.lock");
    safe(&path)?;
    // Allow durable flushes to complete on a busy disk during simultaneous starts.
    // A bounded wait still leaves real access failures available to the UI retry.
    for attempt in 0..200 {
        match fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .custom_flags(0x0020_0000)
            .open(&path)
        {
            Ok(file) => {
                let metadata = file.metadata().map_err(|_| "endpoint_unavailable")?;
                if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
                    return Err("endpoint_unavailable".into());
                }
                // The empty lock file remains; deleting it would race the next opener.
                return Ok(file);
            }
            Err(error) if error.raw_os_error() == Some(32) && attempt < 199 => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return Err("endpoint_unavailable".into()),
        }
    }
    Err("endpoint_unavailable".into())
}

fn install(root: &Path, path: &Path, identity: &Identity) -> Result<(), String> {
    safe(path)?;
    let temporary = root.join(format!(".broadcast-write-{}.tmp", nonce()?));
    let mut owns_temporary = false;
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "endpoint_unavailable")?;
        owns_temporary = true;
        file.write_all(&serde_json::to_vec(identity).map_err(|_| "endpoint_unavailable")?)
            .and_then(|()| file.sync_all())
            .map_err(|_| "endpoint_unavailable")?;
        drop(file);
        if read(&temporary) != Stored::Valid(identity.clone()) {
            return Err("endpoint_unavailable".into());
        }
        safe(path)?;
        commit_new(&temporary, path)?;
        owns_temporary = false;
        if read(path) != Stored::Valid(identity.clone()) {
            return Err("endpoint_unavailable".into());
        }
        Ok(())
    })();
    if owns_temporary {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn commit_new(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

    let source = fs::canonicalize(source).map_err(|_| "endpoint_unavailable")?;
    let parent = fs::canonicalize(destination.parent().ok_or("endpoint_unavailable")?)
        .map_err(|_| "endpoint_unavailable")?;
    let destination = parent.join(destination.file_name().ok_or("endpoint_unavailable")?);
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // No REPLACE_EXISTING: even a writer that ignores our lock cannot have its
    // newly appeared identity silently overwritten. Both paths stay on this volume.
    // SAFETY: the owned, NUL-terminated UTF-16 buffers outlive this synchronous call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err("endpoint_unavailable".into());
    }
    Ok(())
}

fn preserve_invalid(root: &Path, path: &Path) -> Result<(), String> {
    safe(path)?;
    let saved = root.join(format!(
        "{}.invalid-{}",
        path.file_name().unwrap().to_string_lossy(),
        nonce()?
    ));
    commit_new(path, &saved)
}

fn with_warning(identity: Identity, result: Result<(), String>) -> LoadedIdentity {
    LoadedIdentity {
        identity,
        warning: result.err().map(|_| "endpoint_backup_unavailable".into()),
    }
}

/// Endpoint v1 is a user-owned identity, independent of installation, version and
/// frontend reset. A validated durable copy must exist before any URL is exposed.
pub(super) fn load_known(
    root: &Path,
    expected: Option<&Identity>,
) -> Result<LoadedIdentity, String> {
    let _lock = lock(root)?;
    let path = root.join(IDENTITY_FILE);
    let backup = root.join(BACKUP_FILE);
    let primary = read(&path);
    let retained = read(&backup);
    if let Some(expected) = expected {
        if [&primary, &retained]
            .iter()
            .any(|state| matches!(state, Stored::Valid(value) if value != expected))
        {
            return Err("endpoint_conflict".into());
        }
        if matches!(primary, Stored::Missing | Stored::Invalid)
            && matches!(retained, Stored::Missing | Stored::Invalid)
        {
            // Retry already owns a proven address. Never generate a different one,
            // even if both durable copies disappeared after startup.
            let backup_result = if retained == Stored::Invalid {
                preserve_invalid(root, &backup)
            } else {
                Ok(())
            }
            .and_then(|()| install(root, &backup, expected));
            if backup_result.is_err() {
                return Ok(with_warning(expected.clone(), backup_result));
            }
            let saved = if primary == Stored::Invalid {
                preserve_invalid(root, &path)
            } else {
                Ok(())
            }
            .and_then(|()| install(root, &path, expected));
            return Ok(with_warning(expected.clone(), saved));
        }
    }
    match (primary, retained) {
        (Stored::Valid(a), Stored::Valid(b)) if a != b => Err("endpoint_conflict".into()),
        (Stored::Valid(identity), Stored::Valid(_)) => Ok(with_warning(identity, Ok(()))),
        (Stored::Valid(identity), Stored::Missing) => {
            let saved = install(root, &backup, &identity);
            Ok(with_warning(identity, saved))
        }
        (Stored::Valid(identity), Stored::Invalid) => {
            let saved =
                preserve_invalid(root, &backup).and_then(|()| install(root, &backup, &identity));
            Ok(with_warning(identity, saved))
        }
        (Stored::Valid(identity), Stored::Unavailable) => {
            Ok(with_warning(identity, Err("unavailable".into())))
        }
        (Stored::Missing, Stored::Valid(identity)) => {
            let saved = install(root, &path, &identity);
            Ok(with_warning(identity, saved))
        }
        (Stored::Invalid, Stored::Valid(identity)) => {
            let saved =
                preserve_invalid(root, &path).and_then(|()| install(root, &path, &identity));
            Ok(with_warning(identity, saved))
        }
        (Stored::Missing, Stored::Missing) => {
            let mut random = [0_u8; 32];
            getrandom::fill(&mut random).map_err(|_| "endpoint_unavailable")?;
            let port = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .and_then(|listener| listener.local_addr())
                .map_err(|_| "endpoint_unavailable")?
                .port();
            let identity = Identity {
                schema_version: 1,
                port,
                token: random.iter().map(|byte| format!("{byte:02x}")).collect(),
            };
            // Backup first: a crash before primary publication recovers this same identity.
            install(root, &backup, &identity)?;
            let saved = install(root, &path, &identity);
            Ok(with_warning(identity, saved))
        }
        (Stored::Unavailable, _) | (_, Stored::Unavailable) => Err("endpoint_unavailable".into()),
        _ => Err("endpoint_invalid".into()),
    }
}

#[cfg(test)]
pub(super) fn load_with_backup(root: &Path) -> Result<LoadedIdentity, String> {
    load_known(root, None)
}

#[cfg(test)]
pub(super) fn load_or_create(root: &Path) -> Result<Identity, String> {
    load_with_backup(root).map(|loaded| loaded.identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_never_overwrites_an_unexpected_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let identity = load_or_create(root.path()).unwrap();
        let path = root.path().join("unexpected.json");
        fs::write(&path, b"another writer").unwrap();
        assert_eq!(
            install(root.path(), &path, &identity).unwrap_err(),
            "endpoint_unavailable"
        );
        assert_eq!(fs::read(path).unwrap(), b"another writer");
    }

    #[test]
    fn legacy_bytes_survive_adoption_and_missing_or_corrupt_primary_recovers() {
        let root = tempfile::tempdir().unwrap();
        let original = load_or_create(root.path()).unwrap();
        let path = root.path().join(IDENTITY_FILE);
        let bytes = fs::read(&path).unwrap();
        fs::remove_file(root.path().join(BACKUP_FILE)).unwrap();
        assert_eq!(load_or_create(root.path()).unwrap(), original);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(fs::read(root.path().join(BACKUP_FILE)).unwrap(), bytes);
        fs::remove_file(&path).unwrap();
        assert_eq!(load_or_create(root.path()).unwrap(), original);
        fs::write(&path, b"broken state").unwrap();
        assert_eq!(load_or_create(root.path()).unwrap(), original);
        let preserved: Vec<_> = fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("broadcast-endpoint.json.invalid-")
            })
            .collect();
        assert_eq!(preserved.len(), 1);
        assert_eq!(fs::read(&preserved[0]).unwrap(), b"broken state");
    }

    #[test]
    fn invalid_or_conflicting_copies_never_generate_a_new_identity() {
        let root = tempfile::tempdir().unwrap();
        let first = load_or_create(root.path()).unwrap();
        let path = root.path().join(IDENTITY_FILE);
        let backup = root.path().join(BACKUP_FILE);
        let mut other = first.clone();
        other.token = "b".repeat(64);
        fs::write(&backup, serde_json::to_vec(&other).unwrap()).unwrap();
        assert_eq!(
            load_or_create(root.path()).unwrap_err(),
            "endpoint_conflict"
        );
        assert_eq!(read(&path), Stored::Valid(first));
        assert_eq!(read(&backup), Stored::Valid(other));
        fs::write(&backup, b"bad backup").unwrap();
        fs::write(&path, b"bad primary").unwrap();
        assert_eq!(load_or_create(root.path()).unwrap_err(), "endpoint_invalid");
        assert_eq!(fs::read(&path).unwrap(), b"bad primary");
        assert_eq!(fs::read(&backup).unwrap(), b"bad backup");
    }

    #[test]
    fn unavailable_primary_is_not_mistaken_for_absence_and_backup_failure_is_visible() {
        let root = tempfile::tempdir().unwrap();
        let first = load_or_create(root.path()).unwrap();
        let path = root.path().join(IDENTITY_FILE);
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert_eq!(
            load_or_create(root.path()).unwrap_err(),
            "endpoint_unavailable"
        );
        drop(held);
        let backup = root.path().join(BACKUP_FILE);
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&backup)
            .unwrap();
        let loaded = load_with_backup(root.path()).unwrap();
        assert_eq!(loaded.identity, first);
        assert_eq!(
            loaded.warning.as_deref(),
            Some("endpoint_backup_unavailable")
        );
        drop(held);
        assert_eq!(load_with_backup(root.path()).unwrap().warning, None);
    }

    #[test]
    fn interrupted_first_commit_and_backup_damage_retain_the_same_address() {
        let root = tempfile::tempdir().unwrap();
        let first = load_or_create(root.path()).unwrap();
        fs::remove_file(root.path().join(IDENTITY_FILE)).unwrap();
        fs::write(
            root.path().join(".broadcast-write-abandoned.tmp"),
            b"partial",
        )
        .unwrap();
        assert_eq!(load_or_create(root.path()).unwrap(), first);
        fs::write(root.path().join(BACKUP_FILE), b"partial backup").unwrap();
        assert_eq!(load_or_create(root.path()).unwrap(), first);
        assert_eq!(read(&root.path().join(BACKUP_FILE)), Stored::Valid(first));
        assert_eq!(
            fs::read(root.path().join(".broadcast-write-abandoned.tmp")).unwrap(),
            b"partial"
        );
    }

    #[test]
    fn concurrent_initializers_share_one_identity() {
        let root = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let root = root.path().to_owned();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    load_or_create(&root).unwrap()
                })
            })
            .collect();
        let values: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(values.iter().all(|v| v == &values[0]));
    }

    #[test]
    fn child_process_identity_probe() {
        let Some(root) = std::env::var_os("DMELOPER_BROADCAST_TEST_ROOT") else {
            return;
        };
        load_or_create(Path::new(&root)).unwrap();
    }

    #[test]
    fn separate_processes_reuse_persisted_identity() {
        let root = tempfile::tempdir().unwrap();
        let exe = std::env::current_exe().unwrap();
        let mut previous = None;
        for _ in 0..2 {
            let output = std::process::Command::new(&exe)
                .args([
                    "--exact",
                    "broadcast::identity::tests::child_process_identity_probe",
                ])
                .env("DMELOPER_BROADCAST_TEST_ROOT", root.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let value = load_or_create(root.path()).unwrap();
            assert_eq!(
                read(&root.path().join(BACKUP_FILE)),
                Stored::Valid(value.clone())
            );
            if let Some(previous) = &previous {
                assert_eq!(&value, previous);
            }
            previous = Some(value);
        }
    }
}
