// GitHub and Store share the core but have mutually exclusive native delivery.
// Historical update helper sources and retained bytes remain outside this graph.
fn main() {
    println!("cargo:rerun-if-env-changed=DMELOPER_WIX_BA_SHA256");
    if std::env::var_os("CARGO_FEATURE_WIX_LOCAL_TEST").is_some() || std::env::var_os("CARGO_FEATURE_WIX_GITHUB").is_some() {
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            // Tauri's linked build script publishes this metadata. Optimized
            // Cargo output alone still uses devUrl unless custom-protocol is set.
            assert_eq!(std::env::var("DEP_TAURI_DEV").as_deref(), Ok("false"),
                "release WiX profile requires tauri/custom-protocol (embedded frontend, not devUrl)");
        }
        let hash = std::env::var("DMELOPER_WIX_BA_SHA256").unwrap_or_default();
        assert!(hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "WiX profile requires the exact compiled BA SHA-256 in DMELOPER_WIX_BA_SHA256");
    }
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
        "retired private-update-qa feature is unsupported"
    );
    assert!(std::env::var_os("CARGO_FEATURE_TEST_REPOSITORY").is_none() || std::env::var_os("CARGO_FEATURE_WIX_LOCAL_TEST").is_some(), "test-repository requires the WiX installer profile");
    tauri_build::build();
    // Test executables also import TaskDialogIndirect. These flags apply only
    // to tests; the app manifest remains owned by Tauri's resource build.
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        r#"cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"#
    );
}
