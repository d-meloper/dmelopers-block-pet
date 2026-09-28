use std::{
    collections::HashSet,
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose};
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[path = "preset_transfer.rs"]
pub(crate) mod preset_transfer;

const CATALOG_VERSION: u32 = 1;
const LIBRARY_DIRECTORY: &str = "skin-library";
const MANIFEST_FILE: &str = "manifest.json";
const CATALOG_BYTE_LIMIT: usize = 2 * 1024 * 1024 * 1024;
const RAW_DIRECTORY: &str = "raw";
const THUMBNAIL_DIRECTORY: &str = "thumbnails";
const RAW_PNG_LIMIT: usize = 2 * 1024 * 1024;
const THUMBNAIL_PNG_LIMIT: usize = 256 * 1024;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum SkinLibrarySource {
    Java,
    Local,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkinLibraryModel {
    Wide,
    Slim,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreSkinLibraryEntryRequest {
    pub source: SkinLibrarySource,
    pub display_name: String,
    #[serde(default)]
    pub canonical_nickname: Option<String>,
    #[serde(default)]
    pub original_filename: Option<String>,
    pub model: SkinLibraryModel,
    pub png_base64: String,
    pub thumbnail_png_base64: String,
    #[serde(default = "default_overwrite_existing")]
    pub overwrite_existing: bool,
}

fn default_overwrite_existing() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkinLibraryEntry {
    pub id: String,
    pub source: SkinLibrarySource,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_filename: Option<String>,
    pub model: SkinLibraryModel,
    pub png_sha256: String,
    pub width: u32,
    pub height: u32,
    pub thumbnail_png_base64: String,
    pub added_at: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkinLibraryReadResponse {
    #[serde(flatten)]
    pub entry: SkinLibraryEntry,
    pub png_base64: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadLocalSkinFileResponse {
    pub original_filename: String,
    pub png_base64: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSkinLibraryEntriesResponse {
    pub deleted_entry_ids: Vec<String>,
    pub cleanup_pending: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSkinLibraryResponse {
    pub cleanup_pending: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClearSkinLibraryResponse {
    pub deleted_count: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkinLibraryErrorResponse {
    pub code: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LibraryErrorKind {
    StorageUnavailable,
    InvalidRequest,
    InvalidPng,
    InvalidDimensions,
    TooLarge,
    CatalogCorrupt,
    EntryNotFound,
    EntryAlreadyExists,
    Io,
}

#[derive(Clone, Debug)]
struct LibraryError {
    kind: LibraryErrorKind,
}

impl LibraryError {
    fn new(kind: LibraryErrorKind) -> Self {
        Self { kind }
    }
}

impl From<LibraryError> for SkinLibraryErrorResponse {
    fn from(error: LibraryError) -> Self {
        let code = match error.kind {
            LibraryErrorKind::StorageUnavailable => "STORAGE_UNAVAILABLE",
            LibraryErrorKind::InvalidRequest => "INVALID_REQUEST",
            LibraryErrorKind::InvalidPng => "INVALID_PNG",
            LibraryErrorKind::InvalidDimensions => "INVALID_DIMENSIONS",
            LibraryErrorKind::TooLarge => "TOO_LARGE",
            LibraryErrorKind::CatalogCorrupt => "CATALOG_CORRUPT",
            LibraryErrorKind::EntryNotFound => "ENTRY_NOT_FOUND",
            LibraryErrorKind::EntryAlreadyExists => "ENTRY_ALREADY_EXISTS",
            LibraryErrorKind::Io => "IO_ERROR",
        };
        Self {
            code: code.to_owned(),
        }
    }
}

fn log_library_io(operation: &'static str, error: &io::Error) {
    crate::diagnostics::warn(
        operation,
        &format!("IO_{:?}_OS_{}", error.kind(), error.raw_os_error().unwrap_or(0)),
    );
}

impl From<io::Error> for LibraryError {
    fn from(error: io::Error) -> Self {
        log_library_io("skin_library.storage", &error);
        Self::new(LibraryErrorKind::Io)
    }
}

pub struct SkinLibraryState {
    service: Arc<SkinLibraryService>,
}

impl SkinLibraryState {
    pub fn new(app_handle: &tauri::AppHandle) -> Self {
        let root = crate::data_paths::durable_root(app_handle)
            .inspect_err(|_| crate::diagnostics::warn("skin_library.initialize", "STORAGE_UNAVAILABLE"))
            .ok()
            .map(|path| path.join(LIBRARY_DIRECTORY));
        Self {
            service: Arc::new(SkinLibraryService::new(root)),
        }
    }
}

#[tauri::command]
pub async fn list_skin_library(
    state: tauri::State<'_, SkinLibraryState>,
) -> Result<Vec<SkinLibraryEntry>, SkinLibraryErrorResponse> {
    let service = Arc::clone(&state.service);
    run_blocking("skin_library.list", move || service.list()).await
}

#[tauri::command]
pub async fn store_skin_library_entry(
    request: StoreSkinLibraryEntryRequest,
    state: tauri::State<'_, SkinLibraryState>,
) -> Result<SkinLibraryEntry, SkinLibraryErrorResponse> {
    let service = Arc::clone(&state.service);
    run_blocking("skin_library.store", move || {
        let _guard = crate::state_safety::guard_write().map_err(|_| LibraryError::new(LibraryErrorKind::Io))?;
        service.ensure_no_preset_import()?;
        service.store(request)
    }).await
}

#[tauri::command]
pub async fn read_skin_library_entry(
    entry_id: String,
    state: tauri::State<'_, SkinLibraryState>,
) -> Result<SkinLibraryReadResponse, SkinLibraryErrorResponse> {
    let service = Arc::clone(&state.service);
    run_blocking("skin_library.read", move || service.read(&entry_id)).await
}

#[tauri::command]
pub async fn read_local_skin_file(
    file_path: String,
) -> Result<ReadLocalSkinFileResponse, SkinLibraryErrorResponse> {
    run_blocking("skin_library.read_local", move || read_local_skin_file_path(&file_path)).await
}

#[tauri::command]
pub async fn rename_skin_library_entry(
    entry_id: String,
    display_name: String,
    state: tauri::State<'_, SkinLibraryState>,
) -> Result<SkinLibraryEntry, SkinLibraryErrorResponse> {
    let service = Arc::clone(&state.service);
    run_blocking("skin_library.rename", move || {
        let _guard = crate::state_safety::guard_write().map_err(|_| LibraryError::new(LibraryErrorKind::Io))?;
        service.ensure_no_preset_import()?;
        service.rename(&entry_id, &display_name)
    }).await
}

#[tauri::command]
pub async fn delete_skin_library_entries(
    entry_ids: Vec<String>,
    state: tauri::State<'_, SkinLibraryState>,
) -> Result<DeleteSkinLibraryEntriesResponse, SkinLibraryErrorResponse> {
    let service = Arc::clone(&state.service);
    run_blocking("skin_library.delete", move || {
        let _guard = crate::state_safety::guard_write().map_err(|_| LibraryError::new(LibraryErrorKind::Io))?;
        service.ensure_no_preset_import()?;
        service.delete(&entry_ids)
    }).await
}

#[tauri::command]
pub async fn cleanup_skin_library(
    state: tauri::State<'_, SkinLibraryState>,
) -> Result<CleanupSkinLibraryResponse, SkinLibraryErrorResponse> {
    let service = Arc::clone(&state.service);
    run_blocking("skin_library.cleanup", move || {
        let _guard = crate::state_safety::guard_write().map_err(|_| LibraryError::new(LibraryErrorKind::Io))?;
        service.ensure_no_preset_import()?;
        service.cleanup()
    }).await
}

#[tauri::command]
pub async fn clear_skin_library(
    state: tauri::State<'_, SkinLibraryState>,
) -> Result<ClearSkinLibraryResponse, SkinLibraryErrorResponse> {
    let service = Arc::clone(&state.service);
    run_blocking("skin_library.clear", move || {
        let _guard = crate::state_safety::guard_write().map_err(|_| LibraryError::new(LibraryErrorKind::Io))?;
        service.ensure_no_preset_import()?;
        service.clear()
    }).await
}

async fn run_blocking<T: Send + 'static>(
    operation_name: &'static str,
    operation: impl FnOnce() -> Result<T, LibraryError> + Send + 'static,
) -> Result<T, SkinLibraryErrorResponse> {
    let result = tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| LibraryError::new(LibraryErrorKind::Io))
        .and_then(|result| result)
        .map_err(SkinLibraryErrorResponse::from);
    if let Err(error) = &result {
        crate::diagnostics::warn(operation_name, &error.code);
    }
    result
}

struct SkinLibraryService {
    root: Option<PathBuf>,
    operation_lock: Mutex<()>,
}

impl SkinLibraryService {
    fn new(root: Option<PathBuf>) -> Self {
        Self {
            root,
            operation_lock: Mutex::new(()),
        }
    }

    fn list(&self) -> Result<Vec<SkinLibraryEntry>, LibraryError> {
        let _guard = self.lock()?;
        let root = self.root()?;
        let mut catalog = load_catalog(root)?;
        sort_entries(&mut catalog.entries);
        catalog
            .entries
            .iter()
            .map(|entry| public_entry(root, entry))
            .collect()
    }

    fn store(
        &self,
        request: StoreSkinLibraryEntryRequest,
    ) -> Result<SkinLibraryEntry, LibraryError> {
        self.store_with_catalog_limit(request, CATALOG_BYTE_LIMIT)
    }

    // The same byte budget governs the reader and atomic writer. Tests exercise
    // this production path with small exact boundaries, without a 2 GiB allocation.
    fn store_with_catalog_limit(
        &self,
        request: StoreSkinLibraryEntryRequest,
        catalog_byte_limit: usize,
    ) -> Result<SkinLibraryEntry, LibraryError> {
        self.store_with_options(request, catalog_byte_limit, true)
    }

    fn store_with_options(
        &self,
        request: StoreSkinLibraryEntryRequest,
        catalog_byte_limit: usize,
        cleanup: bool,
    ) -> Result<SkinLibraryEntry, LibraryError> {
        let validated = validate_store_request(request)?;
        let _guard = self.lock()?;
        let root = self.root()?;
        let mut catalog = load_catalog_with_limit(root, catalog_byte_limit)?;
        let existing_index = catalog
            .entries
            .iter()
            .position(|entry| entry.id == validated.id);
        if existing_index.is_some() && !validated.overwrite_existing {
            return Err(LibraryError::new(LibraryErrorKind::EntryAlreadyExists));
        }
        ensure_library_directories(root)?;

        let same_content = existing_index
            .and_then(|index| catalog.entries.get(index))
            .is_some_and(|entry| entry.png_sha256 == validated.png.sha256);
        let added_at = if let Some(index) = existing_index {
            if same_content {
                catalog.entries[index].added_at
            } else {
                next_added_at(&catalog.entries)
            }
        } else {
            next_added_at(&catalog.entries)
        };

        let raw_created = store_content_addressed_asset(
            root,
            RAW_DIRECTORY,
            &validated.png.sha256,
            &validated.png.bytes,
            AssetKind::Raw,
        )?;
        let thumbnail_created = match store_content_addressed_asset(
            root,
            THUMBNAIL_DIRECTORY,
            &validated.thumbnail.sha256,
            &validated.thumbnail.bytes,
            AssetKind::Thumbnail,
        ) {
            Ok(created) => created,
            Err(error) => {
                if raw_created {
                    let _ = fs::remove_file(asset_path(root, RAW_DIRECTORY, &validated.png.sha256));
                }
                return Err(error);
            }
        };

        let catalog_entry = CatalogEntry {
            id: validated.id,
            source: validated.source,
            display_name: validated.display_name,
            canonical_nickname: validated.canonical_nickname,
            original_filename: validated.original_filename,
            model: validated.model,
            png_sha256: validated.png.sha256,
            width: validated.png.width,
            height: validated.png.height,
            thumbnail_sha256: validated.thumbnail.sha256,
            thumbnail_width: validated.thumbnail.width,
            thumbnail_height: validated.thumbnail.height,
            added_at,
        };
        if let Some(index) = existing_index {
            catalog.entries[index] = catalog_entry.clone();
        } else {
            catalog.entries.push(catalog_entry.clone());
        }
        sort_entries(&mut catalog.entries);

        if let Err(error) = write_catalog_atomic_with_limit(root, &catalog, catalog_byte_limit) {
            if raw_created {
                let _ = fs::remove_file(asset_path(root, RAW_DIRECTORY, &catalog_entry.png_sha256));
            }
            if thumbnail_created {
                let _ = fs::remove_file(asset_path(
                    root,
                    THUMBNAIL_DIRECTORY,
                    &catalog_entry.thumbnail_sha256,
                ));
            }
            return Err(error);
        }

        if cleanup {
            let _ = remove_unreferenced_assets(root, &catalog);
        }
        public_entry(root, &catalog_entry)
    }

    fn read(&self, entry_id: &str) -> Result<SkinLibraryReadResponse, LibraryError> {
        validate_entry_id(entry_id)
            .map_err(|_| LibraryError::new(LibraryErrorKind::InvalidRequest))?;
        let _guard = self.lock()?;
        let root = self.root()?;
        let catalog = load_catalog(root)?;
        let entry = catalog
            .entries
            .iter()
            .find(|entry| entry.id == entry_id)
            .ok_or_else(|| LibraryError::new(LibraryErrorKind::EntryNotFound))?;
        let raw = read_and_validate_asset(root, RAW_DIRECTORY, &entry.png_sha256, AssetKind::Raw)?;
        Ok(SkinLibraryReadResponse {
            entry: public_entry(root, entry)?,
            png_base64: general_purpose::STANDARD.encode(raw.bytes),
        })
    }

    fn rename(&self, entry_id: &str, display_name: &str) -> Result<SkinLibraryEntry, LibraryError> {
        validate_entry_id(entry_id)
            .map_err(|_| LibraryError::new(LibraryErrorKind::InvalidRequest))?;
        let display_name = validate_display_name(display_name)?;
        let _guard = self.lock()?;
        let root = self.root()?;
        let mut catalog = load_catalog(root)?;
        let index = catalog
            .entries
            .iter()
            .position(|entry| entry.id == entry_id)
            .ok_or_else(|| LibraryError::new(LibraryErrorKind::EntryNotFound))?;
        catalog.entries[index].display_name = display_name;
        let renamed = catalog.entries[index].clone();
        write_catalog_atomic(root, &catalog)?;
        public_entry(root, &renamed)
    }

    fn delete(
        &self,
        entry_ids: &[String],
    ) -> Result<DeleteSkinLibraryEntriesResponse, LibraryError> {
        if entry_ids.is_empty() {
            return Err(LibraryError::new(LibraryErrorKind::InvalidRequest));
        }
        let mut requested = HashSet::with_capacity(entry_ids.len());
        for entry_id in entry_ids {
            validate_entry_id(entry_id)
                .map_err(|_| LibraryError::new(LibraryErrorKind::InvalidRequest))?;
            if !requested.insert(entry_id.as_str()) {
                return Err(LibraryError::new(LibraryErrorKind::InvalidRequest));
            }
        }

        let _guard = self.lock()?;
        let root = self.root()?;
        let mut catalog = load_catalog(root)?;
        if requested
            .iter()
            .any(|id| !catalog.entries.iter().any(|entry| entry.id == *id))
        {
            return Err(LibraryError::new(LibraryErrorKind::EntryNotFound));
        }

        catalog
            .entries
            .retain(|entry| !requested.contains(entry.id.as_str()));
        write_catalog_atomic(root, &catalog)?;
        // The catalog deletion is committed even when a locked file needs a
        // later retry. Keep logical deletion and physical cleanup distinguishable.
        let cleanup_pending = remove_unreferenced_assets(root, &catalog).is_err();
        Ok(DeleteSkinLibraryEntriesResponse {
            deleted_entry_ids: entry_ids.to_vec(),
            cleanup_pending,
        })
    }

    fn cleanup(&self) -> Result<CleanupSkinLibraryResponse, LibraryError> {
        let _guard = self.lock()?;
        let root = self.root()?;
        let catalog = load_catalog(root)?;
        Ok(CleanupSkinLibraryResponse {
            cleanup_pending: remove_unreferenced_assets(root, &catalog).is_err(),
        })
    }

    fn clear(&self) -> Result<ClearSkinLibraryResponse, LibraryError> {
        self.clear_with_cleanup(|root| fs::remove_dir_all(root))
    }

    fn clear_with_cleanup(
        &self,
        cleanup: impl FnOnce(&Path) -> io::Result<()>,
    ) -> Result<ClearSkinLibraryResponse, LibraryError> {
        let _guard = self.lock()?;
        let root = self.root()?;
        let catalog = load_catalog(root)?;
        let deleted_count = catalog.entries.len();
        if !root.exists() {
            return Ok(ClearSkinLibraryResponse { deleted_count });
        }

        // Commit an empty catalog before removing assets: recursive deletion may
        // fail after removing only some files, so its output cannot be rolled back
        // into a valid library. An absent manifest also loads as an empty catalog.
        write_catalog_atomic(root, &Catalog::default())?;
        // Preserve the error so whole-program reset stops. A retry can remove any
        // remaining files at the same root without loading now-missing assets.
        cleanup(root)?;
        Ok(ClearSkinLibraryResponse { deleted_count })
    }

    fn root(&self) -> Result<&Path, LibraryError> {
        self.root
            .as_deref()
            .ok_or_else(|| LibraryError::new(LibraryErrorKind::StorageUnavailable))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, LibraryError> {
        self.operation_lock
            .lock()
            .map_err(|_| LibraryError::new(LibraryErrorKind::Io))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    version: u32,
    entries: Vec<CatalogEntry>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            version: CATALOG_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogEntry {
    id: String,
    source: SkinLibrarySource,
    display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    canonical_nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_filename: Option<String>,
    model: SkinLibraryModel,
    png_sha256: String,
    width: u32,
    height: u32,
    thumbnail_sha256: String,
    thumbnail_width: u32,
    thumbnail_height: u32,
    added_at: u64,
}

struct ValidatedStoreRequest {
    id: String,
    source: SkinLibrarySource,
    display_name: String,
    canonical_nickname: Option<String>,
    original_filename: Option<String>,
    model: SkinLibraryModel,
    png: ValidatedPng,
    thumbnail: ValidatedPng,
    overwrite_existing: bool,
}

struct ValidatedPng {
    bytes: Vec<u8>,
    sha256: String,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy)]
enum AssetKind {
    Raw,
    Thumbnail,
}

fn validate_store_request(
    request: StoreSkinLibraryEntryRequest,
) -> Result<ValidatedStoreRequest, LibraryError> {
    let display_name = validate_display_name(&request.display_name)?;
    let (canonical_nickname, original_filename, identity_key) = match request.source {
        SkinLibrarySource::Java => {
            let canonical = request
                .canonical_nickname
                .as_deref()
                .ok_or_else(|| LibraryError::new(LibraryErrorKind::InvalidRequest))?;
            if request.original_filename.is_some() || !is_valid_java_nickname(canonical) {
                return Err(LibraryError::new(LibraryErrorKind::InvalidRequest));
            }
            (
                Some(canonical.to_owned()),
                None,
                canonical.to_ascii_lowercase(),
            )
        }
        SkinLibrarySource::Local => {
            let filename = request
                .original_filename
                .as_deref()
                .ok_or_else(|| LibraryError::new(LibraryErrorKind::InvalidRequest))?;
            if request.canonical_nickname.is_some() || !is_safe_original_filename(filename) {
                return Err(LibraryError::new(LibraryErrorKind::InvalidRequest));
            }
            (None, Some(filename.to_owned()), filename.to_lowercase())
        }
    };
    let id = identity_id(request.source, &identity_key);
    let png_bytes = decode_base64(&request.png_base64, RAW_PNG_LIMIT)?;
    let png = validate_png(png_bytes, AssetKind::Raw)?;
    let thumbnail_bytes = decode_base64(&request.thumbnail_png_base64, THUMBNAIL_PNG_LIMIT)?;
    let thumbnail = validate_png(thumbnail_bytes, AssetKind::Thumbnail)?;

    Ok(ValidatedStoreRequest {
        id,
        source: request.source,
        display_name,
        canonical_nickname,
        original_filename,
        model: request.model,
        png,
        thumbnail,
        overwrite_existing: request.overwrite_existing,
    })
}

fn read_local_skin_file_path(file_path: &str) -> Result<ReadLocalSkinFileResponse, LibraryError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ,
    };

    let path = Path::new(file_path);
    if !path.is_absolute() {
        return Err(LibraryError::new(LibraryErrorKind::InvalidRequest));
    }
    let original_filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| is_safe_original_filename(name))
        .ok_or_else(|| LibraryError::new(LibraryErrorKind::InvalidRequest))?;
    // Validate and read the same opened object. Do not follow a final reparse
    // point or allow another opener to write/replace it while importing.
    // BACKUP_SEMANTICS lets directory inputs retain their InvalidRequest result.
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|_| LibraryError::new(LibraryErrorKind::Io))?;
    let metadata = file.metadata().map_err(|_| LibraryError::new(LibraryErrorKind::Io))?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(LibraryError::new(LibraryErrorKind::InvalidRequest));
    }

    let bytes = read_local_skin_bytes(file, metadata.len())?;
    let png = validate_png(bytes, AssetKind::Raw)?;
    Ok(ReadLocalSkinFileResponse {
        original_filename: original_filename.to_owned(),
        png_base64: general_purpose::STANDARD.encode(png.bytes),
    })
}

fn read_local_skin_bytes(reader: impl Read, reported_size: u64) -> Result<Vec<u8>, LibraryError> {
    if reported_size > RAW_PNG_LIMIT as u64 {
        return Err(LibraryError::new(LibraryErrorKind::TooLarge));
    }
    // Metadata is only an early rejection. Bound the stream even if a source
    // reports an outdated size; the extra byte distinguishes a full valid read.
    let mut bytes = Vec::new();
    reader
        .take(RAW_PNG_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::new(LibraryErrorKind::Io))?;
    if bytes.len() > RAW_PNG_LIMIT {
        return Err(LibraryError::new(LibraryErrorKind::TooLarge));
    }
    Ok(bytes)
}

fn validate_display_name(value: &str) -> Result<String, LibraryError> {
    if value.is_empty()
        || value.trim() != value
        || value.chars().count() > 255
        || value.chars().any(char::is_control)
    {
        return Err(LibraryError::new(LibraryErrorKind::InvalidRequest));
    }
    Ok(value.to_owned())
}

fn is_valid_java_nickname(value: &str) -> bool {
    (3..=16).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn is_safe_original_filename(value: &str) -> bool {
    if value.is_empty()
        || value.chars().count() > 255
        || value.chars().any(char::is_control)
        || value.contains(['/', '\\', ':'])
        || !value.to_ascii_lowercase().ends_with(".png")
    {
        return false;
    }
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn decode_base64(value: &str, max_bytes: usize) -> Result<Vec<u8>, LibraryError> {
    let max_encoded = max_bytes.saturating_add(2) / 3 * 4;
    if value.len() > max_encoded {
        return Err(LibraryError::new(LibraryErrorKind::TooLarge));
    }
    let bytes = general_purpose::STANDARD
        .decode(value)
        .map_err(|_| LibraryError::new(LibraryErrorKind::InvalidRequest))?;
    if bytes.len() > max_bytes {
        return Err(LibraryError::new(LibraryErrorKind::TooLarge));
    }
    Ok(bytes)
}

fn validate_png(bytes: Vec<u8>, kind: AssetKind) -> Result<ValidatedPng, LibraryError> {
    let (width, height) = validate_png_dimensions(&bytes, kind)?;
    Ok(ValidatedPng {
        sha256: sha256_hex(&bytes),
        bytes,
        width,
        height,
    })
}

fn validate_png_dimensions(bytes: &[u8], kind: AssetKind) -> Result<(u32, u32), LibraryError> {
    let max_bytes = match kind {
        AssetKind::Raw => RAW_PNG_LIMIT,
        AssetKind::Thumbnail => THUMBNAIL_PNG_LIMIT,
    };
    if bytes.len() > max_bytes {
        return Err(LibraryError::new(LibraryErrorKind::TooLarge));
    }
    if bytes.len() < 24
        || bytes.get(..8) != Some(PNG_SIGNATURE)
        || bytes.get(8..12) != Some(&13_u32.to_be_bytes())
        || bytes.get(12..16) != Some(b"IHDR")
    {
        return Err(LibraryError::new(LibraryErrorKind::InvalidPng));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("fixed PNG width slice"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("fixed PNG height slice"));
    let expected_dimensions = match kind {
        AssetKind::Raw => width == 64 && matches!(height, 32 | 64),
        AssetKind::Thumbnail => width == 64 && height == 64,
    };
    if !expected_dimensions {
        return Err(LibraryError::new(LibraryErrorKind::InvalidDimensions));
    }
    #[cfg(test)]
    tests::PNG_DECODE_COUNT.with(|count| count.set(count.get() + 1));
    let decoded = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|_| LibraryError::new(LibraryErrorKind::InvalidPng))?;
    if decoded.dimensions() != (width, height) {
        return Err(LibraryError::new(LibraryErrorKind::InvalidPng));
    }
    Ok((width, height))
}

fn load_catalog(root: &Path) -> Result<Catalog, LibraryError> {
    load_catalog_with_limit(root, CATALOG_BYTE_LIMIT)
}

fn load_catalog_with_limit(root: &Path, byte_limit: usize) -> Result<Catalog, LibraryError> {
    validate_existing_directory(root)?;
    let manifest_path = root.join(MANIFEST_FILE);
    let bytes = match read_regular_file(&manifest_path, byte_limit) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Catalog::default()),
        Err(error) => {
            log_library_io("skin_library.catalog_read", &error);
            return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
        }
    };
    let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|_| {
        crate::diagnostics::warn("skin_library.catalog_read", "INVALID_CATALOG_JSON");
        LibraryError::new(LibraryErrorKind::CatalogCorrupt)
    })?;
    validate_catalog(root, &catalog)?;
    Ok(catalog)
}

fn validate_existing_directory(path: &Path) -> Result<(), LibraryError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(LibraryError::new(LibraryErrorKind::Io)),
    }
}

fn validate_catalog(root: &Path, catalog: &Catalog) -> Result<(), LibraryError> {
    if catalog.version != CATALOG_VERSION {
        return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
    }
    let mut ids = HashSet::with_capacity(catalog.entries.len());
    let mut identities = HashSet::with_capacity(catalog.entries.len());
    for entry in &catalog.entries {
        validate_catalog_entry(entry)?;
        if !ids.insert(entry.id.as_str()) {
            return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
        }
        let identity = catalog_identity(entry)?;
        if !identities.insert((entry.source, identity.clone()))
            || entry.id != identity_id(entry.source, &identity)
        {
            return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
        }

        let raw = read_and_validate_asset(root, RAW_DIRECTORY, &entry.png_sha256, AssetKind::Raw)?;
        if raw.width != entry.width || raw.height != entry.height {
            return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
        }
        let thumbnail = read_and_validate_asset(
            root,
            THUMBNAIL_DIRECTORY,
            &entry.thumbnail_sha256,
            AssetKind::Thumbnail,
        )?;
        if thumbnail.width != entry.thumbnail_width || thumbnail.height != entry.thumbnail_height {
            return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
        }
    }
    Ok(())
}

fn validate_catalog_entry(entry: &CatalogEntry) -> Result<(), LibraryError> {
    validate_entry_id(&entry.id)?;
    validate_display_name(&entry.display_name)
        .map_err(|_| LibraryError::new(LibraryErrorKind::CatalogCorrupt))?;
    validate_hash(&entry.png_sha256)?;
    validate_hash(&entry.thumbnail_sha256)?;
    if entry.width != 64
        || !matches!(entry.height, 32 | 64)
        || entry.thumbnail_width != 64
        || entry.thumbnail_height != 64
        || entry.added_at == 0
    {
        return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
    }
    match entry.source {
        SkinLibrarySource::Java => {
            if entry.original_filename.is_some()
                || !entry
                    .canonical_nickname
                    .as_deref()
                    .is_some_and(is_valid_java_nickname)
            {
                return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
            }
        }
        SkinLibrarySource::Local => {
            if entry.canonical_nickname.is_some()
                || !entry
                    .original_filename
                    .as_deref()
                    .is_some_and(is_safe_original_filename)
            {
                return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
            }
        }
    }
    Ok(())
}

fn catalog_identity(entry: &CatalogEntry) -> Result<String, LibraryError> {
    match entry.source {
        SkinLibrarySource::Java => entry
            .canonical_nickname
            .as_deref()
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| LibraryError::new(LibraryErrorKind::CatalogCorrupt)),
        SkinLibrarySource::Local => entry
            .original_filename
            .as_deref()
            .map(str::to_lowercase)
            .ok_or_else(|| LibraryError::new(LibraryErrorKind::CatalogCorrupt)),
    }
}

