//! Shared durable data is external to both installation lifecycles.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;
use tauri_plugin_pinia::ManagerExt;
use windows_sys::Win32::{
    System::Com::CoTaskMemFree,
    UI::Shell::{
        FOLDERID_LocalAppData, FOLDERID_SavedGames, KF_FLAG_DONT_VERIFY, SHGetKnownFolderPath,
    },
};

#[derive(Clone)]
pub struct DataRoots {
    pub durable: PathBuf,
    pub local: PathBuf,
}

fn known_folder(id: &windows_sys::core::GUID) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    let mut value = std::ptr::null_mut();
    // Resolve the registered (possibly redirected) location even on a profile
    // where Saved Games has not been created. Creation remains behind the lock
    // and our own path/schema checks; this never asks for a default/fallback path.
    let result = unsafe {
        SHGetKnownFolderPath(
            id,
            KF_FLAG_DONT_VERIFY as u32,
            std::ptr::null_mut(),
            &mut value,
        )
    };
    if result < 0 || value.is_null() {
        return Err("KNOWN_FOLDER_UNAVAILABLE".into());
    }
    let path = unsafe {
        let mut len = 0;
        while *value.add(len) != 0 {
            len += 1;
        }
        let path = PathBuf::from(std::ffi::OsString::from_wide(std::slice::from_raw_parts(
            value, len,
        )));
        CoTaskMemFree(value.cast());
        path
    };
    if !path.is_absolute() {
        return Err("KNOWN_FOLDER_INVALID".into());
    }
    crate::state_safety::check_path(&path)?;
    Ok(path)
}

impl DataRoots {
    pub fn resolve() -> Result<Self, String> {
        let channel = crate::distribution::channel();
        let local = known_folder(&FOLDERID_LocalAppData)?.join(channel.identifier());
        let durable = if channel.official() {
            known_folder(&FOLDERID_SavedGames)?.join("DMeloper's Block Pet")
        } else {
            local.join("isolated-data-v1")
        };
        crate::state_safety::check_path(&durable)?;
        crate::state_safety::check_path(&local)?;
        Ok(Self { durable, local })
    }
    pub fn initialize(&self) -> Result<(), String> {
        initialize_schema(&self.durable)
    }
}

pub fn durable_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.try_state::<DataRoots>()
        .map(|r| r.durable.clone())
        .ok_or("DATA_ROOT_NOT_READY".into())
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Schema {
    format: u32,
    data_schema: u32,
    minimum_reader: u32,
    minimum_writer: u32,
}
fn compatible(schema: &Schema) -> bool {
    schema.format == 1
        && schema.data_schema == 1
        && schema.minimum_reader <= 1
        && schema.minimum_reader >= 1
        && schema.minimum_writer == 1
}
fn read_limited(path: &Path) -> Result<Vec<u8>, String> {
    use std::os::windows::fs::OpenOptionsExt;
    crate::state_safety::check_path(path)?;
    let mut f = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(path)
        .map_err(|_| "DATA_METADATA_UNAVAILABLE")?;
    if !f
        .metadata()
        .map_err(|_| "DATA_METADATA_UNAVAILABLE")?
        .is_file()
    {
        return Err("DATA_METADATA_INVALID".into());
    }
    let mut bytes = Vec::new();
    (&mut f)
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| "DATA_METADATA_UNAVAILABLE")?;
    if bytes.len() > 16384 {
        return Err("DATA_METADATA_INVALID".into());
    }
    Ok(bytes)
}
fn initialize_schema(root: &Path) -> Result<(), String> {
    crate::state_safety::check_path(root)?;
    let metadata = root.join("data-compatibility.json");
    if metadata.try_exists().map_err(|_| "DATA_ROOT_UNAVAILABLE")? {
        let schema: Schema = serde_json::from_slice(&read_limited(&metadata)?)
            .map_err(|_| "DATA_METADATA_INVALID")?;
        if !compatible(&schema) {
            return Err("DATA_SCHEMA_UNSUPPORTED".into());
        }
        return Ok(());
    }
    if root.try_exists().map_err(|_| "DATA_ROOT_UNAVAILABLE")? {
        let mut entries = fs::read_dir(root).map_err(|_| "DATA_ROOT_UNAVAILABLE")?;
        if entries.next().is_some() {
            return Err("DATA_METADATA_MISSING".into());
        }
    }
    fs::create_dir_all(root).map_err(|_| "DATA_ROOT_UNAVAILABLE")?;
    crate::state_safety::check_path(root)?;
    let bytes = serde_json::to_vec_pretty(&Schema {
        format: 1,
        data_schema: 1,
        minimum_reader: 1,
        minimum_writer: 1,
    })
    .map_err(|_| "DATA_METADATA_INVALID")?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(metadata)
        .map_err(|_| "DATA_METADATA_WRITE_FAILED")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "DATA_METADATA_WRITE_FAILED".into())
}

