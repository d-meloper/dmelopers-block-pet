pub mod feed;
mod helper;
pub(crate) use block_pet_update_core::process;
#[cfg(feature = "private-update-qa")]
mod qa;
mod source;
#[cfg(test)]
mod tests;

#[cfg(test)]
use feed::REPOSITORY;
use feed::{Feed, MAX_METADATA_BYTES, Trust};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{Emitter, Listener, Manager};
use tokio::io::AsyncWriteExt;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub revision: u64,
    pub phase: String,
    pub request_id: Option<String>,
    pub current_version: String,
    pub target_version: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub can_cancel: bool,
    pub error_code: Option<String>,
    pub release_url: Option<String>,
}

use block_pet_update_core::require_same_feed;
pub use block_pet_update_core::{UpdateError, fail, new_request_id};

pub struct UpdateState {
    status: Mutex<UpdateStatus>,
    decision: Mutex<Option<Feed>>,
    operation: tokio::sync::Mutex<()>,
    commit_gate: Mutex<()>,
    cancelled: AtomicBool,
    cancel_signal: tokio::sync::watch::Sender<bool>,
    automatic: AtomicBool,
    installing: AtomicBool,
    exiting_for_install: AtomicBool,
    cleanup_running: AtomicBool,
    data_ready: Mutex<Option<(String, tokio::sync::oneshot::Sender<bool>)>>,
    root: PathBuf,
}

impl UpdateState {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, UpdateError> {
        #[cfg(not(feature = "private-update-qa"))]
        if let Ok(root) = app.path().app_data_dir() {
            if source::initialize(&root).is_err() {
                // An invalid or unwritable update selector blocks updates only;
                // opening the app must remain possible to repair local data.
                log::warn!("Update repository selector could not be initialized");
            }
        }
        // Resolve persisted startup policy synchronously before any WebView can
        // issue a newer configuration command. A late disk read cannot undo it.
        let automatic = app
            .path()
            .app_data_dir()
            .ok()
            .map(|root| automatic_from_user_root(&root))
            .unwrap_or(false);
        Ok(Self {
            status: Mutex::new(UpdateStatus {
                revision: 0,
                phase: "idle".into(),
                request_id: None,
                current_version: app.package_info().version.to_string(),
                target_version: None,
                downloaded_bytes: 0,
                total_bytes: 0,
                can_cancel: false,
                error_code: None,
                release_url: None,
            }),
            decision: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
            commit_gate: Mutex::new(()),
            cancelled: AtomicBool::new(false),
            automatic: AtomicBool::new(automatic),
            cancel_signal: tokio::sync::watch::channel(false).0,
            installing: AtomicBool::new(false),
            exiting_for_install: AtomicBool::new(false),
            cleanup_running: AtomicBool::new(false),
            data_ready: Mutex::new(None),
            root: app
                .path()
                .app_local_data_dir()
                .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
                .join("update-delivery"),
        })
    }
    fn status(&self) -> UpdateStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    fn change(
        &self,
        app: &tauri::AppHandle,
        update: impl FnOnce(&mut UpdateStatus),
    ) -> UpdateStatus {
        let value = {
            let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
            update(&mut status);
            status.revision += 1;
            status.clone()
        };
        let _ = app.emit("update-status", &value);
        value
    }
    fn check_cancelled(&self) -> Result<(), UpdateError> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(fail("CANCELLED"))
        } else {
            Ok(())
        }
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.cancel_signal.send_replace(true);
    }
    fn try_cancel(&self) -> Result<(), UpdateError> {
        let _gate = self
            .commit_gate
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.installing.load(Ordering::SeqCst) || !self.status().can_cancel {
            return Err(fail("CANNOT_CANCEL"));
        }
        self.cancel();
        Ok(())
    }
    fn begin_commit(&self) -> Result<std::sync::MutexGuard<'_, ()>, UpdateError> {
        let gate = self
            .commit_gate
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.check_cancelled()?;
        Ok(gate)
    }
    fn finish_error(&self, app: &tauri::AppHandle, error: UpdateError) -> UpdateError {
        self.change(app, |s| {
            s.phase = if error.code == "CANCELLED" {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            s.error_code = Some(error.code.clone());
            s.can_cancel = false;
        });
        error
    }
}