fn validate_entry_id(value: &str) -> Result<(), LibraryError> {
    validate_hash(value)
}

fn validate_hash(value: &str) -> Result<(), LibraryError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
    }
    Ok(())
}

fn public_entry(root: &Path, entry: &CatalogEntry) -> Result<SkinLibraryEntry, LibraryError> {
    let thumbnail = read_and_validate_asset(
        root,
        THUMBNAIL_DIRECTORY,
        &entry.thumbnail_sha256,
        AssetKind::Thumbnail,
    )?;
    Ok(SkinLibraryEntry {
        id: entry.id.clone(),
        source: entry.source,
        display_name: entry.display_name.clone(),
        canonical_nickname: entry.canonical_nickname.clone(),
        original_filename: entry.original_filename.clone(),
        model: entry.model,
        png_sha256: entry.png_sha256.clone(),
        width: entry.width,
        height: entry.height,
        thumbnail_png_base64: general_purpose::STANDARD.encode(thumbnail.bytes),
        added_at: entry.added_at,
    })
}

fn read_and_validate_asset(
    root: &Path,
    directory: &str,
    expected_sha256: &str,
    kind: AssetKind,
) -> Result<ValidatedPng, LibraryError> {
    validate_hash(expected_sha256)?;
    let path = asset_path(root, directory, expected_sha256);
    let limit = match kind {
        AssetKind::Raw => RAW_PNG_LIMIT,
        AssetKind::Thumbnail => THUMBNAIL_PNG_LIMIT,
    };
    let operation = match kind {
        AssetKind::Raw => "skin_library.raw_asset_read",
        AssetKind::Thumbnail => "skin_library.thumbnail_read",
    };
    let bytes = read_regular_file(&path, limit).map_err(|error| {
        // A catalog reference requires this asset; missing referenced PNGs are failures.
        log_library_io(operation, &error);
        LibraryError::new(LibraryErrorKind::CatalogCorrupt)
    })?;
    let sha256 = sha256_hex(&bytes);
    if sha256 != expected_sha256 {
        crate::diagnostics::warn(operation, "ASSET_HASH_MISMATCH");
        return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
    }
    let (width, height) = validate_png_dimensions(&bytes, kind).map_err(|error| {
        crate::diagnostics::warn(operation, &SkinLibraryErrorResponse::from(error).code);
        LibraryError::new(LibraryErrorKind::CatalogCorrupt)
    })?;
    Ok(ValidatedPng {
        bytes,
        sha256,
        width,
        height,
    })
}

