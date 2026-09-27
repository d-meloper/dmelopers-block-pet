pub(crate) fn generate<R: tauri::Runtime>() -> tauri::Context<R> {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = native_identifier().into();
    #[cfg(feature = "test-repository")]
    {
        context.config_mut().product_name = Some("DMeloper's Block Pet Test".into());
        context.package_info_mut().name = "DMeloper's Block Pet Test".into();
    }
    #[cfg(any(feature = "channel-github", feature = "test-repository"))]
    let context = {
        let mut context = context;
        // Tauri deserializes plugin config before running the plugin's setup
        // closure. Builder::pubkey alone cannot supply the required field then.
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({ "pubkey": updater_public_key() }),
        );
        context
    };
    context
}

pub(crate) fn native_identifier() -> &'static str {
    if cfg!(feature = "test-repository") {
        "com.dmeloper.blockpet.test"
    } else if tauri::is_dev() {
        "com.dmeloper.blockpet.development"
    } else if cfg!(feature = "channel-store") {
        "com.dmeloper.blockpet.store"
    } else {
        "com.dmeloper.blockpet"
    }
}

#[cfg(any(feature = "channel-github", feature = "test-repository"))]
pub(crate) fn initialize_updater<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<()> {
    app.plugin(tauri_plugin_updater::Builder::new().build())
}

#[cfg(any(feature = "channel-github", feature = "test-repository"))]
pub(crate) fn updater_public_key() -> String {
    #[cfg(feature = "test-repository")]
    let raw = include_str!("../update-trust.test.json");
    #[cfg(not(feature = "test-repository"))]
    let raw = include_str!("../update-trust.json");
    let trust: serde_json::Value = serde_json::from_str(raw).expect("tracked update trust");
    trust["publicKey"]
        .as_str()
        .expect("update public key")
        .to_owned()
}
