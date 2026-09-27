use super::*;
use std::io::Cursor;

#[test]
fn json_temporary_reparse_never_overwrites_its_external_target() {
    let temp = tempfile::tempdir().unwrap();
    let operations = temp.path().join("operations");
    fs::create_dir(&operations).unwrap();
    let target = operations.join("active.json");
    let unrelated = temp.path().join("unrelated.json");
    fs::write(&target, b"original operation").unwrap();
    fs::write(&unrelated, b"unrelated data").unwrap();
    if let Err(error) = std::os::windows::fs::symlink_file(&unrelated, target.with_extension("json.part")) {
        if error.raw_os_error() == Some(1314) {
            eprintln!("Skipping file-symlink fixture: Windows symbolic-link privilege is unavailable (1314).");
            return;
        }
        panic!("Could not create file-symlink fixture: {error}");
    }

    let result = write_json(&target, &serde_json::json!({"replacement": true}));
    assert!(unrelated.exists(), "the redirected target must stay at its original path");
    assert_eq!(fs::read(&unrelated).unwrap(), b"unrelated data");
    assert_eq!(fs::read(&target).unwrap(), b"original operation");
    assert!(result.is_err(), "a redirected temporary file must be rejected");
}

#[test]
fn json_writer_can_resume_an_ordinary_partial_file() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("active.json");
    fs::write(target.with_extension("json.part"), b"interrupted longer JSON document").unwrap();
    let expected = serde_json::json!({"ok": true});
    write_json(&target, &expected).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&fs::read(&target).unwrap()).unwrap(), expected);
    assert!(!target.with_extension("json.part").exists());
}

fn runtime_fixture() -> Stores {
    let input: Value = serde_json::from_str(include_str!("fixtures/runtime-v1.json")).unwrap();
    serde_json::from_value(input["stores"].clone()).unwrap()
}
fn png() -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(64, 64, image::Rgba([70, 80, 120, 255]));
    let mut bytes = Cursor::new(vec![]);
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}
fn transaction_fixture(
    base: &Path,
    stores: &Stores,
) -> (PathBuf, PathBuf, PathBuf, OperationState) {
    let live = base.join("새 사용자 Example");
    let operations = base.join("operations");
    let work = operations.join("0123456789abcdef0123456789abcdef");
    for (id, value) in stores {
        write_json(
            &live.join(STORE_DIRECTORY).join(format!("{id}.json")),
            value,
        )
        .unwrap();
    }
    fs::create_dir_all(live.join("skin-library/raw")).unwrap();
    fs::write(live.join("skin-library/raw/retained.png"), png()).unwrap();
    fs::write(
        live.join("skin-library/manifest.json"),
        b"retained catalog bytes",
    )
    .unwrap();
    let backup_digest = snapshot_live(&live, &work.join("backup")).unwrap();
    let (data_digest, preset_id, skin_hashes) =
        proof_fields(stores, &live.join("skin-library")).unwrap();
    let state = OperationState {
        request_id: "0123456789abcdef0123456789abcdef".into(),
        phase: "awaitingHealth".into(),
        expected_version: "1.0.1".into(),
        source_version: "1.0.0".into(),
        started_at: now(),
        rollback_attempted: false,
        data_digest,
        preset_id,
        skin_hashes,
        backup_digest,
        error: None,
        failure_reason: None,
        warnings: vec![],
        rendered: false,
        window_digest: String::new(),
        window_geometry: None,
    };
    persist_at(&operations, &state).unwrap();
    (live, work, operations, state)
}