fn read_regular_file(path: &Path, max_bytes: usize) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a regular file",
        ));
    }
    if metadata.len() > max_bytes as u64 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file too large"));
    }
    read_bounded(fs::File::open(path)?, max_bytes)
}

fn read_bounded(reader: impl Read, max_bytes: usize) -> io::Result<Vec<u8>> {
    // The file can grow after metadata is read. Bound actual streamed bytes too.
    let mut bytes = Vec::new();
    reader
        .take((max_bytes as u64).saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file too large"));
    }
    Ok(bytes)
}

fn ensure_library_directories(root: &Path) -> Result<(), LibraryError> {
    ensure_directory(root)?;
    ensure_directory(&root.join(RAW_DIRECTORY))?;
    ensure_directory(&root.join(THUMBNAIL_DIRECTORY))?;
    Ok(())
}

fn ensure_directory(path: &Path) -> Result<(), LibraryError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path)?;
            let metadata = fs::symlink_metadata(path)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                Ok(())
            } else {
                Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt))
            }
        }
        Err(error) => Err(error.into()),
    }
}

fn store_content_addressed_asset(
    root: &Path,
    directory: &str,
    sha256: &str,
    bytes: &[u8],
    kind: AssetKind,
) -> Result<bool, LibraryError> {
    let destination = asset_path(root, directory, sha256);
    if destination.exists() {
        let existing = read_and_validate_asset(root, directory, sha256, kind)?;
        if existing.bytes != bytes {
            return Err(LibraryError::new(LibraryErrorKind::CatalogCorrupt));
        }
        return Ok(false);
    }

    let temporary = destination.with_file_name(format!(".{sha256}.{}.tmp", unique_file_suffix()));
    let result = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace_path(&temporary, &destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(true)
}

fn write_catalog_atomic(root: &Path, catalog: &Catalog) -> Result<(), LibraryError> {
    write_catalog_atomic_with_limit(root, catalog, CATALOG_BYTE_LIMIT)
}

fn write_catalog_atomic_with_limit(
    root: &Path,
    catalog: &Catalog,
    byte_limit: usize,
) -> Result<(), LibraryError> {
    let bytes = serde_json::to_vec(catalog)
        .map_err(|_| LibraryError::new(LibraryErrorKind::CatalogCorrupt))?;
    // Never commit a catalog that this same service refuses to read afterward.
    if bytes.len() > byte_limit {
        return Err(LibraryError::new(LibraryErrorKind::TooLarge));
    }
    ensure_library_directories(root)?;
    let destination = root.join(MANIFEST_FILE);
    let temporary = root.join(format!(".{MANIFEST_FILE}.{}.tmp", unique_file_suffix()));
    let result = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace_path(&temporary, &destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(Into::into)
}

fn remove_unreferenced_assets(root: &Path, catalog: &Catalog) -> Result<(), LibraryError> {
    // A retry may begin with an empty catalog, which does not otherwise inspect
    // the asset directories. Never follow directory links during garbage collection.
    validate_existing_directory(root)?;
    let raw_references: HashSet<&str> = catalog
        .entries
        .iter()
        .map(|entry| entry.png_sha256.as_str())
        .collect();
    let thumbnail_references: HashSet<&str> = catalog
        .entries
        .iter()
        .map(|entry| entry.thumbnail_sha256.as_str())
        .collect();
    let raw = remove_unreferenced_from_directory(root, RAW_DIRECTORY, &raw_references);
    let thumbnails = remove_unreferenced_from_directory(root, THUMBNAIL_DIRECTORY, &thumbnail_references);
    let result = raw.and(thumbnails);
    if result.is_err() {
        crate::diagnostics::warn("skin_library.cleanup", "CLEANUP_INCOMPLETE");
    }
    result
}

fn remove_unreferenced_from_directory(
    root: &Path,
    directory: &str,
    references: &HashSet<&str>,
) -> Result<(), LibraryError> {
    let path = root.join(directory);
    validate_existing_directory(&path)?;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let mut failure = None;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                failure = Some(LibraryError::from(error));
                continue;
            }
        };
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(hash) = file_name.strip_suffix(".png") else {
            continue;
        };
        if validate_hash(hash).is_err() || references.contains(hash) {
            continue;
        }
        match entry.file_type() {
            Ok(file_type) if file_type.is_file() && !file_type.is_symlink() => {
                if let Err(error) = fs::remove_file(entry.path()) {
                    if error.kind() != io::ErrorKind::NotFound {
                        failure = Some(LibraryError::from(error));
                    }
                }
            }
            Ok(_) => failure = Some(LibraryError::new(LibraryErrorKind::CatalogCorrupt)),
            Err(error) => failure = Some(LibraryError::from(error)),
        }
    }
    failure.map_or(Ok(()), Err)
}

