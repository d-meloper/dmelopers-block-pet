//! Owner-enabled test updates. Official builds retain manual installation.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    available: bool,
    current_version: String,
    version: Option<String>,
    bytes: Option<usize>,
}

#[tauri::command]
pub fn in_app_updater_enabled() -> bool {
    cfg!(feature = "test-repository")
}

#[tauri::command]
pub async fn check_app_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<UpdateInfo, String> {
    #[cfg(feature = "test-repository")]
    return test_profile::check(app, window).await;
    #[cfg(not(feature = "test-repository"))]
    {
        let _ = (app, window);
        Err("UPDATER_DISABLED".into())
    }
}

#[tauri::command]
pub async fn download_app_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    #[cfg(feature = "test-repository")]
    return test_profile::download(app, window).await;
    #[cfg(not(feature = "test-repository"))]
    {
        let _ = (app, window);
        Err("UPDATER_DISABLED".into())
    }
}

#[tauri::command]
pub async fn install_app_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    #[cfg(feature = "test-repository")]
    return test_profile::install(app, window, request_id).await;
    #[cfg(not(feature = "test-repository"))]
    {
        let _ = (app, window, request_id);
        Err("UPDATER_DISABLED".into())
    }
}

#[cfg(feature = "test-repository")]
pub mod test_profile {
    use super::UpdateInfo;
    use crate::application_context::{
        initialize_test_updater, test_updater_public_key as public_key,
    };
    use base64::{Engine, engine::general_purpose::STANDARD};
    use minisign_verify::{PublicKey, Signature};
    use reqwest::{Url, redirect::Policy};
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use std::time::{Duration, Instant};
    use tauri::{Emitter, Manager};
    use tauri_plugin_updater::{Update, UpdaterExt};

    const MARKER: &str = "DMELoper_TEST_TAURI_UPDATER_V1";
    const REPOSITORY: &str = "oup030416/dmelopers-block-pet-test";
    const ENDPOINT: &str = "https://raw.githubusercontent.com/oup030416/dmelopers-block-pet-test/updates/tauri-test.json";
    const MAX_METADATA: usize = 64 * 1024;
    const MAX_DOWNLOAD: usize = 128 * 1024 * 1024;
    const TTL: Duration = Duration::from_secs(300);

    fn endpoint(signature: bool) -> Url {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_millis();
        format!(
            "{ENDPOINT}{}?check={stamp}",
            if signature { ".sig" } else { "" }
        )
        .parse()
        .expect("fixed endpoint")
    }

    struct Selected {
        update: Update,
        metadata: Metadata,
        selected_at: Instant,
        downloaded: Option<Vec<u8>>,
    }
    #[derive(Default)]
    struct State(tokio::sync::Mutex<Option<Selected>>);

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Metadata {
        schema_version: u32,
        repository: String,
        repository_id: u64,
        channel: String,
        installer_mode: String,
        version: String,
        size: usize,
        sha256: String,
    }

