//! Settings readback compares exact JavaScript numbers, including slider arithmetic.
#[test]
fn settings_json_preserves_slider_number_bits() {
    for expected in [
        3.9000000000000004_f64,
        -29.099999999999998_f64,
        -27.900000000000002_f64,
        0.07800000000000001_f64,
        1.2345678901234567_f64,
    ] {
        let encoded = serde_json::to_string(&expected).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(parsed.as_f64().unwrap().to_bits(), expected.to_bits());
        let saved = serde_json::to_string(&parsed).unwrap();
        let restored: f64 = serde_json::from_str(&saved).unwrap();
        assert_eq!(restored.to_bits(), expected.to_bits());
    }
}

#[test]
fn full_reset_defaults_and_explicit_mouse_choices_survive_real_pinia_disk() {
    use serde_json::{json, Value};
    use std::fs;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri_plugin_pinia::ManagerExt;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("초기화 😶 storage");
    fs::create_dir(&root).unwrap();
    let filename = if cfg!(debug_assertions) {
        "cat.dev.json"
    } else {
        "cat.json"
    };
    let path = root.join(filename);
    let defaults: Value = crate::settings_defaults::section("preset").unwrap();
    let catalog =
        json!({"schemaVersion":4,"activeId":"keep","entries":[{"id":"keep","unknown":false}]});
    let original = json!({"customization3d":{"preset":{"mouseEnabled":false}},"presetCollection":catalog,"unknown":{"zero":0,"empty":""}});
    fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
    let mut context = mock_context(noop_assets());
    context.config_mut().identifier = root.to_str().unwrap().to_owned();
    let app = mock_builder()
        .plugin(tauri_plugin_pinia::Builder::default().path(&root).build())
        .build(context)
        .unwrap();
    assert_eq!(app.pinia().try_state::<Value>("cat").unwrap(), original);
    for (enabled, language) in [
        (false, "ko"),
        (true, "ja"),
        (false, "en"),
        (true, "system"),
        (true, "ko"),
    ] {
        let mut preset = defaults.clone();
        preset["mouseEnabled"] = json!(enabled);
        preset["keyboardLegendLanguage"] = json!(language);
        let patch = json!({"customization3d":{"preset":preset},
            "model":crate::settings_defaults::section::<Value>("model").unwrap(),
            "window":crate::settings_defaults::section::<Value>("window").unwrap()});
        app.pinia()
            .with_store("cat", |store| {
                store.patch(
                    patch
                        .as_object()
                        .unwrap()
                        .clone()
                        .into_iter()
                        .collect::<Vec<_>>(),
                )
            })
            .unwrap()
            .unwrap();
        app.pinia().save_all_now().unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["customization3d"]["preset"], preset);
        assert_eq!(saved["presetCollection"], catalog);
        assert_eq!(saved["unknown"], original["unknown"]);
        assert_eq!(app.pinia().try_state::<Value>("cat").unwrap(), saved);
    }
}
