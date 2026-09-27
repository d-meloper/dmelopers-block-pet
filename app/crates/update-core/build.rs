use std::{env, fs, path::PathBuf};

mod build_version;

fn main() {
    assert!(
        !(env::var_os("CARGO_FEATURE_TEST_REPOSITORY").is_some()
            && env::var_os("CARGO_FEATURE_PRIVATE_UPDATE_QA").is_some()),
        "test-repository and private-update-qa cannot be combined"
    );
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest"));
    // This is an independently versioned component. App-only releases must
    // not rewrite the worker's version resource or its embedded identity.
    let version = env::var("CARGO_PKG_VERSION").expect("worker component version");
    let packed = build_version::pack_component_version(&version);
    println!("cargo:rerun-if-changed=build_version.rs");
    println!("cargo:rustc-env=BLOCK_PET_WORKER_PRODUCT_VERSION={version}");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut resource = tauri_winres::WindowsResource::new();
        resource
            .set("FileDescription", "3D Block Pet Update Worker")
            .set("ProductName", "DMeloper's 3D Block Pet")
            .set("CompanyName", "DMeloper")
            .set("OriginalFilename", "block-pet-update-worker.exe")
            .set("FileVersion", &version)
            .set("ProductVersion", &version)
            .set_version_info(tauri_winres::VersionInfo::FILEVERSION, packed)
            .set_version_info(tauri_winres::VersionInfo::PRODUCTVERSION, packed)
            .set_manifest(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>"#);
        let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output"));
        let rc = output.join("worker-resource.rc");
        resource
            .write_resource_file(&rc)
            .expect("worker resource source");
        // The pinned tauri-winres compile_for method loses OUT_DIR. Pass the
        // actual source path directly and link this resource only to the worker.
        embed_resource::compile_for(&rc, &["block-pet-update-worker"], embed_resource::NONE)
            .manifest_required()
            .expect("worker version resource");
    }
    if env::var_os("CARGO_FEATURE_PRIVATE_UPDATE_QA").is_some() {
        // Private QA fixtures describe the app baseline, not the independent
        // worker component version. Keep this input out of ordinary builds.
        let app_manifest = root.join("../../src-tauri/Cargo.toml");
        let app: toml::Value =
            toml::from_str(&fs::read_to_string(&app_manifest).expect("app manifest"))
                .expect("valid app manifest");
        let app_version = app["package"]["version"].as_str().expect("app version");
        println!("cargo:rerun-if-changed={}", app_manifest.display());
        let bundle =
            PathBuf::from(env::var_os("BLOCK_PET_PRIVATE_QA_BUNDLE").expect("private QA bundle"));
        let source = bundle.join("fixture.json");
        let metadata = fs::symlink_metadata(&source).expect("private QA fixture exists");
        assert!(
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 512 * 1024,
            "invalid private QA fixture"
        );
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&source).expect("private QA fixture"))
                .expect("private QA fixture JSON");
        assert!(
            value["schemaVersion"] == 1
                && value["kind"] == "block-pet-private-qa-bundle"
                && value["qaBaseline"] == true,
            "invalid private QA fixture kind"
        );
        build_version::check_private_qa_version(app_version, value["baselineVersion"].as_str());
        let trust = value.get("trust").expect("private QA trust");
        let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output"));
        fs::write(
            output.join("private-trust.json"),
            serde_json::to_vec(trust).expect("private QA trust JSON"),
        )
        .expect("freeze compile-time trust");
        println!("cargo:rerun-if-changed={}", source.display());
        println!("cargo:rerun-if-env-changed=BLOCK_PET_PRIVATE_QA_BUNDLE");
    }
}