fn local_window(window: &tauri::WebviewWindow) -> Result<(), UpdateError> {
    if !matches!(window.label(), "main" | "preference") {
        return Err(fail("UNAUTHORIZED"));
    }
    Ok(())
}

#[cfg(not(feature = "private-update-qa"))]
fn client(metadata: bool) -> Result<reqwest::Client, UpdateError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(if metadata { 30 } else { 15 * 60 }))
        .user_agent("dmelopers-3d-block-pet-updater/1")
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 5 || !feed::allowed_url(attempt.url(), metadata) {
                attempt.error("update redirect rejected")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| fail("NETWORK_UNAVAILABLE"))
}

enum TransportResponse {
    #[cfg(not(feature = "private-update-qa"))]
    Network(reqwest::Response),
    #[cfg(feature = "private-update-qa")]
    Fixture {
        bytes: std::borrow::Cow<'static, [u8]>,
        offset: usize,
    },
}

impl TransportResponse {
    fn content_length(&self) -> Option<u64> {
        match self {
            #[cfg(not(feature = "private-update-qa"))]
            Self::Network(response) => response.content_length(),
            #[cfg(feature = "private-update-qa")]
            Self::Fixture { bytes, .. } => Some(bytes.len() as u64),
        }
    }
    async fn chunk(&mut self) -> Result<Option<Vec<u8>>, UpdateError> {
        match self {
            #[cfg(not(feature = "private-update-qa"))]
            Self::Network(response) => response
                .chunk()
                .await
                .map(|value| value.map(|bytes| bytes.to_vec()))
                .map_err(|_| fail("NETWORK_UNAVAILABLE")),
            #[cfg(feature = "private-update-qa")]
            Self::Fixture { bytes, offset } => {
                tokio::task::yield_now().await;
                if *offset == bytes.len() {
                    return Ok(None);
                }
                let end = (*offset + 65536).min(bytes.len());
                let chunk = bytes[*offset..end].to_vec();
                *offset = end;
                Ok(Some(chunk))
            }
        }
    }
}

async fn response(url: &str, metadata: bool) -> Result<TransportResponse, UpdateError> {
    let url = reqwest::Url::parse(url).map_err(|_| fail("METADATA_INVALID"))?;
    if !feed::allowed_url(&url, metadata) {
        return Err(fail("METADATA_INVALID"));
    }
    #[cfg(feature = "private-update-qa")]
    {
        qa::response(url.as_str(), metadata)
    }
    #[cfg(not(feature = "private-update-qa"))]
    {
        let response = client(metadata)?
            .get(url)
            .header("Cache-Control", "no-cache, no-store")
            .send()
            .await
            .map_err(|_| fail("NETWORK_UNAVAILABLE"))?;
        if response.status().as_u16() == 429
            || (response.status().as_u16() == 403
                && response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|v| v == "0"))
        {
            return Err(fail("RATE_LIMITED"));
        }
        if response.status().as_u16() == 404 {
            return Err(fail("RELEASE_UNAVAILABLE"));
        }
        if !response.status().is_success() || !feed::allowed_url(response.url(), metadata) {
            return Err(fail("NETWORK_UNAVAILABLE"));
        }
        Ok(TransportResponse::Network(response))
    }
}

async fn metadata(url: &str, limit: u64) -> Result<Vec<u8>, UpdateError> {
    read_bounded(response(url, true).await?, limit).await
}