#[test]
fn restart_worker() {
    let Some(base) = std::env::var_os("BLOCK_PET_TEST_ROOT") else {
        return;
    };
    let base = PathBuf::from(base);
    assert_eq!(
        fs::read(base.join("test-only.marker")).unwrap(),
        b"isolated update recovery fixture"
    );
    let operations = base.join("operations");
    let mut state = read_state(&operations).unwrap().unwrap();
    resume_operation(
        &base.join("새 사용자 Example"),
        &operations.join(&state.request_id),
        &operations,
        &mut state,
    )
    .unwrap();
}
fn restart_in_child(base: &Path, fault: bool) -> std::process::ExitStatus {
    fs::write(
        base.join("test-only.marker"),
        b"isolated update recovery fixture",
    )
    .unwrap();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "update_recovery::tests::restart_worker",
            "--test-threads=1",
        ])
        .env("BLOCK_PET_TEST_ROOT", base)
        .env_remove("BLOCK_PET_TEST_FAULT");
    if fault {
        command.env("BLOCK_PET_TEST_FAULT", "after-pinia");
    }
    command.status().unwrap()
}

#[test]
fn actual_process_exit_during_rollback_resumes_the_same_attempt_once() {
    let temp = tempfile::tempdir().unwrap();
    let (live, work, operations, mut state) = transaction_fixture(temp.path(), &runtime_fixture());
    fs::write(
        live.join(STORE_DIRECTORY).join("cat.json"),
        b"failed new-version write",
    )
    .unwrap();
    state.phase = "rollbackPending".into();
    state.error = Some("RENDER_FAILED".into());
    persist_at(&operations, &state).unwrap();
    assert_eq!(restart_in_child(temp.path(), true).code(), Some(73));
    let interrupted = read_state(&operations).unwrap().unwrap();
    assert_eq!(interrupted.phase, "rollingBack");
    assert!(interrupted.rollback_attempted);
    assert_eq!(interrupted.failure_reason.as_deref(), Some("RENDER_FAILED"));
    assert!(restart_in_child(temp.path(), false).success());
    let mut recovered = read_state(&operations).unwrap().unwrap();
    assert_eq!(recovered.phase, "awaitingRollbackHealth");
    assert!(recovered.rollback_attempted);
    assert!(!recovered.rendered);
    assert_eq!(scope_digest(&live).unwrap(), state.backup_digest);
    assert!(work.join("backup").exists());
    recovered.phase = "rollbackPending".into();
    resume_operation(&live, &work, &operations, &mut recovered).unwrap();
    assert_eq!(recovered.phase, "failed");
    assert_eq!(
        recovered.error.as_deref(),
        Some("ROLLBACK_ALREADY_ATTEMPTED")
    );
    assert_eq!(recovered.failure_reason.as_deref(), Some("RENDER_FAILED"));
}

#[test]
fn installer_failure_proof_restores_every_store_and_skin_before_health() {
    let temp = tempfile::tempdir().unwrap();
    let (live, work, operations, mut state) = transaction_fixture(temp.path(), &runtime_fixture());
    let original = scope_digest(&live).unwrap();
    fs::write(
        live.join(STORE_DIRECTORY).join("general.json"),
        b"broken changed state",
    )
    .unwrap();
    fs::write(
        live.join("skin-library/raw/new.png"),
        b"failed target asset",
    )
    .unwrap();
    let path = operations.join(format!("{}.failure.json", state.request_id));
    write_json(&path,&json!({"requestId":"other","expectedVersion":state.expected_version,"reason":"INSTALLER_FAILED"})).unwrap();
    let changed = scope_digest(&live).unwrap();
    assert_eq!(
        resume_operation(&live, &work, &operations, &mut state).unwrap_err(),
        "INVALID_FAILURE_PROOF"
    );
    assert_eq!(scope_digest(&live).unwrap(), changed);
    write_json(&path,&json!({"requestId":state.request_id,"expectedVersion":state.expected_version,"reason":"INSTALLER_FAILED"})).unwrap();
    resume_operation(&live, &work, &operations, &mut state).unwrap();
    assert_eq!(state.phase, "awaitingRollbackHealth");
    assert!(!state.rendered);
    assert_eq!(state.failure_reason.as_deref(), Some("INSTALLER_FAILED"));
    assert_eq!(scope_digest(&live).unwrap(), original);
    assert!(!live.join("skin-library/raw/new.png").exists());
    assert!(work.join("backup").exists());
}

