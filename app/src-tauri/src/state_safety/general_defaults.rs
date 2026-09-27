//! Materialize untouched frontend defaults before either webview creates writers.
use serde_json::{Map, Value};
use tauri_plugin_pinia::ManagerExt;

fn fill_missing(actual: &mut Value, defaults: &Value) {
    if let (Value::Object(actual), Value::Object(defaults)) = (actual, defaults) {
        for (key, default) in defaults {
            match actual.get_mut(key) {
                Some(value) => fill_missing(value, default),
                None => {
                    actual.insert(key.clone(), default.clone());
                }
            }
        }
    }
}

/// Startup owns this call before `await_native_startup` releases either frontend.
/// Pinia loads with save-on-change disabled: patch memory here and leave durable
/// saving to normal editing and the existing acknowledged save/Exit path.
pub(crate) fn initialize_store<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), &'static str> {
    let defaults: Map<String, Value> =
        crate::settings_defaults::section("general").map_err(|_| "GENERAL_DEFAULTS_INVALID")?;
    app.pinia()
        .with_store("general", |store| {
            let mut patch = Map::new();
            for (key, default) in defaults {
                match store.get(&key) {
                    Some(current) => {
                        let mut next = current.clone();
                        fill_missing(&mut next, &default);
                        if &next != current {
                            patch.insert(key, next);
                        }
                    }
                    None => {
                        patch.insert(key, default);
                    }
                }
            }
            if patch.is_empty() {
                return Ok(());
            }
            store
                .patch(patch.into_iter().collect::<Vec<_>>())
                .map_err(|_| "GENERAL_SETTINGS_SYNC_FAILED")
        })
        // Read/parse failures must never become an empty writable store.
        .map_err(|_| "GENERAL_SETTINGS_LOAD_FAILED")?
}
