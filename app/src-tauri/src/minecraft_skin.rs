use std::{
    collections::HashMap,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex, MutexGuard, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose};
use image::GenericImageView;
use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::{
    fs,
    io::AsyncWriteExt,
    sync::{Mutex as AsyncMutex, Notify},
    time::{Instant as TokioInstant, timeout},
};

const MODERN_LOOKUP_BASE: &str = "https://api.minecraftservices.com/minecraft/profile/lookup/name/";
const LEGACY_LOOKUP_BASE: &str = "https://api.mojang.com/users/profiles/minecraft/";
const SESSION_BASE: &str = "https://sessionserver.mojang.com/session/minecraft/profile/";
const TEXTURE_HOST: &str = "textures.minecraft.net";

const LOOKUP_LIMIT: usize = 64 * 1024;
const SESSION_LIMIT: usize = 512 * 1024;
const PNG_LIMIT: usize = 2 * 1024 * 1024;
const RAW_CACHE_LIMIT: u64 = 32 * 1024 * 1024;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);
static RETRY_JITTER_COUNTER: AtomicU64 = AtomicU64::new(0x9e37_79b9_7f4a_7c15);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftSkinResponse {
    pub canonical_name: String,
    pub uuid: String,
    pub model: MinecraftSkinModel,
    pub texture_key: String,
    pub png_base64: String,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
    pub cache_hit: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MinecraftSkinModel {
    Wide,
    Slim,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftSkinErrorResponse {
    pub code: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

pub struct MinecraftSkinState {
    service: Arc<MinecraftSkinService>,
}

impl MinecraftSkinState {
    pub fn new(app_handle: &tauri::AppHandle) -> Self {
        let cache_root = app_handle
            .path()
            .app_cache_dir()
            .inspect_err(|_| crate::diagnostics::warn("minecraft_skin.initialize", "CACHE_ROOT_UNAVAILABLE"))
            .ok()
            .map(|path| path.join("minecraft-skins"));
        let transport = Arc::new(ReqwestTransport::new());

        Self {
            service: Arc::new(MinecraftSkinService::new(
                transport,
                cache_root,
                ServiceConfig::production(),
            )),
        }
    }
}

#[tauri::command]
pub async fn fetch_minecraft_skin(
    username: String,
    state: tauri::State<'_, MinecraftSkinState>,
) -> Result<MinecraftSkinResponse, MinecraftSkinErrorResponse> {
    state.service.fetch(&username).await.map_err(|error| {
        let response = MinecraftSkinErrorResponse::from(error);
        crate::diagnostics::warn("minecraft_skin.fetch", &response.code);
        response
    })
}

#[derive(Clone)]
struct ServiceConfig {
    request_timeout: Duration,
    overall_timeout: Duration,
    max_attempts: usize,
    backoff_base: Duration,
    jitter_max: Duration,
    legacy_lookup_base: Option<String>,
}

impl ServiceConfig {
    fn production() -> Self {
        Self {
            request_timeout: Duration::from_secs(12),
            overall_timeout: Duration::from_secs(25),
            max_attempts: 3,
            backoff_base: Duration::from_millis(250),
            jitter_max: Duration::from_millis(150),
            legacy_lookup_base: Some(LEGACY_LOOKUP_BASE.to_owned()),
        }
    }
}

#[derive(Clone, Debug)]
struct AppError {
    kind: ErrorKind,
    retryable: bool,
    retry_after_seconds: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ErrorKind {
    InvalidUsername,
    ProfileNotFound,
    NoSkin,
    RateLimited,
    Timeout,
    Network,
    Upstream,
    ServiceBlocked,
    InvalidResponse,
    UntrustedTextureUrl,
    TooLarge,
    InvalidPng,
    InvalidDimensions,
    HashMismatch,
    Gone,
    TextureNotFound,
}

impl AppError {
    fn new(kind: ErrorKind) -> Self {
        let retryable = matches!(
            kind,
            ErrorKind::RateLimited | ErrorKind::Timeout | ErrorKind::Network | ErrorKind::Upstream
        );
        Self {
            kind,
            retryable,
            retry_after_seconds: None,
        }
    }

    fn retry_after(mut self, seconds: Option<u64>) -> Self {
        self.retry_after_seconds = seconds;
        self
    }

    fn permits_legacy_fallback(&self) -> bool {
        matches!(
            self.kind,
            ErrorKind::Timeout | ErrorKind::Network | ErrorKind::Upstream | ErrorKind::Gone
        )
    }
}

impl From<AppError> for MinecraftSkinErrorResponse {
    fn from(error: AppError) -> Self {
        let code = match error.kind {
            ErrorKind::InvalidUsername => "INVALID_USERNAME",
            ErrorKind::ProfileNotFound => "PROFILE_NOT_FOUND",
            ErrorKind::NoSkin => "NO_SKIN",
            ErrorKind::RateLimited => "RATE_LIMITED",
            ErrorKind::Timeout => "TIMEOUT",
            ErrorKind::Network => "NETWORK",
            ErrorKind::Upstream => "UPSTREAM",
            ErrorKind::ServiceBlocked => "SERVICE_BLOCKED",
            ErrorKind::UntrustedTextureUrl => "UNTRUSTED_TEXTURE_URL",
            ErrorKind::TooLarge => "TOO_LARGE",
            ErrorKind::InvalidPng => "INVALID_PNG",
            ErrorKind::InvalidDimensions => "INVALID_DIMENSIONS",
            ErrorKind::HashMismatch => "HASH_MISMATCH",
            ErrorKind::InvalidResponse | ErrorKind::Gone | ErrorKind::TextureNotFound => {
                "INVALID_RESPONSE"
            }
        };

        Self {
            code: code.to_owned(),
            retryable: error.retryable,
            retry_after_seconds: error.retry_after_seconds,
        }
    }
}

type TransportFuture<'a> =
    Pin<Box<dyn Future<Output = Result<HttpResponse, TransportFailure>> + Send + 'a>>;

trait HttpTransport: Send + Sync {
    fn get<'a>(
        &'a self,
        url: Url,
        accept: &'static str,
        request_timeout: Duration,
        max_bytes: usize,
    ) -> TransportFuture<'a>;
}

#[derive(Clone, Debug)]
struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TransportFailure {
    Timeout,
    Network,
    TooLarge,
}

struct ReqwestTransport {
    client: Option<Client>,
}

impl ReqwestTransport {
    fn new() -> Self {
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(12))
            .timeout(Duration::from_secs(12))
            .https_only(true)
            .user_agent(concat!("DMelopersBlockPet/", env!("CARGO_PKG_VERSION")))
            .build()
            .inspect_err(|_| crate::diagnostics::warn("minecraft_skin.http_client", "CLIENT_INITIALIZATION_FAILED"))
            .ok();
        Self { client }
    }
}

impl HttpTransport for ReqwestTransport {
    fn get<'a>(
        &'a self,
        url: Url,
        accept: &'static str,
        request_timeout: Duration,
        max_bytes: usize,
    ) -> TransportFuture<'a> {
        Box::pin(async move {
            let client = self.client.as_ref().ok_or(TransportFailure::Network)?;
            let mut response = client
                .get(url)
                .header(reqwest::header::ACCEPT, accept)
                .timeout(request_timeout)
                .send()
                .await
                .map_err(classify_reqwest_error)?;

            if response
                .content_length()
                .is_some_and(|length| length > max_bytes as u64)
            {
                return Err(TransportFailure::TooLarge);
            }

            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_ascii_lowercase(), value.to_owned()))
                })
                .collect();
            let mut body = Vec::with_capacity(
                response.content_length().unwrap_or(0).min(max_bytes as u64) as usize,
            );

            while let Some(chunk) = response.chunk().await.map_err(classify_reqwest_error)? {
                let next_length = body
                    .len()
                    .checked_add(chunk.len())
                    .ok_or(TransportFailure::TooLarge)?;
                if next_length > max_bytes {
                    return Err(TransportFailure::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }

            Ok(HttpResponse {
                status,
                headers,
                body,
            })
        })
    }
}

fn classify_reqwest_error(error: reqwest::Error) -> TransportFailure {
    if error.is_timeout() {
        TransportFailure::Timeout
    } else {
        TransportFailure::Network
    }
}

#[derive(Clone, Debug)]
struct LookupProfile {
    uuid: String,
    canonical_name: String,
}

#[derive(Clone, Debug)]
struct SessionSkin {
    texture_url: String,
    model: MinecraftSkinModel,
}

#[derive(Clone)]
struct TimedCacheEntry<T> {
    value: T,
    expires_at: Instant,
}

struct Flight {
    result: AsyncMutex<Option<Result<MinecraftSkinResponse, AppError>>>,
    notify: Notify,
}

impl Flight {
    fn new() -> Self {
        Self {
            result: AsyncMutex::new(None),
            notify: Notify::new(),
        }
    }

    async fn wait(&self) -> Result<MinecraftSkinResponse, AppError> {
        loop {
            let notified = self.notify.notified();
            if let Some(result) = self.result.lock().await.clone() {
                return result;
            }
            notified.await;
        }
    }
}

struct MinecraftSkinService {
    transport: Arc<dyn HttpTransport>,
    cache_root: Option<PathBuf>,
    config: ServiceConfig,
    lookup_cache: Mutex<HashMap<String, TimedCacheEntry<LookupProfile>>>,
    session_cache: Mutex<HashMap<String, TimedCacheEntry<SessionSkin>>>,
    flights: Mutex<HashMap<String, Weak<Flight>>>,
    disk_cache_lock: Arc<AsyncMutex<()>>,
    #[cfg(test)]
    cache_io_gate: Option<Arc<tests::CacheIoGate>>,
}

impl MinecraftSkinService {
    fn new(
        transport: Arc<dyn HttpTransport>,
        cache_root: Option<PathBuf>,
        config: ServiceConfig,
    ) -> Self {
        Self {
            transport,
            cache_root,
            config,
            lookup_cache: Mutex::new(HashMap::new()),
            session_cache: Mutex::new(HashMap::new()),
            flights: Mutex::new(HashMap::new()),
            disk_cache_lock: Arc::new(AsyncMutex::new(())),
            #[cfg(test)]
            cache_io_gate: None,
        }
    }

