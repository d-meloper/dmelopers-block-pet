use super::*;
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("signature-fixture.json")).unwrap()
}
fn trust() -> Trust {
    Trust {
        schema_version: 1,
        repository: REPOSITORY.into(),
        repository_id: Some(42),
        public_key: Some(fixture()["publicKey"].as_str().unwrap().into()),
    }
}
fn feed_value() -> Value {
    json!({"schemaVersion":1,"repository":REPOSITORY,"repositoryId":42,"product":feed::PRODUCT,"channel":"stable","platform":feed::PLATFORM,"version":"1.2.3","tag":"v1.2.3","asset":{"name":feed::asset_name("1.2.3"),"size":42,"sha256":"a".repeat(64),"signature":fixture()["signature"],"installedFiles":{"dmelopers-3d-block-pet.exe":"a".repeat(64),"assets/tray.png":"b".repeat(64),"assets/models/dmeloper/dmeloper.glb":"c".repeat(64),"assets/models/dmeloper/default.png":"d".repeat(64)}},"minUpdaterSchema":1,"dataSchema":{"min":1,"max":1},"withdrawn":false,"publishedAt":"2026-09-09T00:00:00Z"})
}
pub(super) fn sample() -> Feed {
    serde_json::from_value(feed_value()).unwrap()
}

#[test]
fn standard_tauri_signature_verifies_real_signed_bytes_and_rejects_tampering() {
    let f = fixture();
    let bytes = f["message"].as_str().unwrap().as_bytes();
    let signature = f["signature"].as_str().unwrap();
    trust().verify(bytes, signature).unwrap();
    assert!(trust().verify(b"changed", signature).is_err());
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("서명 😶.exe");
    std::fs::write(&path, bytes).unwrap();
    trust().verify_file(&path, signature).unwrap();
    std::fs::write(&path, b"changed").unwrap();
    assert!(trust().verify_file(&path, signature).is_err());
    let mut bad = trust();
    bad.public_key = None;
    assert_eq!(
        bad.verify(bytes, signature).unwrap_err().code,
        "TRUST_NOT_CONFIGURED"
    );
}

#[cfg(not(feature = "private-update-qa"))]
#[test]
fn both_repository_choices_use_separate_compiled_trust_and_keep_the_build_default() {
    let official = Trust::for_repository(feed::OFFICIAL_REPOSITORY).unwrap();
    let test = Trust::for_repository(feed::TEST_REPOSITORY).unwrap();
    assert_eq!(official.repository_id, Some(1362161775));
    assert_eq!(test.repository_id, Some(1362494486));
    assert_ne!(official.public_key, test.public_key);
    assert_eq!(Trust::embedded().unwrap().repository, REPOSITORY);
    assert_eq!(
        Trust::for_repository("attacker/repository")
            .unwrap_err()
            .code,
        "UPDATE_SOURCE_INVALID"
    );
    let mut selected = sample();
    selected.repository = official.repository;
    selected.repository_id = official.repository_id.unwrap();
    assert!(selected.validate(&test).is_err());
    assert!(selected.download_url().starts_with(&format!(
        "https://github.com/{}/releases/download/",
        feed::OFFICIAL_REPOSITORY
    )));
}

#[cfg(not(feature = "private-update-qa"))]
#[test]
fn editing_the_source_invalidates_an_existing_decision_even_at_the_same_version() {
    let temporary = tempfile::tempdir().unwrap();
    let selection = temporary.path().join(source::FILE_NAME);
    std::fs::write(
        &selection,
        format!("{{\"repository\":\"{}\"}}", feed::OFFICIAL_REPOSITORY),
    )
    .unwrap();
    let official = Trust::for_repository(source::repository(temporary.path()).unwrap()).unwrap();
    let mut displayed = sample();
    displayed.repository = official.repository.clone();
    displayed.repository_id = official.repository_id.unwrap();
    require_feed_source(&displayed, &official).unwrap();
    std::fs::write(
        &selection,
        format!("{{\"repository\":\"{}\"}}", feed::TEST_REPOSITORY),
    )
    .unwrap();
    let test = Trust::for_repository(source::repository(temporary.path()).unwrap()).unwrap();
    assert_eq!(
        require_feed_source(&displayed, &test).unwrap_err().code,
        "CHECK_REQUIRED"
    );
    let mut fresh = displayed.clone();
    fresh.repository = test.repository;
    fresh.repository_id = test.repository_id.unwrap();
    assert_eq!(
        require_same_feed(&displayed, &fresh).unwrap_err().code,
        "CHECK_REQUIRED"
    );
    assert_ne!(displayed.download_url(), fresh.download_url());
}

