use tauri_plugin_pinia::ManagerExt;

pub(super) const KEYS: &[&str] = &[
    "visibleCat",
    "visiblePreference",
    "mirrorMode",
    "cycleZoom",
    "cycleRotation",
    "penetrable",
    "alwaysOnTop",
    "toggleBroadcast",
    "showDisplayArea",
    "mouseEnabled",
    "keepInScreen",
    "hideOnHover",
];

pub(super) fn initialize_store<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    writable: bool,
) -> Result<(), String> {
    if !writable {
        return Ok(());
    }
    app.pinia()
        .with_store("shortcut", |store| {
            let missing: Vec<_> = KEYS
                .iter()
                .filter(|key| !store.state().has(key))
                .map(|key| (*key, String::new()))
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