#[test]
fn corrupt_snapshot_never_overwrites_live_data_and_failure_keeps_original_cause() {
    let temp = tempfile::tempdir().unwrap();
    let (live, work, operations, mut state) = transaction_fixture(temp.path(), &runtime_fixture());
    state.phase = "rollbackPending".into();
    state.error = Some("RENDER_FAILED".into());
    fs::write(
        work.join("backup").join(STORE_DIRECTORY).join("cat.json"),
        b"bad snapshot",
    )
    .unwrap();
    let before = scope_digest(&live).unwrap();
    resume_operation(&live, &work, &operations, &mut state).unwrap();
    assert_eq!(state.phase, "failed");
    assert_eq!(state.failure_reason.as_deref(), Some("RENDER_FAILED"));
    assert_eq!(state.error.as_deref(), Some("BACKUP_VERIFICATION_FAILED"));
    assert_eq!(scope_digest(&live).unwrap(), before);
}

#[test]
fn known_precommit_cancel_requires_exact_marker_and_unchanged_original_data() {
    let temp = tempfile::tempdir().unwrap();
    let (live, work, operations, mut state) = transaction_fixture(temp.path(), &runtime_fixture());
    let path = operations.join(format!("{}.cancel.json", state.request_id));
    write_json(&path,&json!({"requestId":state.request_id,"sourceVersion":state.source_version,"expectedVersion":state.expected_version,"reason":"UPDATE_NOT_COMMITTED"})).unwrap();
    resume_operation(&live, &work, &operations, &mut state).unwrap();
    assert_eq!(state.phase, "rolledBack");
    assert!(!state.rollback_attempted);
    assert!(!state.rendered);
    assert_eq!(state.error.as_deref(), Some("CANCELLED_BEFORE_INSTALL"));
    state.phase = "prepared".into();
    fs::write(
        live.join(STORE_DIRECTORY).join("cat.json"),
        b"unexpected write",
    )
    .unwrap();
    assert_eq!(
        resume_operation(&live, &work, &operations, &mut state).unwrap_err(),
        "INVALID_CANCEL_PROOF"
    );
}

#[test]
fn snapshot_creation_failure_is_before_any_live_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let (live, _, _, _) = transaction_fixture(temp.path(), &runtime_fixture());
    let before = scope_digest(&live).unwrap();
    let blocked = temp.path().join("blocked");
    fs::write(&blocked, b"regular file").unwrap();
    assert!(
        recovery_snapshot(&live, &blocked)
            .unwrap_err()
            .starts_with("SNAPSHOT_FAILED:")
    );
    assert_eq!(scope_digest(&live).unwrap(), before);
}

#[test]
fn legacy_archives_and_operations_are_outside_update_snapshot_and_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let (live, work, _, _) = transaction_fixture(temp.path(), &runtime_fixture());
    write_json(
        &live.join("data-operations/active.json"),
        &json!({"kind":"import","phase":"prepared"}),
    )
    .unwrap();
    fs::write(
        live.join("historical-user-backup.zip"),
        b"unrelated user archive",
    )
    .unwrap();
    let selected_source = br#"{"repository":"oup030416/dmelopers-3d-block-pet-test"}"#;
    fs::write(live.join("update-source.json"), selected_source).unwrap();
    let selected_snapshot = work.join("selected-source-snapshot");
    snapshot_live(&live, &selected_snapshot).unwrap();
    assert!(!selected_snapshot.join("update-source.json").exists());
    assert!(read_state(&live.join("update-recovery")).unwrap().is_none());
    replace_scope(&live, &work.join("backup")).unwrap();
    assert_eq!(
        fs::read(live.join("historical-user-backup.zip")).unwrap(),
        b"unrelated user archive"
    );
    assert!(live.join("data-operations/active.json").exists());
    assert_eq!(
        fs::read(live.join("update-source.json")).unwrap(),
        selected_source
    );
}

