//! Target-owned repository selection, separate from settings and rollback data.
//! A selector chooses one compiled trust record; it cannot introduce new trust.
use super::{UpdateError, fail, feed};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const FILE_NAME: &str = "update-source.json";
const MAX_BYTES: u64 = 4096;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    repository: String,
}

pub fn normalize(value: &str) -> Result<&'static str, UpdateError> {
    let value = value.trim();
    let value = value
        .strip_prefix("https://github.com/")
        .map(|value| value.strip_suffix('/').unwrap_or(value))
        .unwrap_or(value);
    match value {
        feed::OFFICIAL_REPOSITORY => Ok(feed::OFFICIAL_REPOSITORY),
        feed::TEST_REPOSITORY => Ok(feed::TEST_REPOSITORY),
        _ => Err(fail("UPDATE_SOURCE_INVALID")),
    }
}

fn path(root: &Path) -> Result<PathBuf, UpdateError> {
    for ancestor in root.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if !metadata.is_dir() || is_reparse(&metadata) => {
                return Err(fail("UPDATE_SOURCE_INVALID"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(fail("UPDATE_SOURCE_INVALID")),
        }
    }
    let path = root.join(FILE_NAME);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || is_reparse(&metadata) => {
            Err(fail("UPDATE_SOURCE_INVALID"))
        }
        Ok(_) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(_) => Err(fail("UPDATE_SOURCE_INVALID")),
    }
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

/// Create a visible default once. Existing bytes, including invalid user edits,
/// are preserved so an update error never silently chooses another repository.
pub fn initialize(root: &Path) -> Result<(), UpdateError> {
    let target = path(root)?;
    fs::create_dir_all(root).map_err(|_| fail("UPDATE_SOURCE_INVALID"))?;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
    {
        Ok(mut file) => {
            let contents = serde_json::to_string_pretty(&Selection {
                repository: feed::REPOSITORY.into(),
            })
            .map_err(|_| fail("UPDATE_SOURCE_INVALID"))?;
            file.write_all(format!("{contents}\n").as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| fail("UPDATE_SOURCE_INVALID"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err(fail("UPDATE_SOURCE_INVALID")),
    }
}

pub fn repository(root: &Path) -> Result<&'static str, UpdateError> {
    initialize(root)?;
    let target = path(root)?;
    let mut bytes = Vec::new();
    fs::File::open(target)
        .and_then(|file| file.take(MAX_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| fail("UPDATE_SOURCE_INVALID"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(fail("UPDATE_SOURCE_INVALID"));
    }
    let selection: Selection =
        serde_json::from_slice(&bytes).map_err(|_| fail("UPDATE_SOURCE_INVALID"))?;
    normalize(&selection.repository)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_once_then_rereads_edits_without_overwriting_them() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("설정 😶");
        initialize(&root).unwrap();
        assert_eq!(repository(&root).unwrap(), feed::REPOSITORY);
        for selected in [feed::TEST_REPOSITORY, feed::OFFICIAL_REPOSITORY] {
            let bytes = format!("{{\"repository\":\"https://github.com/{selected}/\"}}\n");
            fs::write(root.join(FILE_NAME), &bytes).unwrap();
            assert_eq!(repository(&root).unwrap(), selected);
            initialize(&root).unwrap();
            assert_eq!(fs::read_to_string(root.join(FILE_NAME)).unwrap(), bytes);
        }
    }

    #[test]
    fn invalid_or_missing_identity_never_falls_back_to_the_compiled_default() {
        let temporary = tempfile::tempdir().unwrap();
        for invalid in [
            "{}".to_owned(),
            "{\"repository\":\"attacker/repository\"}".into(),
            format!(
                "{{\"repository\":\"{}\",\"publicKey\":\"untrusted\"}}",
                feed::TEST_REPOSITORY
            ),
            "{ broken JSON".into(),
            "x".repeat(MAX_BYTES as usize + 1),
        ] {
            fs::write(temporary.path().join(FILE_NAME), &invalid).unwrap();
            assert_eq!(
                repository(temporary.path()).unwrap_err().code,
                "UPDATE_SOURCE_INVALID"
            );
            assert_eq!(
                fs::read_to_string(temporary.path().join(FILE_NAME)).unwrap(),
                invalid
            );
        }
    }

    #[test]
    fn only_exact_slugs_and_github_repository_urls_are_accepted() {
        for allowed in [feed::OFFICIAL_REPOSITORY, feed::TEST_REPOSITORY] {
            assert_eq!(normalize(allowed).unwrap(), allowed);
            assert_eq!(
                normalize(&format!("https://github.com/{allowed}")).unwrap(),
                allowed
            );
        }
        for invalid in [
            "http://github.com/oup030416/dmelopers-3d-block-pet-test",
            "https://github.com/oup030416/dmelopers-3d-block-pet-test?ref=main",
            "https://user@github.com/oup030416/dmelopers-3d-block-pet-test",
            "https://github.com/oup030416/dmelopers-3d-block-pet-test/updates/stable.json",
            "https://github.com.evil.test/oup030416/dmelopers-3d-block-pet-test",
        ] {
            assert_eq!(
                normalize(invalid).unwrap_err().code,
                "UPDATE_SOURCE_INVALID"
            );
        }
    }
}
