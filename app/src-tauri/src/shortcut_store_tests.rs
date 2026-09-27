#[path = "state_safety/shortcuts.rs"]
mod shortcuts;
mod settings_defaults;

use serde_json::{Value, json};
use std::fs;
use tauri::Manager;
use tauri_plugin_pinia::ManagerExt;

#[test]
fn shortcut_defaults_reach_real_pinia_and_disk_without_replacing_existing_values() {
    use tauri::test::{mock_builder, mock_context, noop_assets};

    for initial in [
        json!({}),
        json!({"visibleCat":"F8","alwaysOnTop":"","mirrorMode":null,"legacy":{"kept":true}}),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(if cfg!(debug_assertions) {
            "shortcut.dev.json"
        } else {
            "shortcut.json"
        });
        let before = serde_json::to_vec(&initial).unwrap();
        fs::write(&path, &before).unwrap();
        let mut context = mock_context(noop_assets());
        // Mock path resolution joins this value to AppData. An absolute fixture
        // root also confines plugin metadata; it cannot select a real app store.
        context.config_mut().identifier = temp.path().to_str().unwrap().to_owned();
        let app = mock_builder()
            .plugin(
                tauri_plugin_pinia::Builder::default()
                    .path(temp.path())
                    .build(),
            )
            .build(context)
            .unwrap();
        assert_eq!(app.path().app_config_dir().unwrap(), temp.path());
        assert_eq!(
            app.pinia()
                .with_store("shortcut", |store| store.path())
                .unwrap(),
            path
        );
        assert_eq!(app.pinia().try_state::<Value>("shortcut").unwrap(), initial);

        shortcuts::initialize_store(app.handle(), false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(app.pinia().try_state::<Value>("shortcut").unwrap(), initial);

        shortcuts::initialize_store(app.handle(), true).unwrap();
        let mut expected = initial;
        let defaults: serde_json::Map<String, Value> = settings_defaults::section("shortcuts").unwrap();
        for (key, value) in defaults {
            expected
                .as_object_mut()
                .unwrap()
                .entry(key)
                .or_insert(value);
        }
        assert_eq!(
            app.pinia().try_state::<Value>("shortcut").unwrap(),
            expected
        );
        let saved = fs::read(&path).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&saved).unwrap(), expected);
        shortcuts::initialize_store(app.handle(), true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), saved);
    }
}