async fn read_bounded(mut response: TransportResponse, limit: u64) -> Result<Vec<u8>, UpdateError> {
    if response.content_length().is_some_and(|size| size > limit) {
        return Err(fail("METADATA_INVALID"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| fail("NETWORK_UNAVAILABLE"))?
    {
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err(fail("METADATA_INVALID"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(feature = "private-update-qa")]
async fn fresh_feed() -> Result<Feed, UpdateError> {
    fresh_feed_with_trust(Trust::embedded()?).await
}

fn selected_trust(app: &tauri::AppHandle) -> Result<Trust, UpdateError> {
    #[cfg(feature = "private-update-qa")]
    {
        let _ = app;
        Trust::embedded()
    }
    #[cfg(not(feature = "private-update-qa"))]
    {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|_| fail("STORAGE_UNAVAILABLE"))?;
        Trust::for_repository(source::repository(&root)?)
    }
}

fn require_current_source(app: &tauri::AppHandle, feed: &Feed) -> Result<(), UpdateError> {
    let trust = selected_trust(app)?;
    require_feed_source(feed, &trust)
}

fn require_feed_source(feed: &Feed, trust: &Trust) -> Result<(), UpdateError> {
    if trust.repository != feed.repository || trust.repository_id != Some(feed.repository_id) {
        return Err(fail("CHECK_REQUIRED"));
    }
    Ok(())
}

async fn fresh_feed_for_app(app: &tauri::AppHandle) -> Result<Feed, UpdateError> {
    let feed = fresh_feed_with_trust(selected_trust(app)?).await?;
    // A source file edit during the network request cannot publish an old
    // repository's available decision into the newly selected environment.
    require_current_source(app, &feed)?;
    Ok(feed)
}

async fn fresh_feed_with_trust(trust: Trust) -> Result<Feed, UpdateError> {
    let repository = &trust.repository;
    let base = format!("https://raw.githubusercontent.com/{repository}/updates/stable.json");
    let signature_url = format!("{base}.sig");
    let (bytes, signature) = tokio::try_join!(
        metadata(&base, MAX_METADATA_BYTES),
        metadata(&signature_url, 4096)
    )?;
    let signature = std::str::from_utf8(&signature).map_err(|_| fail("SIGNATURE_INVALID"))?;
    let feed = Feed::parse(&bytes, signature, &trust)?;
    let repo = metadata(
        &format!("https://api.github.com/repos/{repository}"),
        MAX_METADATA_BYTES,
    )
    .await?;
    let repo: serde_json::Value =
        serde_json::from_slice(&repo).map_err(|_| fail("METADATA_INVALID"))?;
    if repo["id"].as_u64() != trust.repository_id
        || repo["full_name"] != *repository
        || repo["private"] != false
    {
        return Err(fail("REPOSITORY_MISMATCH"));
    }
    let release = metadata(
        &format!(
            "https://api.github.com/repos/{repository}/releases/tags/{}",
            feed.tag
        ),
        MAX_METADATA_BYTES,
    )
    .await?;
    feed::validate_release(&release, &feed)?;
    // Bind the activated branch to the exact immutable release's signed feed bytes.
    let released = read_bounded(
        response(
            &format!(
                "https://github.com/{repository}/releases/download/{}/stable.json",
                feed.tag
            ),
            false,
        )
        .await?,
        MAX_METADATA_BYTES,
    )
    .await?;
    let released_signature = read_bounded(
        response(
            &format!(
                "https://github.com/{repository}/releases/download/{}/stable.json.sig",
                feed.tag
            ),
            false,
        )
        .await?,
        4096,
    )
    .await?;
    let installer_signature = read_bounded(
        response(&format!("{}.sig", feed.download_url()), false).await?,
        4096,
    )
    .await?;
    if released != bytes
        || released_signature != signature.as_bytes()
        || std::str::from_utf8(&installer_signature)
            .map(str::trim)
            .ok()
            != Some(feed.asset.signature.trim())
    {
        return Err(fail("INTEGRITY_FAILED"));
    }
    feed::validate_asset_bytes(&release, "stable.json", &released)?;
    feed::validate_asset_bytes(&release, "stable.json.sig", &released_signature)?;
    feed::validate_asset_bytes(
        &release,
        &format!("{}.sig", feed.asset.name),
        &installer_signature,
    )?;
    Ok(feed)
}

async fn check(app: &tauri::AppHandle) -> Result<UpdateStatus, UpdateError> {
    let state = app.state::<UpdateState>();
    let _operation = state.operation.try_lock().map_err(|_| fail("BUSY"))?;
    if state.installing.load(Ordering::SeqCst) {
        return Err(fail("RECOVERY_REQUIRED"));
    }
    if matches!(
        state.status().phase.as_str(),
        "downloading" | "verifying" | "preparing"
    ) {
        return Err(fail("BUSY"));
    }
    *state.decision.lock().unwrap_or_else(|e| e.into_inner()) = None;
    state.change(app, |s| {
        s.phase = "checking".into();
        s.error_code = None;
        s.request_id = None;
        s.target_version = None;
        s.release_url = None;
        s.total_bytes = 0;
        s.downloaded_bytes = 0;
        s.can_cancel = false;
    });
    let feed = fresh_feed_for_app(app)
        .await
        .map_err(|e| state.finish_error(app, e))?;
    if feed::version(&feed.version)? <= feed::version(&state.status().current_version)? {
        return Ok(state.change(app, |s| s.phase = "upToDate".into()));
    }
    *state.decision.lock().unwrap_or_else(|e| e.into_inner()) = Some(feed.clone());
    Ok(state.change(app, |s| {
        s.phase = "available".into();
        s.target_version = Some(feed.version.clone());
        s.total_bytes = feed.asset.size;
        s.release_url = Some(feed.release_url());
    }))
}

#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<UpdateStatus, UpdateError> {
    local_window(&window)?;
    check(&app).await
}

#[tauri::command]
pub fn update_get_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateState>,
) -> Result<UpdateStatus, UpdateError> {
    if window.label() != "update-failure" {
        local_window(&window)?;
    }
    Ok(state.status())
}

#[tauri::command]
pub fn update_configure_automatic(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<(), UpdateError> {
    local_window(&window)?;
    let previous = app
        .state::<UpdateState>()
        .automatic
        .swap(enabled, Ordering::SeqCst);
    if enabled && !previous {
        tauri::async_runtime::spawn(async move {
            let _ = check(&app).await;
        });
    }
    Ok(())
}

pub fn schedule(app: tauri::AppHandle) {
    schedule_cleanup(app.clone());
    let for_cleanup = app.clone();
    app.listen("update-recovery-status", move |_| {
        schedule_cleanup(for_cleanup.clone())
    });
    tauri::async_runtime::spawn(async move {
        // Startup checks do not depend on the hidden preference WebView mounting.
        if app.state::<UpdateState>().automatic.load(Ordering::SeqCst) {
            let _ = check(&app).await;
        }
        loop {
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
            if app.state::<UpdateState>().automatic.load(Ordering::SeqCst) {
                let _ = check(&app).await;
            }
        }
    });
}

fn schedule_cleanup(app: tauri::AppHandle) {
    if app
        .state::<UpdateState>()
        .cleanup_running
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // Bound the retry period. A locked or running helper remains preserved.
        // A later startup or coordinator event may start a fresh cleanup period.
        for _ in 0..6 {
            tokio::time::sleep(Duration::from_secs(10)).await;
            if !helper::cleanup_verified_operations(&app) {
                break;
            }
        }
        app.state::<UpdateState>()
            .cleanup_running
            .store(false, Ordering::SeqCst);
    });
}

fn automatic_from_user_root(root: &std::path::Path) -> bool {
    let path = root
        .join(crate::update_recovery::STORE_DIRECTORY)
        .join("general.json");
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .map(|value| value["app"]["autoUpdateCheck"].as_bool().unwrap_or(true))
            .unwrap_or(false),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

#[tauri::command]
pub fn update_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<UpdateStatus, UpdateError> {
    if window.label() != "preference" {
        return Err(fail("UNAUTHORIZED"));
    }
    if tauri::is_dev() {
        return Err(fail("PACKAGED_APP_REQUIRED"));
    }
    let state = app.state::<UpdateState>();
    let _operation = state.operation.try_lock().map_err(|_| fail("BUSY"))?;
    if state.status().phase != "available" {
        return Err(fail("CHECK_REQUIRED"));
    }
    state
        .decision
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .ok_or_else(|| fail("CHECK_REQUIRED"))?
        .require_supported_installer()?;
    let request_id = new_request_id()?;
    state.cancelled.store(false, Ordering::SeqCst);
    state.cancel_signal.send_replace(false);
    let status = state.change(&app, |s| {
        s.phase = "downloading".into();
        s.request_id = Some(request_id);
        s.can_cancel = true;
        s.downloaded_bytes = 0;
        s.error_code = None;
    });
    let owned = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = owned.state::<UpdateState>();
        let _operation = state.operation.lock().await;
        if let Err(error) = perform_update(&owned, &state).await {
            let failed = state.finish_error(&owned, error);
            if failed.code != "CANCELLED" {
                let status = state.status();
                let outcome = if crate::update_recovery::writes_locked() {
                    "unknown"
                } else {
                    "unchanged"
                };
                crate::update_recovery::notification::report(
                    &owned,
                    status.request_id,
                    &failed.code,
                    outcome,
                    Some(status.current_version),
                    status.target_version,
                );
            }
        }
    });
    Ok(status)
}

