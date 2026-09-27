use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};

use super::{
    ErrorCode, MAX_BYTES,
    feed::{FUTURE_TOLERANCE, Feed},
};

const CACHE_FILE: &str = "latest-version.json";
// Feed bytes plus small local metadata, still bounded on both read and write.
const CACHE_MAX_BYTES: usize = MAX_BYTES + 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Cache {
    pub schema_version: u32,
    pub feed: Option<Feed>,
    pub last_success_at: Option<u64>,
    pub last_attempt_at: Option<u64>,
    pub error_code: Option<ErrorCode>,
}

impl Cache {
    pub fn empty() -> Self {
        Self {
            schema_version: 1,
            ..Self::default()
        }
    }

    fn valid(&self, now: u64) -> bool {
        self.schema_version == 1
            && self
                .last_attempt_at
                .is_some_and(|attempt| attempt <= now.saturating_add(FUTURE_TOLERANCE))
            && match (&self.feed, self.last_success_at) {
                (Some(feed), Some(success)) => {
                    feed.validate().is_ok()
                        && success <= now.saturating_add(FUTURE_TOLERANCE)
                        && self
                            .last_attempt_at
                            .is_some_and(|attempt| success <= attempt)
                }
                (None, None) => self.error_code.is_some(),
                _ => false,
            }
    }
}

pub(super) fn read(root: &Path, now: u64) -> Option<Cache> {
    let path = root.join(CACHE_FILE);
    crate::state_safety::check_path(&path).inspect_err(|code| {
        crate::diagnostics::warn("latest_version.cache_read", code);
    }).ok()?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            cache_read_error(&error);
            return None;
        }
    };
    if !metadata.is_file() || metadata.len() > CACHE_MAX_BYTES as u64 {
        crate::diagnostics::warn("latest_version.cache_read", "INVALID_CACHE_FILE");
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .inspect_err(cache_read_error).ok()?
        .take(CACHE_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .inspect_err(cache_read_error).ok()?;
    if bytes.len() > CACHE_MAX_BYTES {
        crate::diagnostics::warn("latest_version.cache_read", "CACHE_TOO_LARGE");
        return None;
    }
    let cache: Cache = serde_json::from_slice(&bytes).inspect_err(|_| {
        crate::diagnostics::warn("latest_version.cache_read", "INVALID_CACHE_JSON");
    }).ok()?;
    if !cache.valid(now) {
        crate::diagnostics::warn("latest_version.cache_read", "INVALID_CACHE_METADATA");
        return None;
    }
    Some(cache)
}

fn cache_read_error(error: &io::Error) {
    crate::diagnostics::warn("latest_version.cache_read", &format!("IO_{:?}_OS_{}", error.kind(), error.raw_os_error().unwrap_or(0)));
}

pub(super) fn write(root: &Path, cache: &Cache) -> io::Result<()> {
    let destination = root.join(CACHE_FILE);
    safe_path(&destination)?;
    fs::create_dir_all(root)?;
    safe_path(&destination)?;
    if let Ok(metadata) = fs::symlink_metadata(&destination)
        && !metadata.is_file()
    {
        return Err(io::Error::other("invalid cache file"));
    }
    let bytes = serde_json::to_vec(cache).map_err(io::Error::other)?;
    if bytes.len() > CACHE_MAX_BYTES {
        return Err(io::Error::other("cache exceeds byte limit"));
    }
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = root.join(format!(
        ".latest-version-{}-{sequence}.tmp",
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        safe_path(&temporary)?;
        safe_path(&destination)?;
        atomic_replace(&temporary, &destination)
    })();
    if result.is_err() {
        // This invocation created the temporary file; unrelated leftovers stay intact.
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn safe_path(path: &Path) -> io::Result<()> {
    crate::state_safety::check_path(path).map_err(io::Error::other)
}

fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    // As in the existing skin cache writer, canonical extended paths support
    // Unicode and long user-profile paths without changing Windows policy.
    let source = fs::canonicalize(source)?;
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::other("missing cache parent"))?;
    let name = destination
        .file_name()
        .ok_or_else(|| io::Error::other("missing cache filename"))?;
    let destination = fs::canonicalize(parent)?.join(name);
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: owned, NUL-terminated UTF-16 buffers outlive this synchronous call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