#[test]
fn verified_update_deletes_only_its_temporary_snapshot_and_keeps_receipts() {
    let temp = tempfile::tempdir().unwrap();
    let (live, work, _, mut state) = transaction_fixture(temp.path(), &runtime_fixture());
    let operations = live.join("update-recovery");
    fs::create_dir_all(&operations).unwrap();
    let owned_work = operations.join(&state.request_id);
    fs::rename(&work, &owned_work).unwrap();
    persist_at(&operations, &state).unwrap();
    // Data health alone must not manufacture verification or discard recovery.
    assert!(
        cleanup_resolved_backup(
            &live,
            &state.request_id,
            &state.source_version,
            &state.expected_version
        )
        .is_err()
    );
    assert!(owned_work.join("backup").is_dir());
    state.phase = "awaitingCommit".into();
    state.rendered = true;
    state.window_digest = "1".repeat(64);
    state.window_geometry = Some(geometry::Evidence {
        monitor_work_areas: vec![],
        windows: BTreeMap::new(),
    });
    persist_at(&operations, &state).unwrap();
    assert!(
        cleanup_resolved_backup(
            &live,
            &state.request_id,
            &state.source_version,
            &state.expected_version
        )
        .is_err()
    );
    assert!(owned_work.join("backup").exists());
    assert_eq!(
        complete_program_commit(
            &live,
            &state.request_id,
            "wrong version",
            &state.expected_version
        )
        .unwrap_err(),
        "HEALTH_PROOF_MISMATCH"
    );
    complete_program_commit(
        &live,
        &state.request_id,
        &state.source_version,
        &state.expected_version,
    )
    .unwrap();
    assert_eq!(read_state(&operations).unwrap().unwrap().phase, "verified");
    fs::write(live.join("keep-user-backup.zip"), b"user archive").unwrap();
    let unrelated = operations.join("f".repeat(32));
    fs::create_dir_all(&unrelated).unwrap();
    fs::write(unrelated.join("retained"), b"other request").unwrap();
    assert!(
        cleanup_resolved_backup(
            &live,
            "../escape",
            &state.source_version,
            &state.expected_version
        )
        .is_err()
    );
    assert!(
        cleanup_resolved_backup(&live, &state.request_id, "wrong", &state.expected_version)
            .is_err()
    );
    let before = scope_digest(&live).unwrap();
    cleanup_resolved_backup(
        &live,
        &state.request_id,
        &state.source_version,
        &state.expected_version,
    )
    .unwrap();
    assert!(!owned_work.exists());
    assert!(
        operations
            .join(format!("{}.result.json", state.request_id))
            .is_file()
    );
    assert_eq!(read_state(&operations).unwrap().unwrap().phase, "verified");
    assert_eq!(
        fs::read(live.join("keep-user-backup.zip")).unwrap(),
        b"user archive"
    );
    assert_eq!(
        fs::read(unrelated.join("retained")).unwrap(),
        b"other request"
    );
    assert_eq!(scope_digest(&live).unwrap(), before);
    cleanup_resolved_backup(
        &live,
        &state.request_id,
        &state.source_version,
        &state.expected_version,
    )
    .unwrap();
}

#[test]
fn locked_snapshot_cleanup_is_warning_only_and_resumes_after_lock_release() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let (live, work, _, mut state) = transaction_fixture(temp.path(), &runtime_fixture());
    let operations = live.join("update-recovery");
    fs::create_dir_all(&operations).unwrap();
    let owned_work = operations.join(&state.request_id);
    fs::rename(&work, &owned_work).unwrap();
    state.phase = "verified".into();
    state.rendered = true;
    state.window_digest = "1".repeat(64);
    state.window_geometry = Some(geometry::Evidence {
        monitor_work_areas: vec![],
        windows: BTreeMap::new(),
    });
    persist_at(&operations, &state).unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(owned_work.join("backup/skin-library/manifest.json"))
        .unwrap();
    assert!(
        cleanup_resolved_backup(
            &live,
            &state.request_id,
            &state.source_version,
            &state.expected_version
        )
        .is_err()
    );
    let after = read_state(&operations).unwrap().unwrap();
    assert_eq!(after.phase, "verified");
    assert!(after.rendered);
    assert_eq!(after.warnings, vec!["RECOVERY_CLEANUP_DEFERRED"]);
    assert!(owned_work.exists());
    drop(locked);
    cleanup_resolved_backup(
        &live,
        &state.request_id,
        &state.source_version,
        &state.expected_version,
    )
    .unwrap();
    assert!(!owned_work.exists());
}