#[test]
fn stable_versions_are_numeric_canonical_and_cannot_replay_another_identity() {
    assert!(feed::version("1.10.0").unwrap() > feed::version("1.9.99").unwrap());
    for bad in [
        "v1.0.0",
        "01.0.0",
        "1.0.0-beta",
        "1.0.0+build",
        "1.0",
        "1.0.0.0",
        "1.0.-1",
        "999999999999999999999999.0.0",
    ] {
        assert!(feed::version(bad).is_err(), "{bad}");
    }
    sample().validate(&trust()).unwrap();
    for (key, value) in [
        ("repository", json!("attacker/repo")),
        ("repositoryId", json!(43)),
        ("product", json!("other")),
        ("channel", json!("test")),
        ("platform", json!("windows-arm64")),
        ("tag", json!("v1.2.4")),
        ("withdrawn", json!(true)),
        ("publishedAt", json!("2026-02-30T00:00:00Z")),
        ("minUpdaterSchema", json!(2)),
    ] {
        let mut v = feed_value();
        v[key] = value;
        assert!(
            serde_json::from_value::<Feed>(v)
                .unwrap()
                .validate(&trust())
                .is_err(),
            "{key}"
        );
    }
    for (key, value) in [
        ("name", json!("another.exe")),
        ("size", json!(0)),
        ("size", json!(feed::MAX_INSTALLER_BYTES + 1)),
        ("sha256", json!("a".repeat(63))),
        ("signature", json!("")),
    ] {
        let mut v = feed_value();
        v["asset"][key] = value;
        assert!(
            serde_json::from_value::<Feed>(v)
                .unwrap()
                .validate(&trust())
                .is_err(),
            "{key}"
        );
    }
}

fn release(feed: &Feed) -> Value {
    let names = [
        feed.asset.name.clone(),
        format!("{}.sig", feed.asset.name),
        "stable.json".into(),
        "stable.json.sig".into(),
    ];
    json!({"tag_name":feed.tag,"draft":false,"prerelease":false,"html_url":feed.release_url(),"immutable":true,"assets":names.iter().map(|name| json!({"name":name,"size":42,"digest":format!("sha256:{}",feed.asset.sha256),"state":"uploaded","browser_download_url":format!("https://github.com/{REPOSITORY}/releases/download/{}/{name}",feed.tag)})).collect::<Vec<_>>()})
}

#[test]
fn only_exact_immutable_release_with_four_complete_assets_is_accepted() {
    let f = sample();
    let valid = release(&f);
    feed::validate_release(&serde_json::to_vec(&valid).unwrap(), &f).unwrap();
    for key in ["draft", "prerelease"] {
        let mut v = valid.clone();
        v[key] = true.into();
        assert!(feed::validate_release(&serde_json::to_vec(&v).unwrap(), &f).is_err());
    }
    for mutation in 0..5 {
        let mut v = valid.clone();
        match mutation {
            0 => {
                v["assets"].as_array_mut().unwrap().pop();
            }
            1 => {
                let duplicate = v["assets"][0].clone();
                v["assets"][1] = duplicate;
            }
            2 => v["immutable"] = false.into(),
            3 => v["assets"][0]["digest"] = json!(format!("sha256:{}", "b".repeat(64))),
            _ => v["assets"][3]["browser_download_url"] = "https://example.org/feed.sig".into(),
        };
        assert!(feed::validate_release(&serde_json::to_vec(&v).unwrap(), &f).is_err());
    }
}

#[test]
fn network_policy_rejects_untrusted_redirects_and_changed_fresh_decisions() {
    for url in [
        "http://github.com/a",
        "https://github.com.evil.example/a",
        "https://user@github.com/a",
        "https://github.com:444/a",
        "file:///C:/installer.exe",
    ] {
        assert!(!feed::allowed_url(&url.parse().unwrap(), false));
    }
    assert!(feed::allowed_url(
        &"https://release-assets.githubusercontent.com/path?token=opaque"
            .parse()
            .unwrap(),
        false
    ));
    assert!(!feed::allowed_url(
        &"https://release-assets.githubusercontent.com/path"
            .parse()
            .unwrap(),
        true
    ));
    let first = sample();
    let mut changed = first.clone();
    changed.asset.sha256 = "b".repeat(64);
    require_same_feed(&first, &first).unwrap();
    assert_eq!(
        require_same_feed(&first, &changed).unwrap_err().code,
        "CHECK_REQUIRED"
    );
}

