pub(crate) fn generate<R: tauri::Runtime>() -> tauri::Context<R> {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = native_identifier().into();
    #[cfg(feature = "test-repository")]
    {
        let name = "DMeloper's Block Pet";
        context.config_mut().product_name = Some(name.into());
        context.package_info_mut().name = name.into();
    }
    context
}

pub(crate) fn native_identifier() -> &'static str {
    if cfg!(feature = "wix-local-test") {
        "com.dmeloper.blockpet.wixlocal"
    } else if cfg!(feature = "test-repository") {
        "com.dmeloper.blockpet.test"
    } else if tauri::is_dev() {
        "com.dmeloper.blockpet.development"
    } else if cfg!(feature = "channel-store") {
        "com.dmeloper.blockpet.store"
    } else {
        "com.dmeloper.blockpet"
    }
}

#[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
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