#[test]
fn cancelled_and_verified_rollback_remove_temporary_copies_but_failed_recovery_keeps_them() {
    for outcome in ["cancelled", "rolledBack", "failed"] {
        let temp = tempfile::tempdir().unwrap();
        let (live, work, _, mut state) = transaction_fixture(temp.path(), &runtime_fixture());
        let operations = live.join("update-recovery");
        fs::create_dir_all(&operations).unwrap();
        let owned_work = operations.join(&state.request_id);
        fs::rename(&work, &owned_work).unwrap();
        state.phase = if outcome == "failed" {
            "failed"
        } else {
            "rolledBack"
        }
        .into();
        state.rollback_attempted = outcome != "cancelled";
        state.error = Some(
            if outcome == "cancelled" {
                "CANCELLED_BEFORE_INSTALL"
            } else {
                "RENDER_FAILED"
            }
            .into(),
        );
        state.failure_reason = (outcome != "cancelled").then(|| "RENDER_FAILED".into());
        state.rendered = outcome == "rolledBack";
        if state.rendered {
            state.window_digest = "1".repeat(64);
            state.window_geometry = Some(geometry::Evidence {
                monitor_work_areas: vec![],
                windows: BTreeMap::new(),
            });
        }
        persist_at(&operations, &state).unwrap();
        let result = cleanup_resolved_backup(
            &live,
            &state.request_id,
            &state.source_version,
            &state.expected_version,
        );
        assert_eq!(result.is_ok(), outcome != "failed");
        assert_eq!(owned_work.exists(), outcome == "failed");
        let receipt = read_state(&operations).unwrap().unwrap();
        assert_eq!(receipt.phase, state.phase);
        assert_eq!(receipt.failure_reason, state.failure_reason);
    }
}
#[test]
fn saved_noop_is_detected_and_derived_theme_changes_do_not_change_user_meaning() {
    let temp = tempfile::tempdir().unwrap();
    let stores = runtime_fixture();
    for (id, value) in &stores {
        write_json(
            &temp.path().join(STORE_DIRECTORY).join(format!("{id}.json")),
            value,
        )
        .unwrap();
    }
    let mut changed = stores.clone();
    changed.get_mut("general").unwrap()["appearance"]["theme"] = "dark".into();
    assert_eq!(
        verify_saved_stores(temp.path(), &changed).unwrap_err(),
        "SAVE_VERIFICATION_FAILED"
    );
    assert_ne!(
        semantic_digest(&stores).unwrap(),
        semantic_digest(&changed).unwrap()
    );
    let before = semantic_digest(&changed).unwrap();
    changed.get_mut("general").unwrap()["appearance"]["isDark"] = true.into();
    assert_eq!(semantic_digest(&changed).unwrap(), before);
    for (id, value) in &changed {
        write_json(
            &temp.path().join(STORE_DIRECTORY).join(format!("{id}.json")),
            value,
        )
        .unwrap();
    }
    verify_saved_stores(temp.path(), &changed).unwrap();
}

#[test]
fn runtime_fixture_semantic_digest_matches_installed_evidence_projection() {
    let stores = runtime_fixture();
    // Independently projected from these same four raw stores by the installed
    // evidence consumer. This also detects cross-language JSON number drift.
    assert_eq!(
        semantic_digest(&stores).unwrap(),
        "3e92ecd6a2268d041b1fef6d9251fca7abf14b83923a1248e2728fbc211a8284"
    );
}

