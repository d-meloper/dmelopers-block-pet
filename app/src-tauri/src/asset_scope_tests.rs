#[path = "asset_scope.rs"]
mod asset_scope;

use std::fs;

use tauri::{
    Manager,
    test::{mock_builder, mock_context, noop_assets},
};

use asset_scope::{allow_bundled_models, init};

#[test]
fn scope_is_registered_before_webviews_start() {
    let app = mock_builder()
        .plugin(init())
        .build(mock_context(noop_assets()))
        .unwrap();
    let root = app.path().resource_dir().unwrap();
    assert!(
        app.asset_protocol_scope()
            .is_allowed(root.join("assets/models/dmeloper/default.png"))
    );
    assert!(
        !app.asset_protocol_scope()
            .is_allowed(root.join("private-settings.json"))
    );
}

#[test]
fn bundled_assets_accept_literal_install_paths_without_allowing_siblings() {
    for directory in [
        "OneDrive - 팀 & Co/사용자 😶安★/Pet's #100%",
        "OneDrive - 팀 & Co/사용자 😶安★/Pet [release]",
        "OneDrive - 팀 & Co/사용자 😶安★/Pet [unfinished",
    ] {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join(directory);
        let model = root.join("assets/models/dmeloper/dmeloper.glb");
        let skin = root.join("assets/models/dmeloper/default.png");
        fs::create_dir_all(model.parent().unwrap()).unwrap();
        fs::write(&model, b"fixture model").unwrap();
        fs::write(&skin, b"fixture skin").unwrap();

        let mut config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        // Scope::new parses $RESOURCE before compiling the resulting path as a glob.
        // Substitute this fixture root at that same boundary without changing the process path.
        let scope_json = &mut config["app"]["security"]["assetProtocol"]["scope"];
        for pattern in scope_json.as_array_mut().unwrap() {
            *pattern = pattern
                .as_str()
                .unwrap()
                .replace("$RESOURCE", root.to_str().unwrap())
                .into();
        }
        let mut context = mock_context(noop_assets());
        context.config_mut().app.security.asset_protocol.scope =
            serde_json::from_value(scope_json.clone()).unwrap();
        let app = mock_builder().build(context).unwrap();
        let scope = app.asset_protocol_scope();
        allow_bundled_models(&scope, &root).unwrap();

        assert!(scope.is_allowed(&model), "model denied under {directory}");
        assert!(scope.is_allowed(&skin), "skin denied under {directory}");
        assert!(scope.is_allowed(fs::canonicalize(&skin).unwrap()));
        assert!(!scope.is_allowed(root.join("private-settings.json")));
        assert!(!scope.is_allowed(root.join("assets/tray.png")));
        assert!(!scope.is_allowed(root.join("assets/models-backup/default.png")));
        let sibling = root
            .with_file_name("Pet r")
            .join("assets/models/default.png");
        fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        fs::write(&sibling, b"private sibling").unwrap();
        assert!(!scope.is_allowed(sibling));
    }
}
