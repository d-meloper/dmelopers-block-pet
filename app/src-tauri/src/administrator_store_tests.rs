//! The real Pinia/defaults save path, isolated to temporary data; no app/UAC.
use crate::state_safety::initialize_general_defaults as initialize_store;
use serde_json::{Value, json};
use std::{fs, path::Path};
use tauri::{
    Manager,
    test::{MockRuntime, mock_builder, mock_context, noop_assets},
};
use tauri_plugin_pinia::ManagerExt;

fn app(root: &Path) -> tauri::App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    context.config_mut().identifier = root.to_str().unwrap().to_owned();
    mock_builder()
        .plugin(tauri_plugin_pinia::Builder::default().path(root).build())
        .build(context)
        .unwrap()
}
fn filename() -> &'static str {
    if cfg!(debug_assertions) {
        "general.dev.json"
    } else {
        "general.json"
    }
}

#[test]
fn administrator_choices_survive_defaults_save_reload_and_explicit_disable() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join(filename());
    let before = serde_json::to_vec(&json!({"migrated":true,"app":{
        "alwaysRunAsAdministrator":true,"administratorReminderDismissed":true,
        "futureSetting":{"keep":"user choice"}
    }}))
    .unwrap();
    fs::write(&path, &before).unwrap();
    let first = app(temp.path());
    initialize_store(first.handle()).unwrap();
    assert_eq!(
        fs::read(&path).unwrap(),
        before,
        "initialization cannot save eagerly"
    );
    first.pinia().save_all_now().unwrap();
    drop(first);
    let reopened = app(temp.path());
    initialize_store(reopened.handle()).unwrap();
    let mut state: Value = reopened.pinia().try_state("general").unwrap();
    assert_eq!(state["app"]["alwaysRunAsAdministrator"], true);
    assert_eq!(state["app"]["administratorReminderDismissed"], true);
    assert_eq!(state["app"]["futureSetting"]["keep"], "user choice");
    state["app"]["alwaysRunAsAdministrator"] = json!(false);
    state["app"]["administratorReminderDismissed"] = json!(false);
    reopened
        .pinia()
        .with_store("general", |store| {
            store.patch([("app", state["app"].clone())]).unwrap();
        })
        .unwrap();
    reopened.pinia().save_all_now().unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["app"]["alwaysRunAsAdministrator"], false);
    assert_eq!(saved["app"]["administratorReminderDismissed"], false);
    assert_eq!(saved["app"]["futureSetting"]["keep"], "user choice");
}