#[test]
fn release_catalog_digest_is_checked_against_each_actual_auxiliary_asset() {
    let bytes = b"actual signed feed bytes";
    let value = json!({"assets":[{"name":"stable.json", "size":bytes.len(),"digest":format!("sha256:{:x}",Sha256::digest(bytes))}]});
    let catalog = serde_json::to_vec(&value).unwrap();
    feed::validate_asset_bytes(&catalog, "stable.json", bytes).unwrap();
    assert!(feed::validate_asset_bytes(&catalog, "stable.json", b"changed").is_err());
    assert!(feed::validate_asset_bytes(&catalog, "stable.json.sig", bytes).is_err());
}

#[test]
fn startup_automatic_policy_handles_disabled_legacy_missing_and_corrupt_state() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("tauri-plugin-pinia/general.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    assert!(automatic_from_user_root(temp.path()));
    let unrelated = temp.path().join("pinia/general.json");
    std::fs::create_dir_all(unrelated.parent().unwrap()).unwrap();
    std::fs::write(&unrelated, br#"{"app":{"autoUpdateCheck":false}}"#).unwrap();
    assert!(automatic_from_user_root(temp.path()));
    std::fs::write(&path, br#"{"app":{"autoUpdateCheck":false}}"#).unwrap();
    assert!(!automatic_from_user_root(temp.path()));
    std::fs::write(&path, br#"{"app":{}}"#).unwrap();
    assert!(automatic_from_user_root(temp.path()));
    std::fs::write(&path, b"partial write").unwrap();
    assert!(!automatic_from_user_root(temp.path()));
}

#[tokio::test]
async fn cancellation_interrupts_a_network_future_that_never_delivers_a_chunk() {
    let state = cancellable_state();
    let wait = cancellable::<()>(&state, std::future::pending());
    let cancel = async {
        tokio::task::yield_now().await;
        state.cancel();
    };
    let result = tokio::time::timeout(Duration::from_millis(200), async {
        tokio::join!(wait, cancel).0
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err().code, "CANCELLED");
}

fn cancellable_state() -> UpdateState {
    UpdateState {
        status: Mutex::new(UpdateStatus {
            revision: 0,
            phase: "downloading".into(),
            request_id: None,
            current_version: "1.0.0".into(),
            target_version: None,
            downloaded_bytes: 0,
            total_bytes: 0,
            can_cancel: true,
            error_code: None,
            release_url: None,
        }),
        decision: Mutex::new(None),
        operation: tokio::sync::Mutex::new(()),
        commit_gate: Mutex::new(()),
        cancelled: AtomicBool::new(false),
        cancel_signal: tokio::sync::watch::channel(false).0,
        automatic: AtomicBool::new(false),
        installing: AtomicBool::new(false),
        exiting_for_install: AtomicBool::new(false),
        cleanup_running: AtomicBool::new(false),
        data_ready: Mutex::new(None),
        root: PathBuf::new(),
    }
}

#[test]
fn accepted_cancel_prevents_commit_and_closed_commit_gate_rejects_a_racing_cancel() {
    let state = cancellable_state();
    state.try_cancel().unwrap();
    assert_eq!(state.begin_commit().unwrap_err().code, "CANCELLED");
    let state = cancellable_state();
    std::thread::scope(|scope| {
        let gate = state.begin_commit().unwrap();
        let (started, ready) = std::sync::mpsc::channel();
        let state_ref = &state;
        let racing = scope.spawn(move || {
            started.send(()).unwrap();
            state_ref.try_cancel()
        });
        ready.recv().unwrap();
        state.installing.store(true, Ordering::SeqCst);
        drop(gate);
        assert_eq!(racing.join().unwrap().unwrap_err().code, "CANNOT_CANCEL");
        assert!(!state.cancelled.load(Ordering::SeqCst));
    });
}
