//! Display-only, fixed-source release metadata. Never downloads or runs installers.
mod cache;
mod feed;
#[cfg(test)]
mod tests;

use std::{
    cmp::Ordering,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::sync::Mutex;

use cache::Cache;
use feed::{Feed, version};

#[cfg(not(feature = "test-repository"))]
const FEED_URL: &str =
    "https://raw.githubusercontent.com/d-meloper/dmelopers-block-pet/badges/badge-data.json";
#[cfg(feature = "test-repository")]
const FEED_URL: &str =
    "https://raw.githubusercontent.com/oup030416/dmelopers-block-pet-test/badges/badge-data.json";
#[cfg(not(feature = "test-repository"))]
const PROFILE_MARKER: &str = "DMELoper_VERSION_DEFAULT_OFFICIAL";
#[cfg(feature = "test-repository")]
const PROFILE_MARKER: &str = "DMELoper_VERSION_DEFAULT_TEST";
#[cfg(not(feature = "test-repository"))]
const CACHE_DIRECTORY: &str = "program-version";
#[cfg(feature = "test-repository")]
const CACHE_DIRECTORY: &str = "program-version-test";
const MAX_BYTES: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const SUCCESS_TTL: u64 = 6 * 60 * 60;
const FAILURE_COOLDOWN: u64 = 10 * 60;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VersionStatus {
    UpToDate,
    Available,
    LocalNewer,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    CurrentVersionInvalid,
    InvalidFeed,
    StaleFeed,
    FutureFeed,
    Network,
    Timeout,
    HttpStatus,
    ResponseTooLarge,
    NoStableRelease,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersionResponse {
    pub status: VersionStatus,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub last_success_at: Option<u64>,
    pub last_attempt_at: Option<u64>,
    pub error_code: Option<ErrorCode>,
    pub from_cache: bool,
}

pub struct LatestVersionState {
    service: Arc<Service>,
}

impl LatestVersionState {
    pub fn new(app: &tauri::AppHandle) -> Self {
        std::hint::black_box(PROFILE_MARKER);
        Self {
            service: Arc::new(Service::new(
                app.package_info().version.to_string(),
                app.path()
                    .app_cache_dir()
                    .ok()
                    .map(|root| root.join(CACHE_DIRECTORY)),
                Arc::new(ReqwestTransport::new()),
                Arc::new(SystemClock),
            )),
        }
    }
}

fn authorize_window(label: &str) -> Result<(), String> {
    if label == "preference" {
        Ok(())
    } else {
        Err("LATEST_VERSION_FORBIDDEN".into())
    }
}

#[tauri::command]
pub fn latest_version_releases_url(window: tauri::WebviewWindow) -> Result<String, String> {
    authorize_window(window.label())?;
    if cfg!(feature = "channel-store") { return Err("LATEST_VERSION_DISABLED".into()); }
    Ok(format!("https://github.com/{}/releases", feed::REPOSITORY))
}

#[tauri::command]
pub async fn check_latest_version(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, LatestVersionState>,
) -> Result<LatestVersionResponse, String> {
    authorize_window(window.label())?;
    if cfg!(feature = "channel-store") { return Err("LATEST_VERSION_DISABLED".into()); }
    Ok(state.service.check().await)
}

trait Clock: Send + Sync {
    fn now(&self) -> u64;
}
struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}

type TransportFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<u8>, ErrorCode>> + Send + 'a>>;
trait Transport: Send + Sync {
    fn fetch(&self) -> TransportFuture<'_>;
}
struct ReqwestTransport {
    client: Option<reqwest::Client>,
}
impl ReqwestTransport {
    fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(REQUEST_TIMEOUT)
                .connect_timeout(REQUEST_TIMEOUT)
                .user_agent(concat!("DMelopersBlockPet/", env!("CARGO_PKG_VERSION")))
                .build()
                .inspect_err(|_| crate::diagnostics::warn("latest_version.http_client", "CLIENT_INITIALIZATION_FAILED"))
                .ok(),
        }
    }
}
impl Transport for ReqwestTransport {
    fn fetch(&self) -> TransportFuture<'_> {
        Box::pin(async {
            let client = self.client.as_ref().ok_or(ErrorCode::Network)?;
            let mut response = client
                .get(FEED_URL)
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .await
                .map_err(http_error)?;
            if response.status() != reqwest::StatusCode::OK {
                return Err(ErrorCode::HttpStatus);
            }
            if response
                .content_length()
                .is_some_and(|size| size > MAX_BYTES as u64)
            {
                return Err(ErrorCode::ResponseTooLarge);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(http_error)? {
                if chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
                    return Err(ErrorCode::ResponseTooLarge);
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        })
    }
}

fn http_error(error: reqwest::Error) -> ErrorCode {
    if error.is_timeout() {
        ErrorCode::Timeout
    } else {
        ErrorCode::Network
    }
}

struct Runtime {
    loaded: bool,
    cache: Cache,
}
struct Service {
    current_version: String,
    cache_root: Option<PathBuf>,
    transport: Arc<dyn Transport>,
    clock: Arc<dyn Clock>,
    // Holding this lock across a request coalesces callers: after it finishes,
    // queued checks reuse its fresh result or the same failure cooldown.
    runtime: Mutex<Runtime>,
}
impl Service {
    fn new(
        current_version: String,
        cache_root: Option<PathBuf>,
        transport: Arc<dyn Transport>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            current_version,
            cache_root,
            transport,
            clock,
            runtime: Mutex::new(Runtime {
                loaded: false,
                cache: Cache::empty(),
            }),
        }
    }

