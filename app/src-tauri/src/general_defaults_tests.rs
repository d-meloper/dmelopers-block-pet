#[path = "state_safety/general_defaults.rs"]
mod general_defaults;
mod settings_defaults;
#[path = "system_language.rs"]
#[allow(dead_code)]
mod system_language;
#[path = "state_safety/startup_stores.rs"]
mod startup_stores;

use general_defaults::initialize_store;
use serde_json::{Value, json};
use std::{fs, path::Path};
use tauri::{
    Manager,
    test::{MockRuntime, mock_builder, mock_context, noop_assets},
};
use tauri_plugin_pinia::ManagerExt;

fn app(root: &Path) -> tauri::App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    // Confine both Pinia state and metadata to the fixture, including Unicode paths.
    context.config_mut().identifier = root.to_str().unwrap().to_owned();
    let app = mock_builder()
        .plugin(tauri_plugin_pinia::Builder::default().path(root).build())
        .build(context)
        .unwrap();
    assert_eq!(app.path().app_config_dir().unwrap(), root);
    app
}

fn filename() -> &'static str {
    if cfg!(debug_assertions) {
        "general.dev.json"
    } else {
        "general.json"
    }
}

#[test]
fn missing_defaults_reach_native_memory_before_frontends_without_an_eager_save() {
    let defaults: Value = settings_defaults::section("general").unwrap();
    let mut app_expected = defaults.clone();
    app_expected["migrated"] = json!(true);
    app_expected["app"]["autostart"] = json!(true);
    app_expected["app"]["extra"] = json!(0);
    app_expected["legacy"] = json!({"empty":"","null":null});
    let mut broadcast_expected = defaults.clone();
    broadcast_expected["migrated"] = json!(true);
    broadcast_expected["broadcast"]["extra"] = json!(0);
    broadcast_expected["appearance"]["theme"] = json!("dark");
    for (initial, expected) in [
        (None, defaults.clone()),
        (
            Some(
                json!({"migrated":true,"app":{"autostart":true,"extra":0},"legacy":{"empty":"","null":null}}),
            ),
            app_expected,
        ),
        (
            Some(
                json!({"migrated":true,"broadcast":{"enabled":false,"extra":0},"appearance":{"theme":"dark"}}),
            ),
            broadcast_expected,
        ),
        (Some(defaults.clone()), defaults.clone()),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("설정 with spaces");
        fs::create_dir(&root).unwrap();
        let path = root.join(filename());
        let before = initial
            .as_ref()
            .map(|value| serde_json::to_vec(value).unwrap());
        if let Some(bytes) = &before {
            fs::write(&path, bytes).unwrap();
        }
        let app = app(&root);
        initialize_store(app.handle()).unwrap();
        assert_eq!(app.pinia().try_state::<Value>("general").unwrap(), expected);
        assert_eq!(
            fs::read(&path).ok(),
            before,
            "initialization must not save a file"
        );
        initialize_store(app.handle()).unwrap();
        assert_eq!(
            fs::read(&path).ok(),
            before,
            "repeated initialization is inert"
        );
        assert_eq!(app.pinia().try_state::<Value>("general").unwrap(), expected);
        // The same public save used by the existing barrier persists those defaults.
        app.pinia().save_all_now().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
            expected
        );
    }
}

#[test]
fn shared_language_default_is_system_and_existing_explicit_choices_survive() {
    let defaults: Value = settings_defaults::section("general").unwrap();
    assert_eq!(defaults["appearance"]["language"], "system");
    for language in ["ko-KR", "en-US", "system"] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(filename());
        let initial = json!({"appearance":{"language":language,"retained":0}});
        let before = serde_json::to_vec(&initial).unwrap();
        fs::write(&path, &before).unwrap();
        let app = app(temp.path());
        initialize_store(app.handle()).unwrap();
        let state = app.pinia().try_state::<Value>("general").unwrap();
        assert_eq!(state["appearance"]["language"], language);
        assert_eq!(state["appearance"]["retained"], 0);
        assert_eq!(state["appearance"]["theme"], defaults["appearance"]["theme"]);
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}

