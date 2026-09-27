use std::collections::BTreeMap;
use tauri_plugin_pinia::ManagerExt;

pub(super) fn initialize_store<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    writable: bool,
) -> Result<(), String> {
    if !writable {
        return Ok(());
    }
    let defaults: BTreeMap<String, String> = crate::settings_defaults::section("shortcuts")
        .map_err(|_| "SHORTCUT_DEFAULTS_INVALID")?;
    app.pinia()
        .with_store("shortcut", |store| {
            let missing: Vec<_> = defaults
                .into_iter()
                .filter(|(key, _)| !store.state().has(key))
                .collect();
            if missing.is_empty() {
                return Ok(());
            }
            store.patch(missing)?;
            store.save_now()
        })
        .map_err(|_| "STORES_NOT_READY")?
        .map_err(|_| "SAVE_FAILED".into())
}