    async fn check(&self) -> LatestVersionResponse {
        let mut runtime = self.runtime.lock().await;
        let now = self.clock.now();
        if version(&self.current_version).is_none() {
            crate::diagnostics::warn("latest_version.check", "CURRENT_VERSION_INVALID");
            return self.response(
                &runtime.cache,
                false,
                Some(ErrorCode::CurrentVersionInvalid),
            );
        }
        if !runtime.loaded {
            if let Some(root) = self.cache_root.clone() {
                runtime.cache = tokio::task::spawn_blocking(move || cache::read(&root, now))
                    .await
                    .inspect_err(|_| crate::diagnostics::error("latest_version.cache_read_task", "TASK_FAILED"))
                    .ok()
                    .flatten()
                    .unwrap_or_else(Cache::empty);
            }
            runtime.loaded = true;
        }
        let cached = &runtime.cache;
        if cached.error_code.is_some()
            && cached
                .last_attempt_at
                .is_some_and(|attempt| now.saturating_sub(attempt) < FAILURE_COOLDOWN)
        {
            return self.response(cached, true, cached.error_code);
        }
        if cached.error_code.is_none()
            && cached
                .last_success_at
                .is_some_and(|success| now.saturating_sub(success) < SUCCESS_TTL)
            && cached
                .feed
                .as_ref()
                .is_some_and(|feed| feed.validate_fresh(now).is_ok())
        {
            return self.response(cached, true, None);
        }
        // Persist the attempt before network I/O, so cancellation/restart cannot
        // bypass the minimum retry interval. The prior verified feed stays intact.
        runtime.cache.last_attempt_at = Some(now);
        runtime.cache.error_code = Some(ErrorCode::Network);
        self.persist(&runtime.cache).await;
        let result = tokio::time::timeout(REQUEST_TIMEOUT, self.transport.fetch())
            .await
            .map_err(|_| ErrorCode::Timeout)
            .and_then(|result| result)
            .and_then(|bytes| {
                if bytes.len() > MAX_BYTES {
                    return Err(ErrorCode::ResponseTooLarge);
                }
                let feed: Feed =
                    serde_json::from_slice(&bytes).map_err(|_| ErrorCode::InvalidFeed)?;
                feed.validate_fresh(self.clock.now())?;
                Ok(feed)
            });
        match result {
            Ok(feed) => {
                runtime.cache.feed = Some(feed);
                runtime.cache.last_success_at = Some(self.clock.now());
                // Completion is the attempt time used by cooldown and cache validation.
                runtime.cache.last_attempt_at = runtime.cache.last_success_at;
                runtime.cache.error_code = None;
            }
            Err(error) => {
                crate::diagnostics::warn("latest_version.check", &format!("{error:?}"));
                runtime.cache.last_attempt_at = Some(self.clock.now());
                runtime.cache.error_code = Some(error);
            }
        }
        self.persist(&runtime.cache).await;
        self.response(&runtime.cache, false, runtime.cache.error_code)
    }

    async fn persist(&self, cache: &Cache) {
        let Some(root) = self.cache_root.clone() else {
            crate::diagnostics::warn("latest_version.cache_write", "STORAGE_UNAVAILABLE");
            return;
        };
        let cache = cache.clone();
        match tokio::task::spawn_blocking(move || cache::write(&root, &cache)).await {
            Ok(Ok(())) => {},
            Ok(Err(error)) => crate::diagnostics::warn("latest_version.cache_write", &format!("IO_{:?}_OS_{}", error.kind(), error.raw_os_error().unwrap_or(0))),
            Err(_) => crate::diagnostics::error("latest_version.cache_write_task", "TASK_FAILED"),
        }
    }

    fn response(
        &self,
        cache: &Cache,
        from_cache: bool,
        error: Option<ErrorCode>,
    ) -> LatestVersionResponse {
        let latest_version = cache
            .feed
            .as_ref()
            .and_then(|feed| feed.latest.as_ref())
            .map(|latest| latest.version.clone());
        let mut status = VersionStatus::Unknown;
        let mut error_code = error;
        if error_code.is_none() {
            error_code = cache
                .feed
                .as_ref()
                .and_then(|feed| feed.validate_fresh(self.clock.now()).err());
        }
        if error_code.is_none() {
            if let (Some(current), Some(latest)) = (
                version(&self.current_version),
                latest_version.as_deref().and_then(version),
            ) {
                status = match current.cmp(&latest) {
                    Ordering::Less => VersionStatus::Available,
                    Ordering::Equal => VersionStatus::UpToDate,
                    Ordering::Greater => VersionStatus::LocalNewer,
                };
            } else {
                error_code = Some(ErrorCode::NoStableRelease);
            }
        }
        LatestVersionResponse {
            status,
            current_version: self.current_version.clone(),
            latest_version,
            last_success_at: cache.last_success_at,
            last_attempt_at: cache.last_attempt_at,
            error_code,
            from_cache,
        }
    }
}
