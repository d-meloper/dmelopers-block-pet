use std::{
    collections::VecDeque,
    fs,
    sync::{
        Mutex as StdMutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};

use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore};

use super::*;

const FIXTURE: &str = include_str!("fixtures/feed.json");

fn fixture() -> Feed {
    let mut value: Feed = serde_json::from_str(FIXTURE).unwrap();
    value.repository = feed::REPOSITORY.into();
    value.repository_id = feed::REPOSITORY_ID;
    value
}

#[test]
fn build_profile_binds_feed_link_cache_and_rejects_other_repository() {
    assert!(FEED_URL.contains(feed::REPOSITORY));
    assert_eq!(CACHE_DIRECTORY, if cfg!(feature = "test-repository") { "program-version-test" } else { "program-version" });
    let mut other = fixture();
    other.repository = if cfg!(feature = "test-repository") { "d-meloper/dmelopers-block-pet" } else { "oup030416/dmelopers-block-pet-test" }.into();
    other.repository_id = if cfg!(feature = "test-repository") { 1_390_031_914 } else { 1_390_032_052 };
    assert_eq!(other.validate(), Err(ErrorCode::InvalidFeed));
}
fn now() -> u64 {
    feed::timestamp(&fixture().verified_at).unwrap()
}

struct TestClock(AtomicU64);
impl TestClock {
    fn new() -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(now())))
    }
    fn advance(&self, seconds: u64) {
        self.0.fetch_add(seconds, Ordering::SeqCst);
    }
}
impl Clock for TestClock {
    fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct TestTransport {
    responses: StdMutex<VecDeque<Result<Vec<u8>, ErrorCode>>>,
    calls: AtomicUsize,
    entered: Notify,
    gate: Option<Arc<Semaphore>>,
}
impl TestTransport {
    fn new(responses: Vec<Result<Vec<u8>, ErrorCode>>) -> Arc<Self> {
        Arc::new(Self {
            responses: StdMutex::new(responses.into()),
            calls: AtomicUsize::new(0),
            entered: Notify::new(),
            gate: None,
        })
    }
    fn count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}
impl Transport for TestTransport {
    fn fetch(&self) -> TransportFuture<'_> {
        Box::pin(async {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
            let _permit = match &self.gate {
                Some(gate) => Some(gate.acquire().await.unwrap()),
                None => None,
            };
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected additional HTTP request")
        })
    }
}

fn success() -> Result<Vec<u8>, ErrorCode> {
    Ok(serde_json::to_vec(&fixture()).unwrap())
}
fn service(
    version: &str,
    root: Option<PathBuf>,
    transport: Arc<TestTransport>,
    clock: Arc<TestClock>,
) -> Service {
    Service::new(version.into(), root, transport, clock)
}

#[test]
fn shared_producer_fixture_binds_exact_release_identity() {
    let feed = fixture();
    feed.validate_fresh(now()).unwrap();
    let release = feed.latest.unwrap();
    assert_eq!(release.version, "1.10.0");
    assert_eq!(release.tag, "v1.10.0");
    assert_eq!(release.platform, "windows-x86_64");
    assert_eq!(
        release.installer.name,
        "dmelopers-block-pet_1.10.0_x64-setup.exe"
    );
    assert_eq!(
        release.signature.name,
        format!("{}.sig", release.installer.name)
    );
    assert_eq!(release.installer.sha256, "a".repeat(64));
    assert_eq!(release.signature.sha256, "b".repeat(64));
}

#[test]
fn stable_versions_compare_numeric_triplets_without_overflow_or_ambiguous_forms() {
    assert!(version("1.4.3") < version("1.10.0"));
    assert!(version("1.10.999") < version("2.0.0"));
    assert_eq!(version("18446744073709551615.0.0"), Some([u64::MAX, 0, 0]));
    for invalid in [
        "18446744073709551616.0.0",
        "1.2",
        "1.2.3.4",
        "v1.2.3",
        "01.2.3",
        "1.02.3",
        "1.2.-3",
        "1.2.3-beta",
        "1.2.3+build",
        " 1.2.3",
        "1.2.3\n",
        "１.2.3",
    ] {
        assert_eq!(version(invalid), None, "{invalid}");
    }
}