    async fn fetch(&self, username: &str) -> Result<MinecraftSkinResponse, AppError> {
        let requested_name = username.trim();
        if !is_valid_username(requested_name) {
            return Err(AppError::new(ErrorKind::InvalidUsername));
        }
        let flight_key = requested_name.to_ascii_lowercase();
        let (flight, leader) = {
            let mut flights = lock_unpoisoned(&self.flights);
            if let Some(flight) = flights.get(&flight_key).and_then(Weak::upgrade) {
                (flight, false)
            } else {
                let flight = Arc::new(Flight::new());
                flights.insert(flight_key.clone(), Arc::downgrade(&flight));
                (flight, true)
            }
        };

        if !leader {
            return flight.wait().await;
        }

        let overall_timeout = self.config.overall_timeout;
        let result = match timeout(
            overall_timeout,
            self.fetch_inner(requested_name, TokioInstant::now() + overall_timeout),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(AppError::new(ErrorKind::Timeout)),
        };
        *flight.result.lock().await = Some(result.clone());
        flight.notify.notify_waiters();

        let mut flights = lock_unpoisoned(&self.flights);
        if flights
            .get(&flight_key)
            .and_then(Weak::upgrade)
            .is_some_and(|registered| Arc::ptr_eq(&registered, &flight))
        {
            flights.remove(&flight_key);
        }

        result
    }

