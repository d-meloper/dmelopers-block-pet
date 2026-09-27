mod application_context;

use tauri::test::{MockRuntime, mock_builder};
use tauri_plugin_updater::UpdaterExt;

#[test]
fn builder_pubkey_cannot_initialize_an_absent_plugin_config() {
    let context: tauri::Context<MockRuntime> = tauri::generate_context!();
    assert!(!context.config().plugins.0.contains_key("updater"));
    let app = mock_builder().build(context).unwrap();
    let result = app.handle().plugin(
        tauri_plugin_updater::Builder::new()
            .pubkey(application_context::test_updater_public_key())
            .build(),
    );
    match result {
        Err(tauri::Error::PluginInitialization(name, detail)) => {
            assert_eq!(name, "updater");
            assert!(detail.contains("Error deserializing 'plugins.updater'"));
        }
        other => panic!("expected the original startup configuration failure: {other:?}"),
    }
}

#[test]
fn application_context_initializes_the_real_updater_with_test_trust() {
    let context = application_context::generate::<MockRuntime>();
    let config: tauri_plugin_updater::Config =
        serde_json::from_value(context.config().plugins.0["updater"].clone()).unwrap();
    assert_eq!(
        config.pubkey,
        application_context::test_updater_public_key()
    );
    assert!(config.endpoints.is_empty());
    assert!(!config.dangerous_insecure_transport_protocol);
    assert!(!config.dangerous_accept_invalid_certs);
    assert!(!config.dangerous_accept_invalid_hostnames);
    let app = mock_builder().build(context).unwrap();
    application_context::initialize_test_updater(app.handle()).unwrap();
    // Construct a client from the real registered SDK state. This fixture URL
    // is never requested; no windows, downloads or installers are run.
    app.updater_builder()
        .endpoints(vec!["https://example.invalid/update.json".parse().unwrap()])
        .unwrap()
        .build()
        .unwrap();
}