/// tauri-store 0.12.1 gives persisted metadata precedence over Builder.path.
/// Validate before its plugin setup performs even its metadata initialization.
pub fn storage_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("shared-storage-guard")
        .setup(|app, _| {
            let expected = durable_root(app)?.join("tauri-plugin-pinia");
            let config = app.path().app_config_dir()?.join("tauri-plugin-pinia");
            crate::state_safety::check_path(&config)?;
            // 0.12.1 chooses its filename by debug_assertions, not tauri::is_dev().
            // Unused historical metadata is preserved and cannot redirect this collection.
            let meta = config.join(if cfg!(debug_assertions) {
                "meta.dev.tauristore"
            } else {
                "meta.tauristore"
            });
            if meta.try_exists()? {
                validate_pinia_metadata(&read_limited(&meta)?, &expected)?;
            }
            crate::state_safety::check_path(&expected)?;
            // Validate all existing entries before Pinia reads or rewrites any of them.
            if expected.exists() {
                for entry in fs::read_dir(&expected)? {
                    crate::state_safety::check_path(&entry?.path())?;
                }
            }
            Ok(())
        })
        .build()
}
fn validate_pinia_metadata(bytes: &[u8], expected: &Path) -> Result<(), String> {
    let meta: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "STORE_METADATA_INVALID")?;
    if !meta.is_object() {
        return Err("STORE_METADATA_INVALID".into());
    }
    match meta.get("path") {
        None | Some(serde_json::Value::Null) => Ok(()),
        Some(serde_json::Value::String(path)) if Path::new(path) == expected => Ok(()),
        _ => Err("STORE_PATH_OVERRIDE_REJECTED".into()),
    }
}
pub fn assert_store_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    if app.pinia().path() != durable_root(app)?.join("tauri-plugin-pinia") {
        return Err("STORE_PATH_OVERRIDE_REJECTED".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn future_or_corrupt_schema_never_rewrites_data() {
        let temp = tempfile::tempdir().unwrap();
        initialize_schema(temp.path()).unwrap();
        let path = temp.path().join("data-compatibility.json");
        let future = br#"{"format":1,"dataSchema":2,"minimumReader":2,"minimumWriter":2}"#;
        fs::write(&path, future).unwrap();
        assert_eq!(
            initialize_schema(temp.path()).unwrap_err(),
            "DATA_SCHEMA_UNSUPPORTED"
        );
        assert_eq!(fs::read(path).unwrap(), future);
    }
    #[test]
    fn unknown_existing_data_is_not_adopted() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("settings.json"), b"{}").unwrap();
        assert_eq!(
            initialize_schema(temp.path()).unwrap_err(),
            "DATA_METADATA_MISSING"
        );
        assert!(!temp.path().join("data-compatibility.json").exists());
    }
    #[test]
    fn persisted_store_path_cannot_override_native_root() {
        let root = Path::new("C:\\shared\\tauri-plugin-pinia");
        assert!(validate_pinia_metadata(br#"{"path":null}"#, root).is_ok());
        assert!(validate_pinia_metadata(br#"{"path":"C:\\elsewhere"}"#, root).is_err());
        assert!(validate_pinia_metadata(br#"{"path":4}"#, root).is_err());
    }
    #[test]
    fn pinia_metadata_override_is_rejected_before_any_store_can_load() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("installation");
        let durable = temp.path().join("shared");
        let escaped = temp.path().join("must-not-be-created");
        fs::create_dir_all(config.join("tauri-plugin-pinia")).unwrap();
        let metadata = config
            .join("tauri-plugin-pinia")
            .join(if cfg!(debug_assertions) {
                "meta.dev.tauristore"
            } else {
                "meta.tauristore"
            });
        let original = serde_json::to_vec(&serde_json::json!({"path": escaped})).unwrap();
        fs::write(&metadata, &original).unwrap();
        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = config.to_str().unwrap().into();
        let result = mock_builder()
            .manage(DataRoots {
                durable: durable.clone(),
                local: config,
            })
            .plugin(storage_guard())
            .plugin(
                tauri_plugin_pinia::Builder::new()
                    .path(durable.join("tauri-plugin-pinia"))
                    .build(),
            )
            .build(context);
        assert!(result.is_err());
        assert!(!escaped.exists());
        assert_eq!(fs::read(metadata).unwrap(), original);
    }
    #[test]
    fn two_installations_read_identical_shared_pinia_state_without_copying() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let temp = tempfile::tempdir().unwrap();
        let durable = temp.path().join("공유 데이터");
        initialize_schema(&durable).unwrap();
        let make_app = |name: &str| {
            let local = temp.path().join(name);
            let mut context = mock_context(noop_assets());
            context.config_mut().identifier = local.to_str().unwrap().into();
            mock_builder()
                .manage(DataRoots {
                    durable: durable.clone(),
                    local,
                })
                .plugin(storage_guard())
                .plugin(
                    tauri_plugin_pinia::Builder::new()
                        .path(durable.join("tauri-plugin-pinia"))
                        .build(),
                )
                .build(context)
                .unwrap()
        };
        let github = make_app("github");
        assert_store_root(github.handle()).unwrap();
        github
            .pinia()
            .with_store("general", |store| {
                store
                    .patch([("sharedPreset", serde_json::json!("user-owned"))])
                    .unwrap();
                store.save_now().unwrap();
            })
            .unwrap();
        drop(github);
        let store = make_app("store");
        assert_store_root(store.handle()).unwrap();
        let value: serde_json::Value = store.pinia().try_state("general").unwrap();
        assert_eq!(value["sharedPreset"], "user-owned");
    }
}