fn asset_path(root: &Path, directory: &str, sha256: &str) -> PathBuf {
    root.join(directory).join(format!("{sha256}.png"))
}

fn identity_id(source: SkinLibrarySource, identity_key: &str) -> String {
    let namespace = match source {
        SkinLibrarySource::Java => "java",
        SkinLibrarySource::Local => "local",
    };
    sha256_hex(format!("{namespace}\0{identity_key}").as_bytes())
}

fn sort_entries(entries: &mut [CatalogEntry]) {
    entries.sort_by(|left, right| {
        right
            .added_at
            .cmp(&left.added_at)
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn next_added_at(entries: &[CatalogEntry]) -> u64 {
    let now = epoch_millis().max(1);
    let after_latest = entries
        .iter()
        .map(|entry| entry.added_at)
        .max()
        .unwrap_or(0)
        .saturating_add(1);
    now.max(after_latest)
}

fn sha256_hex(bytes: &[u8]) -> String {
    #[cfg(test)]
    tests::SHA256_COUNT.with(|count| count.set(count.get() + 1));
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn unique_file_suffix() -> String {
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos}-{counter}", std::process::id())
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn atomic_replace_path(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    // Rust file I/O accepts long paths without a system-wide opt-in. Preserve
    // that support for this direct Win32 call using canonical extended paths.
    // Resolve only the destination's parent so a new file need not exist and
    // an existing destination link is replaced, never followed.
    let source = std::fs::canonicalize(source)?;
    let destination_name = destination.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "missing destination filename")
    })?;
    let destination_parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let destination = std::fs::canonicalize(destination_parent)?.join(destination_name);
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
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

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
    use tempfile::TempDir;

    use super::*;

    thread_local! {
        pub(super) static PNG_DECODE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
        pub(super) static SHA256_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    #[test]
    fn catalog_asset_validation_preserves_bytes_and_dimensions_without_repeated_work() {
        for height in [32, 64] {
            let temp = TempDir::new().unwrap();
            let service = service(&temp);
            let raw = make_png(64, height, 63);
            let thumbnail = make_png(64, 64, 64);
            let stored = service
                .store(request(
                    SkinLibrarySource::Local,
                    "validation.png",
                    &raw,
                    &thumbnail,
                ))
                .unwrap();
            let root = temp.path().join(LIBRARY_DIRECTORY);
            PNG_DECODE_COUNT.set(0);
            SHA256_COUNT.set(0);
            let catalog = load_catalog(&root).unwrap();
            assert_eq!(PNG_DECODE_COUNT.get(), 2);
            // One digest per asset, plus the catalog's independent identity check.
            assert_eq!(SHA256_COUNT.get(), 3);
            assert_eq!(catalog.entries[0].height, height);
            let response = service.read(&stored.id).unwrap();
            assert_eq!(response.entry, stored);
            assert_eq!(
                general_purpose::STANDARD
                    .decode(response.png_base64)
                    .unwrap(),
                raw
            );
        }
    }

    #[test]
    fn cached_asset_validation_keeps_hash_decode_and_catalog_dimension_checks() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 65);
        let thumbnail = make_png(64, 64, 66);
        let stored = service
            .store(request(
                SkinLibrarySource::Local,
                "checks.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let root = temp.path().join(LIBRARY_DIRECTORY);
        let mut catalog = load_catalog(&root).unwrap();

        catalog.entries[0].height = 32;
        assert_eq!(
            validate_catalog(&root, &catalog).unwrap_err().kind,
            LibraryErrorKind::CatalogCorrupt
        );

        // A matching hash never substitutes for successful PNG decoding.
        let truncated = &raw[..24];
        let truncated_hash = sha256_hex(truncated);
        fs::write(asset_path(&root, RAW_DIRECTORY, &truncated_hash), truncated).unwrap();
        assert_eq!(
            read_and_validate_asset(&root, RAW_DIRECTORY, &truncated_hash, AssetKind::Raw)
                .err()
                .unwrap()
                .kind,
            LibraryErrorKind::CatalogCorrupt
        );

        // Preserve early hash rejection before handing changed bytes to the decoder.
        fs::write(
            asset_path(&root, RAW_DIRECTORY, &stored.png_sha256),
            truncated,
        )
        .unwrap();
        PNG_DECODE_COUNT.set(0);
        assert_eq!(
            read_and_validate_asset(&root, RAW_DIRECTORY, &stored.png_sha256, AssetKind::Raw)
                .err()
                .unwrap()
                .kind,
            LibraryErrorKind::CatalogCorrupt
        );
        assert_eq!(PNG_DECODE_COUNT.get(), 0);
    }

    fn make_png(width: u32, height: u32, value: u8) -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(
            width,
            height,
            Rgba([value, value.wrapping_add(1), value.wrapping_add(2), 255]),
        ));
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, ImageFormat::Png).unwrap();
        output.into_inner()
    }

    fn request(
        source: SkinLibrarySource,
        identity: &str,
        raw: &[u8],
        thumbnail: &[u8],
    ) -> StoreSkinLibraryEntryRequest {
        let (canonical_nickname, original_filename, display_name) = match source {
            SkinLibrarySource::Java => (Some(identity.to_owned()), None, identity.to_owned()),
            SkinLibrarySource::Local => (None, Some(identity.to_owned()), identity.to_owned()),
        };
        StoreSkinLibraryEntryRequest {
            source,
            display_name,
            canonical_nickname,
            original_filename,
            model: SkinLibraryModel::Wide,
            png_base64: general_purpose::STANDARD.encode(raw),
            thumbnail_png_base64: general_purpose::STANDARD.encode(thumbnail),
            overwrite_existing: true,
        }
    }

    #[test]
    fn overwrite_policy_is_atomic_and_omission_preserves_compatibility() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let original_raw = make_png(64, 64, 70);
        let replacement_raw = make_png(64, 32, 71);
        let original_thumbnail = make_png(64, 64, 72);
        let replacement_thumbnail = make_png(64, 64, 73);
        let original = service
            .store(request(
                SkinLibrarySource::Local,
                "CaseSensitive.png",
                &original_raw,
                &original_thumbnail,
            ))
            .unwrap();
        let root = temp.path().join(LIBRARY_DIRECTORY);
        let manifest_path = root.join(MANIFEST_FILE);
        let manifest_before = fs::read(&manifest_path).unwrap();
        let entry_before = service.read(&original.id).unwrap();
        let replacement_hash = sha256_hex(&replacement_raw);
        let replacement_thumbnail_hash = sha256_hex(&replacement_thumbnail);

        let mut refused = request(
            SkinLibrarySource::Local,
            "casesensitive.PNG",
            &replacement_raw,
            &replacement_thumbnail,
        );
        refused.display_name = "A renamed replacement".to_owned();
        refused.overwrite_existing = false;
        assert_eq!(
            service.store(refused.clone()).unwrap_err().kind,
            LibraryErrorKind::EntryAlreadyExists
        );
        assert_eq!(fs::read(&manifest_path).unwrap(), manifest_before);
        assert_eq!(service.read(&original.id).unwrap(), entry_before);
        assert!(!asset_path(&root, RAW_DIRECTORY, &replacement_hash).exists());
        assert!(!asset_path(&root, THUMBNAIL_DIRECTORY, &replacement_thumbnail_hash).exists());

        refused.overwrite_existing = true;
        let replaced = service.store(refused).unwrap();
        assert_eq!(replaced.id, original.id);
        assert_eq!(replaced.display_name, "A renamed replacement");
        assert_eq!(
            replaced.original_filename.as_deref(),
            Some("casesensitive.PNG")
        );
        assert_eq!(
            general_purpose::STANDARD
                .decode(service.read(&original.id).unwrap().png_base64)
                .unwrap(),
            replacement_raw
        );

        let omitted_json = serde_json::json!({
            "source": "local",
            "displayName": "Compatibility replacement",
            "originalFilename": "CASESENSITIVE.png",
            "model": "wide",
            "pngBase64": general_purpose::STANDARD.encode(&original_raw),
            "thumbnailPngBase64": general_purpose::STANDARD.encode(&original_thumbnail),
        });
        let omitted: StoreSkinLibraryEntryRequest = serde_json::from_value(omitted_json).unwrap();
        assert!(omitted.overwrite_existing);
        let compatibility_replacement = service.store(omitted).unwrap();
        assert_eq!(compatibility_replacement.id, original.id);
        assert_eq!(
            general_purpose::STANDARD
                .decode(service.read(&original.id).unwrap().png_base64)
                .unwrap(),
            original_raw
        );

        let mut new_without_overwrite = request(
            SkinLibrarySource::Local,
            "new.png",
            &original_raw,
            &original_thumbnail,
        );
        new_without_overwrite.overwrite_existing = false;
        assert!(service.store(new_without_overwrite).is_ok());
    }

    fn service(temp: &TempDir) -> SkinLibraryService {
        SkinLibraryService::new(Some(temp.path().join(LIBRARY_DIRECTORY)))
    }

    #[test]
    fn local_skin_reader_bounds_a_source_that_grows_after_size_inspection() {
        struct GrowingReader {
            consumed: usize,
        }
        impl Read for GrowingReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                // The inspected source contained one byte; more bytes continue
                // arriving after it. This deliberately never reaches EOF.
                buffer.fill(0);
                self.consumed += buffer.len();
                Ok(buffer.len())
            }
        }
        let mut reader = GrowingReader { consumed: 0 };
        assert_eq!(
            read_local_skin_bytes(&mut reader, 1).unwrap_err().kind,
            LibraryErrorKind::TooLarge
        );
        assert_eq!(reader.consumed, RAW_PNG_LIMIT + 1);
    }

    #[test]
    fn local_skin_reader_preserves_exact_limit_short_reads_and_io_errors() {
        let bytes = read_local_skin_bytes(io::repeat(7).take(RAW_PNG_LIMIT as u64), 1).unwrap();
        assert_eq!(bytes.len(), RAW_PNG_LIMIT);
        assert!(bytes.iter().all(|byte| *byte == 7));
        assert_eq!(read_local_skin_bytes(&b"short"[..], 100).unwrap(), b"short");

        struct FailingReader;
        impl Read for FailingReader {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            }
        }
        assert_eq!(read_local_skin_bytes(FailingReader, 1).unwrap_err().kind, LibraryErrorKind::Io);
        // The metadata rejection must happen before attempting the failing read.
        assert_eq!(
            read_local_skin_bytes(FailingReader, RAW_PNG_LIMIT as u64 + 1).unwrap_err().kind,
            LibraryErrorKind::TooLarge
        );
    }

    #[test]
    fn reads_valid_dropped_skin_files_without_persisting_the_source_path() {
        let temp = TempDir::new().unwrap();
        for (filename, height, value) in [("wide.PNG", 64, 1), ("legacy.png", 32, 2)] {
            let path = temp.path().join(filename);
            let bytes = make_png(64, height, value);
            fs::write(&path, &bytes).unwrap();

            let response = read_local_skin_file_path(path.to_str().unwrap()).unwrap();
            assert_eq!(response.original_filename, filename);
            assert_eq!(
                general_purpose::STANDARD
                    .decode(response.png_base64)
                    .unwrap(),
                bytes
            );
        }
    }

    #[test]
    fn leading_space_unicode_filename_survives_import_store_and_reload() {
        let temp = TempDir::new().unwrap();
        let source_directory = temp.path().join("OneDrive - 회사 安 😶 #100% [팀] & O'Brien");
        fs::create_dir_all(&source_directory).unwrap();
        let filename = " 스킨 😶 #100% [원본].png";
        let raw = make_png(64, 64, 70);
        let thumbnail = make_png(64, 64, 71);
        let source = source_directory.join(filename);
        fs::write(&source, &raw).unwrap();
        let imported = read_local_skin_file_path(source.to_str().unwrap()).unwrap();
        assert_eq!(imported.original_filename, filename);
        let mut input = request(SkinLibrarySource::Local, filename, &raw, &thumbnail);
        input.display_name = filename.trim().to_owned();
        let stored = service(&temp).store(input).unwrap();
        assert_eq!(stored.original_filename.as_deref(), Some(filename));
        assert_eq!(stored.display_name, filename.trim());
        assert_eq!(service(&temp).list().unwrap(), vec![stored.clone()]);
        assert_eq!(service(&temp).read(&stored.id).unwrap().entry, stored);
    }

    #[test]
    fn rename_preserves_identity_assets_metadata_and_catalog_order() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let first_raw = make_png(64, 64, 6);
        let second_raw = make_png(64, 32, 7);
        let first_thumbnail = make_png(64, 64, 8);
        let second_thumbnail = make_png(64, 64, 9);
        let first = service
            .store(request(
                SkinLibrarySource::Local,
                "first.png",
                &first_raw,
                &first_thumbnail,
            ))
            .unwrap();
        let second = service
            .store(request(
                SkinLibrarySource::Java,
                "Dmeloper",
                &second_raw,
                &second_thumbnail,
            ))
            .unwrap();
        let before = service.list().unwrap();
        let before_content = service.read(&first.id).unwrap();

        let renamed = service.rename(&first.id, &second.display_name).unwrap();
        let mut expected = first.clone();
        expected.display_name = second.display_name.clone();
        assert_eq!(renamed, expected);

        let after = service.list().unwrap();
        assert_eq!(
            after
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            before
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            after.iter().map(|entry| entry.added_at).collect::<Vec<_>>(),
            before
                .iter()
                .map(|entry| entry.added_at)
                .collect::<Vec<_>>()
        );
        let after_content = service.read(&first.id).unwrap();
        assert_eq!(after_content.entry, expected);
        assert_eq!(after_content.png_base64, before_content.png_base64);

        let reopened = SkinLibraryService::new(Some(temp.path().join(LIBRARY_DIRECTORY)));
        let persisted = reopened
            .list()
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == first.id)
            .unwrap();
        assert_eq!(persisted, expected);
    }

    #[test]
    fn rename_rejects_invalid_or_unknown_entries_without_changing_catalog() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 10);
        let thumbnail = make_png(64, 64, 11);
        let entry = service
            .store(request(
                SkinLibrarySource::Local,
                "kept.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let before = service.list().unwrap();

        assert_eq!(
            service.rename("../entry", "Safe name").unwrap_err().kind,
            LibraryErrorKind::InvalidRequest
        );
        for invalid_name in [
            "".to_owned(),
            " padded ".to_owned(),
            "bad\0name".to_owned(),
            "🐈".repeat(256),
        ] {
            assert_eq!(
                service.rename(&entry.id, &invalid_name).unwrap_err().kind,
                LibraryErrorKind::InvalidRequest
            );
        }
        assert_eq!(
            service.rename(&"f".repeat(64), "Missing").unwrap_err().kind,
            LibraryErrorKind::EntryNotFound
        );
        assert_eq!(service.list().unwrap(), before);
    }

    #[test]
    fn dropped_skin_reader_rejects_unsafe_paths_and_invalid_pngs() {
        let temp = TempDir::new().unwrap();
        assert_eq!(
            read_local_skin_file_path("relative.png").unwrap_err().kind,
            LibraryErrorKind::InvalidRequest
        );

        let directory = temp.path().join("directory.png");
        fs::create_dir(&directory).unwrap();
        assert_eq!(
            read_local_skin_file_path(directory.to_str().unwrap())
                .unwrap_err()
                .kind,
            LibraryErrorKind::InvalidRequest
        );

        let non_png = temp.path().join("skin.jpg");
        fs::write(&non_png, make_png(64, 64, 3)).unwrap();
        assert_eq!(
            read_local_skin_file_path(non_png.to_str().unwrap())
                .unwrap_err()
                .kind,
            LibraryErrorKind::InvalidRequest
        );

        let corrupt = temp.path().join("corrupt.png");
        fs::write(&corrupt, b"not a png").unwrap();
        assert_eq!(
            read_local_skin_file_path(corrupt.to_str().unwrap())
                .unwrap_err()
                .kind,
            LibraryErrorKind::InvalidPng
        );

        let wrong_dimensions = temp.path().join("wrong.png");
        fs::write(&wrong_dimensions, make_png(32, 32, 4)).unwrap();
        assert_eq!(
            read_local_skin_file_path(wrong_dimensions.to_str().unwrap())
                .unwrap_err()
                .kind,
            LibraryErrorKind::InvalidDimensions
        );

        let too_large = temp.path().join("large.png");
        fs::write(&too_large, vec![0; RAW_PNG_LIMIT + 1]).unwrap();
        assert_eq!(
            read_local_skin_file_path(too_large.to_str().unwrap())
                .unwrap_err()
                .kind,
            LibraryErrorKind::TooLarge
        );
    }

    #[test]
    fn dropped_skin_reader_rejects_symbolic_links() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("target.png");
        let link = temp.path().join("link.png");
        fs::write(&target, make_png(64, 64, 5)).unwrap();

        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&target, &link).is_err() {
            return;
        }

        assert_eq!(
            read_local_skin_file_path(link.to_str().unwrap())
                .unwrap_err()
                .kind,
            LibraryErrorKind::InvalidRequest
        );
    }

    #[test]
    fn identity_dedup_replacement_namespace_and_recent_sort_are_stable() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw_one = make_png(64, 64, 1);
        let raw_two = make_png(64, 64, 2);
        let thumbnail = make_png(64, 64, 3);

        let java = service
            .store(request(
                SkinLibrarySource::Java,
                "Jeb_",
                &raw_one,
                &thumbnail,
            ))
            .unwrap();
        let duplicate = service
            .store(request(
                SkinLibrarySource::Java,
                "jEB_",
                &raw_one,
                &thumbnail,
            ))
            .unwrap();
        assert_eq!(duplicate.id, java.id);
        assert_eq!(duplicate.added_at, java.added_at);
        assert_eq!(service.list().unwrap().len(), 1);

        let local = service
            .store(request(
                SkinLibrarySource::Local,
                "JEB_.png",
                &raw_one,
                &thumbnail,
            ))
            .unwrap();
        assert_ne!(local.id, java.id);
        assert_eq!(service.list().unwrap()[0].id, local.id);

        let replaced = service
            .store(request(
                SkinLibrarySource::Java,
                "JEB_",
                &raw_two,
                &thumbnail,
            ))
            .unwrap();
        assert_eq!(replaced.id, java.id);
        assert!(replaced.added_at > local.added_at);
        assert_eq!(service.list().unwrap()[0].id, java.id);
        assert_eq!(
            general_purpose::STANDARD
                .decode(service.read(&java.id).unwrap().png_base64)
                .unwrap(),
            raw_two
        );
    }

    #[test]
    fn same_content_reapply_does_not_change_existing_sort_position() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 8);
        let thumbnail = make_png(64, 64, 9);
        let first = service
            .store(request(
                SkinLibrarySource::Local,
                "first.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let second = service
            .store(request(
                SkinLibrarySource::Local,
                "second.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let repeated = service
            .store(request(
                SkinLibrarySource::Local,
                "FIRST.PNG",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        assert_eq!(repeated.added_at, first.added_at);
        assert_eq!(
            service
                .list()
                .unwrap()
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec![second.id.as_str(), first.id.as_str()]
        );
    }

    #[test]
    fn rejects_corrupt_png_wrong_dimensions_and_path_like_filename() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 10);
        let thumbnail = make_png(64, 64, 11);

        let corrupt = service
            .store(request(
                SkinLibrarySource::Local,
                "bad.png",
                b"not png",
                &thumbnail,
            ))
            .unwrap_err();
        assert_eq!(corrupt.kind, LibraryErrorKind::InvalidPng);

        let wrong_raw = make_png(32, 32, 12);
        let wrong = service
            .store(request(
                SkinLibrarySource::Local,
                "bad.png",
                &wrong_raw,
                &thumbnail,
            ))
            .unwrap_err();
        assert_eq!(wrong.kind, LibraryErrorKind::InvalidDimensions);

        let wrong_thumbnail = make_png(32, 32, 13);
        let wrong = service
            .store(request(
                SkinLibrarySource::Local,
                "bad.png",
                &raw,
                &wrong_thumbnail,
            ))
            .unwrap_err();
        assert_eq!(wrong.kind, LibraryErrorKind::InvalidDimensions);

        for filename in [
            "../bad.png",
            "folder/bad.png",
            "folder\\bad.png",
            "C:bad.png",
        ] {
            let error = service
                .store(request(
                    SkinLibrarySource::Local,
                    filename,
                    &raw,
                    &thumbnail,
                ))
                .unwrap_err();
            assert_eq!(error.kind, LibraryErrorKind::InvalidRequest);
        }
    }

    #[test]
    fn manifest_and_assets_use_safe_hash_paths_and_are_atomically_replaced() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw_one = make_png(64, 64, 20);
        let raw_two = make_png(64, 64, 21);
        let thumbnail = make_png(64, 64, 22);
        let first = service
            .store(request(
                SkinLibrarySource::Java,
                "Dmeloper",
                &raw_one,
                &thumbnail,
            ))
            .unwrap();
        let root = temp.path().join(LIBRARY_DIRECTORY);
        let first_manifest = fs::read(root.join(MANIFEST_FILE)).unwrap();
        assert!(asset_path(&root, RAW_DIRECTORY, &first.png_sha256).is_file());
        assert!(
            fs::read_dir(root.join(RAW_DIRECTORY))
                .unwrap()
                .all(|entry| entry.unwrap().file_name().to_string_lossy().len() == 68)
        );

        service
            .store(request(
                SkinLibrarySource::Java,
                "Dmeloper",
                &raw_two,
                &thumbnail,
            ))
            .unwrap();
        let second_manifest = fs::read(root.join(MANIFEST_FILE)).unwrap();
        assert_ne!(first_manifest, second_manifest);
        assert!(fs::read_dir(&root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
        assert_eq!(service.list().unwrap().len(), 1);
    }

    #[test]
    fn invalid_update_leaves_previous_manifest_and_entry_unchanged() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 30);
        let thumbnail = make_png(64, 64, 31);
        let original = service
            .store(request(SkinLibrarySource::Java, "Alex", &raw, &thumbnail))
            .unwrap();
        let manifest_path = temp.path().join(LIBRARY_DIRECTORY).join(MANIFEST_FILE);
        let before = fs::read(&manifest_path).unwrap();
        let error = service
            .store(request(
                SkinLibrarySource::Java,
                "Alex",
                b"partial",
                &thumbnail,
            ))
            .unwrap_err();
        assert_eq!(error.kind, LibraryErrorKind::InvalidPng);
        assert_eq!(fs::read(manifest_path).unwrap(), before);
        assert_eq!(service.list().unwrap(), vec![original]);
    }

    #[test]
    fn delete_is_atomic_for_missing_ids_and_batch_delete_removes_entries() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 40);
        let thumbnail = make_png(64, 64, 41);
        let first = service
            .store(request(
                SkinLibrarySource::Local,
                "one.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let second = service
            .store(request(
                SkinLibrarySource::Local,
                "two.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let missing = "0".repeat(64);
        assert_eq!(
            service
                .delete(&[first.id.clone(), missing])
                .unwrap_err()
                .kind,
            LibraryErrorKind::EntryNotFound
        );
        assert_eq!(service.list().unwrap().len(), 2);

        let deleted = service
            .delete(&[first.id.clone(), second.id.clone()])
            .unwrap();
        assert_eq!(deleted.deleted_entry_ids, vec![first.id, second.id]);
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn delete_removes_only_last_unreferenced_library_assets_and_preserves_originals() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 111);
        let thumbnail = make_png(64, 64, 112);
        let source = temp.path().join("original-user-skin.png");
        fs::write(&source, &raw).unwrap();
        let first = service.store(request(SkinLibrarySource::Local, "one.png", &raw, &thumbnail)).unwrap();
        let second = service.store(request(SkinLibrarySource::Local, "two.png", &raw, &thumbnail)).unwrap();
        let root = service.root().unwrap();
        let raw_path = asset_path(root, RAW_DIRECTORY, &sha256_hex(&raw));
        let thumbnail_path = asset_path(root, THUMBNAIL_DIRECTORY, &sha256_hex(&thumbnail));
        let unrelated = root.join(RAW_DIRECTORY).join("owner-note.txt");
        fs::write(&unrelated, b"keep").unwrap();

        let first_delete = service.delete(&[first.id]).unwrap();
        assert!(!first_delete.cleanup_pending);
        assert!(raw_path.is_file());
        assert!(thumbnail_path.is_file());
        assert_eq!(service.read(&second.id).unwrap().png_base64, general_purpose::STANDARD.encode(&raw));

        let last_delete = service.delete(&[second.id]).unwrap();
        assert!(!last_delete.cleanup_pending);
        assert!(!raw_path.exists());
        assert!(!thumbnail_path.exists());
        assert_eq!(fs::read(&source).unwrap(), raw);
        assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
        assert_eq!(load_catalog(root).unwrap().version, CATALOG_VERSION);
    }

    #[test]
    fn delete_reports_locked_asset_cleanup_and_retries_after_restart_without_a_journal() {
        use std::os::windows::fs::OpenOptionsExt;

        let temp = TempDir::new().unwrap();
        let library = service(&temp);
        let raw = make_png(64, 64, 113);
        let thumbnail = make_png(64, 64, 114);
        let entry = library.store(request(SkinLibrarySource::Local, "locked.png", &raw, &thumbnail)).unwrap();
        let root = library.root().unwrap();
        let raw_path = asset_path(root, RAW_DIRECTORY, &sha256_hex(&raw));
        let thumbnail_path = asset_path(root, THUMBNAIL_DIRECTORY, &sha256_hex(&thumbnail));
        // Allow normal catalog validation reads, but emulate another process
        // keeping the raw PNG open without FILE_SHARE_DELETE.
        let locked = fs::OpenOptions::new().read(true).share_mode(0x1 | 0x2).open(&raw_path).unwrap();
        let deleted = library.delete(&[entry.id.clone()]).unwrap();
        assert_eq!(deleted.deleted_entry_ids, vec![entry.id]);
        assert!(deleted.cleanup_pending);
        assert!(library.list().unwrap().is_empty());
        assert!(raw_path.is_file());
        assert!(!thumbnail_path.exists());

        let restarted = service(&temp);
        assert!(restarted.cleanup().unwrap().cleanup_pending);
        drop(locked);
        assert!(!restarted.cleanup().unwrap().cleanup_pending);
        assert!(!raw_path.exists());
        assert!(!restarted.cleanup().unwrap().cleanup_pending);
        assert_eq!(load_catalog(root).unwrap().version, CATALOG_VERSION);
    }

    #[test]
    fn failed_delete_catalog_commit_preserves_assets_and_catalog() {
        use std::os::windows::fs::OpenOptionsExt;

        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 115);
        let thumbnail = make_png(64, 64, 116);
        let entry = service.store(request(SkinLibrarySource::Local, "keep.png", &raw, &thumbnail)).unwrap();
        let root = service.root().unwrap();
        let manifest = root.join(MANIFEST_FILE);
        let before = fs::read(&manifest).unwrap();
        let locked = fs::OpenOptions::new().read(true).share_mode(0x1 | 0x2).open(&manifest).unwrap();
        assert_eq!(service.delete(&[entry.id.clone()]).unwrap_err().kind, LibraryErrorKind::Io);
        assert_eq!(fs::read(&manifest).unwrap(), before);
        assert!(asset_path(root, RAW_DIRECTORY, &sha256_hex(&raw)).is_file());
        assert!(asset_path(root, THUMBNAIL_DIRECTORY, &sha256_hex(&thumbnail)).is_file());
        assert_eq!(service.list().unwrap(), vec![entry]);
        drop(locked);
    }

    #[test]
    fn cleanup_rejects_an_invalid_asset_directory_even_with_an_empty_catalog() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let root = service.root().unwrap();
        fs::create_dir_all(root).unwrap();
        let unexpected_file = root.join(RAW_DIRECTORY);
        fs::write(&unexpected_file, b"not a directory").unwrap();
        assert!(service.cleanup().unwrap().cleanup_pending);
        assert_eq!(fs::read(&unexpected_file).unwrap(), b"not a directory");
    }

    #[test]
    fn cleanup_never_follows_asset_directory_links_or_accepts_a_corrupt_catalog() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let root = service.root().unwrap();
        fs::create_dir_all(root).unwrap();
        let external = temp.path().join("outside-library");
        fs::create_dir(&external).unwrap();
        let external_png = external.join(format!("{}.png", "a".repeat(64)));
        fs::write(&external_png, b"outside owner content").unwrap();
        let linked = std::os::windows::fs::symlink_dir(&external, root.join(RAW_DIRECTORY)).is_ok();
        if linked {
            assert!(service.cleanup().unwrap().cleanup_pending);
            assert_eq!(fs::read(&external_png).unwrap(), b"outside owner content");
        }
        fs::write(root.join(MANIFEST_FILE), b"invalid catalog").unwrap();
        assert_eq!(service.cleanup().unwrap_err().kind, LibraryErrorKind::CatalogCorrupt);
        assert_eq!(fs::read(&external_png).unwrap(), b"outside owner content");
    }

    #[test]
    fn oversized_catalog_replacement_preserves_the_readable_manifest() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 70);
        let thumbnail = make_png(64, 64, 71);
        let original = service
            .store(request(
                SkinLibrarySource::Local,
                "one.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let root = service.root().unwrap();
        let manifest = root.join(MANIFEST_FILE);
        let before = fs::read(&manifest).unwrap();
        let mut catalog = load_catalog(root).unwrap();
        let original_catalog = catalog.clone();
        let template = catalog.entries[0].clone();
        for index in 0..5_000 {
            let filename = format!("{}-{index}.png", "a".repeat(240));
            let mut entry = template.clone();
            entry.id = identity_id(SkinLibrarySource::Local, &filename);
            entry.original_filename = Some(filename);
            entry.display_name = "b".repeat(255);
            catalog.entries.push(entry);
        }
        assert!(serde_json::to_vec(&catalog).unwrap().len() < CATALOG_BYTE_LIMIT);
        // This used to be an oversized fixture at the old byte budget. Under
        // the current budget it remains readable: 5,001 records are not a count limit.
        write_catalog_atomic(root, &catalog).unwrap();
        assert_eq!(load_catalog(root).unwrap().entries.len(), 5_001);

        let limit = before.len();
        write_catalog_atomic_with_limit(root, &original_catalog, limit).unwrap();
        assert_eq!(load_catalog_with_limit(root, limit).unwrap().entries.len(), 1);
        assert_eq!(
            load_catalog_with_limit(root, limit - 1).unwrap_err().kind,
            LibraryErrorKind::CatalogCorrupt
        );
        assert_eq!(
            write_catalog_atomic_with_limit(root, &original_catalog, limit - 1)
                .unwrap_err()
                .kind,
            LibraryErrorKind::TooLarge
        );
        assert!(serde_json::to_vec(&catalog).unwrap().len() > limit);
        let error = write_catalog_atomic_with_limit(root, &catalog, limit).unwrap_err();
        assert_eq!(error.kind, LibraryErrorKind::TooLarge);
        assert_eq!(fs::read(&manifest).unwrap(), before);
        assert_eq!(service.list().unwrap(), vec![original]);
    }

    #[test]
    fn oversized_store_rolls_back_only_its_new_assets() {
        const LIMIT: usize = 4 * 1024;
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 74);
        let thumbnail = make_png(64, 64, 75);
        service
            .store(request(
                SkinLibrarySource::Local,
                "one.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let root = service.root().unwrap();
        let mut catalog = load_catalog(root).unwrap();
        let template = catalog.entries[0].clone();
        for index in 0..64 {
            let filename = format!("{}-{index:05}.png", "a".repeat(240));
            let mut entry = template.clone();
            entry.id = identity_id(SkinLibrarySource::Local, &filename);
            entry.original_filename = Some(filename);
            entry.display_name = "b".repeat(255);
            catalog.entries.push(entry);
        }
        assert!(serde_json::to_vec(&catalog).unwrap().len() > LIMIT);
        let mut low = 1;
        let mut high = catalog.entries.len();
        while low < high {
            let middle = (low + high + 1) / 2;
            let candidate = Catalog {
                version: CATALOG_VERSION,
                entries: catalog.entries[..middle].to_vec(),
            };
            if serde_json::to_vec(&candidate).unwrap().len() <= LIMIT {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        catalog.entries.truncate(low);
        write_catalog_atomic_with_limit(root, &catalog, LIMIT).unwrap();
        assert_eq!(
            load_catalog_with_limit(root, LIMIT).unwrap().entries.len(),
            low
        );
        let manifest = root.join(MANIFEST_FILE);
        let before = fs::read(&manifest).unwrap();
        let new_raw = make_png(64, 64, 76);
        let new_thumbnail = make_png(64, 64, 77);
        let filename = format!("{}-99999.png", "a".repeat(240));
        let mut input = request(
            SkinLibrarySource::Local,
            &filename,
            &new_raw,
            &new_thumbnail,
        );
        input.display_name = "b".repeat(255);
        assert_eq!(
            service.store_with_catalog_limit(input, LIMIT).unwrap_err().kind,
            LibraryErrorKind::TooLarge
        );
        assert_eq!(fs::read(&manifest).unwrap(), before);
        for (directory, old_bytes, new_bytes) in [
            (RAW_DIRECTORY, &raw, &new_raw),
            (THUMBNAIL_DIRECTORY, &thumbnail, &new_thumbnail),
        ] {
            assert!(asset_path(root, directory, &sha256_hex(old_bytes)).is_file());
            assert!(!asset_path(root, directory, &sha256_hex(new_bytes)).exists());
            assert_eq!(fs::read_dir(root.join(directory)).unwrap().count(), 1);
        }
    }

    #[test]
    fn bounded_reader_checks_actual_bytes_and_stops_after_the_first_excess_byte() {
        let bytes = vec![7u8; 8];
        assert_eq!(read_bounded(Cursor::new(&bytes), 8).unwrap(), bytes);
        // Model a stream that grew after its initial metadata observation.
        let mut growing = Cursor::new(vec![7u8; 128]);
        assert_eq!(
            read_bounded(&mut growing, 8).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(growing.position(), 9);
    }

    #[test]
    fn failed_clear_commit_preserves_the_catalog_without_starting_cleanup() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 78);
        let thumbnail = make_png(64, 64, 79);
        let original = service
            .store(request(
                SkinLibrarySource::Local,
                "one.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let manifest = service.root().unwrap().join(MANIFEST_FILE);
        let before = fs::read(&manifest).unwrap();
        let writable = fs::metadata(&manifest).unwrap().permissions();
        let mut readonly = writable.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&manifest, readonly).unwrap();
        let mut cleanup_started = false;
        let result = service.clear_with_cleanup(|_| {
            cleanup_started = true;
            Ok(())
        });
        fs::set_permissions(&manifest, writable).unwrap();
        assert_eq!(result.unwrap_err().kind, LibraryErrorKind::Io);
        assert!(!cleanup_started);
        assert_eq!(fs::read(&manifest).unwrap(), before);
        assert_eq!(service.list().unwrap(), vec![original]);
    }

    #[test]
    fn failed_clear_keeps_an_empty_catalog_and_reports_cleanup_failure_on_retry() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 72);
        let thumbnail = make_png(64, 64, 73);
        service
            .store(request(
                SkinLibrarySource::Local,
                "one.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let root = service.root().unwrap();
        // Inject the documented remove_dir_all error contract without deleting
        // any files. An error cannot prove that all original assets still exist.
        let error = service
            .clear_with_cleanup(|_| Err(io::ErrorKind::PermissionDenied.into()))
            .unwrap_err();
        assert_eq!(error.kind, LibraryErrorKind::Io);
        assert!(service.list().unwrap().is_empty());
        assert!(load_catalog(root).unwrap().entries.is_empty());
        let mut retried = false;
        let error = service
            .clear_with_cleanup(|cleanup_root| {
                retried = true;
                assert_eq!(cleanup_root, root);
                Err(io::ErrorKind::PermissionDenied.into())
            })
            .unwrap_err();
        assert!(retried);
        assert_eq!(error.kind, LibraryErrorKind::Io);
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn clear_removes_the_complete_library() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let raw = make_png(64, 64, 50);
        let thumbnail = make_png(64, 64, 51);
        service
            .store(request(
                SkinLibrarySource::Local,
                "one.png",
                &raw,
                &thumbnail,
            ))
            .unwrap();
        let root = temp.path().join(LIBRARY_DIRECTORY);
        assert_eq!(service.clear().unwrap().deleted_count, 1);
        assert!(!root.exists());
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn unicode_long_paths_round_trip_local_import_and_atomic_library_updates() {
        use std::os::windows::ffi::OsStrExt;

        let temp = TempDir::new().unwrap();
        let mut directory = temp.path().join("OneDrive - 테스트 [팀] & # % ' 😶");
        for _ in 0..12 {
            directory = directory.join("긴 경로 폴더 (공백) 특수문자 & # 😶");
        }
        assert!(directory.as_os_str().encode_wide().count() > 260);
        fs::create_dir_all(&directory).unwrap();
        let raw = make_png(64, 64, 60);
        let thumbnail = make_png(64, 64, 61);
        let filename = "사용자 스킨 [Wide] & # % ' 😶.png";
        let source = directory.join(filename);
        fs::write(&source, &raw).unwrap();
        let imported = read_local_skin_file_path(source.to_str().unwrap()).unwrap();
        assert_eq!(imported.original_filename, filename);
        assert_eq!(
            general_purpose::STANDARD.decode(imported.png_base64).unwrap(),
            raw
        );
        let service = SkinLibraryService::new(Some(directory.join(LIBRARY_DIRECTORY)));
        let entry = service
            .store(request(SkinLibrarySource::Local, filename, &raw, &thumbnail))
            .unwrap();
        assert_eq!(service.read(&entry.id).unwrap().entry, entry);
        let renamed = service
            .rename(&entry.id, "이름 변경 [이모지 😶] & # % '")
            .unwrap();
        assert_eq!(service.list().unwrap(), vec![renamed]);
    }

    #[test]
    fn corrupt_catalog_and_corrupt_assets_fail_closed() {
        let temp = TempDir::new().unwrap();
        let service = service(&temp);
        let root = temp.path().join(LIBRARY_DIRECTORY);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE), b"not json").unwrap();
        assert_eq!(
            service.list().unwrap_err().kind,
            LibraryErrorKind::CatalogCorrupt
        );
        assert_eq!(
            service.clear().unwrap_err().kind,
            LibraryErrorKind::CatalogCorrupt
        );
        assert!(root.join(MANIFEST_FILE).exists());

        fs::remove_dir_all(&root).unwrap();
        let raw = make_png(64, 64, 60);
        let thumbnail = make_png(64, 64, 61);
        let entry = service
            .store(request(SkinLibrarySource::Java, "Notch", &raw, &thumbnail))
            .unwrap();
        fs::write(
            asset_path(&root, RAW_DIRECTORY, &entry.png_sha256),
            b"corrupt",
        )
        .unwrap();
        assert_eq!(
            service.list().unwrap_err().kind,
            LibraryErrorKind::CatalogCorrupt
        );
        assert!(
            service
                .store(request(
                    SkinLibrarySource::Java,
                    "Dinnerbone",
                    &raw,
                    &thumbnail
                ))
                .is_err()
        );
    }
}
