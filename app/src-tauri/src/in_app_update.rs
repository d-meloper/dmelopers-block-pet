//! Channel-bound, user-initiated GitHub updates. Store builds cannot install them.
use serde::{Deserialize, Serialize};

#[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
mod operation;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    available: bool,
    current_version: String,
    version: Option<String>,
    bytes: Option<usize>,
}

#[tauri::command]
pub fn in_app_updater_enabled() -> bool {
    cfg!(any(feature = "wix-local-test", feature = "wix-github"))
        && !cfg!(debug_assertions)
        && crate::distribution::channel() != crate::distribution::Channel::Development
}

#[tauri::command]
pub async fn check_app_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    force: Option<bool>,
) -> Result<UpdateInfo, String> {
    #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
    return enabled_profile::check(app, window, force.unwrap_or(false)).await;
    #[cfg(not(any(feature = "wix-local-test", feature = "wix-github")))]
    {
        let _ = (app, window, force);
        Err("UPDATER_DISABLED".into())
    }
}

#[tauri::command]
pub async fn download_app_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
    return enabled_profile::download(app, window, request_id).await;
    #[cfg(not(any(feature = "wix-local-test", feature = "wix-github")))]
    {
        let _ = (app, window, request_id);
        Err("UPDATER_DISABLED".into())
    }
}

#[tauri::command]
pub async fn install_app_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
    return enabled_profile::install(app, window, request_id).await;
    #[cfg(not(any(feature = "wix-local-test", feature = "wix-github")))]
    {
        let _ = (app, window, request_id);
        Err("UPDATER_DISABLED".into())
    }
}

#[tauri::command]
pub fn begin_app_update_save(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
    return enabled_profile::begin_save(app, window, request_id);
    #[cfg(not(any(feature = "wix-local-test", feature = "wix-github")))]
    {
        let _ = (app, window, request_id);
        Err("UPDATER_DISABLED".into())
    }
}

#[tauri::command]
pub fn cancel_app_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
    return enabled_profile::cancel(app, window, request_id);
    #[cfg(not(any(feature = "wix-local-test", feature = "wix-github")))]
    {
        let _ = (app, window, request_id);
        Err("UPDATER_DISABLED".into())
    }
}

#[tauri::command]
pub fn abort_app_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
    return enabled_profile::abort(app, window, request_id);
    #[cfg(not(any(feature = "wix-local-test", feature = "wix-github")))]
    {
        let _ = (app, window, request_id);
        Err("UPDATER_DISABLED".into())
    }
}

#[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
pub mod enabled_profile {
    use super::{
        UpdateInfo,
        operation::{Cancellation, Control, Phase},
    };
    use crate::application_context::updater_public_key as public_key;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use minisign_verify::{PublicKey, Signature};
    use reqwest::{Url, redirect::Policy};
    use serde::{Deserialize, Serialize};
    use sha2::{Digest, Sha256};
    use std::time::{Duration, Instant};
    use tauri::{Emitter, Manager};

    const MARKER: &str = if cfg!(feature = "wix-github") { "DMELoper_WIX_OFFICIAL_UPDATER_V1" } else if cfg!(feature = "wix-github-test") { "DMELoper_WIX_GITHUB_TEST_UPDATER_V1" } else { "DMELoper_WIX_LOCAL_UPDATER_V1" };
    const REPOSITORY: &str = crate::wix_local::REPOSITORY;
    const REPOSITORY_ID: u64 = crate::wix_local::REPOSITORY_ID;
    const CHANNEL: &str = crate::wix_local::CHANNEL;
    const INSTALLER_MODE: &str = crate::wix_local::MODE;
    const ENDPOINT: &str = crate::wix_local::ENDPOINT;
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

    struct VerifiedUpdate {
        version: String,
        signature: String,
        download_url: Url,
        raw_json: serde_json::Value,
    }

    fn parse_update(raw: &[u8]) -> Result<VerifiedUpdate, String> {
        if raw.len() > MAX_METADATA { return Err("UPDATE_METADATA_INVALID".into()); }
        let value: serde_json::Value = serde_json::from_slice(raw).map_err(|_| "UPDATE_METADATA_INVALID")?;
        let version = value["version"].as_str().ok_or("UPDATE_METADATA_INVALID")?.to_owned();
        let platform = &value["platforms"]["windows-x86_64"];
        let signature = platform["signature"].as_str().filter(|s| !s.is_empty() && s.len() <= 8192)
            .ok_or("UPDATE_METADATA_INVALID")?.to_owned();
        let download_url = platform["url"].as_str().ok_or("UPDATE_METADATA_INVALID")?
            .parse().map_err(|_| "UPDATE_METADATA_INVALID")?;
        Ok(VerifiedUpdate { version, signature, download_url, raw_json: value })
    }