    pub fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
        std::hint::black_box(MARKER);
        initialize_test_updater(app)?;
        app.manage(State::default());
        Ok(())
    }

    fn verify_signature(data: &[u8], encoded: &str) -> Result<(), String> {
        let decode = |value: &str| {
            STANDARD
                .decode(value.trim())
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .ok_or("UPDATE_SIGNATURE_INVALID")
        };
        let key =
            PublicKey::decode(&decode(&public_key())?).map_err(|_| "UPDATE_SIGNATURE_INVALID")?;
        let signature =
            Signature::decode(&decode(encoded)?).map_err(|_| "UPDATE_SIGNATURE_INVALID")?;
        key.verify(data, &signature, true)
            .map_err(|_| "UPDATE_SIGNATURE_INVALID".into())
    }

    fn version(value: &str) -> Result<[u16; 3], String> {
        let parts: Vec<_> = value.split('.').collect();
        if parts.len() != 3 {
            return Err("UPDATE_VERSION_INVALID".into());
        }
        let mut parsed = [0; 3];
        for (index, part) in parts.iter().enumerate() {
            let number: u16 = part.parse().map_err(|_| "UPDATE_VERSION_INVALID")?;
            if number.to_string() != *part {
                return Err("UPDATE_VERSION_INVALID".into());
            }
            parsed[index] = number;
        }
        Ok(parsed)
    }

    fn trusted_window(window: &tauri::WebviewWindow) -> Result<(), String> {
        let url = window.url().map_err(|_| "UPDATE_WINDOW_INVALID")?;
        if window.label() != "preference"
            || !matches!(
                (url.scheme(), url.host_str()),
                ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
            )
        {
            return Err("UPDATE_WINDOW_INVALID".into());
        }
        Ok(())
    }

    fn allowed_redirect(url: &Url) -> bool {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
            && url.fragment().is_none()
            && matches!(
                url.host_str(),
                Some("github.com" | "release-assets.githubusercontent.com")
            )
    }

    fn redirect_policy() -> Policy {
        Policy::custom(|attempt| {
            if attempt.previous().len() < 4 && allowed_redirect(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("update redirect rejected")
            }
        })
    }

    async fn bounded_get(
        url: Url,
        limit: usize,
        window: Option<&tauri::WebviewWindow>,
    ) -> Result<Vec<u8>, String> {
        let mut response = reqwest::Client::builder()
            .user_agent("DMeloper-BlockPet-Test-Updater/1")
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(120))
            .redirect(redirect_policy())
            .build()
            .map_err(|_| "UPDATE_NETWORK_FAILED")?
            .get(url)
            .header("Cache-Control", "no-cache")
            .send()
            .await
            .map_err(|_| "UPDATE_NETWORK_FAILED")?
            .error_for_status()
            .map_err(|_| "UPDATE_NETWORK_FAILED")?;
        if response
            .content_length()
            .is_some_and(|size| size > limit as u64)
        {
            return Err("UPDATE_SIZE_INVALID".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "UPDATE_NETWORK_FAILED")?
        {
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err("UPDATE_SIZE_INVALID".into());
            }
            bytes.extend_from_slice(&chunk);
            if let Some(window) = window {
                let _ = window.emit("app-update-progress", (bytes.len(), limit));
            }
        }
        Ok(bytes)
    }

    fn validate(
        metadata: &Metadata,
        current: &str,
        selected: &str,
        url: &Url,
    ) -> Result<(), String> {
        if metadata.schema_version != 1
            || metadata.repository != REPOSITORY
            || metadata.repository_id != 1390032052
            || metadata.channel != "test"
            || metadata.installer_mode != "tauri-test-nsis-v1"
            || metadata.version != selected
            || version(selected)? <= version(current)?
            || metadata.size == 0
            || metadata.size > MAX_DOWNLOAD
            || metadata.sha256.len() != 64
            || !metadata
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("UPDATE_IDENTITY_INVALID".into());
        }
        let expected = format!(
            "https://github.com/{REPOSITORY}/releases/download/v{selected}/dmelopers-block-pet_{selected}_x64-setup.exe?sha256={}",
            metadata.sha256
        );
        if url.as_str() != expected {
            return Err("UPDATE_IDENTITY_INVALID".into());
        }
        Ok(())
    }

    pub async fn check(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
    ) -> Result<UpdateInfo, String> {
        trusted_window(&window)?;
        let state = app.state::<State>();
        let mut selected = state.0.try_lock().map_err(|_| "UPDATE_BUSY")?;
        *selected = None;
        let current = app.package_info().version.to_string();
        let updater = app
            .updater_builder()
            .endpoints(vec![endpoint(false)])
            .map_err(|_| "UPDATE_CONFIG_INVALID")?
            .version_comparator(|_, _| true)
            .timeout(Duration::from_secs(15))
            .configure_client(|client| {
                client
                    .connect_timeout(Duration::from_secs(5))
                    .redirect(Policy::none())
            })
            .build()
            .map_err(|_| "UPDATE_CONFIG_INVALID")?;
        let update = updater
            .check()
            .await
            .map_err(|_| "UPDATE_CHECK_FAILED")?
            .ok_or("UPDATE_CHECK_FAILED")?;
        // Upstream parses metadata before returning. This post-parse ceiling is
        // not a strict bound on upstream JSON parsing memory.
        let canonical =
            serde_json::to_vec(&update.raw_json).map_err(|_| "UPDATE_METADATA_INVALID")?;
        if canonical.len() > MAX_METADATA || update.signature.len() > 8192 {
            return Err("UPDATE_METADATA_INVALID".into());
        }
        let signature = bounded_get(endpoint(true), 8192, None).await?;
        verify_signature(
            &canonical,
            std::str::from_utf8(&signature).map_err(|_| "UPDATE_SIGNATURE_INVALID")?,
        )?;
        let metadata: Metadata = serde_json::from_value(update.raw_json.clone())
            .map_err(|_| "UPDATE_METADATA_INVALID")?;
        // Validate the complete signed identity even for an up-to-date installation.
        validate(&metadata, "0.0.0", &update.version, &update.download_url)?;
        let available = version(&update.version)? > version(&current)?;
        let result = UpdateInfo {
            available,
            current_version: current,
            version: Some(update.version.clone()),
            bytes: Some(metadata.size),
        };
        if available {
            *selected = Some(Selected {
                update,
                metadata,
                selected_at: Instant::now(),
                downloaded: None,
            });
        }
        Ok(result)
    }

    pub async fn download(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
    ) -> Result<(), String> {
        trusted_window(&window)?;
        let state = app.state::<State>();
        let mut selected = state.0.try_lock().map_err(|_| "UPDATE_BUSY")?;
        let selection = selected.as_mut().ok_or("UPDATE_CHECK_REQUIRED")?;
        selection.downloaded = None;
        if selection.selected_at.elapsed() > TTL {
            return Err("UPDATE_CHECK_EXPIRED".into());
        }
        validate(
            &selection.metadata,
            &app.package_info().version.to_string(),
            &selection.update.version,
            &selection.update.download_url,
        )?;
        // Use a bounded reader and the same Minisign verifier as the maintained
        // plugin; its install API consumes these exact already-verified bytes.
        let bytes = bounded_get(
            selection.update.download_url.clone(),
            selection.metadata.size,
            Some(&window),
        )
        .await?;
        if bytes.len() != selection.metadata.size
            || format!("{:x}", Sha256::digest(&bytes)) != selection.metadata.sha256
            || !bytes.starts_with(b"MZ")
        {
            return Err("UPDATE_HASH_INVALID".into());
        }
        verify_signature(&bytes, &selection.update.signature)?;
        selection.downloaded = Some(bytes);
        selection.selected_at = Instant::now();
        Ok(())
    }

    pub async fn install(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        request_id: String,
    ) -> Result<(), String> {
        trusted_window(&window)?;
        let state = app.state::<State>();
        let mut selected = state.0.try_lock().map_err(|_| "UPDATE_BUSY")?;
        let selection = selected.take().ok_or("UPDATE_CHECK_REQUIRED")?;
        if selection.selected_at.elapsed() > TTL {
            return Err("UPDATE_CHECK_EXPIRED".into());
        }
        let bytes = selection.downloaded.ok_or("UPDATE_DOWNLOAD_REQUIRED")?;
        let native_window = window.as_ref().window();
        crate::state_safety::verify_state_quiescence(
            app.clone(),
            native_window.clone(),
            request_id.clone(),
        )?;
        let executable = std::env::current_exe().map_err(|_| "UPDATE_INSTALL_LOCATION_INVALID")?;
        let parent = executable
            .parent()
            .ok_or("UPDATE_INSTALL_LOCATION_INVALID")?;
        crate::state_safety::check_path(parent)?;
        if !parent.join("uninstall.exe").is_file() {
            return Err("UPDATE_INSTALLED_APP_REQUIRED".into());
        }
        // Install into this running program's exact directory, including Unicode
        // and spaces. NSIS /D is the final unquoted command-line remainder.
        // Reuse the checked Update while changing only locally owned installer args.
        let mut install_update = selection.update;
        let installer = app
            .updater_builder()
            .endpoints(vec![endpoint(false)])
            .map_err(|_| "UPDATE_CONFIG_INVALID")?
            .clear_installer_args()
            .installer_arg(format!("/D={}", parent.display()))
            .timeout(Duration::from_secs(15))
            .configure_client(|client| client.redirect(Policy::none()))
            .build()
            .map_err(|_| "UPDATE_CONFIG_INVALID")?;
        // Refetch at the apply boundary; changed selections require a fresh user
        // operation. Feed bytes and installer signature must be identical.
        let fresh = installer
            .check()
            .await
            .map_err(|_| "UPDATE_CHECK_FAILED")?
            .ok_or("UPDATE_CHANGED")?;
        if fresh.raw_json != install_update.raw_json
            || fresh.signature != install_update.signature
            || fresh.download_url != install_update.download_url
        {
            return Err("UPDATE_CHANGED".into());
        }
        install_update = fresh;
        verify_signature(&bytes, &install_update.signature)?;
        crate::state_safety::verify_state_quiescence(
            app.clone(),
            native_window.clone(),
            request_id,
        )?;
        install_update
            .install(bytes)
            .map_err(|_| "UPDATE_INSTALL_FAILED".into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn canonical_forward_versions_and_exact_asset_identity() {
            let metadata = Metadata {
                schema_version: 1,
                repository: REPOSITORY.into(),
                repository_id: 1390032052,
                channel: "test".into(),
                installer_mode: "tauri-test-nsis-v1".into(),
                version: "1.0.2".into(),
                size: 1024,
                sha256: "a".repeat(64),
            };
            let url: Url = format!("https://github.com/{REPOSITORY}/releases/download/v1.0.2/dmelopers-block-pet_1.0.2_x64-setup.exe?sha256={}", metadata.sha256).parse().unwrap();
            assert!(validate(&metadata, "1.0.1", "1.0.2", &url).is_ok());
            assert!(validate(&metadata, "1.0.2", "1.0.2", &url).is_err());
            for input in ["01.0.2", "1.0.2-beta", "1.0.65536", "1.0.2+test", "1.2"] {
                assert!(version(input).is_err());
            }
            assert!(
                validate(
                    &metadata,
                    "1.0.1",
                    "1.0.2",
                    &url.as_str()
                        .replace(REPOSITORY, "evil/repo")
                        .parse()
                        .unwrap()
                )
                .is_err()
            );
        }
        #[test]
        fn redirects_cannot_escape_the_download_provider() {
            assert!(allowed_redirect(
                &"https://release-assets.githubusercontent.com/path?x=1"
                    .parse()
                    .unwrap()
            ));
            for input in [
                "http://github.com/x",
                "https://github.com.evil/x",
                "https://user@github.com/x",
                "https://github.com:444/x",
                "https://127.0.0.1/x",
            ] {
                assert!(!allowed_redirect(&input.parse().unwrap()));
            }
        }
        #[test]
        fn direct_plugin_install_ipc_stays_denied() {
            use tauri::{ipc::Origin, test::MockRuntime};
            let mut context: tauri::Context<MockRuntime> = tauri::generate_context!();
            for window in ["main", "preference", "untrusted"] {
                for command in ["check", "download", "install", "download_and_install"] {
                    assert!(
                        context
                            .runtime_authority_mut()
                            .resolve_access(
                                &format!("plugin:updater|{command}"),
                                window,
                                window,
                                &Origin::Local
                            )
                            .is_none()
                    );
                }
            }
        }
    }
}
