// GitHub and Store share the core but have mutually exclusive native delivery.
// Historical update helper sources and retained bytes remain outside this graph.
fn main() {
    println!("cargo:rerun-if-env-changed=DMELOPER_STORE_PRODUCT_ID");
    println!("cargo:rerun-if-env-changed=DMELOPER_STORE_IDENTITY_NAME");
    println!("cargo:rerun-if-env-changed=DMELOPER_STORE_PUBLISHER");
    if let Ok(id) = std::env::var("DMELOPER_STORE_PRODUCT_ID") {
        assert!(
            id.len() == 12 && id.bytes().all(|c| c.is_ascii_alphanumeric()),
            "DMELOPER_STORE_PRODUCT_ID must be a Partner Center product ID"
        );
    }
    assert_eq!(
        std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
        Ok("windows"),
        "DMeloper's Block Pet currently supports Windows only."
    );
    let channels = [
        "CARGO_FEATURE_CHANNEL_GITHUB",
        "CARGO_FEATURE_CHANNEL_STORE",
        "CARGO_FEATURE_TEST_REPOSITORY",
    ];
    assert_eq!(
        channels
            .iter()
            .filter(|name| std::env::var_os(name).is_some())
            .count(),
        1,
        "select exactly one native channel: channel-github, channel-store, test-repository (use --no-default-features)"
    );
    assert_eq!(
        std::env::var("CARGO_CFG_TARGET_ARCH").as_deref(),
        Ok("x86_64"),
        "Windows x64 is required"
    );
    assert!(
        std::env::var_os("CARGO_FEATURE_PRIVATE_UPDATE_QA").is_none(),
        "manual-nsis does not accept an automatic-update repository profile"
    );
    tauri_build::build();
    // Test executables also import TaskDialogIndirect. These flags apply only
    // to tests; the app manifest remains owned by Tauri's resource build.
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        r#"cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"#
    );
}