async fn perform_update(app: &tauri::AppHandle, state: &UpdateState) -> Result<(), UpdateError> {
    let feed = cancellable(state, fresh_feed_for_app(app)).await?;
    feed.require_supported_installer()?;
    state.check_cancelled()?;
    let displayed = state
        .decision
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| fail("CHECK_REQUIRED"))?;
    require_same_feed(&displayed, &feed)?;
    let id = state
        .status()
        .request_id
        .ok_or_else(|| fail("INVALID_REQUEST"))?;
    state.change(app, |s| {
        s.request_id = Some(id.clone());
        s.target_version = Some(feed.version.clone());
    });
    std::fs::create_dir_all(&state.root)?;
    helper::require_plain_directory(&state.root)?;
    let staging = state.root.join(&id);
    std::fs::create_dir(&staging)?;
    let path = staging.join("installer.exe");
    let result = download(app, state, &feed, &path).await;
    if result.is_err() {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&staging);
        return result;
    }
    state.change(app, |s| s.phase = "verifying".into());
    Trust::for_repository(&feed.repository)?.verify_file(&path, &feed.asset.signature)?;
    require_same_feed(&feed, &cancellable(state, fresh_feed_for_app(app)).await?)?;
    state.check_cancelled()?;
    helper::require_no_other_account_process()?;
    state.change(app, |s| s.phase = "preparing".into());
    let (sender, receiver) = tokio::sync::oneshot::channel();
    *state.data_ready.lock().unwrap_or_else(|e| e.into_inner()) = Some((id.clone(), sender));
    if let Some(window) = app.get_webview_window("preference") {
        let _ = tauri_plugin_custom_window::set_webview_memory_active(&window, true);
    }
    app.emit_to(
        "preference",
        "update-prepare-data",
        serde_json::json!({"requestId":id}),
    )
    .map_err(|_| fail("RECOVERY_PREPARE_FAILED"))?;
    let ready = cancellable(state, async {
        tokio::time::timeout(Duration::from_secs(30), receiver)
            .await
            .map_err(|_| fail("RECOVERY_PREPARE_FAILED"))?
            .map_err(|_| fail("RECOVERY_PREPARE_FAILED"))
    })
    .await;
    *state.data_ready.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if !ready? {
        return Err(fail("RECOVERY_PREPARE_FAILED"));
    }
    state.check_cancelled()?;
    require_current_source(app, &feed)?;
    let request_id = crate::update_recovery::begin_update_recovery(app, &feed.version)
        .map_err(|_| fail("RECOVERY_PREPARE_FAILED"))?;
    state.change(app, |s| {
        s.phase = "preparing".into();
        s.request_id = Some(request_id.clone());
    });
    if let Err(error) = state.check_cancelled() {
        let _ = crate::update_recovery::abort_update_recovery(app, &request_id);
        return Err(error);
    }
    // The helper is fully copied, validated and READY before cancellation closes.
    if let Err(error) = helper::prepare(app, &staging, &request_id, &feed, || {
        state.cancelled.load(Ordering::SeqCst)
    }) {
        helper::cancel_prepared(&staging);
        let _ = crate::update_recovery::abort_update_recovery(app, &request_id);
        return Err(error);
    }
    if let Err(error) = require_current_source(app, &feed) {
        helper::cancel_prepared(&staging);
        let _ = crate::update_recovery::abort_update_recovery(app, &request_id);
        return Err(error);
    }
    let _commit_gate = match state.begin_commit() {
        Ok(gate) => gate,
        Err(error) => {
            helper::cancel_prepared(&staging);
            let _ = crate::update_recovery::abort_update_before_commit(app, &request_id);
            return Err(error);
        }
    };
    if let Err(error) = crate::update_recovery::mark_update_launched(app, &request_id) {
        helper::cancel_prepared(&staging);
        // No COMMIT has been sent. A failed durable data write may have reached
        // disk; abort accepts either exact pre-install phase and otherwise keeps
        // the coordinator locked for its cancellation-marker boot recovery.
        let _ = crate::update_recovery::abort_update_before_commit(app, &request_id);
        log::warn!("Update launch preparation failed: {error}");
        return Err(fail("RECOVERY_PREPARE_FAILED"));
    }
    state.installing.store(true, Ordering::SeqCst);
    state.change(app, |s| {
        s.phase = "installing".into();
        s.can_cancel = false;
    });
    match helper::commit(&staging) {
        helper::CommitOutcome::NotCommitted(error) => {
            state.installing.store(false, Ordering::SeqCst);
            helper::cancel_prepared(&staging);
            let _ = crate::update_recovery::abort_update_before_commit(app, &request_id);
            return Err(error);
        }
        helper::CommitOutcome::Ambiguous => {
            // Keep the durable transaction locked; only the helper can establish
            // whether COMMIT reached disk. Let it resume after this process exits.
            state.change(app, |s| {
                s.error_code = Some("RECOVERY_REQUIRED".into());
            });
        }
        helper::CommitOutcome::Committed => {}
    }
    state.exiting_for_install.store(true, Ordering::SeqCst);
    drop(_commit_gate);
    app.exit(0);
    Ok(())
}