#[test]
fn explicit_values_and_unknown_fields_are_never_replaced_by_defaults() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join(filename());
    let initial = json!({
        "migrated":true,
        "app":null,
        "broadcast":{"enabled":0,"showOnDesktop":false,"extra":""},
        "appearance":"",
        "unknown":{"value":null}
    });
    let before = serde_json::to_vec(&initial).unwrap();
    fs::write(&path, &before).unwrap();
    let app = app(temp.path());
    initialize_store(app.handle()).unwrap();
    assert_eq!(app.pinia().try_state::<Value>("general").unwrap(), initial);
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn corrupt_or_unreadable_existing_state_fails_without_overwriting_it() {
    for bytes in [b"{broken".as_slice(), b"null", b"[]"] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(filename());
        fs::write(&path, bytes).unwrap();
        let app = app(temp.path());
        assert_eq!(
            initialize_store(app.handle()),
            Err("GENERAL_SETTINGS_LOAD_FAILED")
        );
        assert_eq!(fs::read(path).unwrap(), bytes);
        assert!(!app.pinia().ids().iter().any(|id| id.as_ref() == "general"));
    }
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join(filename());
    fs::create_dir(&path).unwrap();
    fs::write(path.join("retained"), b"unchanged").unwrap();
    let app = app(temp.path());
    assert_eq!(
        initialize_store(app.handle()),
        Err("GENERAL_SETTINGS_LOAD_FAILED")
    );
    assert_eq!(fs::read(path.join("retained")).unwrap(), b"unchanged");
}

#[test]
fn other_store_corruption_is_reported_without_overwriting_existing_bytes() {
    for (id, code) in [
        ("app", "APP_SETTINGS_LOAD_FAILED"),
        ("cat", "PET_SETTINGS_LOAD_FAILED"),
        ("shortcut", "SHORTCUT_SETTINGS_LOAD_FAILED"),
    ] {
        for bytes in [b"{broken".as_slice(), b"null", b"[]"] {
            let temp = tempfile::tempdir().unwrap();
            let suffix = if cfg!(debug_assertions) {
                "dev.json"
            } else {
                "json"
            };
            let path = temp.path().join(format!("{id}.{suffix}"));
            fs::write(&path, bytes).unwrap();
            let app = app(temp.path());
            initialize_store(app.handle()).unwrap();
            assert_eq!(startup_stores::validate(app.handle()), Err(code));
            assert_eq!(fs::read(path).unwrap(), bytes);
            assert!(!app.pinia().ids().iter().any(|loaded| loaded.as_ref() == id));
        }
        let temp = tempfile::tempdir().unwrap();
        let suffix = if cfg!(debug_assertions) {
            "dev.json"
        } else {
            "json"
        };
        let path = temp.path().join(format!("{id}.{suffix}"));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("retained"), b"unchanged").unwrap();
        let app = app(temp.path());
        assert_eq!(startup_stores::validate(app.handle()), Err(code));
        assert_eq!(fs::read(path.join("retained")).unwrap(), b"unchanged");
        assert!(!app.pinia().ids().iter().any(|loaded| loaded.as_ref() == id));
    }
}

#[test]
fn startup_validation_retains_lazy_defaults_and_existing_state_without_saving() {
    let temp = tempfile::tempdir().unwrap();
    let suffix = if cfg!(debug_assertions) {
        "dev.json"
    } else {
        "json"
    };
    let initial = json!({
        "migrated": true,
        "unknown": {"value": null},
        "empty": "",
        "explicit": false,
        "nested": {"legacy": 0}
    });
    let bytes = serde_json::to_vec(&initial).unwrap();
    let missing_app = app(temp.path());
    // Load all missing stores without a durable file or synthesized defaults.
    startup_stores::validate(missing_app.handle()).unwrap();
    for id in ["app", "cat", "shortcut"] {
        assert!(!temp.path().join(format!("{id}.{suffix}")).exists());
        assert_eq!(
            missing_app.pinia().try_state::<Value>(id).unwrap(),
            json!({})
        );
    }
    drop(missing_app);

    for id in ["app", "cat", "shortcut"] {
        assert!(!temp.path().join(format!("{id}.{suffix}")).exists());
        fs::write(temp.path().join(format!("{id}.{suffix}")), &bytes).unwrap();
    }
    let app = app(temp.path());
    startup_stores::validate(app.handle()).unwrap();
    initialize_store(app.handle()).unwrap();
    startup_stores::validate(app.handle()).unwrap();
    for id in ["app", "cat", "shortcut"] {
        assert_eq!(app.pinia().try_state::<Value>(id).unwrap(), initial);
        assert_eq!(
            fs::read(temp.path().join(format!("{id}.{suffix}"))).unwrap(),
            bytes
        );
    }
    assert!(!temp.path().join(filename()).exists());
}
