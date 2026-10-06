//! Load persisted stores before hidden webviews start their restoration.
use tauri_plugin_pinia::ManagerExt;

/// Use the same loader as frontend store start without patching or saving state.
/// Missing files keep Pinia's existing empty state for lazy frontend defaults.
pub(crate) fn validate<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), &'static str> {
    for (id, code) in [
        ("app", "APP_SETTINGS_LOAD_FAILED"),
        ("cat", "PET_SETTINGS_LOAD_FAILED"),
        ("shortcut", "SHORTCUT_SETTINGS_LOAD_FAILED"),
    ] {
        app.pinia().with_store(id, |_| ()).map_err(|_| code)?;
    }
    Ok(())
}