#[test]
fn semantic_float_values_preserve_native_json_roundtrip_identity() {
    let stores = runtime_fixture();
    for (label, key, value) in [
        ("opacity-tiny", "opacity", 1e-7),
        ("opacity-threshold", "opacity", 0.000001),
        ("opacity-fraction", "opacity", 0.1),
        ("opacity-whole-float", "opacity", 1.0),
        ("delay-large", "autoReleaseDelay", 1e20),
    ] {
        let mut changed = stores.clone();
        let number = json!(value);
        let section = if key == "opacity" { "window" } else { "model" };
        changed.get_mut("cat").unwrap()[section][key] = number.clone();
        let native_digest = semantic_digest(&changed).unwrap();
        let encoded = serde_json::to_vec(&changed).unwrap();
        let reread: Stores = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(semantic_digest(&reread).unwrap(), native_digest);
        eprintln!("SEMANTIC_NUMBER {label} value={number} sha256={native_digest}");
    }
}

#[test]
fn verified_native_geometry_capture_survives_cleanup_and_older_receipts_resume() {
    let temp = tempfile::tempdir().unwrap();
    let mut stores = runtime_fixture();
    let positions = json!({
        "main": {"x":0,"y":0,"width":500,"height":422},
        "preference": {"x":0,"y":0,"width":900,"height":480}
    });
    stores.get_mut("app").unwrap()["windowState"] = positions.clone();
    let mut source = positions.clone();
    source["preference"]["width"] = 500.into();
    source["preference"]["height"] = 300.into();
    let area = geometry::Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1040.0,
    };
    let mut capture = geometry::Evidence {
        monitor_work_areas: vec![area],
        windows: BTreeMap::new(),
    };
    for (label, inner, outer, minimum) in [
        ("main", (480.0, 400.0), (500.0, 422.0), (0.0, 0.0)),
        ("preference", (900.0, 480.0), (916.0, 519.0), (900.0, 480.0)),
    ] {
        capture.windows.insert(
            label.into(),
            geometry::WindowObservation {
                position: geometry::Position { x: 0.0, y: 0.0 },
                inner_size: geometry::Size {
                    width: inner.0,
                    height: inner.1,
                },
                outer_size: geometry::Size {
                    width: outer.0,
                    height: outer.1,
                },
                monitor_work_area: area,
                scale_factor: 1.5,
                minimum_size: geometry::Size {
                    width: minimum.0,
                    height: minimum.1,
                },
            },
        );
    }
    capture.verify(&source, &positions).unwrap();
    let mut drifted = capture.clone();
    drifted.windows.get_mut("main").unwrap().position.x = 2.0;
    assert_eq!(
        drifted.verify(&source, &positions).unwrap_err(),
        "WINDOW_NATIVE_MISMATCH"
    );
    let mut drifted = capture.clone();
    drifted
        .windows
        .get_mut("preference")
        .unwrap()
        .inner_size
        .width += 2.0;
    assert_eq!(
        drifted.verify(&source, &positions).unwrap_err(),
        "WINDOW_NATIVE_SIZE_MISMATCH"
    );
    let mut drifted = capture.clone();
    drifted
        .windows
        .get_mut("preference")
        .unwrap()
        .minimum_size
        .width = 1000.0;
    assert_eq!(
        drifted.verify(&source, &positions).unwrap_err(),
        "WINDOW_SIZE_CLAMP_MISMATCH"
    );

    let (live, work, operations, state) = transaction_fixture(temp.path(), &stores);
    let mut older = serde_json::to_value(&state).unwrap();
    older.as_object_mut().unwrap().remove("windowGeometry");
    let mut state: OperationState = serde_json::from_value(older).unwrap();
    assert!(state.window_geometry.is_none());
    resume_operation(&live, &work, &operations, &mut state).unwrap();
    assert_eq!(state.phase, "awaitingHealth");
    state.phase = "verified".into();
    state.rendered = true;
    state.window_digest = digest(&serde_json::to_vec(&positions).unwrap());
    state.window_geometry = Some(capture.clone());
    persist_at(&operations, &state).unwrap();
    // The receipt is outside the transaction work directory removed on success.
    fs::remove_dir_all(&work).unwrap();
    let receipt_path = operations.join(format!("{}.result.json", state.request_id));
    let receipt: OperationState =
        serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    assert_eq!(receipt.window_geometry, Some(capture.clone()));
    assert_eq!(receipt.window_digest, state.window_digest);
    assert!(receipt.rendered);
    assert_eq!(receipt.phase, "verified");
    record_cleanup_result(&mut state, Err("denied".into()));
    persist_at(&operations, &state).unwrap();
    let receipt: OperationState = serde_json::from_slice(&fs::read(receipt_path).unwrap()).unwrap();
    assert_eq!(receipt.window_geometry, Some(capture));
    assert_eq!(receipt.warnings, vec!["RECOVERY_CLEANUP_DEFERRED"]);
    assert_eq!(receipt.phase, "verified");
}