    async fn fetch_inner(
        &self,
        username: &str,
        deadline: TokioInstant,
    ) -> Result<MinecraftSkinResponse, AppError> {
        let profile = self.lookup_profile(username, deadline).await?;
        let mut session = self.fetch_session(&profile.uuid, false, deadline).await?;
        let mut refreshed_session = false;

        loop {
            let secured = secure_texture_url(&session.texture_url)?;
            if let Some(validated) = self.try_read_raw_cache(&secured.texture_key).await {
                return Ok(build_response(
                    &profile,
                    session.model,
                    &secured.texture_key,
                    &validated,
                    true,
                ));
            }

            match self
                .download_texture(secured.url.clone(), &secured.texture_key, deadline)
                .await
            {
                Ok(validated) => {
                    let validated = Arc::new(validated);
                    self.store_raw_cache(&secured.texture_key, &validated).await;
                    return Ok(build_response(
                        &profile,
                        session.model,
                        &secured.texture_key,
                        &validated,
                        false,
                    ));
                }
                Err(error) if error.kind == ErrorKind::TextureNotFound && !refreshed_session => {
                    refreshed_session = true;
                    session = self.fetch_session(&profile.uuid, true, deadline).await?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn lookup_profile(
        &self,
        username: &str,
        deadline: TokioInstant,
    ) -> Result<LookupProfile, AppError> {
        let cache_key = username.to_ascii_lowercase();
        if let Some(profile) = get_timed_cache(&self.lookup_cache, &cache_key) {
            return Ok(profile);
        }

        let modern_url = endpoint_with_segment(MODERN_LOOKUP_BASE, username)?;
        match self
            .lookup_profile_from_url(modern_url, &cache_key, deadline)
            .await
        {
            Ok(profile) => Ok(profile),
            Err(error) if error.permits_legacy_fallback() => {
                let Some(legacy_lookup_base) = self.config.legacy_lookup_base.as_deref() else {
                    return Err(error);
                };
                let legacy_url = endpoint_with_segment(legacy_lookup_base, username)?;
                self.lookup_profile_from_url(legacy_url, &cache_key, deadline)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    async fn lookup_profile_from_url(
        &self,
        url: Url,
        cache_key: &str,
        deadline: TokioInstant,
    ) -> Result<LookupProfile, AppError> {
        let response = self
            .request_with_retry(url, "application/json", LOOKUP_LIMIT, true, deadline)
            .await?;
        match response.status {
            200 => {}
            204 | 404 => return Err(AppError::new(ErrorKind::ProfileNotFound)),
            410 => return Err(AppError::new(ErrorKind::Gone)),
            401 | 403 | 300..=399 => return Err(AppError::new(ErrorKind::ServiceBlocked)),
            _ => return Err(AppError::new(ErrorKind::InvalidResponse)),
        }
        validate_json_content_type(&response)?;

        let payload: LookupPayload = serde_json::from_slice(&response.body)
            .map_err(|_| AppError::new(ErrorKind::InvalidResponse))?;
        let uuid =
            normalize_uuid(&payload.id).ok_or_else(|| AppError::new(ErrorKind::InvalidResponse))?;
        if !is_valid_username(&payload.name) || !payload.name.eq_ignore_ascii_case(cache_key) {
            return Err(AppError::new(ErrorKind::InvalidResponse));
        }
        let profile = LookupProfile {
            uuid,
            canonical_name: payload.name,
        };
        if let Some(lifetime) = cache_lifetime(&response.headers) {
            insert_timed_cache(
                &self.lookup_cache,
                cache_key.to_owned(),
                profile.clone(),
                lifetime,
            );
        }
        Ok(profile)
    }

    async fn fetch_session(
        &self,
        uuid: &str,
        force_refresh: bool,
        deadline: TokioInstant,
    ) -> Result<SessionSkin, AppError> {
        if force_refresh {
            // A texture 404 invalidates the cached session. A replacement that
            // cannot be cached (or fails) must not revive that obsolete URL.
            lock_unpoisoned(&self.session_cache).remove(uuid);
        } else if let Some(session) = get_timed_cache(&self.session_cache, uuid) {
            return Ok(session);
        }

        let mut url = endpoint_with_segment(SESSION_BASE, uuid)?;
        url.set_query(Some("unsigned=true"));
        let response = self
            .request_with_retry(url, "application/json", SESSION_LIMIT, false, deadline)
            .await?;
        match response.status {
            200 => {}
            204 | 404 => return Err(AppError::new(ErrorKind::ProfileNotFound)),
            401 | 403 | 300..=399 => return Err(AppError::new(ErrorKind::ServiceBlocked)),
            _ => return Err(AppError::new(ErrorKind::InvalidResponse)),
        }
        validate_json_content_type(&response)?;

        let payload: SessionPayload = serde_json::from_slice(&response.body)
            .map_err(|_| AppError::new(ErrorKind::InvalidResponse))?;
        if !payload.id.is_empty() && normalize_uuid(&payload.id).as_deref() != Some(uuid) {
            return Err(AppError::new(ErrorKind::InvalidResponse));
        }
        let property = payload
            .properties
            .iter()
            .find(|property| property.name == "textures" && !property.value.is_empty())
            .ok_or_else(|| AppError::new(ErrorKind::NoSkin))?;
        let decoded = general_purpose::STANDARD
            .decode(&property.value)
            .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(&property.value))
            .map_err(|_| AppError::new(ErrorKind::InvalidResponse))?;
        let textures: TexturesPayload = serde_json::from_slice(&decoded)
            .map_err(|_| AppError::new(ErrorKind::InvalidResponse))?;
        if let Some(payload_uuid) = textures.profile_id.as_deref() {
            if normalize_uuid(payload_uuid).as_deref() != Some(uuid) {
                return Err(AppError::new(ErrorKind::InvalidResponse));
            }
        }
        let skin = textures
            .textures
            .skin
            .ok_or_else(|| AppError::new(ErrorKind::NoSkin))?;
        if skin.url.is_empty() {
            return Err(AppError::new(ErrorKind::NoSkin));
        }
        let model = if skin
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.model.as_deref())
            == Some("slim")
        {
            MinecraftSkinModel::Slim
        } else {
            MinecraftSkinModel::Wide
        };
        let session = SessionSkin {
            texture_url: skin.url,
            model,
        };
        if let Some(lifetime) = cache_lifetime(&response.headers) {
            insert_timed_cache(
                &self.session_cache,
                uuid.to_owned(),
                session.clone(),
                lifetime,
            );
        }
        Ok(session)
    }

    async fn download_texture(
        &self,
        url: Url,
        texture_key: &str,
        deadline: TokioInstant,
    ) -> Result<ValidatedPng, AppError> {
        let response = self
            .request_with_retry(url, "image/png", PNG_LIMIT, false, deadline)
            .await?;
        match response.status {
            200 => {}
            404 => return Err(AppError::new(ErrorKind::TextureNotFound)),
            401 | 403 | 300..=399 => return Err(AppError::new(ErrorKind::ServiceBlocked)),
            _ => return Err(AppError::new(ErrorKind::InvalidResponse)),
        }
        if let Some(content_type) = response.headers.get("content-type") {
            let media_type = content_type
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if media_type != "image/png" {
                return Err(AppError::new(ErrorKind::InvalidResponse));
            }
        }
        validate_png(response.body, texture_key)
    }

    async fn request_with_retry(
        &self,
        url: Url,
        accept: &'static str,
        max_bytes: usize,
        retry_gone: bool,
        deadline: TokioInstant,
    ) -> Result<HttpResponse, AppError> {
        let attempts = self.config.max_attempts.max(1);
        let mut last_error = AppError::new(ErrorKind::Network);

        for attempt in 0..attempts {
            let remaining = deadline.saturating_duration_since(TokioInstant::now());
            if remaining.is_zero() {
                return Err(AppError::new(ErrorKind::Timeout));
            }
            let request_timeout = self.config.request_timeout.min(remaining);
            let request = self
                .transport
                .get(url.clone(), accept, request_timeout, max_bytes);
            let outcome = timeout(request_timeout, request).await;
            let response = match outcome {
                Err(_) => Err(TransportFailure::Timeout),
                Ok(result) => result,
            };

            match response {
                Ok(response) => {
                    if response.status == 429 {
                        let retry_after = retry_after(&response.headers);
                        last_error = AppError::new(ErrorKind::RateLimited)
                            .retry_after(retry_after.map(duration_to_ceil_seconds));
                        if attempt + 1 < attempts
                            && self.wait_for_retry(attempt, retry_after, deadline).await
                        {
                            continue;
                        }
                        return Err(last_error);
                    }
                    if (500..=599).contains(&response.status) {
                        let retry_after = retry_after(&response.headers);
                        last_error = AppError::new(ErrorKind::Upstream)
                            .retry_after(retry_after.map(duration_to_ceil_seconds));
                        if attempt + 1 < attempts
                            && self.wait_for_retry(attempt, retry_after, deadline).await
                        {
                            continue;
                        }
                        return Err(last_error);
                    }
                    if retry_gone && response.status == 410 {
                        last_error = AppError::new(ErrorKind::Gone);
                        if attempt + 1 < attempts
                            && self.wait_for_retry(attempt, None, deadline).await
                        {
                            continue;
                        }
                        return Err(last_error);
                    }
                    return Ok(response);
                }
                Err(TransportFailure::Timeout) => {
                    last_error = AppError::new(ErrorKind::Timeout);
                    if attempt + 1 < attempts && self.wait_for_retry(attempt, None, deadline).await
                    {
                        continue;
                    }
                    return Err(last_error);
                }
                Err(TransportFailure::Network) => {
                    last_error = AppError::new(ErrorKind::Network);
                    if attempt + 1 < attempts && self.wait_for_retry(attempt, None, deadline).await
                    {
                        continue;
                    }
                    return Err(last_error);
                }
                Err(TransportFailure::TooLarge) => {
                    return Err(AppError::new(ErrorKind::TooLarge));
                }
            }
        }

        Err(last_error)
    }

    async fn wait_for_retry(
        &self,
        attempt: usize,
        retry_after: Option<Duration>,
        deadline: TokioInstant,
    ) -> bool {
        let exponential = self
            .config
            .backoff_base
            .checked_mul(1_u32 << attempt.min(16))
            .unwrap_or(Duration::MAX);
        let jitter = retry_jitter(self.config.jitter_max);
        let delay = retry_after.unwrap_or_else(|| exponential.saturating_add(jitter));
        let remaining = deadline.saturating_duration_since(TokioInstant::now());
        if delay >= remaining {
            return false;
        }
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        true
    }

    async fn try_read_raw_cache(&self, texture_key: &str) -> Option<ValidatedPng> {
        let root = self.cache_root.clone()?;
        let texture_key = texture_key.to_owned();
        match self
            .run_cache_operation(async move { read_raw_cache(&root, &texture_key).await })
            .await
        {
            Ok(value) => value,
            Err(error) => {
                log_cache_io_warning("read task", &io::Error::other(error));
                None
            }
        }
    }

    async fn store_raw_cache(&self, texture_key: &str, validated: &Arc<ValidatedPng>) {
        let Some(root) = self.cache_root.clone() else {
            return;
        };
        let texture_key = texture_key.to_owned();
        let validated = Arc::clone(validated);
        if let Err(error) = self
            .run_cache_operation(async move {
                if let Err(error) = write_raw_atomic(&root, &texture_key, &validated.bytes).await {
                    log_cache_io_warning("write", &error);
                    return;
                }
                if let Err(error) = maintain_cache_index(
                    &root,
                    Some((
                        &texture_key,
                        validated.bytes.len() as u64,
                        &validated.sha256,
                    )),
                )
                .await
                {
                    log_cache_io_warning("update index", &error);
                }
            })
            .await
        {
            log_cache_io_warning("write task", &io::Error::other(error));
        }
    }

    async fn run_cache_operation<T: Send + 'static>(
        &self,
        operation: impl Future<Output = T> + Send + 'static,
    ) -> Result<T, tokio::task::JoinError> {
        // Cancelling a lock waiter starts no I/O. Once spawned, the task owns the
        // lock through raw/index writes and cleanup even if its caller times out.
        let guard = Arc::clone(&self.disk_cache_lock).lock_owned().await;
        #[cfg(test)]
        let gate = self.cache_io_gate.clone();
        tokio::spawn(async move {
            let _guard = guard;
            #[cfg(test)]
            if let Some(gate) = gate {
                return tests::CACHE_IO_GATE.scope(gate, operation).await;
            }
            operation.await
        })
        .await
    }
}

async fn read_raw_cache(root: &Path, texture_key: &str) -> Option<ValidatedPng> {
    let raw_path = root.join("raw").join(format!("{texture_key}.png"));
    let metadata = match fs::symlink_metadata(&raw_path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            log_cache_io_warning("read metadata", &error);
            return None;
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > PNG_LIMIT as u64
    {
        crate::diagnostics::warn("minecraft_skin.cache_read", "INVALID_CACHE_FILE");
        let _ = fs::remove_file(&raw_path).await;
        return None;
    }
    let bytes = match fs::read(&raw_path).await {
        Ok(bytes) => bytes,
        Err(error) => {
            log_cache_io_warning("read", &error);
            return None;
        }
    };
    let validated = match validate_png(bytes, texture_key) {
        Ok(validated) => validated,
        Err(error) => {
            crate::diagnostics::warn("minecraft_skin.cache_validate", &MinecraftSkinErrorResponse::from(error).code);
            let _ = fs::remove_file(&raw_path).await;
            return None;
        }
    };
    let indexed = match read_cache_index_entry(root, texture_key).await {
        Ok(Some(entry))
            if entry.size == validated.bytes.len() as u64 && entry.sha256 == validated.sha256 =>
        {
            true
        }
        Ok(_) => false,
        Err(error) => {
            log_cache_io_warning("read index", &error);
            false
        }
    };
    if !indexed {
        crate::diagnostics::warn("minecraft_skin.cache_validate", "CACHE_INDEX_MISMATCH");
        let _ = fs::remove_file(&raw_path).await;
        return None;
    }
    if let Err(error) = maintain_cache_index(
        root,
        Some((texture_key, validated.bytes.len() as u64, &validated.sha256)),
    )
    .await
    {
        log_cache_io_warning("update index", &error);
    }
    Some(validated)
}

#[derive(Deserialize)]
struct LookupPayload {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct SessionPayload {
    #[serde(default)]
    id: String,
    #[serde(default)]
    properties: Vec<SessionProperty>,
}

#[derive(Deserialize)]
struct SessionProperty {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TexturesPayload {
    #[serde(default)]
    profile_id: Option<String>,
    #[serde(default)]
    textures: TextureSet,
}

#[derive(Default, Deserialize)]
struct TextureSet {
    #[serde(rename = "SKIN", default)]
    skin: Option<SkinTexture>,
}

#[derive(Deserialize)]
struct SkinTexture {
    url: String,
    #[serde(default)]
    metadata: Option<SkinMetadata>,
}

#[derive(Deserialize)]
struct SkinMetadata {
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug)]
struct SecuredTextureUrl {
    url: Url,
    texture_key: String,
}

fn secure_texture_url(raw_url: &str) -> Result<SecuredTextureUrl, AppError> {
    let mut url = Url::parse(raw_url).map_err(|_| AppError::new(ErrorKind::UntrustedTextureUrl))?;
    let scheme = url.scheme();
    if !matches!(scheme, "http" | "https")
        || url.host_str().map(str::to_ascii_lowercase).as_deref() != Some(TEXTURE_HOST)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new(ErrorKind::UntrustedTextureUrl));
    }
    match (scheme, url.port()) {
        ("http", None | Some(80)) | ("https", None | Some(443)) => {}
        _ => return Err(AppError::new(ErrorKind::UntrustedTextureUrl)),
    }

    let path = url.path();
    let texture_key = path
        .strip_prefix("/texture/")
        .filter(|key| !key.contains('/'))
        .filter(|key| (32..=128).contains(&key.len()))
        .filter(|key| key.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| AppError::new(ErrorKind::UntrustedTextureUrl))?
        .to_ascii_lowercase();
    url.set_port(None)
        .map_err(|_| AppError::new(ErrorKind::UntrustedTextureUrl))?;
    url.set_scheme("https")
        .map_err(|_| AppError::new(ErrorKind::UntrustedTextureUrl))?;

    Ok(SecuredTextureUrl { url, texture_key })
}

#[derive(Clone, Debug)]
struct ValidatedPng {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    sha256: String,
}

fn validate_png(bytes: Vec<u8>, texture_key: &str) -> Result<ValidatedPng, AppError> {
    if bytes.len() > PNG_LIMIT {
        return Err(AppError::new(ErrorKind::TooLarge));
    }
    if bytes.len() < 24
        || bytes.get(..8) != Some(PNG_SIGNATURE)
        || bytes.get(8..12) != Some(&13_u32.to_be_bytes())
        || bytes.get(12..16) != Some(b"IHDR")
    {
        return Err(AppError::new(ErrorKind::InvalidPng));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("fixed PNG width slice"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("fixed PNG height slice"));
    if width != 64 || !matches!(height, 32 | 64) {
        return Err(AppError::new(ErrorKind::InvalidDimensions));
    }
    #[cfg(test)]
    tests::PNG_DECODE_COUNT.with(|count| count.set(count.get() + 1));
    let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|_| AppError::new(ErrorKind::InvalidPng))?;
    if decoded.dimensions() != (width, height) {
        return Err(AppError::new(ErrorKind::InvalidPng));
    }
    let sha256 = sha256_hex(&bytes);
    if texture_key.len() == 64 && texture_key != sha256 {
        return Err(AppError::new(ErrorKind::HashMismatch));
    }
    Ok(ValidatedPng {
        bytes,
        width,
        height,
        sha256,
    })
}

fn build_response(
    profile: &LookupProfile,
    model: MinecraftSkinModel,
    texture_key: &str,
    validated: &ValidatedPng,
    cache_hit: bool,
) -> MinecraftSkinResponse {
    MinecraftSkinResponse {
        canonical_name: profile.canonical_name.clone(),
        uuid: profile.uuid.clone(),
        model,
        texture_key: texture_key.to_owned(),
        png_base64: general_purpose::STANDARD.encode(&validated.bytes),
        sha256: validated.sha256.clone(),
        width: validated.width,
        height: validated.height,
        cache_hit,
    }
}

fn endpoint_with_segment(base: &str, segment: &str) -> Result<Url, AppError> {
    let mut url = Url::parse(base).map_err(|_| AppError::new(ErrorKind::InvalidResponse))?;
    url.path_segments_mut()
        .map_err(|_| AppError::new(ErrorKind::InvalidResponse))?
        .pop_if_empty()
        .push(segment);
    Ok(url)
}

fn is_valid_username(username: &str) -> bool {
    (3..=16).contains(&username.len())
        && username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn normalize_uuid(uuid: &str) -> Option<String> {
    let normalized: String = uuid.chars().filter(|character| *character != '-').collect();
    if normalized.len() == 32 && normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(normalized.to_ascii_lowercase())
    } else {
        None
    }
}

fn validate_json_content_type(response: &HttpResponse) -> Result<(), AppError> {
    let Some(content_type) = response.headers.get("content-type") else {
        return Ok(());
    };
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if media_type == "application/json" || media_type.ends_with("+json") {
        Ok(())
    } else {
        Err(AppError::new(ErrorKind::InvalidResponse))
    }
}

fn get_timed_cache<T: Clone>(
    cache: &Mutex<HashMap<String, TimedCacheEntry<T>>>,
    key: &str,
) -> Option<T> {
    let mut cache = lock_unpoisoned(cache);
    if cache
        .get(key)
        .is_some_and(|entry| entry.expires_at > Instant::now())
    {
        return cache.get(key).map(|entry| entry.value.clone());
    }
    cache.remove(key);
    None
}

fn insert_timed_cache<T>(
    cache: &Mutex<HashMap<String, TimedCacheEntry<T>>>,
    key: String,
    value: T,
    lifetime: Duration,
) {
    if lifetime.is_zero() {
        return;
    }
    if let Some(expires_at) = Instant::now().checked_add(lifetime) {
        lock_unpoisoned(cache).insert(key, TimedCacheEntry { value, expires_at });
    }
}

fn cache_lifetime(headers: &HashMap<String, String>) -> Option<Duration> {
    let cache_control = headers.get("cache-control")?;
    let mut max_age = None;
    for directive in cache_control.split(',').map(str::trim) {
        if directive.eq_ignore_ascii_case("no-store") || directive.eq_ignore_ascii_case("no-cache")
        {
            return None;
        }
        if let Some((name, value)) = directive.split_once('=') {
            if name.trim().eq_ignore_ascii_case("max-age") {
                max_age = value.trim().trim_matches('"').parse::<u64>().ok();
            }
        }
    }
    let max_age = max_age?;
    let age = headers
        .get("age")
        .and_then(|age| age.trim().parse::<u64>().ok())
        .unwrap_or(0);
    Some(Duration::from_secs(max_age.saturating_sub(age)))
}

fn retry_after(headers: &HashMap<String, String>) -> Option<Duration> {
    let value = headers.get("retry-after")?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let retry_at = httpdate::parse_http_date(value).ok()?;
    Some(
        retry_at
            .duration_since(SystemTime::now())
            .unwrap_or_default(),
    )
}

fn duration_to_ceil_seconds(duration: Duration) -> u64 {
    duration.as_secs() + u64::from(duration.subsec_nanos() > 0)
}

fn retry_jitter(max: Duration) -> Duration {
    let max_millis = max.as_millis().min(u128::from(u64::MAX)) as u64;
    if max_millis == 0 {
        return Duration::ZERO;
    }
    let mut value = RETRY_JITTER_COUNTER.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed);
    value ^= value >> 12;
    value ^= value << 25;
    value ^= value >> 27;
    Duration::from_millis(value.wrapping_mul(0x2545_f491_4f6c_dd1d) % (max_millis + 1))
}

fn sha256_hex(bytes: &[u8]) -> String {
    #[cfg(test)]
    tests::SHA256_COUNT.with(|count| count.set(count.get() + 1));
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn log_cache_io_warning(operation: &str, error: &io::Error) {
    let operation = match operation {
        "read task" => "minecraft_skin.cache_read_task",
        "write task" => "minecraft_skin.cache_write_task",
        "write" => "minecraft_skin.cache_write",
        "read metadata" => "minecraft_skin.cache_metadata",
        "read" => "minecraft_skin.cache_read",
        "read index" => "minecraft_skin.cache_index_read",
        _ => "minecraft_skin.cache_index_write",
    };
    crate::diagnostics::warn(operation, &format!("IO_{:?}_OS_{}", error.kind(), error.raw_os_error().unwrap_or(0)));
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawCacheIndex {
    #[serde(default = "cache_index_version")]
    version: u8,
    #[serde(default)]
    entries: HashMap<String, RawCacheIndexEntry>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawCacheIndexEntry {
    size: u64,
    last_used_epoch_millis: u64,
    #[serde(default)]
    sha256: String,
}

fn cache_index_version() -> u8 {
    1
}

struct TemporaryFileCleanup {
    path: PathBuf,
    armed: bool,
}

impl TemporaryFileCleanup {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TemporaryFileCleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

async fn write_raw_atomic(root: &Path, texture_key: &str, bytes: &[u8]) -> io::Result<()> {
    let raw_dir = root.join("raw");
    fs::create_dir_all(&raw_dir).await?;
    let destination = raw_dir.join(format!("{texture_key}.png"));
    let temporary = raw_dir.join(format!(".{texture_key}.{}.tmp", unique_file_suffix()));
    let mut cleanup = TemporaryFileCleanup::new(temporary.clone());
    let result = async {
        #[cfg(test)]
        tests::pause_cache_io(tests::CacheIoPhase::Raw).await;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        file.write_all(bytes).await?;
        file.sync_all().await?;
        drop(file);
        atomic_replace_path(&temporary, &destination)
    }
    .await;
    if result.is_ok() {
        cleanup.disarm();
    } else {
        match fs::remove_file(&temporary).await {
            Ok(()) => cleanup.disarm(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => cleanup.disarm(),
            Err(_) => {}
        }
    }
    result
}

async fn maintain_cache_index(root: &Path, touched: Option<(&str, u64, &str)>) -> io::Result<()> {
    let raw_dir = root.join("raw");
    fs::create_dir_all(&raw_dir).await?;
    let index_path = root.join("index.json");
    let mut index = match fs::read(&index_path).await {
        Ok(bytes) => serde_json::from_slice::<RawCacheIndex>(&bytes).unwrap_or_default(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => RawCacheIndex::default(),
        Err(error) => return Err(error),
    };
    index.version = cache_index_version();
    let now = epoch_millis();
    let mut present = HashMap::new();
    let mut directory = fs::read_dir(&raw_dir).await?;
    while let Some(entry) = directory.next_entry().await? {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.ends_with(".tmp") {
            let _ = fs::remove_file(entry.path()).await;
            continue;
        }
        let Some(key) = file_name.strip_suffix(".png") else {
            continue;
        };
        if !(32..=128).contains(&key.len())
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            continue;
        }
        let file_type = entry.file_type().await?;
        if file_type.is_file() && !file_type.is_symlink() {
            let metadata = entry.metadata().await?;
            present.insert(key.to_owned(), metadata.len());
        }
    }

    index.entries.retain(|key, _| present.contains_key(key));
    for (key, size) in present {
        let entry = index.entries.entry(key).or_insert(RawCacheIndexEntry {
            size,
            last_used_epoch_millis: 0,
            sha256: String::new(),
        });
        entry.size = size;
    }
    if let Some((key, size, sha256)) = touched {
        index.entries.insert(
            key.to_owned(),
            RawCacheIndexEntry {
                size,
                last_used_epoch_millis: now,
                sha256: sha256.to_owned(),
            },
        );
    }

    let mut total: u64 = index.entries.values().map(|entry| entry.size).sum();
    if total > RAW_CACHE_LIMIT {
        let mut oldest: Vec<_> = index
            .entries
            .iter()
            .map(|(key, entry)| (key.clone(), entry.last_used_epoch_millis, entry.size))
            .collect();
        oldest.sort_by_key(|(_, last_used, _)| *last_used);
        for (key, _, size) in oldest {
            if total <= RAW_CACHE_LIMIT {
                break;
            }
            match fs::remove_file(raw_dir.join(format!("{key}.png"))).await {
                Ok(()) => {
                    total = total.saturating_sub(size);
                    index.entries.remove(&key);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    total = total.saturating_sub(size);
                    index.entries.remove(&key);
                }
                Err(_) => {}
            }
        }
    }

    write_index_atomic(root, &index_path, &index).await
}

async fn read_cache_index_entry(
    root: &Path,
    texture_key: &str,
) -> io::Result<Option<RawCacheIndexEntry>> {
    let bytes = match fs::read(root.join("index.json")).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let index: RawCacheIndex = serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(index.entries.get(texture_key).cloned())
}

async fn write_index_atomic(
    root: &Path,
    destination: &Path,
    index: &RawCacheIndex,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(index).map_err(io::Error::other)?;
    let temporary = root.join(format!("index.json.{}.tmp", unique_file_suffix()));
    let mut cleanup = TemporaryFileCleanup::new(temporary.clone());
    let result = async {
        #[cfg(test)]
        tests::pause_cache_io(tests::CacheIoPhase::Index).await;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        atomic_replace_path(&temporary, destination)
    }
    .await;
    if result.is_ok() {
        cleanup.disarm();
    } else {
        match fs::remove_file(&temporary).await {
            Ok(()) => cleanup.disarm(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => cleanup.disarm(),
            Err(_) => {}
        }
    }
    result
}

fn unique_file_suffix() -> String {
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos}-{counter}", std::process::id())
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn atomic_replace_path(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    // Rust file I/O accepts long paths without a system-wide opt-in. Preserve
    // that support for this direct Win32 call using canonical extended paths.
    // Resolve only the destination's parent so a new file need not exist and
    // an existing destination link is replaced, never followed.
    let source = std::fs::canonicalize(source)?;
    let destination_name = destination.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "missing destination filename")
    })?;
    let destination_parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let destination = std::fs::canonicalize(destination_parent)?.join(destination_name);
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both buffers are owned, NUL-terminated UTF-16 paths and remain alive for the call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        io::Cursor,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
    use tempfile::TempDir;

    use super::*;

    const TEST_UUID: &str = "853c80ef3c3749fdaa49938b674adae6";

    thread_local! {
        pub(super) static PNG_DECODE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
        pub(super) static SHA256_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    pub(super) enum CacheIoPhase {
        Raw,
        Index,
    }

    pub(super) struct CacheIoGate {
        phase: CacheIoPhase,
        entered: std::sync::atomic::AtomicBool,
        reached: Notify,
        receiver: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
        panic_on_release: bool,
    }

    tokio::task_local! {
        pub(super) static CACHE_IO_GATE: Arc<CacheIoGate>;
    }

    impl CacheIoGate {
        fn new(
            phase: CacheIoPhase,
            panic_on_release: bool,
        ) -> (Arc<Self>, std::sync::mpsc::Sender<()>) {
            let (sender, receiver) = std::sync::mpsc::channel();
            (
                Arc::new(Self {
                    phase,
                    entered: std::sync::atomic::AtomicBool::new(false),
                    reached: Notify::new(),
                    receiver: Mutex::new(Some(receiver)),
                    panic_on_release,
                }),
                sender,
            )
        }
    }

    pub(super) async fn pause_cache_io(phase: CacheIoPhase) {
        let Ok(gate) = CACHE_IO_GATE.try_with(Arc::clone) else {
            return;
        };
        if gate.phase != phase || gate.entered.swap(true, Ordering::SeqCst) {
            return;
        }
        let receiver = lock_unpoisoned(&gate.receiver).take().unwrap();
        let reached = Arc::clone(&gate);
        // Dropping the test's sender also releases this worker after an assertion
        // failure; the worker never owns its own release signal.
        tokio::task::spawn_blocking(move || {
            reached.reached.notify_one();
            let _ = receiver.recv();
        })
        .await
        .unwrap();
        assert!(!gate.panic_on_release, "controlled cache worker failure");
    }

    fn assert_no_cache_temporaries(root: &Path) {
        for directory in [root.to_path_buf(), root.join("raw")] {
            if directory.is_dir() {
                for entry in std::fs::read_dir(directory).unwrap() {
                    assert!(
                        !entry
                            .unwrap()
                            .file_name()
                            .to_string_lossy()
                            .ends_with(".tmp")
                    );
                }
            }
        }
    }

    #[derive(Clone)]
    enum FakeOutcome {
        Response(HttpResponse),
        Failure(TransportFailure),
        Delayed(Duration, HttpResponse),
    }

    struct FakeTransport {
        outcomes: AsyncMutex<VecDeque<FakeOutcome>>,
        calls: Mutex<Vec<String>>,
        count: AtomicUsize,
    }

    impl FakeTransport {
        fn new(outcomes: Vec<FakeOutcome>) -> Arc<Self> {
            Arc::new(Self {
                outcomes: AsyncMutex::new(outcomes.into()),
                calls: Mutex::new(Vec::new()),
                count: AtomicUsize::new(0),
            })
        }

        fn call_count(&self) -> usize {
            self.count.load(Ordering::SeqCst)
        }

        fn called_urls(&self) -> Vec<String> {
            lock_unpoisoned(&self.calls).clone()
        }
    }

    impl HttpTransport for FakeTransport {
        fn get<'a>(
            &'a self,
            url: Url,
            _accept: &'static str,
            _request_timeout: Duration,
            max_bytes: usize,
        ) -> TransportFuture<'a> {
            Box::pin(async move {
                self.count.fetch_add(1, Ordering::SeqCst);
                lock_unpoisoned(&self.calls).push(url.to_string());
                let outcome = self
                    .outcomes
                    .lock()
                    .await
                    .pop_front()
                    .expect("fake transport outcome");
                let response = match outcome {
                    FakeOutcome::Response(response) => response,
                    FakeOutcome::Failure(failure) => return Err(failure),
                    FakeOutcome::Delayed(delay, response) => {
                        tokio::time::sleep(delay).await;
                        response
                    }
                };
                if response.body.len() > max_bytes {
                    Err(TransportFailure::TooLarge)
                } else {
                    Ok(response)
                }
            })
        }
    }

    fn test_config() -> ServiceConfig {
        ServiceConfig {
            request_timeout: Duration::from_millis(250),
            overall_timeout: Duration::from_secs(2),
            max_attempts: 3,
            backoff_base: Duration::ZERO,
            jitter_max: Duration::ZERO,
            legacy_lookup_base: Some(LEGACY_LOOKUP_BASE.to_owned()),
        }
    }

    fn service(
        transport: Arc<dyn HttpTransport>,
        cache_root: Option<PathBuf>,
    ) -> MinecraftSkinService {
        MinecraftSkinService::new(transport, cache_root, test_config())
    }

    fn response(status: u16, content_type: Option<&str>, body: Vec<u8>) -> HttpResponse {
        let mut headers = HashMap::new();
        if let Some(content_type) = content_type {
            headers.insert("content-type".to_owned(), content_type.to_owned());
        }
        HttpResponse {
            status,
            headers,
            body,
        }
    }

    fn json_response(status: u16, value: serde_json::Value) -> HttpResponse {
        response(
            status,
            Some("application/json; charset=utf-8"),
            serde_json::to_vec(&value).unwrap(),
        )
    }

    fn with_cache_control(mut response: HttpResponse, value: &str) -> HttpResponse {
        response
            .headers
            .insert("cache-control".to_owned(), value.to_owned());
        response
    }

    fn lookup_response() -> HttpResponse {
        json_response(200, serde_json::json!({ "id": TEST_UUID, "name": "jeb_" }))
    }

    fn session_response(texture_url: &str, model: Option<&str>) -> HttpResponse {
        let skin = match model {
            Some(model) => serde_json::json!({
                "url": texture_url,
                "metadata": { "model": model }
            }),
            None => serde_json::json!({ "url": texture_url }),
        };
        let textures = serde_json::json!({
            "profileId": TEST_UUID,
            "profileName": "jeb_",
            "textures": { "SKIN": skin }
        });
        let encoded = general_purpose::STANDARD.encode(serde_json::to_vec(&textures).unwrap());
        json_response(
            200,
            serde_json::json!({
                "id": TEST_UUID,
                "name": "jeb_",
                "properties": [{ "name": "textures", "value": encoded }]
            }),
        )
    }

    fn png_response(bytes: Vec<u8>) -> HttpResponse {
        response(200, Some("image/png"), bytes)
    }

    fn make_png(width: u32, height: u32) -> Vec<u8> {
        let image = ImageBuffer::from_fn(width, height, |x, y| {
            Rgba([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8, 255])
        });
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut output, ImageFormat::Png)
            .unwrap();
        output.into_inner()
    }

    fn success_outcomes(
        png: &[u8],
        model: Option<&str>,
        cache_control: Option<&str>,
    ) -> (String, Vec<FakeOutcome>) {
        let key = sha256_hex(png);
        let texture_url = format!("http://textures.minecraft.net/texture/{key}");
        let mut lookup = lookup_response();
        let mut session = session_response(&texture_url, model);
        if let Some(cache_control) = cache_control {
            lookup = with_cache_control(lookup, cache_control);
            session = with_cache_control(session, cache_control);
        }
        (
            key,
            vec![
                FakeOutcome::Response(lookup),
                FakeOutcome::Response(session),
                FakeOutcome::Response(png_response(png.to_vec())),
            ],
        )
    }

    fn assert_public_code(error: AppError, expected: &str) {
        let public: MinecraftSkinErrorResponse = error.into();
        assert_eq!(public.code, expected);
    }

    #[test]
    fn validates_java_usernames_and_uuids() {
        for username in ["abc", "Jeb_", "a_b_123", "abcdefghijklmnop"] {
            assert!(is_valid_username(username), "{username}");
        }
        for username in ["", "ab", "abcdefghijklmnopq", "space name", "한글", "a-b"] {
            assert!(!is_valid_username(username), "{username}");
        }
        assert_eq!(
            normalize_uuid("853c80ef-3c37-49fd-aa49-938b674adae6").as_deref(),
            Some(TEST_UUID)
        );
        assert!(normalize_uuid("not-a-uuid").is_none());
        assert_eq!(
            endpoint_with_segment(MODERN_LOOKUP_BASE, "jeb_")
                .unwrap()
                .as_str(),
            "https://api.minecraftservices.com/minecraft/profile/lookup/name/jeb_"
        );
        assert_eq!(
            endpoint_with_segment(SESSION_BASE, TEST_UUID)
                .unwrap()
                .as_str(),
            format!("https://sessionserver.mojang.com/session/minecraft/profile/{TEST_UUID}")
        );
    }

    #[tokio::test]
    async fn resolves_canonical_name_uuid_slim_model_and_png() {
        let png = make_png(64, 64);
        let (key, outcomes) = success_outcomes(&png, Some("slim"), None);
        let transport = FakeTransport::new(outcomes);
        let result = service(transport.clone(), None)
            .fetch("  JEB_ ")
            .await
            .unwrap();

        assert_eq!(result.canonical_name, "jeb_");
        assert_eq!(result.uuid, TEST_UUID);
        assert_eq!(result.model, MinecraftSkinModel::Slim);
        assert_eq!(result.texture_key, key);
        assert_eq!(result.sha256, sha256_hex(&png));
        assert_eq!((result.width, result.height), (64, 64));
        assert_eq!(
            general_purpose::STANDARD.decode(result.png_base64).unwrap(),
            png
        );
        assert!(!result.cache_hit);
        assert_eq!(transport.call_count(), 3);
        assert!(transport.called_urls()[2].starts_with("https://textures.minecraft.net/"));
    }

    #[tokio::test]
    async fn metadata_absence_defaults_to_wide_and_legacy_png_is_accepted() {
        let png = make_png(64, 32);
        let (_, outcomes) = success_outcomes(&png, None, None);
        let result = service(FakeTransport::new(outcomes), None)
            .fetch("jeb_")
            .await
            .unwrap();
        assert_eq!(result.model, MinecraftSkinModel::Wide);
        assert_eq!((result.width, result.height), (64, 32));
    }

    #[tokio::test]
    async fn rejects_missing_skin_and_texture_payload_uuid_mismatch() {
        let missing_textures = general_purpose::STANDARD.encode(
            serde_json::to_vec(&serde_json::json!({
                "profileId": TEST_UUID
            }))
            .unwrap(),
        );
        let no_skin = FakeTransport::new(vec![
            FakeOutcome::Response(lookup_response()),
            FakeOutcome::Response(json_response(
                200,
                serde_json::json!({
                    "id": TEST_UUID,
                    "properties": [{ "name": "textures", "value": missing_textures }]
                }),
            )),
        ]);
        assert_public_code(
            service(no_skin, None).fetch("jeb_").await.unwrap_err(),
            "NO_SKIN",
        );

        let mismatch = general_purpose::STANDARD.encode(
            serde_json::to_vec(&serde_json::json!({
                "profileId": "00000000000000000000000000000000",
                "textures": { "SKIN": { "url": "https://textures.minecraft.net/texture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }
            }))
            .unwrap(),
        );
        let mismatch_transport = FakeTransport::new(vec![
            FakeOutcome::Response(lookup_response()),
            FakeOutcome::Response(json_response(
                200,
                serde_json::json!({
                    "id": TEST_UUID,
                    "properties": [{ "name": "textures", "value": mismatch }]
                }),
            )),
        ]);
        assert_public_code(
            service(mismatch_transport, None)
                .fetch("jeb_")
                .await
                .unwrap_err(),
            "INVALID_RESPONSE",
        );
    }

    #[test]
    fn secures_texture_urls_and_rejects_url_attacks() {
        let key = "a".repeat(64);
        let secured =
            secure_texture_url(&format!("http://textures.minecraft.net:80/texture/{key}")).unwrap();
        assert_eq!(secured.url.scheme(), "https");
        assert_eq!(secured.url.port(), None);
        assert_eq!(secured.texture_key, key);

        let rejected = [
            format!("https://example.com/texture/{key}"),
            format!("https://textures.minecraft.net.evil.test/texture/{key}"),
            format!("https://user@textures.minecraft.net/texture/{key}"),
            format!("https://textures.minecraft.net:444/texture/{key}"),
            format!("https://textures.minecraft.net/texture/{key}?download=1"),
            format!("https://textures.minecraft.net/texture/{key}#fragment"),
            format!("https://textures.minecraft.net/other/{key}"),
            "https://textures.minecraft.net/texture/not-hex".to_owned(),
            format!("file://textures.minecraft.net/texture/{key}"),
        ];
        for url in rejected {
            assert_public_code(
                secure_texture_url(&url).unwrap_err(),
                "UNTRUSTED_TEXTURE_URL",
            );
        }
    }

    #[test]
    fn validates_png_structure_dimensions_decode_and_hash() {
        let png = make_png(64, 64);
        let key = sha256_hex(&png);
        assert_eq!(validate_png(png.clone(), &key).unwrap().width, 64);

        let mut bad_signature = png.clone();
        bad_signature[0] = 0;
        assert_public_code(
            validate_png(bad_signature, &key).unwrap_err(),
            "INVALID_PNG",
        );

        let wrong_dimensions = make_png(32, 64);
        assert_public_code(
            validate_png(wrong_dimensions.clone(), &sha256_hex(&wrong_dimensions)).unwrap_err(),
            "INVALID_DIMENSIONS",
        );

        let mut corrupt = png.clone();
        let index = corrupt.len() / 2;
        corrupt[index] ^= 0xff;
        assert_public_code(
            validate_png(corrupt.clone(), &sha256_hex(&corrupt)).unwrap_err(),
            "INVALID_PNG",
        );

        assert_public_code(
            validate_png(png, &"0".repeat(64)).unwrap_err(),
            "HASH_MISMATCH",
        );
    }

    #[tokio::test]
    async fn profile_404_is_not_retried_or_fallen_back() {
        let transport = FakeTransport::new(vec![FakeOutcome::Response(response(
            404,
            Some("application/json"),
            Vec::new(),
        ))]);
        assert_public_code(
            service(transport.clone(), None)
                .fetch("missing")
                .await
                .unwrap_err(),
            "PROFILE_NOT_FOUND",
        );
        assert_eq!(transport.call_count(), 1);
        assert!(transport.called_urls()[0].contains("api.minecraftservices.com"));
    }

    #[tokio::test]
    async fn redirects_are_never_followed() {
        let mut redirect = response(302, None, Vec::new());
        redirect.headers.insert(
            "location".to_owned(),
            "https://example.com/not-allowed".to_owned(),
        );
        let transport = FakeTransport::new(vec![FakeOutcome::Response(redirect)]);
        assert_public_code(
            service(transport.clone(), None)
                .fetch("jeb_")
                .await
                .unwrap_err(),
            "SERVICE_BLOCKED",
        );
        assert_eq!(transport.call_count(), 1);
    }

    #[tokio::test]
    async fn rate_limit_and_server_failures_retry_but_rate_limit_does_not_fallback() {
        let mut limited = response(429, None, Vec::new());
        limited
            .headers
            .insert("retry-after".to_owned(), "0".to_owned());
        let transport = FakeTransport::new(vec![
            FakeOutcome::Response(limited.clone()),
            FakeOutcome::Response(limited.clone()),
            FakeOutcome::Response(limited),
        ]);
        let error = service(transport.clone(), None)
            .fetch("jeb_")
            .await
            .unwrap_err();
        let public: MinecraftSkinErrorResponse = error.into();
        assert_eq!(public.code, "RATE_LIMITED");
        assert_eq!(public.retry_after_seconds, Some(0));
        assert_eq!(transport.call_count(), 3);
        assert!(
            transport
                .called_urls()
                .iter()
                .all(|url| url.contains("api.minecraftservices.com"))
        );

        let mut unavailable = response(503, None, Vec::new());
        unavailable
            .headers
            .insert("retry-after".to_owned(), "0".to_owned());
        let session_transport = FakeTransport::new(vec![
            FakeOutcome::Response(lookup_response()),
            FakeOutcome::Response(unavailable.clone()),
            FakeOutcome::Response(unavailable.clone()),
            FakeOutcome::Response(unavailable),
        ]);
        let public: MinecraftSkinErrorResponse = service(session_transport.clone(), None)
            .fetch("jeb_")
            .await
            .unwrap_err()
            .into();
        assert_eq!(public.code, "UPSTREAM");
        assert_eq!(public.retry_after_seconds, Some(0));
        assert_eq!(session_transport.call_count(), 4);
    }

    #[tokio::test]
    async fn transient_modern_failure_uses_legacy_after_bounded_retries() {
        let png = make_png(64, 64);
        let key = sha256_hex(&png);
        let transport = FakeTransport::new(vec![
            FakeOutcome::Response(response(503, None, Vec::new())),
            FakeOutcome::Response(response(503, None, Vec::new())),
            FakeOutcome::Response(response(503, None, Vec::new())),
            FakeOutcome::Response(lookup_response()),
            FakeOutcome::Response(session_response(
                &format!("https://textures.minecraft.net/texture/{key}"),
                None,
            )),
            FakeOutcome::Response(png_response(png)),
        ]);
        service(transport.clone(), None)
            .fetch("jeb_")
            .await
            .unwrap();
        let urls = transport.called_urls();
        assert_eq!(urls.len(), 6);
        assert!(urls[0].contains("api.minecraftservices.com"));
        assert!(urls[3].contains("api.mojang.com"));
    }

    #[tokio::test]
    async fn gone_response_is_bounded_before_legacy_and_adapter_can_be_disabled() {
        let gone = || FakeOutcome::Response(response(410, None, Vec::new()));
        let transport = FakeTransport::new(vec![
            gone(),
            gone(),
            gone(),
            FakeOutcome::Response(response(404, None, Vec::new())),
        ]);
        assert_public_code(
            service(transport.clone(), None)
                .fetch("missing")
                .await
                .unwrap_err(),
            "PROFILE_NOT_FOUND",
        );
        assert_eq!(transport.call_count(), 4);
        assert!(transport.called_urls()[3].contains("api.mojang.com"));

        let disabled = FakeTransport::new(vec![gone(), gone(), gone()]);
        let mut config = test_config();
        config.legacy_lookup_base = None;
        let error = MinecraftSkinService::new(disabled.clone(), None, config)
            .fetch("jeb_")
            .await
            .unwrap_err();
        assert_public_code(error, "INVALID_RESPONSE");
        assert_eq!(disabled.call_count(), 3);
    }

    #[tokio::test]
    async fn malformed_modern_payload_never_falls_back() {
        let transport = FakeTransport::new(vec![FakeOutcome::Response(response(
            200,
            Some("application/json"),
            b"not json".to_vec(),
        ))]);
        assert_public_code(
            service(transport.clone(), None)
                .fetch("jeb_")
                .await
                .unwrap_err(),
            "INVALID_RESPONSE",
        );
        assert_eq!(transport.call_count(), 1);
    }

    #[tokio::test]
    async fn texture_404_forces_exactly_one_session_refresh() {
        let png = make_png(64, 64);
        let old_key = "a".repeat(32);
        let new_key = "b".repeat(32);
        let transport = FakeTransport::new(vec![
            FakeOutcome::Response(lookup_response()),
            FakeOutcome::Response(with_cache_control(
                session_response(
                    &format!("https://textures.minecraft.net/texture/{old_key}"),
                    None,
                ),
                "max-age=600",
            )),
            FakeOutcome::Response(response(404, None, Vec::new())),
            FakeOutcome::Response(session_response(
                &format!("https://textures.minecraft.net/texture/{new_key}"),
                Some("slim"),
            )),
            FakeOutcome::Response(png_response(png)),
        ]);
        let result = service(transport.clone(), None)
            .fetch("jeb_")
            .await
            .unwrap();
        assert_eq!(result.texture_key, new_key);
        assert_eq!(result.model, MinecraftSkinModel::Slim);
        assert_eq!(transport.call_count(), 5);
        assert_eq!(
            transport
                .called_urls()
                .iter()
                .filter(|url| url.contains("sessionserver.mojang.com"))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn refreshed_uncacheable_session_does_not_restore_a_deleted_texture_on_reapply() {
        for policy in [None, Some("no-store"), Some("no-cache"), Some("max-age=0")] {
            let png = make_png(64, 64);
            let old_url = format!("https://textures.minecraft.net/texture/{}", "a".repeat(32));
            let new_key = sha256_hex(&png);
            let new_url = format!("https://textures.minecraft.net/texture/{new_key}");
            let mut refreshed = session_response(&new_url, Some("slim"));
            if let Some(policy) = policy {
                refreshed = with_cache_control(refreshed, policy);
            }
            let transport = FakeTransport::new(vec![
                FakeOutcome::Response(with_cache_control(lookup_response(), "max-age=600")),
                FakeOutcome::Response(with_cache_control(
                    session_response(&old_url, None),
                    "max-age=600",
                )),
                FakeOutcome::Response(response(404, None, Vec::new())),
                FakeOutcome::Response(refreshed.clone()),
                FakeOutcome::Response(png_response(png.clone())),
                FakeOutcome::Response(refreshed),
                FakeOutcome::Response(png_response(png)),
            ]);
            let service = service(transport.clone(), None);
            let first = service.fetch("jeb_").await.unwrap();
            assert_eq!(first.texture_key, new_key);
            let reapplied = service.fetch("jeb_").await.unwrap();
            assert_eq!(reapplied.texture_key, new_key);
            assert_eq!(reapplied.model, MinecraftSkinModel::Slim);
            assert_eq!(transport.call_count(), 7);
            assert_eq!(
                transport
                    .called_urls()
                    .iter()
                    .filter(|url| **url == old_url)
                    .count(),
                1
            );
        }
    }

    #[tokio::test]
    async fn duplicate_concurrent_names_share_one_in_flight_request() {
        let png = make_png(64, 64);
        let (key, mut outcomes) = success_outcomes(&png, None, None);
        let lookup = match outcomes.remove(0) {
            FakeOutcome::Response(response) => response,
            _ => unreachable!(),
        };
        outcomes.insert(0, FakeOutcome::Delayed(Duration::from_millis(30), lookup));
        let transport = FakeTransport::new(outcomes);
        let service = Arc::new(service(transport.clone(), None));

        let first = {
            let service = Arc::clone(&service);
            tokio::spawn(async move { service.fetch("JEB_").await })
        };
        tokio::task::yield_now().await;
        let second = {
            let service = Arc::clone(&service);
            tokio::spawn(async move { service.fetch("jeb_").await })
        };
        let first = first.await.unwrap().unwrap();
        let second = second.await.unwrap().unwrap();

        assert_eq!(first.texture_key, key);
        assert_eq!(first, second);
        assert_eq!(transport.call_count(), 3);
    }

    #[tokio::test]
    async fn cache_control_and_valid_raw_cache_avoid_repeat_network_calls() {
        let temp = TempDir::new().unwrap();
        let png = make_png(64, 64);
        let (_, outcomes) = success_outcomes(&png, None, Some("public, max-age=600"));
        let transport = FakeTransport::new(outcomes);
        let service = service(transport.clone(), Some(temp.path().join("minecraft-skins")));

        PNG_DECODE_COUNT.set(0);
        SHA256_COUNT.set(0);
        let first = service.fetch("jeb_").await.unwrap();
        assert_eq!(PNG_DECODE_COUNT.get(), 1);
        assert_eq!(SHA256_COUNT.get(), 1);
        PNG_DECODE_COUNT.set(0);
        SHA256_COUNT.set(0);
        let second = service.fetch("JEB_").await.unwrap();
        assert_eq!(PNG_DECODE_COUNT.get(), 1);
        assert_eq!(SHA256_COUNT.get(), 1);
        assert!(!first.cache_hit);
        assert!(second.cache_hit);
        assert_eq!(
            MinecraftSkinResponse {
                cache_hit: false,
                ..second
            },
            first
        );
        assert_eq!(transport.call_count(), 3);
    }

    #[tokio::test]
    async fn no_store_prevents_json_caching_while_raw_texture_remains_content_addressed() {
        let temp = TempDir::new().unwrap();
        let png = make_png(64, 64);
        let key = sha256_hex(&png);
        let url = format!("https://textures.minecraft.net/texture/{key}");
        let transport = FakeTransport::new(vec![
            FakeOutcome::Response(with_cache_control(lookup_response(), "no-store")),
            FakeOutcome::Response(with_cache_control(session_response(&url, None), "no-store")),
            FakeOutcome::Response(png_response(png)),
            FakeOutcome::Response(with_cache_control(lookup_response(), "no-store")),
            FakeOutcome::Response(with_cache_control(session_response(&url, None), "no-store")),
        ]);
        let service = service(transport.clone(), Some(temp.path().join("minecraft-skins")));
        service.fetch("jeb_").await.unwrap();
        let second = service.fetch("jeb_").await.unwrap();
        assert!(second.cache_hit);
        assert_eq!(transport.call_count(), 5);
    }

    #[tokio::test]
    async fn corrupt_cache_is_removed_and_recovered_from_verified_network_bytes() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("minecraft-skins");
        let png = make_png(64, 64);
        let (key, outcomes) = success_outcomes(&png, None, Some("max-age=600"));
        let raw_dir = root.join("raw");
        fs::create_dir_all(&raw_dir).await.unwrap();
        fs::write(raw_dir.join(format!("{key}.png")), b"corrupt")
            .await
            .unwrap();
        let transport = FakeTransport::new(outcomes);
        let service = service(transport.clone(), Some(root.clone()));

        let result = service.fetch("jeb_").await.unwrap();
        assert!(!result.cache_hit);
        assert_eq!(
            fs::read(raw_dir.join(format!("{key}.png"))).await.unwrap(),
            png
        );
        assert_eq!(transport.call_count(), 3);
        let temp_files = std::fs::read_dir(raw_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temp_files, 0);
    }

    #[tokio::test]
    async fn non_64_key_cache_requires_matching_index_hash_or_redownloads() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("minecraft-skins");
        let raw = root.join("raw");
        fs::create_dir_all(&raw).await.unwrap();
        let key = "c".repeat(32);
        let png = make_png(64, 64);
        fs::write(raw.join(format!("{key}.png")), &png)
            .await
            .unwrap();

        let make_transport = || {
            FakeTransport::new(vec![
                FakeOutcome::Response(lookup_response()),
                FakeOutcome::Response(session_response(
                    &format!("https://textures.minecraft.net/texture/{key}"),
                    None,
                )),
                FakeOutcome::Response(png_response(png.clone())),
            ])
        };
        let first_transport = make_transport();
        let first = service(first_transport.clone(), Some(root.clone()))
            .fetch("jeb_")
            .await
            .unwrap();
        assert!(
            !first.cache_hit,
            "an unindexed raw file must be a cache miss"
        );
        assert_eq!(first_transport.call_count(), 3);

        let index_path = root.join("index.json");
        let mut index: RawCacheIndex =
            serde_json::from_slice(&fs::read(&index_path).await.unwrap()).unwrap();
        index.entries.get_mut(&key).unwrap().sha256 = "0".repeat(64);
        fs::write(&index_path, serde_json::to_vec(&index).unwrap())
            .await
            .unwrap();

        let second_transport = make_transport();
        let second = service(second_transport.clone(), Some(root.clone()))
            .fetch("jeb_")
            .await
            .unwrap();
        assert!(!second.cache_hit, "an index hash mismatch must redownload");
        assert_eq!(second_transport.call_count(), 3);
        let repaired: RawCacheIndex =
            serde_json::from_slice(&fs::read(index_path).await.unwrap()).unwrap();
        assert_eq!(repaired.entries[&key].sha256, sha256_hex(&png));
    }

    #[tokio::test]
    async fn cache_failures_do_not_block_applying_network_skin() {
        let temp = TempDir::new().unwrap();
        let unusable_root = temp.path().join("not-a-directory");
        fs::write(&unusable_root, b"file").await.unwrap();
        let png = make_png(64, 64);
        let (_, outcomes) = success_outcomes(&png, None, None);
        let result = service(FakeTransport::new(outcomes), Some(unusable_root))
            .fetch("jeb_")
            .await
            .unwrap();
        assert!(!result.cache_hit);
    }

    #[tokio::test]
    async fn unicode_long_paths_preserve_verified_raw_cache_and_index() {
        use std::os::windows::ffi::OsStrExt;

        let temp = TempDir::new().unwrap();
        let mut root = temp.path().join("OneDrive - 테스트 [팀] & # % ' 😶");
        for _ in 0..12 {
            root = root.join("긴 경로 폴더 (공백) 특수문자 & # 😶");
        }
        assert!(root.as_os_str().encode_wide().count() > 260);
        let bytes = make_png(64, 64);
        let key = sha256_hex(&bytes);
        write_raw_atomic(&root, &key, &bytes).await.unwrap();
        maintain_cache_index(&root, Some((&key, bytes.len() as u64, &key)))
            .await
            .unwrap();
        let restored = read_raw_cache(&root, &key).await.unwrap();
        assert_eq!(restored.bytes, bytes);
        assert_eq!(restored.sha256, key);
        assert_no_cache_temporaries(&root);
    }

    #[tokio::test]
    async fn cache_prunes_oldest_files_to_32_mib_and_cleans_temporary_files() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("minecraft-skins");
        let raw = root.join("raw");
        fs::create_dir_all(&raw).await.unwrap();
        for index in 0..34_u8 {
            let key = format!("{index:032x}");
            let file = fs::File::create(raw.join(format!("{key}.png")))
                .await
                .unwrap();
            file.set_len(1024 * 1024).await.unwrap();
        }
        fs::write(raw.join(".abandoned.tmp"), b"partial")
            .await
            .unwrap();

        maintain_cache_index(&root, None).await.unwrap();
        let index: RawCacheIndex =
            serde_json::from_slice(&fs::read(root.join("index.json")).await.unwrap()).unwrap();
        let total: u64 = index.entries.values().map(|entry| entry.size).sum();
        assert!(total <= RAW_CACHE_LIMIT);
        assert!(index.entries.len() <= 32);
        assert!(!raw.join(".abandoned.tmp").exists());
    }

    #[tokio::test]
    async fn timed_out_raw_and_index_transactions_finish_before_following_cache_operations() {
        assert_eq!(
            ServiceConfig::production().overall_timeout,
            Duration::from_secs(25)
        );
        for phase in [CacheIoPhase::Raw, CacheIoPhase::Index] {
            let temp = TempDir::new().unwrap();
            let root = temp.path().join("minecraft-skins");
            let png = make_png(64, 64);
            let (key, outcomes) = success_outcomes(&png, None, Some("max-age=600"));
            let transport = FakeTransport::new(outcomes);
            let (gate, release) = CacheIoGate::new(phase, false);
            let mut configured = service(transport.clone(), Some(root.clone()));
            configured.cache_io_gate = Some(Arc::clone(&gate));
            let service = Arc::new(configured);
            let leader_service = Arc::clone(&service);
            let leader = tokio::spawn(async move { leader_service.fetch("jeb_").await });
            timeout(Duration::from_secs(5), gate.reached.notified())
                .await
                .unwrap();
            let duplicate_service = Arc::clone(&service);
            let duplicate = tokio::spawn(async move { duplicate_service.fetch("JEB_").await });
            tokio::task::yield_now().await;

            // The real service deadline still replies while its disk worker is blocked.
            let leader_error = timeout(Duration::from_secs(5), leader)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            let duplicate_error = timeout(Duration::from_secs(5), duplicate)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert_public_code(leader_error, "TIMEOUT");
            assert_public_code(duplicate_error, "TIMEOUT");
            assert!(service.disk_cache_lock.try_lock().is_err());
            assert_eq!(
                root.join("raw").join(format!("{key}.png")).exists(),
                phase == CacheIoPhase::Index
            );

            let following_service = Arc::clone(&service);
            let following_key = key.clone();
            let following =
                tokio::spawn(
                    async move { following_service.try_read_raw_cache(&following_key).await },
                );
            tokio::task::yield_now().await;
            assert!(
                !following.is_finished(),
                "the next read must not prune an in-progress transaction"
            );
            release.send(()).unwrap();
            let restored = timeout(Duration::from_secs(5), following)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(restored.bytes, png);
            assert_eq!(restored.sha256, key);
            let index = read_cache_index_entry(&root, &key).await.unwrap().unwrap();
            assert_eq!(index.sha256, key);
            assert_eq!(index.size, png.len() as u64);
            assert_no_cache_temporaries(&root);
            let recovered = service.fetch("jeb_").await.unwrap();
            assert!(recovered.cache_hit);
            assert_eq!(
                general_purpose::STANDARD
                    .decode(recovered.png_base64)
                    .unwrap(),
                png
            );
            assert_eq!(transport.call_count(), 3);
        }
    }

    #[tokio::test]
    async fn cancelling_a_cache_lock_waiter_starts_no_disk_transaction() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("minecraft-skins");
        let (gate, _release) = CacheIoGate::new(CacheIoPhase::Raw, false);
        let mut service = service(FakeTransport::new(vec![]), Some(root.clone()));
        service.cache_io_gate = Some(Arc::clone(&gate));
        let png = make_png(64, 64);
        let key = sha256_hex(&png);
        let validated = Arc::new(validate_png(png, &key).unwrap());
        let guard = Arc::clone(&service.disk_cache_lock).lock_owned().await;
        assert!(
            timeout(
                Duration::from_millis(10),
                service.store_raw_cache(&key, &validated)
            )
            .await
            .is_err()
        );
        drop(guard);
        timeout(
            Duration::from_secs(5),
            service.run_cache_operation(async {}),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!gate.entered.load(Ordering::SeqCst));
        assert!(!root.exists());
    }

    #[tokio::test]
    async fn failed_cache_transactions_clean_temporary_files_and_preserve_network_fallback() {
        for (phase, panic_worker) in [
            (CacheIoPhase::Raw, false),
            (CacheIoPhase::Index, false),
            (CacheIoPhase::Raw, true),
        ] {
            let temp = TempDir::new().unwrap();
            let root = temp.path().join("minecraft-skins");
            let png = make_png(64, 64);
            let (key, outcomes) = success_outcomes(&png, None, Some("max-age=600"));
            let (gate, release) = CacheIoGate::new(phase, panic_worker);
            let mut configured = service(FakeTransport::new(outcomes), Some(root.clone()));
            configured.cache_io_gate = Some(Arc::clone(&gate));
            let service = Arc::new(configured);
            let fetch_service = Arc::clone(&service);
            let fetch = tokio::spawn(async move { fetch_service.fetch("jeb_").await });
            timeout(Duration::from_secs(5), gate.reached.notified())
                .await
                .unwrap();
            if !panic_worker {
                let destination = match phase {
                    CacheIoPhase::Raw => root.join("raw").join(format!("{key}.png")),
                    CacheIoPhase::Index => root.join("index.json"),
                };
                std::fs::create_dir(&destination).unwrap();
            }
            release.send(()).unwrap();
            let response = timeout(Duration::from_secs(5), fetch)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(!response.cache_hit);
            assert_eq!(response.sha256, key);
            assert_eq!(
                general_purpose::STANDARD
                    .decode(response.png_base64)
                    .unwrap(),
                png
            );
            assert!(service.disk_cache_lock.try_lock().is_ok());
            assert_no_cache_temporaries(&root);
        }
    }

    #[tokio::test]
    async fn wrong_content_type_and_oversized_body_are_rejected() {
        let png = make_png(64, 64);
        let key = sha256_hex(&png);
        let url = format!("https://textures.minecraft.net/texture/{key}");
        let wrong_type = FakeTransport::new(vec![
            FakeOutcome::Response(lookup_response()),
            FakeOutcome::Response(session_response(&url, None)),
            FakeOutcome::Response(response(200, Some("text/html"), png)),
        ]);
        assert_public_code(
            service(wrong_type, None).fetch("jeb_").await.unwrap_err(),
            "INVALID_RESPONSE",
        );

        let huge = vec![0; PNG_LIMIT + 1];
        let too_large = FakeTransport::new(vec![
            FakeOutcome::Response(lookup_response()),
            FakeOutcome::Response(session_response(&url, None)),
            FakeOutcome::Response(png_response(huge)),
        ]);
        assert_public_code(
            service(too_large, None).fetch("jeb_").await.unwrap_err(),
            "TOO_LARGE",
        );
    }

    #[tokio::test]
    async fn request_and_overall_deadlines_bound_timeout_retries() {
        let delayed = FakeTransport::new(vec![
            FakeOutcome::Delayed(Duration::from_millis(50), lookup_response()),
            FakeOutcome::Delayed(Duration::from_millis(50), lookup_response()),
            FakeOutcome::Delayed(Duration::from_millis(50), lookup_response()),
        ]);
        let mut config = test_config();
        config.request_timeout = Duration::from_millis(10);
        config.overall_timeout = Duration::from_millis(25);
        let service = MinecraftSkinService::new(delayed.clone(), None, config);
        let started = Instant::now();
        assert_public_code(service.fetch("jeb_").await.unwrap_err(), "TIMEOUT");
        assert!(started.elapsed() < Duration::from_millis(150));
        assert!(delayed.call_count() <= 3);
    }

    #[tokio::test]
    async fn transport_timeout_and_network_errors_retry_then_fall_back() {
        let png = make_png(64, 64);
        let key = sha256_hex(&png);
        let timeout_transport = FakeTransport::new(vec![
            FakeOutcome::Failure(TransportFailure::Timeout),
            FakeOutcome::Response(lookup_response()),
            FakeOutcome::Response(session_response(
                &format!("https://textures.minecraft.net/texture/{key}"),
                None,
            )),
            FakeOutcome::Response(png_response(png.clone())),
        ]);
        service(timeout_transport.clone(), None)
            .fetch("jeb_")
            .await
            .unwrap();
        assert_eq!(timeout_transport.call_count(), 4);

        let network_transport = FakeTransport::new(vec![
            FakeOutcome::Failure(TransportFailure::Network),
            FakeOutcome::Failure(TransportFailure::Network),
            FakeOutcome::Failure(TransportFailure::Network),
            FakeOutcome::Response(lookup_response()),
            FakeOutcome::Response(session_response(
                &format!("https://textures.minecraft.net/texture/{key}"),
                None,
            )),
            FakeOutcome::Response(png_response(png)),
        ]);
        service(network_transport.clone(), None)
            .fetch("jeb_")
            .await
            .unwrap();
        let urls = network_transport.called_urls();
        assert_eq!(urls.len(), 6);
        assert!(urls[0].contains("api.minecraftservices.com"));
        assert!(urls[1].contains("api.minecraftservices.com"));
        assert!(urls[2].contains("api.minecraftservices.com"));
        assert!(urls[3].contains("api.mojang.com"));
    }

    #[tokio::test]
    #[ignore = "opt-in live smoke; set BLOCK_HUD_LIVE_MINECRAFT_SKIN=1 and run ignored tests"]
    async fn live_minecraft_skin_smoke() {
        if std::env::var("BLOCK_HUD_LIVE_MINECRAFT_SKIN").as_deref() != Ok("1") {
            return;
        }
        let service = MinecraftSkinService::new(
            Arc::new(ReqwestTransport::new()),
            None,
            ServiceConfig::production(),
        );
        let result = service.fetch("jeb_").await.unwrap();
        assert_eq!(result.width, 64);
        assert!(matches!(result.height, 32 | 64));
        assert_eq!(
            result.sha256,
            sha256_hex(
                &general_purpose::STANDARD
                    .decode(&result.png_base64)
                    .unwrap()
            )
        );
        assert!(result.texture_key.len() >= 32);
    }
}
