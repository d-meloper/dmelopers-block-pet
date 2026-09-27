pub(crate) fn generate<R: tauri::Runtime>() -> tauri::Context<R> {
    let context = tauri::generate_context!();
    #[cfg(feature = "test-repository")]
    let context = {
        let mut context = context;
        // Tauri deserializes plugin config before running the plugin's setup
        // closure. Builder::pubkey alone cannot supply the required field then.
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({ "pubkey": test_updater_public_key() }),
        );
        context
    };
    context
}

#[cfg(feature = "test-repository")]
pub(crate) fn initialize_test_updater<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<()> {
    app.plugin(tauri_plugin_updater::Builder::new().build())
}

#[cfg(feature = "test-repository")]
pub(crate) fn test_updater_public_key() -> String {
    let trust: serde_json::Value = serde_json::from_str(include_str!("../update-trust.test.json"))
        .expect("tracked test trust");
    trust["publicKey"]
        .as_str()
        .expect("test public key")
        .to_owned()
}