    async fn fetch_update() -> Result<VerifiedUpdate, String> {
        let cancel = Cancellation::default();
        let raw = bounded_get(endpoint(false), MAX_METADATA, None, &cancel).await?;
        let update = parse_update(&raw)?;
        let canonical = serde_json::to_vec(&update.raw_json).map_err(|_| "UPDATE_METADATA_INVALID")?;
        if canonical.len() > MAX_METADATA { return Err("UPDATE_METADATA_INVALID".into()); }
        let signature = bounded_get(endpoint(true), 8192, None, &cancel).await?;
        verify_signature(&canonical, std::str::from_utf8(&signature).map_err(|_| "UPDATE_SIGNATURE_INVALID")?)?;
        Ok(update)
    }

    struct Selected {
        update: VerifiedUpdate,
        metadata: Metadata,
        selected_at: Instant,
        downloaded: Option<Vec<u8>>,
        request_id: Option<String>,
    }
    #[derive(Default)]
    struct State {
        selected: tokio::sync::Mutex<Option<Selected>>,
        control: Control,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Metadata {
        #[serde(default)]
        product: Option<String>,
        schema_version: u32,
        repository: String,
        repository_id: u64,
        channel: String,
        installer_mode: String,
        version: String,
        size: usize,
        sha256: String,
        #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
        bundle_upgrade_code: String,
        #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
        msi_upgrade_code: String,
        #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
        msi_product_code: String,
    }