#[test]
fn only_native_window_clamp_is_accepted() {
    let monitor = geometry::Rect {
        x: 0.,
        y: 0.,
        width: 1920.,
        height: 1040.,
    };
    geometry::verify_position(
        &json!({"x":3000,"y":2000}),
        &json!({"x":1420,"y":618}),
        geometry::Rect {
            x: 1420.,
            y: 618.,
            width: 500.,
            height: 422.,
        },
        &[monitor],
        false,
    )
    .unwrap();
    assert!(
        geometry::verify_position(
            &json!({"x":20,"y":20}),
            &json!({"x":500,"y":500}),
            geometry::Rect {
                x: 500.,
                y: 500.,
                width: 500.,
                height: 422.
            },
            &[monitor],
            false
        )
        .is_err()
    );
    geometry::verify_size(
        &json!({"width":3000,"height":2000}),
        &json!({"width":1920,"height":1000}),
        (1920., 1000.),
        (1920., 1000.),
        monitor,
        1.,
        (600., 320.),
        false,
    )
    .unwrap();
    // Restoring an older/smaller size on a 150% display is expanded by the
    // configured native logical minimum (600 x 320), not rejected as drift.
    geometry::verify_size(
        &json!({"width":500,"height":300}),
        &json!({"width":900,"height":480}),
        (900., 480.),
        (900., 480.),
        monitor,
        1.5,
        (900., 480.),
        false,
    )
    .unwrap();
    assert!(
        geometry::verify_size(
            &json!({"width":800,"height":720}),
            &json!({"width":700,"height":720}),
            (700., 720.),
            (700., 720.),
            monitor,
            1.,
            (600., 320.),
            false
        )
        .is_err()
    );
}

#[test]
fn operation_read_only_accepts_real_absence_and_rejects_unreadable_or_corrupt_state() {
    let temp = tempfile::tempdir().unwrap();
    assert!(read_state(temp.path()).unwrap().is_none());
    let path = temp.path().join("active.json");
    fs::create_dir(&path).unwrap();
    assert_eq!(read_state(temp.path()).unwrap_err(), "READ_FAILED");
    fs::remove_dir(&path).unwrap();
    fs::write(&path, b"{broken").unwrap();
    assert_eq!(read_state(temp.path()).unwrap_err(), "CORRUPT_OPERATION");
}

#[test]
fn hidden_memory_requests_respect_hold_and_return_to_current_visibility_after_release() {
    use tauri_plugin_custom_window::{
        effective_memory_active, hold_update_webviews, record_memory_request,
    };
    record_memory_request("main", false);
    record_memory_request("preference", false);
    hold_update_webviews(true);
    assert!(effective_memory_active("main", false));
    assert!(effective_memory_active("preference", false));
    assert!(!effective_memory_active("recovery", false));
    hold_update_webviews(false);
    assert!(
        !effective_memory_active("main", true),
        "a stale queued wake observes the latest hidden request"
    );
    record_memory_request("preference", true);
    assert!(effective_memory_active("preference", false));
    record_memory_request("main", true);
}