#[test]
fn timestamps_validate_calendar_and_exact_utc_seconds() {
    assert_eq!(feed::timestamp("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(
        feed::timestamp("2000-03-01T00:00:00Z").unwrap()
            - feed::timestamp("2000-02-28T00:00:00Z").unwrap(),
        172_800
    );
    for invalid in [
        "1969-12-31T00:00:00Z",
        "2025-02-29T00:00:00Z",
        "2100-02-29T00:00:00Z",
        "2026-09-31T00:00:00Z",
        "2026-00-01T00:00:00Z",
        "2026-09-13T24:00:00Z",
        "2026-09-13T00:00:60Z",
        "2026-09-13T00:00:00.000Z",
        "2026-09-13T00:00:00+00:00",
    ] {
        assert_eq!(feed::timestamp(invalid), None, "{invalid}");
    }
}

#[test]
fn metadata_rejects_wrong_source_platform_assets_versions_hashes_and_dates() {
    for (pointer, value) in [
        ("/schemaVersion", json!(3)),
        ("/repository", json!("other/repository")),
        ("/repositoryId", json!(0)),
        ("/visibility", json!("private")),
        ("/verifiedAt", json!("invalid")),
        ("/latest/version", json!("1.10.0-beta")),
        ("/latest/tag", json!("v1.010.0")),
        ("/latest/platform", json!("windows-arm64")),
        (
            "/latest/installer/name",
            json!("../dmelopers-block-pet_1.10.0_x64-setup.exe"),
        ),
        ("/latest/signature/name", json!("foreign.exe.sig")),
        ("/latest/installer/size", json!(0)),
        ("/latest/installer/size", json!(9_007_199_254_740_992_u64)),
        ("/latest/signature/sha256", json!("B".repeat(64))),
        ("/latest/installer/sha256", json!("a".repeat(63))),
        ("/latest/publishedAt", json!("2026-09-14T00:00:00Z")),
    ] {
        let mut changed: Value = serde_json::to_value(fixture()).unwrap();
        *changed.pointer_mut(pointer).unwrap() = value;
        let feed: Feed = serde_json::from_value(changed).unwrap();
        assert_eq!(feed.validate(), Err(ErrorCode::InvalidFeed), "{pointer}");
    }
    let missing = FIXTURE.replace("\"latest\":", "\"notLatest\":");
    assert!(serde_json::from_str::<Feed>(&missing).is_err());
    let duplicate = FIXTURE.replacen('{', "{\"schemaVersion\":2,", 1);
    assert!(serde_json::from_str::<Feed>(&duplicate).is_err());
}

#[test]
fn producer_timestamp_expiry_and_future_clock_skew_have_exact_boundaries() {
    let feed = fixture();
    assert!(feed.validate_fresh(now() + feed::FEED_MAX_AGE).is_ok());
    assert_eq!(
        feed.validate_fresh(now() + feed::FEED_MAX_AGE + 1),
        Err(ErrorCode::StaleFeed)
    );
    assert!(feed.validate_fresh(now() - feed::FUTURE_TOLERANCE).is_ok());
    assert_eq!(
        feed.validate_fresh(now() - feed::FUTURE_TOLERANCE - 1),
        Err(ErrorCode::FutureFeed)
    );
}

#[tokio::test]
async fn native_service_reports_all_comparison_states_and_never_checks_invalid_local_versions() {
    for (current, status) in [
        ("1.4.3", VersionStatus::Available),
        ("1.10.0", VersionStatus::UpToDate),
        ("1.11.0", VersionStatus::LocalNewer),
    ] {
        let transport = TestTransport::new(vec![success()]);
        let result = service(current, None, transport.clone(), TestClock::new())
            .check()
            .await;
        assert_eq!(result.status, status);
        assert_eq!(result.error_code, None);
        assert!(!result.from_cache);
        assert_eq!(transport.count(), 1);
    }
    let transport = TestTransport::new(vec![]);
    let result = service("1.0.0-preview", None, transport.clone(), TestClock::new())
        .check()
        .await;
    assert_eq!(result.status, VersionStatus::Unknown);
    assert_eq!(result.error_code, Some(ErrorCode::CurrentVersionInvalid));
    assert_eq!(transport.count(), 0);
}

#[tokio::test]
async fn simultaneous_checks_share_one_request_and_success_expires_at_six_hours() {
    let gate = Arc::new(Semaphore::new(0));
    let transport = Arc::new(TestTransport {
        responses: StdMutex::new(vec![success(), success()].into()),
        calls: AtomicUsize::new(0),
        entered: Notify::new(),
        gate: Some(gate.clone()),
    });
    let clock = TestClock::new();
    let service = Arc::new(service("1.0.0", None, transport.clone(), clock.clone()));
    let task_service = service.clone();
    let pending = tokio::spawn(async move {
        tokio::join!(
            task_service.check(),
            task_service.check(),
            task_service.check()
        )
    });
    transport.entered.notified().await;
    assert_eq!(transport.count(), 1);
    gate.add_permits(1);
    let (first, second, third) = pending.await.unwrap();
    assert_eq!(first.status, VersionStatus::Available);
    assert_eq!(second.status, first.status);
    assert_eq!(third.status, first.status);
    assert_eq!(transport.count(), 1);
    clock.advance(SUCCESS_TTL - 1);
    assert!(service.check().await.from_cache);
    clock.advance(1);
    assert!(!service.check().await.from_cache);
    assert_eq!(transport.count(), 2);
}

#[tokio::test]
async fn no_release_stays_unknown_and_never_substitutes_the_installed_version() {
    let mut feed = fixture();
    feed.latest = None;
    let transport = TestTransport::new(vec![Ok(serde_json::to_vec(&feed).unwrap())]);
    let service = service("1.0.0", None, transport.clone(), TestClock::new());
    let result = service.check().await;
    assert_eq!(result.status, VersionStatus::Unknown);
    assert_eq!(result.latest_version, None);
    assert_eq!(result.error_code, Some(ErrorCode::NoStableRelease));
    assert!(service.check().await.from_cache);
    assert_eq!(transport.count(), 1);
}

#[tokio::test]
async fn failed_refresh_retains_previous_identity_and_success_time_but_shows_unknown() {
    let directory = tempfile::tempdir().unwrap();
    let clock = TestClock::new();
    let transport = TestTransport::new(vec![success(), Err(ErrorCode::Network), success()]);
    let service = service(
        "1.0.0",
        Some(directory.path().into()),
        transport.clone(),
        clock.clone(),
    );
    let first = service.check().await;
    clock.advance(SUCCESS_TTL);
    let failure = service.check().await;
    assert_eq!(failure.status, VersionStatus::Unknown);
    assert_eq!(failure.error_code, Some(ErrorCode::Network));
    assert_eq!(failure.latest_version, first.latest_version);
    assert_eq!(failure.last_success_at, first.last_success_at);
    assert_eq!(failure.last_attempt_at, Some(clock.now()));
    let retained = cache::read(directory.path(), clock.now()).unwrap();
    assert_eq!(
        retained.feed.unwrap().latest.unwrap().installer.sha256,
        "a".repeat(64)
    );
    clock.advance(FAILURE_COOLDOWN - 1);
    assert!(service.check().await.from_cache);
    assert_eq!(transport.count(), 2);
    clock.advance(1);
    assert_eq!(service.check().await.status, VersionStatus::Available);
    assert_eq!(transport.count(), 3);
}

#[tokio::test]
async fn restart_reuses_verified_cache_and_persisted_failure_cooldown() {
    let directory = tempfile::tempdir().unwrap();
    let clock = TestClock::new();
    let first = service(
        "1.0.0",
        Some(directory.path().into()),
        TestTransport::new(vec![success()]),
        clock.clone(),
    );
    first.check().await;
    let offline = TestTransport::new(vec![Err(ErrorCode::Timeout)]);
    let second = service(
        "1.10.0",
        Some(directory.path().into()),
        offline.clone(),
        clock.clone(),
    );
    let reused = second.check().await;
    assert_eq!(reused.status, VersionStatus::UpToDate);
    assert!(reused.from_cache);
    assert_eq!(offline.count(), 0);
    clock.advance(SUCCESS_TTL);
    assert_eq!(second.check().await.error_code, Some(ErrorCode::Timeout));
    let no_request = TestTransport::new(vec![]);
    let third = service(
        "1.0.0",
        Some(directory.path().into()),
        no_request.clone(),
        clock,
    );
    assert_eq!(third.check().await.error_code, Some(ErrorCode::Timeout));
    assert_eq!(no_request.count(), 0);
}

#[tokio::test]
async fn delayed_success_records_completion_time_and_survives_restart() {
    let directory = tempfile::tempdir().unwrap();
    let gate = Arc::new(Semaphore::new(0));
    let transport = Arc::new(TestTransport {
        responses: StdMutex::new(vec![success()].into()),
        calls: AtomicUsize::new(0),
        entered: Notify::new(),
        gate: Some(gate.clone()),
    });
    let clock = TestClock::new();
    let active = Arc::new(service(
        "1.10.0",
        Some(directory.path().into()),
        transport.clone(),
        clock.clone(),
    ));
    let checking = active.clone();
    let pending = tokio::spawn(async move { checking.check().await });
    transport.entered.notified().await;
    // The request crosses multiple clock seconds before its response arrives.
    clock.advance(3);
    gate.add_permits(1);
    let result = pending.await.unwrap();
    assert_eq!(result.last_success_at, Some(clock.now()));
    assert_eq!(result.last_attempt_at, result.last_success_at);
    let persisted = cache::read(directory.path(), clock.now()).unwrap();
    assert_eq!(persisted.last_success_at, result.last_success_at);
    let no_request = TestTransport::new(vec![]);
    let restarted = service(
        "1.10.0",
        Some(directory.path().into()),
        no_request.clone(),
        clock,
    );
    let reused = restarted.check().await;
    assert_eq!(reused.status, VersionStatus::UpToDate);
    assert!(reused.from_cache);
    assert_eq!(no_request.count(), 0);
}

#[tokio::test]
async fn cancellation_releases_singleflight_but_preserves_retry_cooldown_on_disk() {
    let directory = tempfile::tempdir().unwrap();
    let gate = Arc::new(Semaphore::new(0));
    let transport = Arc::new(TestTransport {
        responses: StdMutex::new(vec![success()].into()),
        calls: AtomicUsize::new(0),
        entered: Notify::new(),
        gate: Some(gate.clone()),
    });
    let clock = TestClock::new();
    let active = Arc::new(service(
        "1.10.0",
        Some(directory.path().into()),
        transport.clone(),
        clock.clone(),
    ));
    let checking = active.clone();
    let pending = tokio::spawn(async move { checking.check().await });
    transport.entered.notified().await;
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    let interrupted = cache::read(directory.path(), clock.now()).unwrap();
    assert_eq!(interrupted.last_attempt_at, Some(clock.now()));
    assert_eq!(interrupted.error_code, Some(ErrorCode::Network));
    clock.advance(FAILURE_COOLDOWN - 1);
    let blocked = active.check().await;
    assert_eq!(blocked.status, VersionStatus::Unknown);
    assert!(blocked.from_cache);
    assert_eq!(transport.count(), 1);
    let restarted = service(
        "1.10.0",
        Some(directory.path().into()),
        transport.clone(),
        clock.clone(),
    );
    assert_eq!(restarted.check().await.status, VersionStatus::Unknown);
    assert_eq!(transport.count(), 1);
    clock.advance(1);
    gate.add_permits(1);
    assert_eq!(restarted.check().await.status, VersionStatus::UpToDate);
    assert_eq!(transport.count(), 2);
}

#[tokio::test]
async fn invalid_cached_schema_source_or_times_cannot_claim_up_to_date() {
    let valid = Cache {
        schema_version: 1,
        feed: Some(fixture()),
        last_success_at: Some(now()),
        last_attempt_at: Some(now()),
        error_code: None,
    };
    for (pointer, value) in [
        ("/schemaVersion", json!(2)),
        ("/feed/schemaVersion", json!(3)),
        ("/feed/repository", json!("foreign/source")),
        ("/lastSuccessAt", json!(now() + 301)),
        ("/lastAttemptAt", json!(now() - 1)),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let mut changed = serde_json::to_value(&valid).unwrap();
        *changed.pointer_mut(pointer).unwrap() = value;
        fs::write(
            directory.path().join("latest-version.json"),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        let transport = TestTransport::new(vec![Err(ErrorCode::Network)]);
        let service = service(
            "1.10.0",
            Some(directory.path().into()),
            transport.clone(),
            TestClock::new(),
        );
        let result = service.check().await;
        assert_eq!(result.status, VersionStatus::Unknown, "{pointer}");
        assert_eq!(result.latest_version, None, "{pointer}");
        assert_eq!(transport.count(), 1, "{pointer}");
    }
}

#[tokio::test]
async fn expired_or_corrupt_cache_never_becomes_a_current_version_claim() {
    for cache_contents in [b"not JSON".to_vec(), vec![b' '; MAX_BYTES + 1025]] {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("latest-version.json"), cache_contents).unwrap();
        let service = service(
            "1.0.0",
            Some(directory.path().into()),
            TestTransport::new(vec![Err(ErrorCode::Network)]),
            TestClock::new(),
        );
        assert_eq!(service.check().await.status, VersionStatus::Unknown);
    }
    let clock = TestClock::new();
    let service = service(
        "1.0.0",
        None,
        TestTransport::new(vec![success(), success()]),
        clock.clone(),
    );
    assert_eq!(service.check().await.status, VersionStatus::Available);
    clock.advance(feed::FEED_MAX_AGE + 1);
    let expired = service.check().await;
    assert_eq!(expired.status, VersionStatus::Unknown);
    assert_eq!(expired.error_code, Some(ErrorCode::StaleFeed));
}

#[tokio::test]
async fn oversized_invalid_and_transport_errors_are_unknown_with_bounded_retry() {
    let mut unsupported_schema: Value = serde_json::to_value(fixture()).unwrap();
    unsupported_schema["schemaVersion"] = json!(3);
    for (response, error) in [
        (Ok(vec![b' '; MAX_BYTES + 1]), ErrorCode::ResponseTooLarge),
        (Ok(b"{}".to_vec()), ErrorCode::InvalidFeed),
        (
            Ok(serde_json::to_vec(&unsupported_schema).unwrap()),
            ErrorCode::InvalidFeed,
        ),
        (Err(ErrorCode::HttpStatus), ErrorCode::HttpStatus),
        (Err(ErrorCode::Timeout), ErrorCode::Timeout),
    ] {
        let transport = TestTransport::new(vec![response]);
        let service = service("1.10.0", None, transport.clone(), TestClock::new());
        let result = service.check().await;
        assert_eq!(result.status, VersionStatus::Unknown);
        assert_eq!(result.error_code, Some(error));
        assert_eq!(service.check().await.error_code, Some(error));
        assert_eq!(transport.count(), 1);
    }
}

#[tokio::test]
async fn unwritable_cache_is_nonfatal_and_never_changes_unrelated_files() {
    let directory = tempfile::tempdir().unwrap();
    let blocked = directory.path().join("not-a-directory");
    fs::write(&blocked, b"untouched").unwrap();
    let service = service(
        "1.0.0",
        Some(blocked.clone()),
        TestTransport::new(vec![success()]),
        TestClock::new(),
    );
    assert_eq!(service.check().await.status, VersionStatus::Available);
    assert!(service.check().await.from_cache);
    assert_eq!(fs::read(blocked).unwrap(), b"untouched");
}

#[test]
fn only_the_preferences_webview_may_trigger_a_check() {
    assert!(authorize_window("preference").is_ok());
    for window in ["main", "obs", "", "preference-child"] {
        assert!(authorize_window(window).is_err());
    }
}