async fn download(
    app: &tauri::AppHandle,
    state: &UpdateState,
    feed: &Feed,
    path: &std::path::Path,
) -> Result<(), UpdateError> {
    let mut response = cancellable(state, response(&feed.download_url(), false)).await?;
    if response
        .content_length()
        .is_some_and(|size| size != feed.asset.size)
    {
        return Err(fail("INTEGRITY_FAILED"));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await?;
    let mut hasher = Sha256::new();
    let mut count = 0u64;
    while let Some(chunk) = cancellable(state, async {
        response
            .chunk()
            .await
            .map_err(|_| fail("NETWORK_UNAVAILABLE"))
    })
    .await?
    {
        state.check_cancelled()?;
        count += chunk.len() as u64;
        if count > feed.asset.size {
            return Err(fail("INTEGRITY_FAILED"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        state.change(app, |s| s.downloaded_bytes = count);
    }
    file.flush().await?;
    file.sync_all().await?;
    state.check_cancelled()?;
    if count != feed.asset.size || format!("{:x}", hasher.finalize()) != feed.asset.sha256 {
        return Err(fail("INTEGRITY_FAILED"));
    }
    Ok(())
}

#[tauri::command]
pub fn update_cancel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateState>,
) -> Result<(), UpdateError> {
    local_window(&window)?;
    state.try_cancel()
}

#[tauri::command]
pub fn update_data_ready(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateState>,
    request_id: String,
    ready: bool,
) -> Result<(), UpdateError> {
    if window.label() != "preference" {
        return Err(fail("UNAUTHORIZED"));
    }
    let mut pending = state.data_ready.lock().unwrap_or_else(|e| e.into_inner());
    if pending.as_ref().is_none_or(|(id, _)| *id != request_id) {
        return Err(fail("INVALID_REQUEST"));
    }
    let (_, sender) = pending.take().ok_or_else(|| fail("INVALID_REQUEST"))?;
    sender.send(ready).map_err(|_| fail("INVALID_REQUEST"))
}

/// All exit paths, including the process plugin and tray, cross this barrier.
pub fn allow_exit(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<UpdateState>() else {
        return true;
    };
    let _gate = state
        .commit_gate
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if state.exiting_for_install.load(Ordering::SeqCst) {
        return true;
    }
    if state.installing.load(Ordering::SeqCst) {
        return false;
    }
    state.cancel();
    true
}

pub fn run_helper_from_args() -> bool {
    #[cfg(feature = "private-update-qa")]
    std::hint::black_box(qa::BINARY_MARKER);
    helper::run_from_args()
}
pub fn guard_program_recovery(app: &tauri::AppHandle) -> Result<(), String> {
    helper::guard_boot(app)
}

async fn cancellable<T>(
    state: &UpdateState,
    work: impl std::future::Future<Output = Result<T, UpdateError>>,
) -> Result<T, UpdateError> {
    let mut signal = state.cancel_signal.subscribe();
    state.check_cancelled()?;
    tokio::select! {
        biased;
        _ = signal.changed() => Err(fail("CANCELLED")),
        result = work => result,
    }
}

pub fn open_recovery_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("update-failure") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            app,
            "update-failure",
            tauri::WebviewUrl::App("index.html#/update-failure".into()),
        )
        .title("3D Block Pet — Update / 업데이트")
        .inner_size(640.0, 460.0)
        .min_inner_size(480.0, 300.0)
        .resizable(true)
        .center()
        .build();
    }
}

pub(crate) fn exit_for_rollback(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.try_state::<UpdateState>().ok_or("RECOVERY_REQUIRED")?;
    state.exiting_for_install.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}