#[test]
fn native_participants_seal_once_and_cleanup_failure_never_revokes_verified_commit() {
    let stores = runtime_fixture();
    let mut lease = Quiescence::default();
    assert_eq!(lease.verify(&stores).unwrap_err(), "QUIESCE_REQUIRED");
    lease.acknowledge("main", &stores).unwrap();
    assert!(lease.verify(&stores).is_err());
    assert_eq!(
        lease.acknowledge("recovery", &stores).unwrap_err(),
        "INVALID_PARTICIPANT"
    );
    lease.acknowledge("preference", &stores).unwrap();
    lease.verify(&stores).unwrap();
    let mut changed = stores.clone();
    changed.get_mut("general").unwrap()["appearance"]["theme"] = "dark".into();
    assert_eq!(lease.verify(&changed).unwrap_err(), "QUIESCE_STATE_CHANGED");
    assert_eq!(
        lease.acknowledge("preference", &changed).unwrap_err(),
        "DUPLICATE_PARTICIPANT"
    );
    let temp = tempfile::tempdir().unwrap();
    let (_, _, _, mut state) = transaction_fixture(temp.path(), &stores);
    state.phase = "verified".into();
    state.rendered = true;
    record_cleanup_result(&mut state, Err("disk denied".into()));
    assert_eq!(state.phase, "verified");
    assert!(state.rendered);
    assert_eq!(state.warnings, vec!["RECOVERY_CLEANUP_DEFERRED"]);
}

#[test]
fn prepared_update_without_helper_locator_can_only_cancel_unchanged_source_version() {
    let temp = tempfile::tempdir().unwrap();
    let stores = runtime_fixture();
    let (live, work, _, mut state) = transaction_fixture(temp.path(), &stores);
    state.phase = "prepared".into();
    state.expected_version = "1.0.1".into();
    let original = state.clone();
    assert_eq!(
        cancel_unstarted_update(&live, &work, &mut state, "1.0.1").unwrap_err(),
        "INVALID_CANCEL_PROOF"
    );
    let locator = live.join("update-recovery/program-recovery.json");
    fs::write(live.join("update-recovery"), b"invalid parent").unwrap();
    assert_eq!(
        cancel_unstarted_update(&live, &work, &mut state, "1.0.0").unwrap_err(),
        "RECOVERY_LOCATOR_UNREADABLE"
    );
    fs::remove_file(live.join("update-recovery")).unwrap();
    fs::create_dir_all(locator.parent().unwrap()).unwrap();
    fs::write(&locator, b"locator exists but is not trusted by this layer").unwrap();
    assert!(!cancel_unstarted_update(&live, &work, &mut state, "1.0.0").unwrap());
    fs::remove_file(&locator).unwrap();
    // An unrelated file in the former, incorrect directory is not the helper's
    // locator and must not conceal the real NotFound proof.
    fs::write(live.join("program-recovery.json"), b"unrelated").unwrap();
    assert!(cancel_unstarted_update(&live, &work, &mut state, "1.0.0").unwrap());
    assert_eq!(state.phase, "rolledBack");
    assert!(!state.rollback_attempted);
    assert!(work.join("backup").exists());
    state = original;
    fs::write(live.join(STORE_DIRECTORY).join("cat.json"), b"live drift").unwrap();
    assert!(cancel_unstarted_update(&live, &work, &mut state, "1.0.0").is_err());
}

#[test]
fn complete_scope_snapshot_restore_and_verification_cover_every_mutated_file() {
    let temp = tempfile::tempdir().unwrap();
    let live = temp.path().join("live");
    fs::create_dir_all(live.join(STORE_DIRECTORY)).unwrap();
    fs::create_dir_all(live.join("skin-library/raw")).unwrap();
    fs::write(live.join(STORE_DIRECTORY).join("cat.json"), b"old preset").unwrap();
    fs::write(
        live.join(STORE_DIRECTORY).join("general.json"),
        b"old settings",
    )
    .unwrap();
    fs::write(live.join("skin-library/raw/private.png"), b"original PNG").unwrap();
    let backup = temp.path().join("backup");
    let hash = snapshot_live(&live, &backup).unwrap();
    fs::write(live.join(STORE_DIRECTORY).join("cat.json"), b"replacement").unwrap();
    fs::write(live.join("skin-library/raw/new.png"), b"replacement asset").unwrap();
    replace_scope(&live, &backup).unwrap();
    assert_eq!(scope_digest(&live).unwrap(), hash);
    assert!(!live.join("skin-library/raw/new.png").exists());
    assert!(live.join("skin-library/raw/private.png").exists());
}
