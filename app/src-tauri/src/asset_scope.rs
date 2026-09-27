use std::path::Path;

use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
    scope::fs::Scope,
};

pub(crate) fn allow_bundled_models(scope: &Scope, resource_root: &Path) -> tauri::Result<()> {
    // The directory API escapes literal path components before appending its glob.
    // Expanding $RESOURCE inside a configured glob treats installation-path [] as syntax.
    scope.allow_directory(resource_root.join("assets/models"), true)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bundled-asset-scope")
        .setup(|app, _| {
            let root = app.path().resource_dir().inspect_err(|_| {
                log::error!(target: "diagnostics", "operation=assets.resource_root code=RESOURCE_DIRECTORY_UNAVAILABLE");
            })?;
            allow_bundled_models(&app.asset_protocol_scope(), &root).inspect_err(|_| {
                log::error!(target: "diagnostics", "operation=assets.bundled_scope code=SCOPE_REGISTRATION_FAILED");
            })?;
            Ok(())
        })
        .build()
}