    pub fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
        std::hint::black_box(MARKER);
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
        if !super::in_app_updater_enabled()
            || window.label() != "preference"
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
        progress: Option<(&tauri::WebviewWindow, &str)>,
        cancel: &Cancellation,
    ) -> Result<Vec<u8>, String> {
        cancel.check()?;
        #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
        if !crate::wix_local::allowed_request(&url) { return Err("UPDATE_IDENTITY_INVALID".into()); }
        let client = reqwest::Client::builder();
        #[cfg(all(feature = "wix-local-test", not(any(feature = "wix-github-test", feature = "wix-github"))))]
        let client = client.no_proxy();
        #[cfg(all(feature = "wix-local-test", not(any(feature = "wix-github-test", feature = "wix-github"))))]
        let redirects = Policy::none();
        #[cfg(any(feature = "wix-github", not(feature = "wix-local-test"), feature = "wix-github-test"))]
        let redirects = redirect_policy();
        let request = client
            .user_agent("DMeloper-BlockPet-Updater/1")
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(120))
            .redirect(redirects)
            .build()
            .map_err(|_| "UPDATE_NETWORK_FAILED")?
            .get(url)
            .header("Cache-Control", "no-cache")
            .send();
        let mut response = tokio::select! {
            biased;
            _ = cancel.wait() => return Err("UPDATE_CANCELLED".into()),
            response = request => response.map_err(|_| "UPDATE_NETWORK_FAILED")?
                .error_for_status().map_err(|_| "UPDATE_NETWORK_FAILED")?,
        };
        if response
            .content_length()
            .is_some_and(|size| size > limit as u64)
        {
            return Err("UPDATE_SIZE_INVALID".into());
        }
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.wait() => return Err("UPDATE_CANCELLED".into()),
                chunk = response.chunk() => chunk.map_err(|_| "UPDATE_NETWORK_FAILED")?,
            };
            let Some(chunk) = chunk else {
                break;
            };
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err("UPDATE_SIZE_INVALID".into());
            }
            bytes.extend_from_slice(&chunk);
            if let Some((window, request_id)) = progress {
                let _ = window.emit(
                    "app-update-progress",
                    serde_json::json!({
                        "requestId": request_id, "received": bytes.len(), "size": limit,
                        "phase": "downloading"
                    }),
                );
            }
        }
        cancel.check()?;
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
            || metadata.repository_id != REPOSITORY_ID
            || metadata.channel != CHANNEL
            || metadata.installer_mode != INSTALLER_MODE
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
        #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
        {
            if metadata.product.as_deref() != Some(crate::wix_local::PRODUCT)
                || metadata.bundle_upgrade_code != crate::wix_local::BUNDLE_UPGRADE
                || metadata.msi_upgrade_code != crate::wix_local::MSI_UPGRADE
                || !crate::wix_local::guid(&metadata.msi_product_code)
                || url.as_str() != crate::wix_local::artifact_url(selected, &metadata.sha256)
            { return Err("UPDATE_IDENTITY_INVALID".into()); }
        }
        #[cfg(feature = "wix-github")]
        if metadata.msi_product_code != crate::wix_local::product_code(selected) {
            return Err("UPDATE_IDENTITY_INVALID".into());
        }
        Ok(())
    }

    const SUCCESS_INTERVAL: u64 = 6 * 60 * 60;
    const ERROR_INTERVAL: u64 = 10 * 60;
    #[derive(Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct DisplayCache {
        repository: String,
        current_version: String,
        checked_at: u64,
        result: Result<UpdateInfo, String>,
    }
    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
    fn cache_current(cache: &DisplayCache, current: &str, time: u64) -> bool {
        let interval = if cache.result.is_ok() {
            SUCCESS_INTERVAL
        } else {
            ERROR_INTERVAL
        };
        cache.repository == REPOSITORY
            && cache.current_version == current
            && cache.checked_at <= time
            && time - cache.checked_at < interval
            && match &cache.result {
                Ok(info) => {
                    info.current_version == current
                        && info.version.as_deref().is_some_and(|v| version(v).is_ok())
                        && info.version.as_deref().is_some_and(|v| {
                            info.available == (version(v).ok() > version(current).ok())
                        })
                        && info.bytes.is_some_and(|n| n > 0 && n <= MAX_DOWNLOAD)
                }
                Err(error) => error.starts_with("UPDATE_") && error.len() <= 80,
            }
    }
    fn cache_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        let root = app
            .path()
            .app_cache_dir()
            .map_err(|_| "UPDATE_CACHE_UNAVAILABLE")?;
        let path = root.join("github-update-display.json");
        crate::state_safety::check_path(&path)?;
        Ok(path)
    }
    fn read_cache(app: &tauri::AppHandle, current: &str) -> Option<Result<UpdateInfo, String>> {
        let path = cache_path(app).ok()?;
        let file = std::fs::File::open(path).ok()?;
        if file.metadata().ok()?.len() > 4096 {
            return None;
        }
        let cache: DisplayCache = serde_json::from_reader(std::io::Read::take(file, 4097)).ok()?;
        cache_current(&cache, current, now()).then_some(cache.result)
    }
    fn write_cache(app: &tauri::AppHandle, current: String, result: Result<UpdateInfo, String>) {
        let write = || -> Result<(), String> {
            let path = cache_path(app)?;
            std::fs::create_dir_all(path.parent().ok_or("UPDATE_CACHE_UNAVAILABLE")?)
                .map_err(|_| "UPDATE_CACHE_UNAVAILABLE")?;
            let cache = DisplayCache {
                repository: REPOSITORY.into(),
                current_version: current,
                checked_at: now(),
                result,
            };
            let bytes = serde_json::to_vec(&cache).map_err(|_| "UPDATE_CACHE_UNAVAILABLE")?;
            // A partial cache is ignored on the next read; it never authorizes installation.
            crate::state_safety::check_path(&path)?;
            std::fs::write(path, bytes).map_err(|_| "UPDATE_CACHE_UNAVAILABLE".into())
        };
        if write().is_err() {
            crate::diagnostics::warn("updates.cache", "UPDATE_CACHE_UNAVAILABLE");
        }
    }
    pub async fn check(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        force: bool,
    ) -> Result<UpdateInfo, String> {
        trusted_window(&window)?;
        let state = app.state::<State>();
        state.control.idle()?;
        let current = app.package_info().version.to_string();
        if !force {
            if let Some(cached) = read_cache(&app, &current) {
                *state.selected.try_lock().map_err(|_| "UPDATE_BUSY")? = None;
                return cached;
            }
        }
        let result = check_fresh(app.clone(), window).await;
        if result.as_ref().err().map(String::as_str) != Some("UPDATE_BUSY") {
            write_cache(&app, current, result.clone());
        }
        result
    }

    async fn check_fresh(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
    ) -> Result<UpdateInfo, String> {
        trusted_window(&window)?;
        let state = app.state::<State>();
        state.control.idle()?;
        let mut selected = state.selected.try_lock().map_err(|_| "UPDATE_BUSY")?;
        *selected = None;
        let current = app.package_info().version.to_string();
        let update = fetch_update().await?;
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
                request_id: None,
            });
        }
        Ok(result)
    }

    pub async fn download(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        request_id: String,
    ) -> Result<(), String> {
        trusted_window(&window)?;
        let state = app.state::<State>();
        let cancel = state.control.start(&request_id)?;
        let result = async {
            let mut selection = state.selected.try_lock().map_err(|_| "UPDATE_BUSY")?.take().ok_or("UPDATE_CHECK_REQUIRED")?;
            if selection.selected_at.elapsed() > TTL { return Err("UPDATE_CHECK_EXPIRED".into()); }
            validate(&selection.metadata, &app.package_info().version.to_string(), &selection.update.version, &selection.update.download_url)?;
            let bytes = bounded_get(selection.update.download_url.clone(), selection.metadata.size, Some((&window, &request_id)), &cancel).await?;
            state.control.transition(&request_id, Phase::Downloading, Phase::Verifying)?;
            let _ = window.emit("app-update-progress", serde_json::json!({ "requestId": request_id, "received": bytes.len(), "size": bytes.len(), "phase": "verifying" }));
            let verifier_cancel = cancel.clone();
            let size = selection.metadata.size;
            let hash = selection.metadata.sha256.clone();
            let signature = selection.update.signature.clone();
            let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
                let mut digest = Sha256::new();
                for chunk in bytes.chunks(1024 * 1024) { verifier_cancel.check()?; digest.update(chunk); }
                if bytes.len() != size || format!("{:x}", digest.finalize()) != hash || !bytes.starts_with(b"MZ") { return Err("UPDATE_HASH_INVALID".into()); }
                verifier_cancel.check()?;
                verify_signature(&bytes, &signature)?;
                verifier_cancel.check()?;
                Ok(bytes)
            }).await.map_err(|_| "UPDATE_VERIFY_FAILED")??;
            selection.downloaded = Some(bytes);
            selection.request_id = Some(request_id.clone());
            selection.selected_at = Instant::now();
            *state.selected.try_lock().map_err(|_| "UPDATE_BUSY")? = Some(selection);
            state.control.transition(&request_id, Phase::Verifying, Phase::Verified)?;
            Ok(())
        }.await;
        if result.is_err() {
            clear(&state, &request_id);
        }
        result
    }
    fn clear(state: &State, request_id: &str) {
        if let Ok(mut selected) = state.selected.try_lock() {
            if selected
                .as_ref()
                .is_some_and(|s| s.request_id.as_deref() == Some(request_id))
            {
                *selected = None;
            }
        }
        state.control.finish(request_id);
    }
    pub fn begin_save(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        request_id: String,
    ) -> Result<(), String> {
        trusted_window(&window)?;
        app.state::<State>()
            .control
            .transition(&request_id, Phase::Verified, Phase::Saving)
    }
    pub fn cancel(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        request_id: String,
    ) -> Result<(), String> {
        trusted_window(&window)?;
        let state = app.state::<State>();
        if state.control.cancel(&request_id)? == Phase::Verified {
            clear(&state, &request_id);
        }
        Ok(())
    }
    pub fn abort(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        request_id: String,
    ) -> Result<(), String> {
        trusted_window(&window)?;
        let state = app.state::<State>();
        state.control.abort_save(&request_id)?;
        clear(&state, &request_id);
        Ok(())
    }

    pub async fn install(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        request_id: String,
    ) -> Result<(), String> {
        trusted_window(&window)?;
        let state = app.state::<State>();
        state
            .control
            .transition(&request_id, Phase::Saving, Phase::Installing)?;
        let result = install_inner(app.clone(), window, request_id.clone()).await;
        clear(&state, &request_id);
        result
    }

    async fn install_inner(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        request_id: String,
    ) -> Result<(), String> {
        trusted_window(&window)?;
        let state = app.state::<State>();
        let mut selected = state.selected.try_lock().map_err(|_| "UPDATE_BUSY")?;
        let selection = selected.take().ok_or("UPDATE_CHECK_REQUIRED")?;
        if selection.selected_at.elapsed() > TTL {
            return Err("UPDATE_CHECK_EXPIRED".into());
        }
        if selection.request_id.as_deref() != Some(&request_id) {
            return Err("UPDATE_REQUEST_INVALID".into());
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
        crate::wix_local::registration(parent)?;
        let install_update = selection.update;
        // Reverify bounded, signed metadata immediately before handing off to Burn.
        let fresh = fetch_update().await?;
        let metadata: Metadata = serde_json::from_value(fresh.raw_json.clone()).map_err(|_| "UPDATE_METADATA_INVALID")?;
        validate(&metadata, &app.package_info().version.to_string(), &fresh.version, &fresh.download_url)?;
        if fresh.raw_json != install_update.raw_json
            || fresh.signature != install_update.signature
            || fresh.download_url != install_update.download_url
        {
            return Err("UPDATE_CHANGED".into());
        }
        verify_signature(&bytes, &fresh.signature)?;
        crate::state_safety::verify_state_quiescence(
            app.clone(),
            native_window.clone(),
            request_id,
        )?;
        crate::wix_local::handoff(&app, parent, &bytes, &selection.metadata.sha256)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        #[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
        fn local_feed_cannot_cross_package_or_transport_identity() {
            let mut metadata = Metadata {
                product: Some(crate::wix_local::PRODUCT.into()), schema_version: 1,
                repository: REPOSITORY.into(), repository_id: REPOSITORY_ID, channel: CHANNEL.into(),
                installer_mode: INSTALLER_MODE.into(), version: "1.0.1".into(), size: 1234,
                sha256: "a".repeat(64), bundle_upgrade_code: crate::wix_local::BUNDLE_UPGRADE.into(),
                msi_upgrade_code: crate::wix_local::MSI_UPGRADE.into(), msi_product_code: "{11111111-1111-1111-1111-111111111111}".into(),
            };
            #[cfg(feature = "wix-github")]
            { metadata.msi_product_code = crate::wix_local::product_code("1.0.1"); }
            let url = crate::wix_local::artifact_url("1.0.1", &metadata.sha256).parse().unwrap();
            assert!(validate(&metadata, "1.0.0", "1.0.1", &url).is_ok());
            assert!(validate(&metadata, "1.0.1", "1.0.1", &url).is_err());
            let foreign = if cfg!(any(feature = "wix-github", feature = "wix-github-test")) { url.as_str().replace(REPOSITORY, "evil/repo") } else { url.as_str().replace("127.0.0.1", "localhost") };
            assert!(validate(&metadata, "1.0.0", "1.0.1", &foreign.parse().unwrap()).is_err());
            metadata.installer_mode = "retired-installer-mode".into();
            assert!(validate(&metadata, "1.0.0", "1.0.1", &url).is_err());
            metadata.installer_mode = INSTALLER_MODE.into();
            metadata.bundle_upgrade_code = crate::wix_local::MSI_UPGRADE.into();
            assert!(validate(&metadata, "1.0.0", "1.0.1", &url).is_err());
            assert!(verify_signature(b"tampered", "not a signature").is_err());
        }
        #[test]
        fn display_cache_obeys_success_error_and_clock_boundaries() {
            let mut cache = DisplayCache {
                repository: REPOSITORY.into(),
                current_version: "1.0.0".into(),
                checked_at: 1000,
                result: Ok(UpdateInfo {
                    available: true,
                    current_version: "1.0.0".into(),
                    version: Some("1.0.1".into()),
                    bytes: Some(1024),
                }),
            };
            assert!(cache_current(&cache, "1.0.0", 1000 + SUCCESS_INTERVAL - 1));
            assert!(!cache_current(&cache, "1.0.0", 1000 + SUCCESS_INTERVAL));
            assert!(!cache_current(&cache, "1.0.0", 999));
            assert!(!cache_current(&cache, "1.0.1", 1000));
            cache.result = Err("UPDATE_NETWORK_FAILED".into());
            assert!(cache_current(&cache, "1.0.0", 1000 + ERROR_INTERVAL - 1));
            assert!(!cache_current(&cache, "1.0.0", 1000 + ERROR_INTERVAL));
            cache.repository = "different/repository".into();
            assert!(!cache_current(&cache, "1.0.0", 1000));
        }
        #[test]
        fn feed_parser_bounds_and_requires_the_exact_platform_fields() {
            let data = serde_json::json!({"version":"1.0.1","platforms":{"windows-x86_64":{
                "url":crate::wix_local::artifact_url("1.0.1", &"a".repeat(64)), "signature":"signature"}}});
            let parsed = parse_update(&serde_json::to_vec(&data).unwrap()).unwrap();
            assert_eq!(parsed.version,"1.0.1");
            assert!(crate::wix_local::allowed_request(&parsed.download_url));
            for invalid in [serde_json::json!({}), serde_json::json!({"version":"1.0.1","platforms":{"other":{}}}),
                            serde_json::json!({"version":"1.0.1","platforms":{"windows-x86_64":{"url":"invalid","signature":""}}})] {
                assert!(parse_update(&serde_json::to_vec(&invalid).unwrap()).is_err());
            }
            assert!(parse_update(&vec![b' '; MAX_METADATA+1]).is_err());
            for v in ["01.0.1","1.0.1-test","1.0.65536","1.0.1+test","1.0"] { assert!(version(v).is_err()); }
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
