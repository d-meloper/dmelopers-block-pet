// The production app uses user-selected manual installation only.
// Historical helper sources and retained bytes remain outside this build graph.
fn main() {
    assert_eq!(
        std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
        Ok("windows"),
        "DMeloper's Block Pet currently supports Windows only."
    );
    assert!(
        std::env::var_os("CARGO_FEATURE_MANUAL_NSIS").is_some(),
        "this application requires the manual-nsis release mode"
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
